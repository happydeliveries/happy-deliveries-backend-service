const db = require('../config/database');

class Payment {
  // Create payment record
  static async create(paymentData) {
    const {
      order_id,
      customer_id,
      amount,
      payment_method,
      gateway_transaction_id = null,
      gateway_response = null
    } = paymentData;
    
    const query = `
      INSERT INTO payments (
        order_id,
        customer_id,
        amount,
        payment_method,
        gateway_transaction_id,
        gateway_response,
        payment_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'processing')
      RETURNING *
    `;
    
    const result = await db.query(query, [
      order_id,
      customer_id,
      amount,
      payment_method,
      gateway_transaction_id,
      JSON.stringify(gateway_response)
    ]);
    
    return result.rows[0];
  }

  // Update payment status
  static async updateStatus(paymentId, status, gatewayResponse = null) {
    const query = `
      UPDATE payments 
      SET 
        payment_status = $2,
        gateway_response = COALESCE($3, gateway_response),
        completed_at = CASE WHEN $2 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await db.query(query, [
      paymentId,
      status,
      gatewayResponse ? JSON.stringify(gatewayResponse) : null
    ]);
    
    return result.rows[0];
  }

  // Get payment by order ID
  static async findByOrderId(orderId) {
    const query = `
      SELECT p.*, o.order_number, c.first_name, c.last_name
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      JOIN customers cust ON p.customer_id = cust.id
      JOIN users c ON cust.user_id = c.id
      WHERE p.order_id = $1
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
    
    const result = await db.query(query, [orderId]);
    return result.rows[0];
  }

  // Get payment by gateway transaction reference (e.g. Paystack reference)
  static async findByReference(reference) {
    if (!reference) return null;
    const query = `
      SELECT p.*, o.order_number
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      WHERE p.gateway_transaction_id = $1
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
    const result = await db.query(query, [reference]);
    return result.rows[0] || null;
  }

  // Create or update a pending/processing Paystack payment record for an order
  static async upsertPendingPaystackPayment({
    order_id,
    customer_id,
    amount,
    payment_method = 'card',
    reference,
    gateway_response = null,
  }) {
    const existing = await this.findByOrderId(order_id);
    if (existing && existing.payment_status !== 'completed') {
      const updateQuery = `
        UPDATE payments
        SET payment_method = $2,
            amount = $3,
            gateway_transaction_id = $4,
            gateway_response = $5,
            payment_status = 'processing',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;
      const res = await db.query(updateQuery, [
        existing.id,
        payment_method,
        amount,
        reference,
        JSON.stringify(gateway_response),
      ]);
      return res.rows[0];
    }

    return this.create({
      order_id,
      customer_id,
      amount,
      payment_method,
      gateway_transaction_id: reference,
      gateway_response,
    });
  }

  // Mark payment completed with gateway reference & payload
  static async markCompleted(paymentId, reference = null, gatewayResponse = null) {
    const query = `
      UPDATE payments
      SET payment_status = 'completed',
          gateway_transaction_id = COALESCE($2, gateway_transaction_id),
          gateway_response = COALESCE($3, gateway_response),
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const result = await db.query(query, [
      paymentId,
      reference,
      gatewayResponse ? JSON.stringify(gatewayResponse) : null,
    ]);
    return result.rows[0];
  }

  // Get customer payments
  static async getCustomerPayments(customerId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    
    const query = `
      SELECT p.*, o.order_number, r.name as restaurant_name
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE p.customer_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    
    const countQuery = 'SELECT COUNT(*) FROM payments WHERE customer_id = $1';
    
    const [paymentsResult, countResult] = await Promise.all([
      db.query(query, [customerId, limit, offset]),
      db.query(countQuery, [customerId])
    ]);
    
    return {
      payments: paymentsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
    };
  }

  // Process refund
  static async processRefund(paymentId, refundAmount, reason = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get payment details
      const paymentQuery = 'SELECT * FROM payments WHERE id = $1 FOR UPDATE';
      const paymentResult = await client.query(paymentQuery, [paymentId]);
      
      if (paymentResult.rows.length === 0) {
        throw new Error('Payment not found');
      }
      
      const payment = paymentResult.rows[0];
      
      if (payment.payment_status !== 'completed') {
        throw new Error('Only completed payments can be refunded');
      }
      
      // Update payment status to refunded
      const updateQuery = `
        UPDATE payments 
        SET 
          payment_status = 'refunded',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [paymentId]);
      
      // Create refund record (you might want a separate refunds table)
      // For now, we'll just log it
      
      await client.query('COMMIT');
      return updateResult.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Payment;