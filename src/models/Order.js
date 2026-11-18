const db = require('../config/database');
const crypto = require('crypto');
const Payment = require('./Payment');
const {
  emitOrderUpdate,
  emitUserEvent,
  emitDriverLocation,
  emitManagerEvent,
  emitDriversEvent,
  invalidateDriverCache
} = require('../socket');
const { sanitizeOrderForDriver } = require('../utils/driverOrderSanitizer');
const { evaluateRestaurantAvailability } = require('../utils/restaurantHours');
const { resolveAddressCoordinates, evaluateDeliveryForOrder } = require('../utils/deliveryPricing');

let interventionSchemaPromise = null;

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

    // Resolve customer drop-off coordinates before opening a DB transaction
    const resolvedCoords = await resolveAddressCoordinates(delivery_address);
    const enrichedDeliveryAddress =
      delivery_address && typeof delivery_address === 'object'
        ? {
            ...delivery_address,
            ...(resolvedCoords
              ? { latitude: resolvedCoords.latitude, longitude: resolvedCoords.longitude }
              : {}),
          }
        : delivery_address;
    
    // Start transaction
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Validate restaurant is active, approved, open right now (manual toggle + opening_hours), and within delivery radius
      const restRes = await client.query(
        `SELECT id, name, is_active, is_accepting_orders, opening_hours, delivery_radius_km, approval_status,
                ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM restaurants WHERE id = $1`,
        [restaurant_id]
      );
      if (restRes.rows.length === 0) {
        throw new Error('Restaurant not found');
      }
      const restaurant = restRes.rows[0];
      if (restaurant.approval_status && restaurant.approval_status !== 'approved') {
        throw new Error('This restaurant is not currently approved for orders');
      }

      const availability = evaluateRestaurantAvailability(restaurant);
      if (!availability.is_open_now) {
        throw new Error(availability.status_message || 'This restaurant is currently closed');
      }

      const deliveryEval = evaluateDeliveryForOrder({
        restaurantLat: restaurant.lat,
        restaurantLng: restaurant.lng,
        deliveryRadiusKm: restaurant.delivery_radius_km,
        customerLat: resolvedCoords?.latitude,
        customerLng: resolvedCoords?.longitude,
        restaurantName: restaurant.name,
      });
      if (!deliveryEval.deliverable) {
        throw new Error(deliveryEval.error);
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
      const verifiedDeliveryFee = deliveryEval.delivery_fee;
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
        JSON.stringify(enrichedDeliveryAddress),
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
    await this.ensureInterventionSchema();

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
        (SELECT e.net_amount FROM earnings e WHERE e.order_id = o.id LIMIT 1) as driver_earnings,
        COALESCE(
          (SELECT json_agg(row_to_json(inc) ORDER BY inc.created_at DESC)
           FROM (
             SELECT
               oi.id,
               oi.incident_type,
               oi.summary,
               oi.metadata,
               oi.created_at,
               oi.previous_driver_id,
               oi.new_driver_id,
               CONCAT_WS(' ', au.first_name, au.last_name) AS actor_name
             FROM order_incidents oi
             LEFT JOIN users au ON oi.actor_user_id = au.id
             WHERE oi.order_id = o.id
             ORDER BY oi.created_at DESC
             LIMIT 25
           ) inc),
          '[]'::json
        ) as incidents
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
        query += ` AND (
          o.restaurant_id IN (SELECT id FROM restaurants WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $2) OR owner_user_id = $2)
          OR EXISTS (SELECT 1 FROM restaurant_managers rm WHERE rm.user_id = $2 AND COALESCE(rm.account_type, 'platform_admin') = 'platform_admin')
        )`;
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

    try {
      const support = await this.getSupportContact();
      row.support_phone = support.support_phone;
      row.support_name = support.support_name;
    } catch {
      row.support_phone = process.env.SUPPORT_PHONE || null;
      row.support_name = 'Happy Deliveries Dispatch';
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

      const driverEarnings = await this.creditDriverDeliveryEarnings(client, order, driverId);

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
          AND (
            o.restaurant_id IN (
              SELECT id FROM restaurants 
              WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $2)
                 OR owner_user_id = $2
            )
            OR EXISTS (
              SELECT 1 FROM restaurant_managers rm
              WHERE rm.user_id = $2
                AND COALESCE(rm.account_type, 'platform_admin') = 'platform_admin'
            )
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
          AND (
            o.restaurant_id IN (
              SELECT id FROM restaurants 
              WHERE manager_id = (SELECT id FROM restaurant_managers WHERE user_id = $2)
                 OR owner_user_id = $2
            )
            OR EXISTS (
              SELECT 1 FROM restaurant_managers rm
              WHERE rm.user_id = $2
                AND COALESCE(rm.account_type, 'platform_admin') = 'platform_admin'
            )
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

      if (emitManagerEvent && updatedOrder.restaurant_id) {
        emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
          orderId: updatedOrder.id,
          order_number: updatedOrder.order_number,
          status: updatedOrder.status,
          payment_status: 'completed',
          order: updatedOrder
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
    await this.ensureInterventionSchema();

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
      'no_drivers_available',
      'delivery_failed'
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
      'no_drivers_available': 'cancelled_at',
      'delivery_failed': 'cancelled_at'
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
      if (['cancelled', 'no_drivers_available', 'delivery_failed'].includes(status)) {
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

      if (emitDriversEvent && ['cancelled', 'no_drivers_available', 'delivery_failed'].includes(status)) {
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
      
      if (status === 'delivered' && activeDriverId && !order.rescue_payout_mode) {
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
    await this.ensureInterventionSchema();
    let baseQuery = '';
    const params = [];
    
    switch (userRole) {
      case 'customer':
        baseQuery = `
          SELECT o.*,
                 r.logo_url as restaurant_logo,
                 r.cover_image_url as restaurant_cover,
                 r.name as restaurant_name,
                 r.address as restaurant_address,
                 r.phone_number as restaurant_phone,
                 du.first_name as driver_first_name,
                 du.last_name as driver_last_name,
                 du.phone_number as driver_phone,
                 du.profile_image_url as driver_image,
                 drv.vehicle_type as driver_vehicle_type,
                 COALESCE(
                   (SELECT SUM(oi.quantity)::int FROM order_items oi WHERE oi.order_id = o.id),
                   0
                 ) as items_count,
                 COALESCE(
                   (
                     SELECT STRING_AGG(
                       CASE WHEN oi.quantity > 1 THEN oi.quantity || 'x ' || mi.name ELSE mi.name END,
                       ', ' ORDER BY oi.created_at
                     )
                     FROM order_items oi
                     JOIN menu_items mi ON oi.menu_item_id = mi.id
                     WHERE oi.order_id = o.id
                   ),
                   ''
                 ) as items_summary,
                 (
                   SELECT mi.image_url
                   FROM order_items oi
                   JOIN menu_items mi ON oi.menu_item_id = mi.id
                   WHERE oi.order_id = o.id
                     AND mi.image_url IS NOT NULL
                     AND mi.image_url <> ''
                   ORDER BY oi.created_at
                   LIMIT 1
                 ) as first_item_image
          FROM orders o
          JOIN restaurants r ON o.restaurant_id = r.id
          LEFT JOIN drivers drv ON o.driver_id = drv.id
          LEFT JOIN users du ON drv.user_id = du.id
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

  // Ensure schema support for order intervention, rescue couriers, delivery failure/forfeit & support contact
  static async ensureInterventionSchema() {
    if (interventionSchemaPromise) return interventionSchemaPromise;
    interventionSchemaPromise = (async () => {
      try {
        await db.query(`ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'delivery_failed'`);
      } catch (err) {
        if (!String(err.message || '').includes('already exists')) {
          console.warn('Order enum delivery_failed note:', err.message);
        }
      }

      await db.query(`
        ALTER TABLE orders
          ADD COLUMN IF NOT EXISTS original_driver_id UUID REFERENCES drivers(id),
          ADD COLUMN IF NOT EXISTS reassigned_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS rescue_courier JSONB,
          ADD COLUMN IF NOT EXISTS rescue_payout_mode VARCHAR(30),
          ADD COLUMN IF NOT EXISTS failure_reason TEXT,
          ADD COLUMN IF NOT EXISTS forfeited BOOLEAN DEFAULT false,
          ADD COLUMN IF NOT EXISTS intervention_notes TEXT,
          ADD COLUMN IF NOT EXISTS intervention_updated_at TIMESTAMPTZ
      `);

      await db.query(`
        ALTER TABLE order_delivery_verification_attempts
          ALTER COLUMN driver_id DROP NOT NULL
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS order_incidents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          incident_type VARCHAR(50) NOT NULL,
          actor_user_id UUID REFERENCES users(id),
          actor_role VARCHAR(30),
          previous_driver_id UUID REFERENCES drivers(id),
          new_driver_id UUID REFERENCES drivers(id),
          summary TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_order_incidents_order_id ON order_incidents(order_id)
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS platform_settings (
          key VARCHAR(100) PRIMARY KEY,
          value JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
    })().catch((err) => {
      interventionSchemaPromise = null;
      throw err;
    });

    return interventionSchemaPromise;
  }

  // Shared helper to credit driver delivery earnings once and mark driver available
  static async creditDriverDeliveryEarnings(client, order, driverId) {
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
      [order.id, driverId, order.restaurant_id, driverEarnings, commissionPercentage, commissionAmount, driverEarnings]
    );

    return driverEarnings;
  }

  static async recordIncident(clientOrDb, {
    orderId,
    incidentType,
    actorUserId = null,
    actorRole = null,
    previousDriverId = null,
    newDriverId = null,
    summary = '',
    metadata = {},
  }) {
    await clientOrDb.query(
      `INSERT INTO order_incidents
         (order_id, incident_type, actor_user_id, actor_role, previous_driver_id, new_driver_id, summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        orderId,
        incidentType,
        actorUserId,
        actorRole,
        previousDriverId,
        newDriverId,
        summary || null,
        JSON.stringify(metadata || {}),
      ]
    );
  }

  // Get configured Happy dispatch support phone (settings -> env fallback -> platform_admin phone)
  static async getSupportContact() {
    await this.ensureInterventionSchema();

    const settingRes = await db.query(
      `SELECT value FROM platform_settings WHERE key = 'dispatch_support' LIMIT 1`
    );
    const cfg = settingRes.rows[0]?.value || {};
    let supportPhone = String(cfg.support_phone || '').trim();
    let supportName = String(cfg.support_name || '').trim() || 'Happy Deliveries Dispatch';

    if (!supportPhone && (process.env.SUPPORT_PHONE || process.env.HAPPY_SUPPORT_PHONE)) {
      supportPhone = String(process.env.SUPPORT_PHONE || process.env.HAPPY_SUPPORT_PHONE).trim();
    }

    if (!supportPhone) {
      const adminRes = await db.query(
        `SELECT u.phone_number, u.first_name, u.last_name
         FROM users u
         JOIN restaurant_managers rm ON rm.user_id = u.id
         WHERE COALESCE(rm.account_type, 'platform_admin') = 'platform_admin'
           AND NULLIF(TRIM(u.phone_number), '') IS NOT NULL
         ORDER BY rm.created_at ASC
         LIMIT 1`
      );
      if (adminRes.rows[0]?.phone_number) {
        supportPhone = String(adminRes.rows[0].phone_number).trim();
      }
    }

    return {
      support_phone: supportPhone || null,
      support_name: supportName,
      configured: Boolean(supportPhone),
    };
  }

  static async updateSupportContact(adminUserId, { support_phone, support_name }) {
    await this.ensureInterventionSchema();
    const cleanPhone = String(support_phone || '').trim();
    const cleanName = String(support_name || 'Happy Deliveries Dispatch').trim() || 'Happy Deliveries Dispatch';

    const payload = {
      support_phone: cleanPhone,
      support_name: cleanName,
      updated_by: adminUserId || null,
      updated_at: new Date().toISOString(),
    };

    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('dispatch_support', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(payload)]
    );

    if (adminUserId && cleanPhone) {
      await db.query(
        `UPDATE users SET phone_number = COALESCE(NULLIF(TRIM(phone_number), ''), $2), updated_at = NOW() WHERE id = $1`,
        [adminUserId, cleanPhone]
      ).catch(() => {});
    }

    return this.getSupportContact();
  }

  // List approved active drivers sorted by availability for Happy's reassignment selector
  static async getReassignDriverCandidates() {
    await this.ensureInterventionSchema();
    const res = await db.query(
      `SELECT d.id, d.user_id, d.is_available, d.current_status, d.approval_status,
              d.vehicle_type, d.vehicle_model, d.vehicle_color, d.vehicle_registration,
              d.last_location_update, d.rating, d.total_deliveries,
              u.first_name, u.last_name, u.phone_number, u.is_active,
              (SELECT COUNT(*)::int FROM orders o
               WHERE o.driver_id = d.id
                 AND o.status IN ('accepted_by_driver', 'order_ready', 'picked_up', 'on_the_way', 'arrived')) AS active_orders_count
       FROM drivers d
       JOIN users u ON d.user_id = u.id
       WHERE COALESCE(d.approval_status, 'approved') = 'approved'
         AND u.is_active = true
       ORDER BY (d.is_available = true AND d.current_status = 'available') DESC,
                active_orders_count ASC,
                d.last_location_update DESC NULLS LAST,
                u.first_name ASC`
    );
    return res.rows;
  }

  // Happy Admin: Reassign order to queue or specific driver STRICTLY BEFORE pickup
  static async reassignBeforePickup(
    orderId,
    adminUserId,
    { mode = 'queue', newDriverId = null, reason = '', oldDriverAction = 'available' } = {}
  ) {
    await this.ensureInterventionSchema();
    const client = await db.pool.connect();

    let updatedOrder = null;
    let oldDriverId = null;
    let oldDriverUserId = null;
    let newDriverUserId = null;
    let cleanMode = mode === 'direct' ? 'direct' : 'queue';

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const order = orderRes.rows[0];
      if (order.picked_up_at || !['accepted_by_driver', 'order_ready'].includes(order.status)) {
        const err = new Error(
          'Order has already been collected or is not in a pre-pickup driver state. Reassigning to available drivers is only allowed before pickup — use Rescue Delivery or Cancel & Refund instead.'
        );
        err.statusCode = 400;
        throw err;
      }

      if (order.payment_status !== 'completed') {
        const err = new Error('Only paid orders can be reassigned to drivers.');
        err.statusCode = 400;
        throw err;
      }

      oldDriverId = order.driver_id || null;
      if (oldDriverId) {
        const oldDrRes = await client.query(`SELECT user_id FROM drivers WHERE id = $1`, [oldDriverId]);
        oldDriverUserId = oldDrRes.rows[0]?.user_id || null;

        const targetOldStatus = oldDriverAction === 'offline' ? 'offline' : 'available';
        const targetOldAvailable = oldDriverAction !== 'offline';
        await client.query(
          `UPDATE drivers SET current_status = $2, is_available = $3, updated_at = NOW() WHERE id = $1`,
          [oldDriverId, targetOldStatus, targetOldAvailable]
        );
      }

      const cleanReason = String(reason || '').trim() || 'Driver unable to collect order before pickup — reassigned by dispatch';
      const nextPrePickupStatus = order.ready_for_pickup_at ? 'order_ready' : 'accepted_by_driver';

      if (cleanMode === 'direct') {
        if (!newDriverId) {
          const err = new Error('Please choose a driver to direct-assign.');
          err.statusCode = 400;
          throw err;
        }
        if (oldDriverId && String(newDriverId) === String(oldDriverId)) {
          const err = new Error('Selected driver is already assigned to this order.');
          err.statusCode = 400;
          throw err;
        }

        const drCheck = await client.query(
          `SELECT d.id, d.user_id, d.approval_status, u.is_active, u.first_name, u.last_name,
                  (SELECT COUNT(*)::int FROM orders o
                   WHERE o.driver_id = d.id AND o.id <> $2
                     AND o.status IN ('accepted_by_driver','order_ready','picked_up','on_the_way','arrived')) AS active_count
           FROM drivers d
           JOIN users u ON d.user_id = u.id
           WHERE d.id = $1
           FOR UPDATE OF d`,
          [newDriverId, orderId]
        );
        if (drCheck.rows.length === 0) {
          const err = new Error('Target driver not found.');
          err.statusCode = 404;
          throw err;
        }
        const newDr = drCheck.rows[0];
        if (!newDr.is_active || (newDr.approval_status && newDr.approval_status !== 'approved')) {
          const err = new Error('Target driver account is not active and approved.');
          err.statusCode = 400;
          throw err;
        }
        if (Number(newDr.active_count || 0) > 0) {
          const err = new Error('Target driver is currently delivering another active order.');
          err.statusCode = 400;
          throw err;
        }

        newDriverUserId = newDr.user_id;

        const upRes = await client.query(
          `UPDATE orders
           SET driver_id = $2,
               original_driver_id = COALESCE(original_driver_id, $3),
               status = $4::order_status,
               accepted_at = CURRENT_TIMESTAMP,
               reassigned_at = CURRENT_TIMESTAMP,
               rescue_courier = NULL,
               rescue_payout_mode = NULL,
               intervention_notes = $5,
               intervention_updated_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [orderId, newDriverId, oldDriverId, nextPrePickupStatus, cleanReason]
        );
        updatedOrder = upRes.rows[0];

        await client.query(
          `UPDATE drivers SET current_status = 'busy', is_available = false, updated_at = NOW() WHERE id = $1`,
          [newDriverId]
        );

        await client.query(
          `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
          [orderId]
        );

        await this.recordIncident(client, {
          orderId,
          incidentType: 'driver_reassigned_direct',
          actorUserId: adminUserId,
          actorRole: 'platform_admin',
          previousDriverId: oldDriverId,
          newDriverId,
          summary: `Reassigned before pickup to ${newDr.first_name} ${newDr.last_name}: ${cleanReason}`,
          metadata: { reason: cleanReason, old_driver_action: oldDriverAction },
        });
      } else {
        const reopenStatus = order.ready_for_pickup_at ? 'order_ready' : 'ordering_at_restaurant';
        const upRes = await client.query(
          `UPDATE orders
           SET driver_id = NULL,
               accepted_at = NULL,
               original_driver_id = COALESCE(original_driver_id, $2),
               status = $3::order_status,
               reassigned_at = CURRENT_TIMESTAMP,
               driver_acceptance_deadline = NOW() + INTERVAL '900 seconds',
               rescue_courier = NULL,
               rescue_payout_mode = NULL,
               intervention_notes = $4,
               intervention_updated_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [orderId, oldDriverId, reopenStatus, cleanReason]
        );
        updatedOrder = upRes.rows[0];

        const availRes = await client.query(
          `SELECT d.id
           FROM drivers d
           JOIN users u ON d.user_id = u.id
           WHERE COALESCE(d.approval_status, 'approved') = 'approved'
             AND u.is_active = true
             AND d.is_available = true
             AND d.current_status = 'available'
             AND ($1::uuid IS NULL OR d.id <> $1::uuid)`,
          [oldDriverId]
        );
        const availIds = availRes.rows.map((r) => r.id);
        const declinedIds = oldDriverId ? [oldDriverId] : [];

        const qUp = await client.query(
          `UPDATE driver_order_queue
           SET available_driver_ids = $2,
               seen_by_driver_ids = '{}'::uuid[],
               declined_by_driver_ids = $3,
               is_active = true,
               expires_at = NOW() + INTERVAL '900 seconds',
               completed_at = NULL
           WHERE order_id = $1
           RETURNING *`,
          [orderId, availIds, declinedIds]
        );
        if (qUp.rows.length === 0) {
          await client.query(
            `INSERT INTO driver_order_queue (order_id, available_driver_ids, seen_by_driver_ids, declined_by_driver_ids, is_active, expires_at)
             VALUES ($1, $2, '{}'::uuid[], $3, true, NOW() + INTERVAL '900 seconds')`,
            [orderId, availIds, declinedIds]
          );
        }

        await this.recordIncident(client, {
          orderId,
          incidentType: 'driver_reassigned_queue',
          actorUserId: adminUserId,
          actorRole: 'platform_admin',
          previousDriverId: oldDriverId,
          newDriverId: null,
          summary: `Returned to available drivers queue before pickup: ${cleanReason}`,
          metadata: { reason: cleanReason, old_driver_action: oldDriverAction, candidate_count: availIds.length },
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (oldDriverId && invalidateDriverCache) invalidateDriverCache(oldDriverId);
    if (newDriverId && invalidateDriverCache) invalidateDriverCache(newDriverId);

    const enrichedOrder = await this.findById(orderId);
    const custRes = await db.query(`SELECT user_id FROM customers WHERE id = $1`, [updatedOrder.customer_id]);
    const customerUserId = custRes.rows[0]?.user_id || null;

    if (oldDriverUserId && emitUserEvent) {
      emitUserEvent(oldDriverUserId, 'order_unavailable', {
        orderId,
        order_number: updatedOrder.order_number,
        reason: 'reassigned_by_admin',
      });
    }

    if (cleanMode === 'direct' && newDriverUserId) {
      if (emitUserEvent) {
        emitUserEvent(newDriverUserId, 'order_assigned', {
          orderId,
          order_number: updatedOrder.order_number,
          order: enrichedOrder,
        });
      }
      await this.createNotification(
        newDriverUserId,
        'driver',
        'Order Assigned by Dispatch',
        `Order #${updatedOrder.order_number} from ${enrichedOrder?.restaurant_name || 'restaurant'} has been assigned to you.`,
        'order_assigned',
        { order_id: orderId }
      ).catch(() => {});
    } else if (cleanMode === 'queue' && emitDriversEvent) {
      emitDriversEvent('new_order_available', {
        orderId,
        order_number: updatedOrder.order_number,
        restaurant_id: updatedOrder.restaurant_id,
        reassigned: true,
      });
    }

    if (emitOrderUpdate) {
      emitOrderUpdate(orderId, {
        type: 'driver_reassigned',
        customerUserId,
        previousDriverId: oldDriverId,
        order: enrichedOrder,
        driver_id: updatedOrder.driver_id,
        new_status: updatedOrder.status,
      });
    }

    if (emitManagerEvent && updatedOrder.restaurant_id) {
      emitManagerEvent(updatedOrder.restaurant_id, 'driver_reassigned', {
        order_id: orderId,
        order_number: updatedOrder.order_number,
        driver_id: updatedOrder.driver_id,
        status: updatedOrder.status,
        order: enrichedOrder,
      });
      emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
        orderId,
        order_number: updatedOrder.order_number,
        driver_id: updatedOrder.driver_id,
        status: updatedOrder.status,
        order: enrichedOrder,
      });
    }

    if (customerUserId) {
      const driverName = enrichedOrder?.driver_first_name
        ? `${enrichedOrder.driver_first_name} ${enrichedOrder.driver_last_name || ''}`.trim()
        : null;
      await this.createNotification(
        customerUserId,
        'customer',
        cleanMode === 'direct' ? 'New Driver Assigned' : 'Finding a New Driver',
        cleanMode === 'direct' && driverName
          ? `Dispatch assigned ${driverName} to pick up your order #${updatedOrder.order_number}.`
          : `Dispatch is assigning a new available driver for your order #${updatedOrder.order_number}.`,
        'driver_reassigned',
        { order_id: orderId }
      ).catch(() => {});
    }

    return enrichedOrder;
  }

  // Happy Admin: Assign trusted special driver (paid directly by Happy) OR Happy delivers himself AFTER pickup
  static async assignPostPickupRescue(
    orderId,
    adminUserId,
    {
      rescueMode = 'special_driver',
      courierName = '',
      courierPhone = '',
      courierVehicle = '',
      courierPlate = '',
      notes = '',
      oldDriverAction = 'offline',
    } = {}
  ) {
    await this.ensureInterventionSchema();
    const isSelf = rescueMode === 'admin_self';
    const cleanName = String(courierName || '').trim();
    const cleanPhone = String(courierPhone || '').trim();
    const cleanVehicle = String(courierVehicle || '').trim();
    const cleanPlate = String(courierPlate || '').trim();
    const cleanNotes = String(notes || '').trim();

    if (!isSelf && (!cleanName || !cleanPhone)) {
      const err = new Error('Please enter both name and phone number for your trusted special driver.');
      err.statusCode = 400;
      throw err;
    }

    const support = await this.getSupportContact();
    let finalName = cleanName;
    let finalPhone = cleanPhone || support.support_phone || '';
    if (isSelf) {
      const adminRes = await db.query(
        `SELECT first_name, last_name, phone_number FROM users WHERE id = $1 LIMIT 1`,
        [adminUserId]
      );
      const u = adminRes.rows[0];
      if (!finalName) {
        finalName = u ? `${u.first_name || 'Happy'} ${u.last_name || ''}`.trim() + ' (Happy Dispatch)' : 'Happy (Owner Rescue Delivery)';
      }
      if (!finalPhone) {
        finalPhone = u?.phone_number || support.support_phone || '';
      }
    }

    const rescuePayload = {
      mode: isSelf ? 'admin_self' : 'special_driver',
      name: finalName,
      phone: finalPhone,
      vehicle: cleanVehicle || (isSelf ? 'Happy Dispatch Rescue Vehicle' : 'Trusted Special Courier'),
      plate: cleanPlate,
      payout_mode: isSelf ? 'admin_self' : 'admin_direct',
      courier_type_label: isSelf ? 'Happy (Self Rescue Delivery)' : 'Trusted Special Driver (Happy Direct Pay)',
      notes: cleanNotes,
      assigned_by: adminUserId || null,
      assigned_at: new Date().toISOString(),
    };

    const client = await db.pool.connect();
    let updatedOrder = null;
    let oldDriverId = null;
    let oldDriverUserId = null;

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const order = orderRes.rows[0];
      if (!['picked_up', 'on_the_way', 'arrived'].includes(order.status)) {
        const err = new Error(
          'Rescue delivery is only for orders already picked up (picked_up, on_the_way, or arrived). Use Reassign Driver before pickup.'
        );
        err.statusCode = 400;
        throw err;
      }

      oldDriverId = order.driver_id || null;
      if (oldDriverId) {
        const drRes = await client.query(`SELECT user_id FROM drivers WHERE id = $1`, [oldDriverId]);
        oldDriverUserId = drRes.rows[0]?.user_id || null;
        const nextStatus = oldDriverAction === 'available' ? 'available' : 'offline';
        const nextAvail = oldDriverAction === 'available';
        await client.query(
          `UPDATE drivers SET current_status = $2, is_available = $3, updated_at = NOW() WHERE id = $1`,
          [oldDriverId, nextStatus, nextAvail]
        );
      }

      const upRes = await client.query(
        `UPDATE orders
         SET driver_id = NULL,
             original_driver_id = COALESCE(original_driver_id, $2),
             rescue_courier = $3::jsonb,
             rescue_payout_mode = $4,
             intervention_notes = COALESCE(NULLIF($5, ''), intervention_notes),
             intervention_updated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId, oldDriverId, JSON.stringify(rescuePayload), rescuePayload.payout_mode, cleanNotes]
      );
      updatedOrder = upRes.rows[0];

      await client.query(
        `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
        [orderId]
      );

      await this.recordIncident(client, {
        orderId,
        incidentType: isSelf ? 'rescue_self_delivery' : 'rescue_special_driver',
        actorUserId: adminUserId,
        actorRole: 'platform_admin',
        previousDriverId: oldDriverId,
        newDriverId: null,
        summary: `${rescuePayload.courier_type_label}: ${finalName}${cleanNotes ? ' — ' + cleanNotes : ''}`,
        metadata: rescuePayload,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (oldDriverId && invalidateDriverCache) invalidateDriverCache(oldDriverId);

    const enrichedOrder = await this.findById(orderId);
    const custRes = await db.query(`SELECT user_id FROM customers WHERE id = $1`, [updatedOrder.customer_id]);
    const customerUserId = custRes.rows[0]?.user_id || null;

    if (oldDriverUserId && emitUserEvent) {
      emitUserEvent(oldDriverUserId, 'order_unavailable', {
        orderId,
        order_number: updatedOrder.order_number,
        reason: 'rescue_dispatched',
      });
    }

    if (emitOrderUpdate) {
      emitOrderUpdate(orderId, {
        type: 'rescue_dispatched',
        customerUserId,
        previousDriverId: oldDriverId,
        order: enrichedOrder,
        rescue_courier: rescuePayload,
        new_status: updatedOrder.status,
      });
    }

    if (emitManagerEvent && updatedOrder.restaurant_id) {
      emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
        orderId,
        order_number: updatedOrder.order_number,
        status: updatedOrder.status,
        order: enrichedOrder,
      });
    }

    if (customerUserId) {
      await this.createNotification(
        customerUserId,
        'customer',
        'Rescue Courier On the Way',
        `Happy Dispatch arranged ${finalName} to complete delivery of your order #${updatedOrder.order_number}.`,
        'rescue_dispatched',
        { order_id: orderId }
      ).catch(() => {});
    }

    return enrichedOrder;
  }

  // Happy Admin: Complete a rescued delivery (optionally verifying customer's code) WITHOUT paying original failed driver
  static async completeRescueDelivery(
    orderId,
    adminUserId,
    { verificationCode = '', bypassCode = false, notes = '' } = {}
  ) {
    await this.ensureInterventionSchema();
    const client = await db.pool.connect();
    let updatedOrder = null;

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const order = orderRes.rows[0];
      if (!['picked_up', 'on_the_way', 'arrived'].includes(order.status)) {
        const err = new Error('Only in-transit rescue orders can be completed here.');
        err.statusCode = 400;
        throw err;
      }

      if (!order.rescue_courier && !order.rescue_payout_mode) {
        const err = new Error('This order is not currently assigned to a Happy/special rescue courier.');
        err.statusCode = 400;
        throw err;
      }

      const providedCode = String(verificationCode || '').trim().toUpperCase();
      if (!bypassCode) {
        const expectedCode = String(order.verification_code || '').trim().toUpperCase();
        if (!expectedCode) {
          const err = new Error('No verification code exists for this order yet.');
          err.statusCode = 400;
          throw err;
        }
        if (providedCode !== expectedCode) {
          const err = new Error('Delivery verification code did not match customer code.');
          err.statusCode = 400;
          throw err;
        }
      }

      const cleanNotes = String(notes || '').trim();
      const upRes = await client.query(
        `UPDATE orders
         SET status = 'delivered',
             delivered_at = CURRENT_TIMESTAMP,
             code_used_at = CURRENT_TIMESTAMP,
             intervention_notes = COALESCE(NULLIF($2, ''), intervention_notes),
             intervention_updated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId, cleanNotes]
      );
      updatedOrder = upRes.rows[0];

      await client.query(
        `INSERT INTO order_delivery_verification_attempts (order_id, driver_id, attempted_code, success, reason)
         VALUES ($1, $2, $3, true, $4)`,
        [orderId, order.original_driver_id || null, providedCode || 'ADMIN', bypassCode ? 'admin_rescue_override' : 'rescue_code_verified']
      ).catch(() => {});

      await this.recordIncident(client, {
        orderId,
        incidentType: 'rescue_completed',
        actorUserId: adminUserId,
        actorRole: 'platform_admin',
        previousDriverId: order.original_driver_id || null,
        summary: bypassCode
          ? `Rescue delivery marked completed by Happy admin${cleanNotes ? ' — ' + cleanNotes : ''}`
          : `Rescue delivery verified with customer code & completed${cleanNotes ? ' — ' + cleanNotes : ''}`,
        metadata: { bypass_code: Boolean(bypassCode), rescue_payout_mode: order.rescue_payout_mode || 'admin_direct' },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const enrichedOrder = await this.findById(orderId);
    const custRes = await db.query(`SELECT user_id FROM customers WHERE id = $1`, [updatedOrder.customer_id]);
    const customerUserId = custRes.rows[0]?.user_id || null;

    if (emitOrderUpdate) {
      emitOrderUpdate(orderId, {
        type: 'delivery_code_verified',
        customerUserId,
        order: enrichedOrder,
        new_status: 'delivered',
      });
    }
    if (emitManagerEvent && updatedOrder.restaurant_id) {
      emitManagerEvent(updatedOrder.restaurant_id, 'order_updated', {
        orderId,
        order_number: updatedOrder.order_number,
        status: 'delivered',
        order: enrichedOrder,
      });
    }
    if (customerUserId) {
      await this.createNotification(
        customerUserId,
        'customer',
        'Order Delivered!',
        `Your rescue delivery for order #${updatedOrder.order_number} is complete. Enjoy your meal!`,
        'order_delivered',
        { order_id: orderId }
      ).catch(() => {});
    }

    return enrichedOrder;
  }

  // Happy Admin: Cancel order (including post-pickup) & issue full customer refund
  static async adminCancelAndRefund(
    orderId,
    adminUserId,
    { reason = '', driverAction = 'available' } = {}
  ) {
    await this.ensureInterventionSchema();
    const cleanReason = String(reason || '').trim() || 'Cancelled and refunded by Happy Deliveries dispatch';
    const client = await db.pool.connect();

    let cancelledOrder = null;
    let oldDriverId = null;
    let oldDriverUserId = null;
    let shouldRefund = false;

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const order = orderRes.rows[0];
      if (['delivered', 'cancelled', 'delivery_failed', 'no_drivers_available'].includes(order.status)) {
        const err = new Error(`Order is already ${order.status.replace(/_/g, ' ')} and cannot be cancelled.`);
        err.statusCode = 400;
        throw err;
      }

      oldDriverId = order.driver_id || null;
      if (oldDriverId) {
        const drRes = await client.query(`SELECT user_id FROM drivers WHERE id = $1`, [oldDriverId]);
        oldDriverUserId = drRes.rows[0]?.user_id || null;
        const nextStatus = driverAction === 'offline' ? 'offline' : 'available';
        const nextAvail = driverAction !== 'offline';
        await client.query(
          `UPDATE drivers SET current_status = $2, is_available = $3, updated_at = NOW() WHERE id = $1`,
          [oldDriverId, nextStatus, nextAvail]
        );
      }

      shouldRefund = order.payment_status === 'completed';

      const upRes = await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancelled_at = CURRENT_TIMESTAMP,
             failure_reason = $2,
             forfeited = false,
             intervention_notes = $2,
             intervention_updated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId, cleanReason]
      );
      cancelledOrder = upRes.rows[0];

      await client.query(
        `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
        [orderId]
      );

      await this.recordIncident(client, {
        orderId,
        incidentType: 'admin_cancel_refund',
        actorUserId: adminUserId,
        actorRole: 'platform_admin',
        previousDriverId: oldDriverId,
        summary: `Cancelled & ${shouldRefund ? 'refunded' : 'closed'} by Happy dispatch: ${cleanReason}`,
        metadata: { reason: cleanReason, driver_action: driverAction, refunded: shouldRefund },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (oldDriverId && invalidateDriverCache) invalidateDriverCache(oldDriverId);

    let refundError = null;
    if (shouldRefund) {
      try {
        await Payment.refundByOrderId(orderId, cleanReason);
      } catch (err) {
        refundError = err.message;
        console.error(`Admin refund error on order ${orderId}:`, err.message);
      }
    }

    const enrichedOrder = await this.findById(orderId);
    const custRes = await db.query(`SELECT user_id FROM customers WHERE id = $1`, [cancelledOrder.customer_id]);
    const customerUserId = custRes.rows[0]?.user_id || null;

    if (oldDriverUserId && emitUserEvent) {
      emitUserEvent(oldDriverUserId, 'order_unavailable', {
        orderId,
        order_number: cancelledOrder.order_number,
        reason: 'cancelled_by_admin',
      });
    }
    if (emitDriversEvent) {
      emitDriversEvent('order_unavailable', {
        orderId,
        order_number: cancelledOrder.order_number,
        reason: 'cancelled',
      });
    }
    if (emitOrderUpdate) {
      emitOrderUpdate(orderId, {
        type: 'order_cancelled',
        customerUserId,
        previousDriverId: oldDriverId,
        order: enrichedOrder,
        new_status: 'cancelled',
      });
    }
    if (emitManagerEvent && cancelledOrder.restaurant_id) {
      emitManagerEvent(cancelledOrder.restaurant_id, 'order_updated', {
        orderId,
        order_number: cancelledOrder.order_number,
        status: 'cancelled',
        order: enrichedOrder,
      });
    }
    if (customerUserId) {
      await this.createNotification(
        customerUserId,
        'customer',
        'Order Cancelled & Refunded',
        shouldRefund
          ? `Order #${cancelledOrder.order_number} was cancelled (${cleanReason}). Your payment has been refunded.`
          : `Order #${cancelledOrder.order_number} was cancelled: ${cleanReason}`,
        'order_cancelled',
        { order_id: orderId, refunded: shouldRefund }
      ).catch(() => {});
    }

    return { order: enrichedOrder, refundError };
  }

  // Happy Admin: Mark order failed due to unreachable customer (Customer FORFEITS payment, driver STILL gets paid)
  static async failOrderCustomerForfeit(
    orderId,
    adminUserId,
    { reason = '', notes = '' } = {}
  ) {
    await this.ensureInterventionSchema();
    const cleanReason =
      String(reason || '').trim() ||
      'Customer unreachable at delivery location — order failed and payment forfeited per delivery policy';
    const cleanNotes = String(notes || '').trim() || cleanReason;

    const client = await db.pool.connect();
    let failedOrder = null;
    let activeDriverId = null;
    let driverUserId = null;
    let driverEarnings = 0;

    try {
      await client.query('BEGIN');

      const orderRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      const order = orderRes.rows[0];
      if (!['picked_up', 'on_the_way', 'arrived'].includes(order.status)) {
        const err = new Error(
          'Customer no-show forfeit can only be triggered after the order has been picked up (ideally once driver arrives).'
        );
        err.statusCode = 400;
        throw err;
      }

      activeDriverId = order.driver_id || null;

      const upRes = await client.query(
        `UPDATE orders
         SET status = 'delivery_failed',
             cancelled_at = CURRENT_TIMESTAMP,
             forfeited = true,
             failure_reason = $2,
             intervention_notes = $3,
             intervention_updated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [orderId, cleanReason, cleanNotes]
      );
      failedOrder = upRes.rows[0];

      await client.query(
        `UPDATE driver_order_queue SET is_active = false, completed_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
        [orderId]
      );

      // Pay the app driver and release them back to available since they fulfilled their part
      if (activeDriverId && !order.rescue_payout_mode) {
        const drRes = await client.query(`SELECT user_id FROM drivers WHERE id = $1`, [activeDriverId]);
        driverUserId = drRes.rows[0]?.user_id || null;
        driverEarnings = await this.creditDriverDeliveryEarnings(client, order, activeDriverId);
      }

      await this.recordIncident(client, {
        orderId,
        incidentType: 'delivery_failed_forfeit',
        actorUserId: adminUserId,
        actorRole: 'platform_admin',
        previousDriverId: activeDriverId,
        summary: `${cleanReason} (Payment forfeited · Driver paid R${Number(driverEarnings || 0).toFixed(2)})`,
        metadata: { reason: cleanReason, forfeited: true, driver_earnings: driverEarnings },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (activeDriverId && invalidateDriverCache) invalidateDriverCache(activeDriverId);

    const enrichedOrder = await this.findById(orderId);
    const custRes = await db.query(`SELECT user_id FROM customers WHERE id = $1`, [failedOrder.customer_id]);
    const customerUserId = custRes.rows[0]?.user_id || null;

    if (driverUserId && emitUserEvent) {
      emitUserEvent(driverUserId, 'order_update', {
        type: 'delivery_failed',
        orderId,
        status: 'delivery_failed',
        new_status: 'delivery_failed',
        order: enrichedOrder,
      });
    }
    if (emitOrderUpdate) {
      emitOrderUpdate(orderId, {
        type: 'delivery_failed',
        customerUserId,
        previousDriverId: activeDriverId,
        order: enrichedOrder,
        forfeited: true,
        new_status: 'delivery_failed',
      });
    }
    if (emitManagerEvent && failedOrder.restaurant_id) {
      emitManagerEvent(failedOrder.restaurant_id, 'order_updated', {
        orderId,
        order_number: failedOrder.order_number,
        status: 'delivery_failed',
        order: enrichedOrder,
      });
    }
    if (customerUserId) {
      await this.createNotification(
        customerUserId,
        'customer',
        'Delivery Failed — Payment Forfeited',
        `We could not reach you for order #${failedOrder.order_number} (${cleanReason}). Per delivery policy, payment has been forfeited.`,
        'delivery_failed',
        { order_id: orderId, forfeited: true }
      ).catch(() => {});
    }
    if (driverUserId) {
      await this.createNotification(
        driverUserId,
        'driver',
        'Delivery Closed — Earnings Credited',
        `Order #${failedOrder.order_number} was closed as customer unreachable. Your delivery fee (R${Number(driverEarnings || 0).toFixed(2)}) has been credited.`,
        'delivery_failed_driver_paid',
        { order_id: orderId, driver_earnings: driverEarnings }
      ).catch(() => {});
    }

    return enrichedOrder;
  }

  // Driver alerts Happy Dispatch when customer is unreachable at drop-off
  static async reportCustomerUnreachable(orderId, driverId, { notes = '' } = {}) {
    await this.ensureInterventionSchema();

    const orderRes = await db.query(
      `SELECT o.*, r.name AS restaurant_name,
              cu.first_name AS customer_first_name, cu.last_name AS customer_last_name, cu.phone_number AS customer_phone,
              du.first_name AS driver_first_name, du.last_name AS driver_last_name, du.phone_number AS driver_phone
       FROM orders o
       JOIN restaurants r ON o.restaurant_id = r.id
       JOIN customers c ON o.customer_id = c.id
       JOIN users cu ON c.user_id = cu.id
       LEFT JOIN drivers d ON o.driver_id = d.id
       LEFT JOIN users du ON d.user_id = du.id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    const order = orderRes.rows[0];
    if (String(order.driver_id) !== String(driverId)) {
      const err = new Error('Not authorized to report this order');
      err.statusCode = 403;
      throw err;
    }

    if (!['picked_up', 'on_the_way', 'arrived'].includes(order.status)) {
      const err = new Error('Customer unreachable report is only available during delivery.');
      err.statusCode = 400;
      throw err;
    }

    const cleanNotes = String(notes || '').trim() || 'Driver cannot reach customer at drop-off';

    await this.recordIncident(db, {
      orderId,
      incidentType: 'customer_unreachable_alert',
      previousDriverId: driverId,
      actorRole: 'driver',
      summary: `Driver reported customer unreachable: ${cleanNotes}`,
      metadata: {
        customer_phone: order.customer_phone,
        driver_phone: order.driver_phone,
        status: order.status,
      },
    });

    await db.query(
      `UPDATE orders
       SET intervention_notes = $2,
           intervention_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [orderId, `Driver alert: ${cleanNotes}`]
    );

    const support = await this.getSupportContact();

    if (emitManagerEvent) {
      emitManagerEvent(null, 'customer_unreachable_alert', {
        order_id: order.id,
        order_number: order.order_number,
        restaurant_name: order.restaurant_name,
        customer_name: `${order.customer_first_name || ''} ${order.customer_last_name || ''}`.trim() || 'Customer',
        customer_phone: order.customer_phone || null,
        driver_name: `${order.driver_first_name || ''} ${order.driver_last_name || ''}`.trim() || 'Driver',
        driver_phone: order.driver_phone || null,
        notes: cleanNotes,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      order_id: order.id,
      order_number: order.order_number,
      reported: true,
      support_contact: support,
    };
  }
}

module.exports = Order;