const db = require('../config/database');
const crypto = require('crypto');
const Payment = require('./Payment');
const {
  emitOrderUpdate,
  emitUserEvent,
  emitDriverLocation,
  emitManagerEvent,
  emitDriversEvent
} = require('../socket');
const { sanitizeOrderForDriver } = require('../utils/driverOrderSanitizer');

function normalizePointCoords(pt) {
  if (!pt) return null;
  let x = null;
  let y = null;
  if (Array.isArray(pt) && pt.length >= 2) {
    x = Number(pt[0]);
    y = Number(pt[1]);
  } else if (typeof pt === 'object') {
    if (pt.latitude !== undefined && pt.longitude !== undefined) {
      x = Number(pt.longitude);
      y = Number(pt.latitude);
    } else if (pt.x !== undefined && pt.y !== undefined) {
      x = Number(pt.x);
      y = Number(pt.y);
    }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x === 0 && y === 0) return null;
  // Auto-correct only if latitude (y) is outside [-90, 90] or South Africa lat/lng were clearly reversed
  if ((Math.abs(y) > 90 && Math.abs(x) <= 90) || (x < -15 && x > -38 && y > 15 && y < 35)) {
    const tmp = x;
    x = y;
    y = tmp;
  }
  return {
    x,
    y,
    longitude: x,
    latitude: y
  };
}

function computeSelectedOptionsDelta(selectedOptions) {
  if (!selectedOptions || typeof selectedOptions !== 'object') return 0;
  let delta = 0;
  for (const val of Object.values(selectedOptions)) {
    if (Array.isArray(val)) {
      for (const entry of val) {
        if (entry && typeof entry === 'object') {
          const p = Number(entry.price ?? entry.priceDelta ?? 0);
          if (Number.isFinite(p) && p > 0) delta += p;
        }
      }
    } else if (val && typeof val === 'object') {
      const p = Number(val.price ?? val.priceDelta ?? 0);
      if (Number.isFinite(p) && p > 0) delta += p;
    }
  }
  return delta;
}

class Order {
  // Create new order (with server-side item & price verification)
  static async create(customerId, orderData) {
    const {
      restaurant_id,
      items,
      special_instructions,
      delivery_instructions,
      delivery_address,
      payment_method = 'card',
      delivery_fee: clientDeliveryFee,
      tax_amount: clientTaxAmount,
      tip_amount = 0
    } = orderData;

    if (!restaurant_id) {
      throw new Error('restaurant_id is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Order must contain at least one item');
    }
    
    const order_number = `ORD-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    
    // Start transaction
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Validate restaurant is active and accepting orders
      const restRes = await client.query(
        `SELECT id, name, is_active, is_accepting_orders FROM restaurants WHERE id = $1`,
        [restaurant_id]
      );
      if (restRes.rows.length === 0) {
        throw new Error('Restaurant not found');
      }
      const restaurant = restRes.rows[0];
      if (restaurant.is_active === false || restaurant.is_accepting_orders === false) {
        throw new Error('This restaurant is currently not accepting orders');
      }

      // 2. Fetch authoritative menu item prices from DB
      const itemIds = items.map((i) => i.menu_item_id).filter(Boolean);
      const dbItemsRes = await client.query(
        `SELECT id, name, restaurant_id, price, discounted_price, is_available
         FROM menu_items
         WHERE id = ANY($1::uuid[])`,
        [itemIds]
      );
      const dbItemMap = new Map(dbItemsRes.rows.map((r) => [r.id, r]));

      let verifiedSubtotal = 0;
      const verifiedItems = [];

      for (const item of items) {
        const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
        const dbItem = dbItemMap.get(item.menu_item_id);
        if (!dbItem) {
          throw new Error('One or more menu items were not found');
        }
        if (dbItem.restaurant_id !== restaurant_id) {
          throw new Error(`Item "${dbItem.name}" does not belong to this restaurant`);
        }
        if (dbItem.is_available === false) {
          throw new Error(`Item "${dbItem.name}" is currently unavailable`);
        }

        const basePrice =
          dbItem.discounted_price !== null &&
          dbItem.discounted_price !== undefined &&
          Number(dbItem.discounted_price) > 0 &&
          Number(dbItem.discounted_price) < Number(dbItem.price)
            ? Number(dbItem.discounted_price)
            : Number(dbItem.price);

        const optionsDelta = computeSelectedOptionsDelta(item.selected_options);
        const authoritativeUnitPrice = +(basePrice + optionsDelta).toFixed(2);
        verifiedSubtotal += authoritativeUnitPrice * qty;

        verifiedItems.push({
          ...item,
          quantity: qty,
          unit_price: authoritativeUnitPrice,
        });
      }

      verifiedSubtotal = +verifiedSubtotal.toFixed(2);
      const verifiedDeliveryFee = Math.max(
        0,
        Number.isFinite(Number(clientDeliveryFee)) ? +Number(clientDeliveryFee).toFixed(2) : 3.99
      );
      const computedTax = +(verifiedSubtotal * 0.08).toFixed(2);
      const verifiedTaxAmount = Math.max(
        computedTax,
        Number.isFinite(Number(clientTaxAmount)) ? +Number(clientTaxAmount).toFixed(2) : computedTax
      );
      const verifiedTipAmount = Math.max(0, Number.isFinite(Number(tip_amount)) ? +Number(tip_amount).toFixed(2) : 0);
      const total_amount = +(
        verifiedSubtotal +
        verifiedDeliveryFee +
        verifiedTaxAmount +
        verifiedTipAmount
      ).toFixed(2);
      
      // Create order
      const orderQuery = `
        INSERT INTO orders (
          order_number,
          customer_id,
          restaurant_id,
          special_instructions,
          delivery_instructions,
          delivery_address,
          payment_method,
          subtotal,
          delivery_fee,
          tax_amount,
          tip_amount,
          total_amount,
          status,
          driver_acceptance_deadline
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', NOW() + INTERVAL '1800 seconds')
        RETURNING *
      `;
      
      const orderResult = await client.query(orderQuery, [
        order_number,
        customerId,
        restaurant_id,
        special_instructions,
        delivery_instructions,
        JSON.stringify(delivery_address),
        payment_method,
        verifiedSubtotal,
        verifiedDeliveryFee,
        verifiedTaxAmount,
        verifiedTipAmount,
        total_amount
      ]);
      
      const order = orderResult.rows[0];
      
      // Add order items
      for (const item of verifiedItems) {
        const itemQuery = `
          INSERT INTO order_items (
            order_id,
            menu_item_id,
            quantity,
            unit_price,
            special_instructions,
            selected_options,
            allergen_notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        
        await client.query(itemQuery, [
          order.id,
          item.menu_item_id,
          item.quantity,
          item.unit_price,
          item.special_instructions,
          JSON.stringify(item.selected_options || {}),
          item.allergen_notes
        ]);
      }
      
      // Add to driver queue WITHOUT populating available_driver_ids
      // Driver queue is created but not activated until manager publishes
      const queueQuery = `
        INSERT INTO driver_order_queue (order_id, expires_at, is_active)
        VALUES ($1, NOW() + INTERVAL '600 seconds', false)
        RETURNING *
      `;
      
      await client.query(queueQuery, [order.id]);
      
      await client.query('COMMIT');
      
      // Emit real-time update - order created but not yet published to drivers
      if (emitOrderUpdate) {
        emitOrderUpdate(order.id, {
          type: 'order_created',
          order,
          status: 'pending',
          message: 'Order created, awaiting manager publication'
        });
      }
      
      return order;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get order by ID
  static async findById(orderId, userId = null, userRole = null) {
    let query = `
      SELECT 
        o.*,
        r.name as restaurant_name,
        r.address as restaurant_address,
        r.phone_number as restaurant_phone,
        r.logo_url as restaurant_logo,
        r.location as restaurant_location,
        CASE WHEN r.location IS NOT NULL THEN ST_X(r.location::geometry) ELSE NULL END as restaurant_lng,
        CASE WHEN r.location IS NOT NULL THEN ST_Y(r.location::geometry) ELSE NULL END as restaurant_lat,
        c.first_name as customer_first_name,
        c.last_name as customer_last_name,
        c.phone_number as customer_phone,
        u.first_name as driver_first_name,
        u.last_name as driver_last_name,
        u.phone_number as driver_phone,
        u.profile_image_url as driver_image,
        -- FIX: Select specific car details here
        d.vehicle_type as driver_vehicle_type,
        d.vehicle_model as driver_vehicle_model,
        d.vehicle_color as driver_vehicle_color,
        d.vehicle_registration as driver_vehicle_plate,
        d.current_location as driver_location,
        d.last_location_update as driver_last_location_update,
        o.verification_code,
        o.code_expires_at,
        o.code_used_at,
        (SELECT e.net_amount FROM earnings e WHERE e.order_id = o.id LIMIT 1) as driver_earnings
      FROM orders o
      LEFT JOIN restaurants r ON o.restaurant_id = r.id
      LEFT JOIN customers cust ON o.customer_id = cust.id
      LEFT JOIN users c ON cust.user_id = c.id
      LEFT JOIN drivers dr ON o.driver_id = dr.id
      LEFT JOIN users u ON dr.user_id = u.id
      LEFT JOIN drivers d ON o.driver_id = d.id
      WHERE o.id = $1
    `;
    
    const params = [orderId];
    
    if (userId && userRole) {
        if (userRole === 'customer') {
        query += ` AND o.customer_id = (SELECT id FROM customers WHERE user_id = $2)`;
        params.push(userId);
        } else if (userRole === 'driver') {
        query += ` AND (o.driver_id = (SELECT id FROM drivers WHERE user_id = $2) OR (o.driver_id IS NULL AND o.status IN ('ordering_at_restaurant', 'order_ready') AND o.payment_status = 'completed'))`;
        params.push(userId);
        } else if (userRole === 'restaurant_manager') {
        query += ` AND o.restaurant_id IN (SELECT id FROM restaurants WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $2))`;
        params.push(userId);
        }
    }
    
    const result = await db.query(query, params);
    const row = result.rows[0];
    if (!row) return undefined;

    // Normalize restaurant_location from PostGIS ST_X / ST_Y so clients can parse { x, y, latitude, longitude } directly
    if (Number.isFinite(Number(row.restaurant_lng)) && Number.isFinite(Number(row.restaurant_lat))) {
      const rCoords = normalizePointCoords({
        x: Number(row.restaurant_lng),
        y: Number(row.restaurant_lat)
      });
      if (rCoords) {
        row.restaurant_location = rCoords;
      }
    }

    // Normalize driver_location (and fall back to latest delivery_tracking or restaurant location when picked_up)
    let normalizedDriverLoc = normalizePointCoords(row.driver_location);
    if (!normalizedDriverLoc && row.driver_id) {
      try {
        const trackRes = await db.query(
          `SELECT location, created_at FROM delivery_tracking WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [orderId]
        );
        if (trackRes.rows[0]?.location) {
          normalizedDriverLoc = normalizePointCoords(trackRes.rows[0].location);
        }
      } catch {
        // ignore if delivery_tracking table or rows unavailable
      }
    }

    // Only fall back to restaurant coordinates right when picked_up at restaurant if no GPS ping has arrived yet
    if (
      !normalizedDriverLoc &&
      row.status === 'picked_up' &&
      row.restaurant_location &&
      typeof row.restaurant_location === 'object' &&
      Number.isFinite(row.restaurant_location.latitude)
    ) {
      normalizedDriverLoc = { ...row.restaurant_location };
    }

    if (normalizedDriverLoc) {
      row.driver_location = normalizedDriverLoc;
    }

    // Automatically ensure a valid delivery verification code for active transit orders
    if (['picked_up', 'on_the_way', 'arrived'].includes(row.status) && !row.code_used_at) {
      const now = new Date();
      if (!row.verification_code || !row.code_expires_at || new Date(row.code_expires_at) <= now) {
        try {
          const refreshed = await this.ensureVerificationCode(orderId);
          if (refreshed) {
            row.verification_code = refreshed.verification_code;
            row.code_expires_at = refreshed.code_expires_at;
            row.code_used_at = refreshed.code_used_at;
          }
        } catch {
          // ignore
        }
      }
    }

    return row;
  }

  // Get order items
  static async getOrderItems(orderId) {
    const query = `
      SELECT 
        oi.*,
        mi.name as item_name,
        mi.description as item_description,
        mi.image_url as item_image
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE oi.order_id = $1
      ORDER BY oi.created_at
    `;
    
    const result = await db.query(query, [orderId]);
    return result.rows;
  }

  static createReadableVerificationCode(length = 8) {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = crypto.randomBytes(length);
    const code = Array.from(bytes)
      .map((byte) => chars[byte % chars.length])
      .join('');
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  static async generateVerificationCode(orderId) {
    const verificationCode = this.createReadableVerificationCode(8);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 minutes (valid for entire delivery window)

    const query = `
      UPDATE orders
      SET
        verification_code = $2,
        code_expires_at = $3,
        code_used_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const result = await db.query(query, [orderId, verificationCode, expiresAt.toISOString()]);
    const order = result.rows[0];

    if (order) {
      try {
        const custRes = await db.query('SELECT user_id FROM customers WHERE id = $1', [order.customer_id]);
        const customerUserId = custRes.rows[0]?.user_id;
        if (customerUserId && emitUserEvent) {
          emitUserEvent(customerUserId, 'order_update', {
            type: 'delivery_code_generated',
            orderId: order.id,
            status: order.status,
            order: {
              id: order.id,
              verification_code: order.verification_code,
              code_expires_at: order.code_expires_at,
              code_used_at: order.code_used_at,
            },
          });
        }
      } catch {
        // ignore
      }
      if (emitOrderUpdate) {
        emitOrderUpdate(order.id, {
          type: 'delivery_code_generated',
          orderId: order.id,
          status: order.status,
        });
      }
    }

    return order;
  }

  static async ensureVerificationCode(orderId) {
    const query = `
      SELECT verification_code, code_expires_at, code_used_at
      FROM orders
      WHERE id = $1
    `;
    const result = await db.query(query, [orderId]);
    const order = result.rows[0];
    const now = new Date();

    if (
      !order ||
      !order.verification_code ||
      !order.code_expires_at ||
      order.code_used_at ||
      new Date(order.code_expires_at) <= now
    ) {
      return this.generateVerificationCode(orderId);
    }

    return order;
  }

  static async logVerificationAttempt(orderId, driverId, attemptedCode, success, reason = null) {
    const query = `
      INSERT INTO order_delivery_verification_attempts (
        order_id,
        driver_id,
        attempted_code,
        success,
        reason
      ) VALUES ($1, $2, $3, $4, $5)
    `;
    await db.query(query, [orderId, driverId, attemptedCode, success, reason]);
  }

  static async verifyDeliveryCode(orderId, driverId, code) {
    const client = await db.pool.connect();
    let order;

    try {
      await client.query('BEGIN');
      const selectQuery = `SELECT * FROM orders WHERE id = $1 FOR UPDATE`;
      const selectResult = await client.query(selectQuery, [orderId]);

      if (selectResult.rows.length === 0) {
        throw new Error('Order not found');
      }

      order = selectResult.rows[0];
      const now = new Date();
      const providedCode = String(code || '').trim().toUpperCase();
      const expectedCode = String(order.verification_code || '').trim().toUpperCase();

      if (order.driver_id !== driverId) {
        throw new Error('Not authorized to verify this delivery');
      }

      if (!['on_the_way', 'arrived'].includes(order.status)) {
        throw new Error('Delivery verification is not allowed for this order status');
      }

      if (!order.verification_code) {
        throw new Error('Delivery code not generated for this order');
      }

      if (order.code_used_at) {
        throw new Error('Delivery code has already been used');
      }

      if (!order.code_expires_at || new Date(order.code_expires_at) <= now) {
        throw new Error('Delivery code has expired');
      }

      if (providedCode !== expectedCode) {
        throw new Error('Delivery code did not match');
      }

      const updateQuery = `
        UPDATE orders
        SET
          status = 'delivered',
          delivered_at = CURRENT_TIMESTAMP,
          code_used_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;
      const updateResult = await client.query(updateQuery, [orderId]);
      const updatedOrder = updateResult.rows[0];

      const deliveryFee = Number(order.delivery_fee || 0);
      const tipAmount = Number(order.tip_amount || 0);
      const subtotalAmount = Number(order.subtotal || order.total_amount || 0);
      const driverEarnings = +(
        (deliveryFee > 0 ? deliveryFee * 0.7 : Number(order.total_amount || 0) * 0.15) + tipAmount
      ).toFixed(2);
      const commissionPercentage = 15;
      const commissionAmount = +(subtotalAmount * 0.15).toFixed(2);

      await client.query(
        `UPDATE drivers
         SET current_status = 'available',
             is_available = true,
             total_deliveries = COALESCE(total_deliveries, 0) + 1,
             total_earnings = COALESCE(total_earnings, 0) + $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [driverId, driverEarnings]
      );

      await client.query(
        `INSERT INTO earnings (order_id, driver_id, restaurant_id, amount, commission_percentage, commission_amount, net_amount)
         SELECT $1, $2, $3, $4, $5, $6, $7
         WHERE NOT EXISTS (SELECT 1 FROM earnings WHERE order_id = $1)`,
        [orderId, driverId, order.restaurant_id, driverEarnings, commissionPercentage, commissionAmount, driverEarnings]
      );

      await client.query(
        `INSERT INTO order_delivery_verification_attempts (
          order_id,
          driver_id,
          attempted_code,
          success,
          reason
        ) VALUES ($1, $2, $3, $4, $5)`,
        [orderId, driverId, providedCode, true, 'verified']
      );

      await client.query('COMMIT');

      updatedOrder.driver_earnings = driverEarnings;

      const customerRes = await db.query('SELECT user_id FROM customers WHERE id = $1', [order.customer_id]);
      const customerUserId = customerRes.rows[0]?.user_id;

      if (emitOrderUpdate) {
        emitOrderUpdate(updatedOrder.id, {
          type: 'delivery_code_verified',
          customerUserId,
          order: updatedOrder,
          new_status: 'delivered'
        });
      }

      if (emitManagerEvent && updatedOrder.restaurant_id) {
        emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
          orderId: updatedOrder.id,
          order_number: updatedOrder.order_number,
          status: 'delivered',
          order: updatedOrder
        });
      }

      if (customerUserId) {
        await this.createNotification(
          customerUserId,
          'customer',
          'Delivery Verified',
          'Your order was verified and marked delivered.',
          'delivery_verified',
          { order_id: orderId }
        );
      }

      return updatedOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      if (order) {
        await db.query(
          `INSERT INTO order_delivery_verification_attempts (
            order_id,
            driver_id,
            attempted_code,
            success,
            reason
          ) VALUES ($1, $2, $3, $4, $5)`,
          [orderId, driverId, String(code || '').trim().toUpperCase(), false, error.message]
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Manager accepts order (allows customer to pay; does NOT publish to drivers until payment is completed)
  static async acceptByManager(orderId, managerId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const authQuery = `
        SELECT o.* FROM orders o
        WHERE o.id = $1
          AND o.restaurant_id IN (
            SELECT id FROM restaurants 
            WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $2)
          )
      `;
      const authResult = await client.query(authQuery, [orderId, managerId]);

      if (authResult.rows.length === 0) {
        throw new Error('Order not found or invalid manager authorization');
      }

      const existingOrder = authResult.rows[0];
      if (existingOrder.status === 'cancelled') {
        throw new Error('Cannot accept a cancelled order');
      }
      if (existingOrder.status !== 'pending') {
        throw new Error(`Order is already ${existingOrder.status.replace(/_/g, ' ')}`);
      }

      const updateResult = await client.query(
        `UPDATE orders
         SET status = 'ordering_at_restaurant',
             restaurant_notified_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );
      const updatedOrder = updateResult.rows[0];

      // Keep driver queue inactive until customer completes payment
      await client.query(
        `UPDATE driver_order_queue
         SET is_active = false
         WHERE order_id = $1`,
        [orderId]
      );

      const userRes = await client.query(
        'SELECT user_id FROM customers WHERE id = $1',
        [updatedOrder.customer_id]
      );
      const customerUserId = userRes.rows[0]?.user_id;

      await client.query('COMMIT');

      if (emitOrderUpdate) {
        emitOrderUpdate(orderId, {
          type: 'order_accepted_by_manager',
          customerUserId,
          order: updatedOrder,
          new_status: 'ordering_at_restaurant'
        });
      }

      if (emitManagerEvent && updatedOrder.restaurant_id) {
        emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
          orderId: updatedOrder.id,
          order_number: updatedOrder.order_number,
          status: updatedOrder.status,
          order: updatedOrder
        });
      }

      if (customerUserId) {
        await this.createNotification(
          customerUserId,
          'customer',
          'Order Accepted by Restaurant',
          'The restaurant accepted your order! Please complete your payment so we can dispatch a driver.',
          'order_accepted_by_manager',
          { order_id: orderId, status: 'ordering_at_restaurant' }
        );
      }

      return updatedOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Manager rejects order (cancels order completely and makes it unavailable)
  static async rejectByManager(orderId, managerId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const authQuery = `
        SELECT o.* FROM orders o
        WHERE o.id = $1
          AND o.restaurant_id IN (
            SELECT id FROM restaurants 
            WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $2)
          )
      `;
      const authResult = await client.query(authQuery, [orderId, managerId]);

      if (authResult.rows.length === 0) {
        throw new Error('Order not found or invalid manager authorization');
      }

      const existingOrder = authResult.rows[0];
      if (existingOrder.status === 'delivered') {
        throw new Error('Cannot reject a delivered order');
      }

      const updateResult = await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );
      const updatedOrder = updateResult.rows[0];

      await client.query(
        `UPDATE driver_order_queue
         SET is_active = false,
             completed_at = CURRENT_TIMESTAMP
         WHERE order_id = $1`,
        [orderId]
      );

      const userRes = await client.query(
        'SELECT user_id FROM customers WHERE id = $1',
        [updatedOrder.customer_id]
      );
      const customerUserId = userRes.rows[0]?.user_id;

      await client.query('COMMIT');

      // If the order was already paid, automatically refund the customer
      if (existingOrder.payment_status === 'completed') {
        await Payment.refundByOrderId(orderId, 'Order rejected/cancelled by restaurant manager');
        updatedOrder.payment_status = 'refunded';
      }

      if (emitOrderUpdate) {
        emitOrderUpdate(orderId, {
          type: 'order_rejected_by_manager',
          customerUserId,
          order: updatedOrder,
          new_status: 'cancelled'
        });
      }

      if (emitManagerEvent && updatedOrder.restaurant_id) {
        emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
          orderId: updatedOrder.id,
          order_number: updatedOrder.order_number,
          status: 'cancelled',
          order: updatedOrder
        });
      }

      if (emitDriversEvent) {
        emitDriversEvent('order_unavailable', {
          orderId: updatedOrder.id,
          order_number: updatedOrder.order_number,
          reason: 'cancelled'
        });
      }

      if (customerUserId) {
        await this.createNotification(
          customerUserId,
          'customer',
          'Order Rejected',
          existingOrder.payment_status === 'completed'
            ? 'Sorry, the restaurant cancelled your order. A full refund has been initiated.'
            : 'Sorry, the restaurant rejected your order and it has been cancelled.',
          'order_cancelled',
          { order_id: orderId, status: 'cancelled' }
        );
      }

      return updatedOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Customer cancels order (allowed before driver pickup: pending, ordering_at_restaurant, order_ready, accepted_by_driver)
  static async cancelByCustomer(orderId, userId, reason = 'Cancelled by customer') {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(
        `SELECT o.*
         FROM orders o
         JOIN customers c ON o.customer_id = c.id
         WHERE o.id = $1 AND c.user_id = $2
         FOR UPDATE OF o`,
        [orderId, userId]
      );

      if (orderRes.rows.length === 0) {
        throw new Error('Order not found');
      }

      const existingOrder = orderRes.rows[0];
      if (existingOrder.status === 'cancelled') {
        throw new Error('Order is already cancelled');
      }
      if (!['pending', 'ordering_at_restaurant', 'order_ready', 'accepted_by_driver'].includes(existingOrder.status)) {
        throw new Error('Order cannot be cancelled once the driver has picked it up');
      }

      const updateRes = await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );
      const updatedOrder = updateRes.rows[0];

      await client.query(
        `UPDATE driver_order_queue
         SET is_active = false,
             completed_at = CURRENT_TIMESTAMP
         WHERE order_id = $1`,
        [orderId]
      );

      let assignedDriverUserId = null;
      if (existingOrder.driver_id) {
        const driverRes = await client.query(
          `SELECT user_id FROM drivers WHERE id = $1`,
          [existingOrder.driver_id]
        );
        assignedDriverUserId = driverRes.rows[0]?.user_id || null;

        await client.query(
          `UPDATE drivers SET current_status = 'available', is_available = true WHERE id = $1`,
          [existingOrder.driver_id]
        );
      }

      await client.query('COMMIT');

      if (existingOrder.payment_status === 'completed') {
        await Payment.refundByOrderId(orderId, reason);
        updatedOrder.payment_status = 'refunded';
      }

      if (emitOrderUpdate) {
        emitOrderUpdate(orderId, {
          type: 'order_cancelled_by_customer',
          customerUserId: userId,
          order: updatedOrder,
          new_status: 'cancelled',
        });
      }

      if (emitManagerEvent && existingOrder.restaurant_id) {
        emitManagerEvent(existingOrder.restaurant_id, 'order_updated', {
          orderId,
          order_id: orderId,
          order_number: existingOrder.order_number,
          status: 'cancelled',
          reason,
        });
      }

      if (emitDriversEvent) {
        emitDriversEvent('order_unavailable', {
          orderId,
          order_number: existingOrder.order_number,
          reason: 'cancelled',
        });
      }

      if (assignedDriverUserId) {
        if (emitUserEvent) {
          emitUserEvent(assignedDriverUserId, 'order_cancelled_by_customer', {
            order_id: orderId,
            order_number: existingOrder.order_number,
            status: 'cancelled',
            message: 'The customer cancelled this order before pickup.',
          });
        }
        await this.createNotification(
          assignedDriverUserId,
          'driver',
          'Order Cancelled',
          `Order #${existingOrder.order_number || orderId.slice(0, 8)} was cancelled by the customer before pickup.`,
          'order_cancelled',
          { order_id: orderId, status: 'cancelled' }
        ).catch(() => {});
      }

      return updatedOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Customer rates a delivered order (1-5 stars for restaurant and/or driver)
  static async rateOrder(orderId, userId, { restaurant_rating, driver_rating }) {
    const rRating = restaurant_rating ? Math.min(5, Math.max(1, parseInt(restaurant_rating, 10))) : null;
    const dRating = driver_rating ? Math.min(5, Math.max(1, parseInt(driver_rating, 10))) : null;

    if (!rRating && !dRating) {
      throw new Error('Please provide a valid rating between 1 and 5');
    }

    const orderRes = await db.query(
      `SELECT o.*
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1 AND c.user_id = $2`,
      [orderId, userId]
    );
    if (orderRes.rows.length === 0) {
      throw new Error('Order not found');
    }
    const order = orderRes.rows[0];
    if (order.status !== 'delivered') {
      throw new Error('Only delivered orders can be rated');
    }

    const updateRes = await db.query(
      `UPDATE orders
       SET restaurant_rating = COALESCE($2, restaurant_rating),
           driver_rating = COALESCE($3, driver_rating),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [orderId, rRating, dRating]
    );
    const updatedOrder = updateRes.rows[0];

    if (rRating && order.restaurant_id) {
      await db.query(
        `UPDATE restaurants r
         SET average_rating = COALESCE((SELECT ROUND(AVG(restaurant_rating)::numeric, 2) FROM orders WHERE restaurant_id = $1 AND restaurant_rating IS NOT NULL), 5.00),
             total_ratings = (SELECT COUNT(*) FROM orders WHERE restaurant_id = $1 AND restaurant_rating IS NOT NULL)
         WHERE r.id = $1`,
        [order.restaurant_id]
      ).catch(() => {});
    }

    if (dRating && order.driver_id) {
      await db.query(
        `UPDATE drivers d
         SET average_rating = COALESCE((SELECT ROUND(AVG(driver_rating)::numeric, 2) FROM orders WHERE driver_id = $1 AND driver_rating IS NOT NULL), 5.00)
         WHERE d.id = $1`,
        [order.driver_id]
      ).catch(() => {});
    }

    return updatedOrder;
  }

  // Complete customer payment and publish order to active drivers
  static async completePaymentAndPublishToDrivers(orderId, paymentMethod = null) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(
        `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      if (orderRes.rows.length === 0) {
        throw new Error('Order not found');
      }

      const existingOrder = orderRes.rows[0];
      if (existingOrder.status === 'cancelled') {
        throw new Error('This order was cancelled and cannot be paid for');
      }
      if (existingOrder.status === 'pending') {
        throw new Error('Order must be accepted by the restaurant manager before payment');
      }

      const updateOrderRes = await client.query(
        `UPDATE orders
         SET payment_status = 'completed',
             payment_method = COALESCE($2, payment_method),
             driver_acceptance_deadline = NOW() + INTERVAL '600 seconds',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId, paymentMethod]
      );
      const updatedOrder = updateOrderRes.rows[0];

      // Find available active drivers (include drivers near restaurant or all available drivers if coordinates are unset)
      const driversQuery = `
        SELECT d.id
        FROM drivers d
        CROSS JOIN restaurants r
        WHERE r.id = $1
          AND d.is_available = true
          AND d.current_status = 'available'
          AND (
            d.current_location IS NULL
            OR r.location IS NULL
            OR ST_DWithin(
              ST_SetSRID(ST_MakePoint(d.current_location[0], d.current_location[1]), 4326)::geography,
              r.location::geography,
              50000
            )
          )
      `;
      const driversResult = await client.query(driversQuery, [updatedOrder.restaurant_id]);
      const driverIds = driversResult.rows.map(row => row.id);

      const queueUpdateRes = await client.query(
        `UPDATE driver_order_queue
         SET available_driver_ids = $1,
             is_active = true,
             expires_at = NOW() + INTERVAL '600 seconds',
             completed_at = NULL
         WHERE order_id = $2
         RETURNING *`,
        [driverIds.length > 0 ? driverIds : [], orderId]
      );

      if (queueUpdateRes.rows.length === 0) {
        await client.query(
          `INSERT INTO driver_order_queue (order_id, available_driver_ids, is_active, expires_at)
           VALUES ($1, $2, true, NOW() + INTERVAL '600 seconds')`,
          [orderId, driverIds.length > 0 ? driverIds : []]
        );
      }

      const userRes = await client.query(
        'SELECT user_id FROM customers WHERE id = $1',
        [updatedOrder.customer_id]
      );
      const customerUserId = userRes.rows[0]?.user_id;

      await client.query('COMMIT');

      if (emitOrderUpdate) {
        emitOrderUpdate(orderId, {
          type: 'payment_completed',
          customerUserId,
          order: updatedOrder,
          payment_status: 'completed',
          available_drivers: driverIds.length
        });
      }

      if (customerUserId) {
        await this.createNotification(
          customerUserId,
          'customer',
          'Payment Confirmed',
          'Your payment was successful! Your order is now visible to active drivers.',
          'payment_completed',
          { order_id: orderId, available_drivers: driverIds.length }
        );
      }

      return updatedOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Manager publishes/accepts order
  static async publishOrder(orderId, managerId) {
    return this.acceptByManager(orderId, managerId);
  }

  // Driver accepts order
  static async acceptOrder(orderId, driverId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Lock and validate driver status to prevent accepting multiple simultaneous orders
      const driverCheck = await client.query(
        `SELECT d.id, d.approval_status, d.current_status, u.is_active
         FROM drivers d
         JOIN users u ON d.user_id = u.id
         WHERE d.id = $1
         FOR UPDATE OF d`,
        [driverId]
      );

      if (driverCheck.rows.length === 0) {
        throw new Error('Driver profile not found');
      }
      const driverRow = driverCheck.rows[0];
      const isApproved = !driverRow.approval_status || driverRow.approval_status === 'approved';
      if (!isApproved || !driverRow.is_active) {
        throw new Error('Driver account is not active or approved');
      }
      
      // Lock both order and queue rows atomically so two concurrent drivers cannot accept the same order
      const checkQuery = `
        SELECT o.*, q.expires_at
        FROM orders o
        JOIN driver_order_queue q ON o.id = q.order_id
        WHERE o.id = $1 
          AND o.status IN ('ordering_at_restaurant', 'order_ready')
          AND o.payment_status = 'completed'
          AND o.driver_id IS NULL
          AND q.is_active = true
          AND q.expires_at > NOW()
        FOR UPDATE OF o, q
      `;
      
      const checkResult = await client.query(checkQuery, [orderId]);
      
      if (checkResult.rows.length === 0) {
        throw new Error('Order no longer available');
      }
      
      const updateQuery = `
        UPDATE orders 
        SET 
          driver_id = $2,
          status = 'accepted_by_driver',
          accepted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND driver_id IS NULL
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [orderId, driverId]);
      const order = updateResult.rows[0];
      if (!order) {
        throw new Error('Order was already accepted by another driver');
      }
      
      await client.query(
        `UPDATE drivers SET current_status = 'busy', is_available = false WHERE id = $1`,
        [driverId]
      );
      
      await client.query(
        `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
        [orderId]
      );

      // Get the actual User ID linked to this Customer ID
      const userRes = await client.query(
        'SELECT user_id FROM customers WHERE id = $1', 
        [order.customer_id]
      );
      const customerUserId = userRes.rows[0]?.user_id;
      
      await client.query('COMMIT');
      
      if (emitOrderUpdate) {
        emitOrderUpdate(order.id, {
          type: 'order_accepted',
          customerUserId,
          order,
          driver_id: driverId
        });
      }

      if (emitManagerEvent && order.restaurant_id) {
        emitManagerEvent(order.restaurant_id, 'driver_assigned', {
          order_id: order.id,
          order_number: order.order_number,
          driver_id: driverId,
          status: order.status
        });
        emitManagerEvent(order.restaurant_id, 'order_updated', {
          orderId: order.id,
          order_number: order.order_number,
          driver_id: driverId,
          status: order.status,
          order
        });
      }

      if (emitDriversEvent) {
        emitDriversEvent('order_unavailable', {
          orderId: order.id,
          order_number: order.order_number,
          reason: 'accepted',
          acceptedByDriverId: driverId
        });
      }
      
      if (customerUserId) {
        await this.createNotification(
          customerUserId,
          'customer',
          'Driver Accepted',
          'A driver has accepted your order!',
          'order_accepted',
          { order_id: orderId, driver_id: driverId }
        );
      }
      
      return order;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Driver declines order
  static async declineOrder(orderId, driverId) {
    const query = `
      UPDATE driver_order_queue 
      SET declined_by_driver_ids = CASE
        WHEN $2 = ANY(COALESCE(declined_by_driver_ids, '{}'::uuid[]))
          THEN COALESCE(declined_by_driver_ids, '{}'::uuid[])
        ELSE COALESCE(declined_by_driver_ids, '{}'::uuid[]) || $2
      END
      WHERE order_id = $1
      RETURNING *
    `;
    
    const result = await db.query(query, [orderId, driverId]);
    const queueRow = result.rows[0];

    if (queueRow && queueRow.is_active) {
      try {
        const remainingRes = await db.query(
          `SELECT COUNT(*)::int AS available_count
           FROM drivers d
           JOIN users u ON d.user_id = u.id
           WHERE (d.approval_status = 'approved' OR d.approval_status IS NULL)
             AND u.is_active = true
             AND d.is_available = true
             AND NOT (d.id = ANY(COALESCE($1::uuid[], '{}'::uuid[])))`,
          [queueRow.declined_by_driver_ids || []]
        );
        const remainingDrivers = remainingRes.rows[0]?.available_count ?? 1;
        if (remainingDrivers === 0) {
          const orderRes = await db.query('SELECT id, order_number, restaurant_id FROM orders WHERE id = $1', [orderId]);
          const order = orderRes.rows[0];
          if (order && emitManagerEvent) {
            emitManagerEvent(order.restaurant_id, 'all_drivers_declined', {
              order_id: order.id,
              order_number: order.order_number,
              message: 'All currently online drivers have declined this order.'
            });
          }
        }
      } catch (notifyErr) {
        console.warn('Failed checking remaining drivers after decline:', notifyErr.message);
      }
    }

    return queueRow;
  }

  // Update order status
  static async updateStatus(orderId, status, driverId = null, locationCoords = null) {
    const validStatuses = [
      'pending',
      'accepted_by_driver',
      'ordering_at_restaurant',
      'order_ready',
      'picked_up',
      'on_the_way',
      'arrived',
      'delivered',
      'cancelled',
      'no_drivers_available'
    ];
    
    if (!validStatuses.includes(status)) {
      throw new Error('Invalid status');
    }
    
    const timestampColumns = {
      'ordering_at_restaurant': 'restaurant_notified_at',
      'order_ready': 'ready_for_pickup_at',
      'picked_up': 'picked_up_at',
      'on_the_way': null,
      'arrived': null,
      'delivered': 'delivered_at',
      'cancelled': 'cancelled_at',
      'no_drivers_available': 'cancelled_at'
    };
    
    let query = `
      UPDATE orders 
      SET 
        status = $2,
        updated_at = CURRENT_TIMESTAMP
    `;
    
    const params = [orderId, status];
    
    if (timestampColumns[status]) {
      query += `, ${timestampColumns[status]} = CURRENT_TIMESTAMP`;
    }
    
    query += ` WHERE id = $1`;
    
    if (driverId) {
      query += ` AND driver_id = $3`;
      params.push(driverId);
    }
    
    query += ` RETURNING *`;
    
    const result = await db.query(query, params);
    const order = result.rows[0];
    
    if (order) {
      if (status === 'cancelled' || status === 'no_drivers_available') {
        await db.query(
          `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
          [order.id]
        );
      }

      if (['picked_up', 'on_the_way', 'arrived'].includes(status)) {
        await this.ensureVerificationCode(order.id);
      }

      // Ensure driver location is recorded & broadcast when order is picked_up / on_the_way / arrived
      const activeDriverId = driverId || order.driver_id;
      let driverCoords = null;

      if (activeDriverId && ['accepted_by_driver', 'order_ready', 'picked_up', 'on_the_way', 'arrived'].includes(status)) {
        if (locationCoords && Number.isFinite(Number(locationCoords.lat)) && Number.isFinite(Number(locationCoords.lng))) {
          const lat = Number(locationCoords.lat);
          const lng = Number(locationCoords.lng);
          await db.query(
            `UPDATE drivers SET current_location = POINT($2, $3), last_location_update = NOW() WHERE id = $1`,
            [activeDriverId, lng, lat]
          ).catch(() => {});
          await db.query(
            `INSERT INTO delivery_tracking (order_id, driver_id, location) VALUES ($1, $2, POINT($3, $4))`,
            [order.id, activeDriverId, lng, lat]
          ).catch(() => {});
          driverCoords = { latitude: lat, longitude: lng, x: lng, y: lat };
        } else {
          // Check driver's current location in DB; only fallback to restaurant_location when status === 'picked_up'
          const locRes = await db.query(
            `SELECT
               d.current_location,
               CASE WHEN r.location IS NOT NULL THEN ST_X(r.location::geometry) ELSE NULL END as restaurant_lng,
               CASE WHEN r.location IS NOT NULL THEN ST_Y(r.location::geometry) ELSE NULL END as restaurant_lat
             FROM orders o
             LEFT JOIN drivers d ON o.driver_id = d.id
             LEFT JOIN restaurants r ON o.restaurant_id = r.id
             WHERE o.id = $1`,
            [order.id]
          ).catch(() => ({ rows: [] }));
          const row = locRes.rows[0];
          driverCoords = normalizePointCoords(row?.current_location);

          if (!driverCoords && status === 'picked_up' && Number.isFinite(Number(row?.restaurant_lng)) && Number.isFinite(Number(row?.restaurant_lat))) {
            const rLng = Number(row.restaurant_lng);
            const rLat = Number(row.restaurant_lat);
            driverCoords = normalizePointCoords({ x: rLng, y: rLat });
            if (driverCoords) {
              await db.query(
                `UPDATE drivers SET current_location = POINT($2, $3), last_location_update = NOW() WHERE id = $1 AND current_location IS NULL`,
                [activeDriverId, driverCoords.longitude, driverCoords.latitude]
              ).catch(() => {});
            }
          }
        }
      }

      // Get User ID for notification & socket sync
      const userRes = await db.query(
        'SELECT user_id FROM customers WHERE id = $1',
        [order.customer_id]
      );
      const customerUserId = userRes.rows[0]?.user_id;

      if (emitOrderUpdate) {
        emitOrderUpdate(order.id, {
          type: 'status_update',
          customerUserId,
          order: {
            ...order,
            ...(driverCoords ? { driver_location: driverCoords } : {})
          },
          status,
          new_status: status,
          driver_location: driverCoords
        });
      }

      if (emitManagerEvent && order.restaurant_id) {
        emitManagerEvent(order.restaurant_id, 'order_updated', {
          orderId: order.id,
          order_number: order.order_number,
          status,
          order
        });
      }

      if (emitDriversEvent && (status === 'cancelled' || status === 'no_drivers_available')) {
        emitDriversEvent('order_unavailable', {
          orderId: order.id,
          order_number: order.order_number,
          reason: status
        });
      }

      if (emitDriverLocation && driverCoords) {
        emitDriverLocation(order.id, {
          driverId: activeDriverId,
          orderId: order.id,
          location: [driverCoords.longitude, driverCoords.latitude],
          latitude: driverCoords.latitude,
          longitude: driverCoords.longitude,
          timestamp: new Date().toISOString()
        });
      }
      
      if (status === 'delivered' && activeDriverId) {
        const deliveryFee = parseFloat(order.delivery_fee) || 0;
        const tipAmount = parseFloat(order.tip_amount) || 0;
        const driverCommission = Math.round(deliveryFee * 0.30 * 100) / 100;
        const driverNet = Math.round((deliveryFee * 0.70 + tipAmount) * 100) / 100;

        await db.query(
          `UPDATE drivers
           SET current_status = 'available',
               is_available = true,
               total_deliveries = COALESCE(total_deliveries, 0) + 1,
               total_earnings = COALESCE(total_earnings, 0) + $2
           WHERE id = $1`,
          [activeDriverId, driverNet]
        );
        
        const existingEarning = await db.query(
          'SELECT id FROM earnings WHERE order_id = $1 AND driver_id = $2 LIMIT 1',
          [order.id, activeDriverId]
        );
        if (existingEarning.rows.length === 0) {
          await this.createEarning(
            order.id,
            activeDriverId,
            null,
            deliveryFee + tipAmount,
            30,
            driverCommission,
            driverNet
          );
        }
      }

      if (customerUserId) {
        const statusTitle = status === 'picked_up'
          ? 'Order Picked Up — Track Live!'
          : 'Order Update';
        const statusBody = status === 'picked_up'
          ? 'Your driver has picked up your order! Open live tracking to watch your driver on the map.'
          : `Your order status has changed to: ${status.replace(/_/g, ' ')}`;
        await this.createNotification(
          customerUserId,
          'customer',
          statusTitle,
          statusBody,
          'status_update',
          { order_id: orderId, status }
        );
      }
    }
    
    return order;
  }

  // Get orders for user based on role
  static async getOrdersByUser(userId, userRole, filters = {}) {
    let baseQuery = '';
    const params = [];
    
    switch (userRole) {
      case 'customer':
        baseQuery = `
          SELECT o.*, r.logo_url as restaurant_logo, r.name as restaurant_name
          FROM orders o
          JOIN restaurants r ON o.restaurant_id = r.id
          WHERE o.customer_id = (SELECT id FROM customers WHERE user_id = $1)
        `;
        params.push(userId);
        break;
      case 'driver':
        baseQuery = `
          SELECT o.*, r.name as restaurant_name, c.first_name as customer_first_name, e.net_amount as driver_earnings
          FROM orders o
          JOIN restaurants r ON o.restaurant_id = r.id
          JOIN customers cust ON o.customer_id = cust.id
          JOIN users c ON cust.user_id = c.id
          LEFT JOIN earnings e ON e.order_id = o.id
          WHERE o.driver_id = (SELECT id FROM drivers WHERE user_id = $1)
        `;
        params.push(userId);
        break;
      case 'restaurant_manager':
        baseQuery = `
          SELECT o.*, c.first_name as customer_first_name
          FROM orders o
          JOIN customers cust ON o.customer_id = cust.id
          JOIN users c ON cust.user_id = c.id
          WHERE o.restaurant_id IN (
            SELECT id FROM restaurants 
            WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $1)
          )
        `;
        params.push(userId);
        break;
      default:
        throw new Error('Invalid user role');
    }
    const { status, start_date, end_date, page = 1, limit = 20 } = filters;
    let paramIndex = params.length + 1;
    if (status) { baseQuery += ` AND o.status = $${paramIndex}`; params.push(status); paramIndex++; }
    if (start_date) { baseQuery += ` AND o.created_at >= $${paramIndex}`; params.push(start_date); paramIndex++; }
    if (end_date) { baseQuery += ` AND o.created_at <= $${paramIndex}`; params.push(end_date); paramIndex++; }
    const offset = (page - 1) * limit;
    baseQuery += ` ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    const result = await db.query(baseQuery, params);
    return result.rows;
  }

  static async createNotification(userId, userType, title, body, type, data = {}) {
    const query = `
      INSERT INTO notifications (user_id, user_type, title, body, type, data)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const result = await db.query(query, [userId, userType, title, body, type, JSON.stringify(data)]);
    return result.rows[0];
  }

  static async createEarning(orderId, driverId, restaurantId, amount, commissionPercentage, commissionAmount, netAmount) {
    const query = `
      INSERT INTO earnings (order_id, driver_id, restaurant_id, amount, commission_percentage, commission_amount, net_amount) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `;
    const result = await db.query(query, [orderId, driverId, restaurantId, amount, commissionPercentage, commissionAmount, netAmount]);
    return result.rows[0];
  }

  // Check for expired orders (cron job)
  static async processExpiredOrders() {
    const query = `
      UPDATE orders o
      SET status = 'no_drivers_available',
          cancelled_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      FROM driver_order_queue q
      WHERE o.id = q.order_id
        AND q.is_active = true
        AND q.expires_at <= NOW()
        AND o.status IN ('pending', 'ordering_at_restaurant', 'order_ready')
        AND o.driver_id IS NULL
      RETURNING o.*
    `;
    const result = await db.query(query);
    if (result.rows.length > 0) {
      const expiredOrderIds = result.rows.map(row => row.id);
      await db.query(
        `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = ANY($1)`,
        [expiredOrderIds]
      );
      const Payment = require('./Payment');
      for (const order of result.rows) {
        if (order.payment_status === 'completed') {
          try {
            await Payment.refundByOrderId(order.id, 'No drivers available within timeout');
            order.payment_status = 'refunded';
          } catch (refundErr) {
            console.error(`Auto-refund failed for expired order ${order.id}:`, refundErr.message);
          }
        }
        const userRes = await db.query('SELECT user_id FROM customers WHERE id = $1', [order.customer_id]);
        const customerUserId = userRes.rows[0]?.user_id || null;

        if (emitOrderUpdate) {
          emitOrderUpdate(order.id, {
            type: 'status_update',
            customerUserId,
            order,
            status: 'no_drivers_available',
            new_status: 'no_drivers_available'
          });
        }
        if (emitManagerEvent && order.restaurant_id) {
          emitManagerEvent(order.restaurant_id, 'order_expired', {
            order_id: order.id,
            order_number: order.order_number,
            status: 'no_drivers_available'
          });
          emitManagerEvent(order.restaurant_id, 'order_updated', {
            orderId: order.id,
            order_number: order.order_number,
            status: 'no_drivers_available',
            order
          });
        }
        if (emitDriversEvent) {
          emitDriversEvent('order_unavailable', {
            orderId: order.id,
            order_number: order.order_number,
            reason: 'expired'
          });
        }
        if (customerUserId) {
          await this.createNotification(
            customerUserId,
            'customer',
            'No Drivers Available',
            order.payment_status === 'refunded'
              ? 'Sorry, no drivers were available for your order. Your payment has been refunded.'
              : 'Sorry, no drivers were available for your order.',
            'order_expired',
            { order_id: order.id }
          );
        }
      }
    }

    // Also cancel abandoned unpaid orders older than 30 minutes
    const staleRes = await db.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancelled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('pending', 'ordering_at_restaurant')
         AND payment_status = 'pending'
         AND driver_id IS NULL
         AND created_at <= NOW() - INTERVAL '30 minutes'
       RETURNING id, order_number, restaurant_id, status`
    ).catch(err => {
      console.warn('Stale unpaid order cleanup warning:', err.message);
      return { rows: [] };
    });

    if (staleRes.rows?.length) {
      for (const stale of staleRes.rows) {
        if (emitOrderUpdate) {
          emitOrderUpdate(stale.id, {
            type: 'status_update',
            order: stale,
            status: 'cancelled',
            new_status: 'cancelled'
          });
        }
        if (emitManagerEvent && stale.restaurant_id) {
          emitManagerEvent(stale.restaurant_id, 'order_updated', {
            orderId: stale.id,
            order_number: stale.order_number,
            status: 'cancelled',
            order: stale
          });
        }
      }
    }

    return result.rows;
  }
}

module.exports = Order;