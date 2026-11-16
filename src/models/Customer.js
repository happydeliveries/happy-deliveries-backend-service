const db = require('../config/database');

class Customer {
  // Create customer profile
  static async create(userId, customerData = {}) {
    const query = `
      INSERT INTO customers (user_id, delivery_addresses)
      VALUES ($1, $2)
      RETURNING *
    `;
    // FIX: Wrap the delivery_addresses in JSON.stringify
    const safeAddresses = JSON.stringify(customerData.delivery_addresses || []);
    const result = await db.query(query, [userId, safeAddresses]);
    return result.rows[0];
  }

  // Get customer by user ID
  static async findByUserId(userId) {
    const query = `
      SELECT c.*, u.email, u.phone_number, u.first_name, u.last_name
      FROM customers c
      JOIN users u ON c.user_id = u.id
      WHERE c.user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  // Ensure customer row exists for a user ID
  static async getOrCreateByUserId(userId) {
    let customer = await this.findByUserId(userId);
    if (!customer) {
      await this.create(userId);
      customer = await this.findByUserId(userId);
    }
    return customer;
  }

  // Add delivery address
  static async addDeliveryAddress(customerId, address) {
    const normalizedAddress = {
      id: address.id || `addr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      label: address.label || 'Home',
      street: address.street || address.address || '',
      city: address.city || '',
      postal_code: address.postal_code || '',
      instructions: address.instructions || '',
      latitude: Number.isFinite(Number(address.latitude)) ? Number(address.latitude) : undefined,
      longitude: Number.isFinite(Number(address.longitude)) ? Number(address.longitude) : undefined,
      is_default: Boolean(address.is_default),
    };

    const existingRes = await db.query(
      'SELECT COALESCE(delivery_addresses, \'[]\'::jsonb) AS delivery_addresses FROM customers WHERE id = $1',
      [customerId]
    );
    const current = Array.isArray(existingRes.rows[0]?.delivery_addresses)
      ? existingRes.rows[0].delivery_addresses
      : [];

    const baseList = normalizedAddress.is_default || current.length === 0
      ? current.map((a) => ({ ...a, is_default: false }))
      : [...current];

    if (current.length === 0) {
      normalizedAddress.is_default = true;
    }

    const updated = [...baseList, normalizedAddress];

    const result = await db.query(
      `UPDATE customers
       SET delivery_addresses = $2::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING delivery_addresses`,
      [customerId, JSON.stringify(updated)]
    );
    return result.rows[0];
  }

  // Remove delivery address by id or array index
  static async removeDeliveryAddress(customerId, identifier) {
    const existingRes = await db.query(
      'SELECT COALESCE(delivery_addresses, \'[]\'::jsonb) AS delivery_addresses FROM customers WHERE id = $1',
      [customerId]
    );
    const current = Array.isArray(existingRes.rows[0]?.delivery_addresses)
      ? existingRes.rows[0].delivery_addresses
      : [];

    const filtered = current.filter((addr, idx) => {
      if (addr && addr.id && String(addr.id) === String(identifier)) return false;
      if (/^\d+$/.test(String(identifier)) && idx === parseInt(identifier, 10)) return false;
      return true;
    });

    if (filtered.length > 0 && !filtered.some((a) => a && a.is_default)) {
      filtered[0] = { ...filtered[0], is_default: true };
    }

    const result = await db.query(
      `UPDATE customers
       SET delivery_addresses = $2::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING delivery_addresses`,
      [customerId, JSON.stringify(filtered)]
    );
    return result.rows[0];
  }

  // Update customer preferences
  static async updatePreferences(customerId, preferences) {
    const { dietary_preferences, default_payment_method } = preferences || {};
    const query = `
      UPDATE customers 
      SET 
        dietary_preferences = COALESCE($2, dietary_preferences),
        default_payment_method = COALESCE($3, default_payment_method),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await db.query(query, [customerId, dietary_preferences ?? null, default_payment_method ?? null]);
    return result.rows[0];
  }

  // Get customer order history
  static async getOrderHistory(customerId, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    
    const query = `
      SELECT o.*, r.name as restaurant_name, d.first_name as driver_first_name, d.last_name as driver_last_name
      FROM orders o
      LEFT JOIN restaurants r ON o.restaurant_id = r.id
      LEFT JOIN drivers dr ON o.driver_id = dr.id
      LEFT JOIN users d ON dr.user_id = d.id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    
    const countQuery = 'SELECT COUNT(*) FROM orders WHERE customer_id = $1';
    
    const [ordersResult, countResult] = await Promise.all([
      db.query(query, [customerId, limit, offset]),
      db.query(countQuery, [customerId])
    ]);
    
    return {
      orders: ordersResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
    };
  }
}

module.exports = Customer;