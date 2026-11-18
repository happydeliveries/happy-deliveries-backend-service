'use strict';

const db = require('../config/database');
const Restaurant = require('../models/Restaurant');
const Order = require('../models/Order');

/**
 * Shared ownership & query helpers for Happy Platform Admin and Restaurant Partner portals.
 * Platform admins (account_type !== 'restaurant_partner') retain full access to all restaurants;
 * restaurant partners are strictly scoped to their own restaurant(s).
 */

async function resolveAccessibleRestaurants(managerProfile, { includePending = false } = {}) {
  return Restaurant.findAccessibleByManager(managerProfile, { includePending });
}

async function resolveAccessibleRestaurantIds(managerProfile, { includePending = false } = {}) {
  await Restaurant.ensureApplicationColumns();
  if (!managerProfile) return [];

  if (Restaurant.isPlatformAdmin(managerProfile)) {
    const sql = includePending
      ? 'SELECT id FROM restaurants ORDER BY created_at DESC'
      : `SELECT id FROM restaurants WHERE COALESCE(approval_status, 'approved') = 'approved' ORDER BY created_at DESC`;
    const { rows } = await db.query(sql);
    return rows.map((r) => r.id);
  }

  const { rows } = await db.query(
    `SELECT id FROM restaurants WHERE manager_id = $1 OR owner_user_id = $2 ORDER BY created_at DESC`,
    [managerProfile.id, managerProfile.user_id]
  );
  return rows.map((r) => r.id);
}

async function verifyRestaurantAccess(restaurantId, managerProfile) {
  if (!restaurantId || !managerProfile) return null;
  await Restaurant.ensureApplicationColumns();

  if (Restaurant.isPlatformAdmin(managerProfile)) {
    const { rows } = await db.query(
      `SELECT *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
       FROM restaurants WHERE id = $1`,
      [restaurantId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `SELECT *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
     FROM restaurants
     WHERE id = $1 AND (manager_id = $2 OR owner_user_id = $3)`,
    [restaurantId, managerProfile.id, managerProfile.user_id]
  );
  return rows[0] || null;
}

async function verifyMenuAccess(menuId, managerProfile) {
  if (!menuId || !managerProfile) return null;
  await Restaurant.ensureApplicationColumns();

  if (Restaurant.isPlatformAdmin(managerProfile)) {
    const { rows } = await db.query(
      `SELECT m.id, m.restaurant_id FROM menus m WHERE m.id = $1`,
      [menuId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `SELECT m.id, m.restaurant_id
     FROM menus m
     JOIN restaurants r ON m.restaurant_id = r.id
     WHERE m.id = $1 AND (r.manager_id = $2 OR r.owner_user_id = $3)`,
    [menuId, managerProfile.id, managerProfile.user_id]
  );
  return rows[0] || null;
}

async function verifyMenuItemAccess(itemId, managerProfile) {
  if (!itemId || !managerProfile) return null;
  await Restaurant.ensureApplicationColumns();

  if (Restaurant.isPlatformAdmin(managerProfile)) {
    const { rows } = await db.query(
      `SELECT mi.id, mi.menu_id, mi.restaurant_id FROM menu_items mi WHERE mi.id = $1`,
      [itemId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `SELECT mi.id, mi.menu_id, mi.restaurant_id
     FROM menu_items mi
     JOIN restaurants r ON mi.restaurant_id = r.id
     WHERE mi.id = $1 AND (r.manager_id = $2 OR r.owner_user_id = $3)`,
    [itemId, managerProfile.id, managerProfile.user_id]
  );
  return rows[0] || null;
}

async function fetchPaginatedOrders(restaurantIds, { status, date, page = 1, limit = 15 } = {}) {
  if (!Array.isArray(restaurantIds) || restaurantIds.length === 0) {
    return { orders: [], total: 0, currentPage: 1, totalPages: 0 };
  }
  await Order.ensureInterventionSchema();

  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 100);
  const offset = (safePage - 1) * safeLimit;

  const params = [restaurantIds];
  let where = 'WHERE o.restaurant_id = ANY($1::uuid[])';
  let pIdx = 2;

  if (status && status !== 'all') {
    if (status === 'kitchen_active') {
      where += ` AND o.status IN ('pending', 'ordering_at_restaurant', 'accepted_by_driver', 'order_ready')`;
    } else if (status === 'kitchen_preparing') {
      where += ` AND o.status IN ('ordering_at_restaurant', 'accepted_by_driver') AND o.payment_status = 'completed'`;
    } else if (String(status).includes(',')) {
      const statusList = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      if (statusList.length) {
        where += ` AND o.status = ANY($${pIdx++}::text[])`;
        params.push(statusList);
      }
    } else {
      where += ` AND o.status = $${pIdx++}`;
      params.push(status);
    }
  }
  if (date) {
    where += ` AND DATE(o.placed_at) = $${pIdx++}`;
    params.push(date);
  }

  const countRes = await db.query(
    `SELECT COUNT(*)::int AS c FROM orders o ${where}`,
    params
  );
  const total = parseInt(countRes.rows[0]?.c || 0, 10);
  const totalPages = Math.ceil(total / safeLimit);

  params.push(safeLimit, offset);

  const orderClause =
    status === 'kitchen_active' || status === 'kitchen_preparing'
      ? `ORDER BY
           CASE
             WHEN o.status = 'pending' THEN 0
             WHEN o.payment_status = 'completed' AND o.status <> 'order_ready' THEN 1
             WHEN o.status = 'ordering_at_restaurant' THEN 2
             ELSE 3
           END ASC,
           o.placed_at ASC`
      : 'ORDER BY o.placed_at DESC';

  const { rows } = await db.query(`
    SELECT
      o.id, o.order_number, o.status, o.subtotal, o.delivery_fee, o.tax_amount,
      o.tip_amount, o.total_amount, o.payment_status, o.payment_method,
      o.special_instructions, o.delivery_instructions,
      o.placed_at, o.restaurant_notified_at, o.accepted_at, o.ready_for_pickup_at,
      o.picked_up_at, o.delivered_at, o.cancelled_at,
      o.original_driver_id, o.reassigned_at, o.rescue_courier, o.rescue_payout_mode,
      o.failure_reason, o.forfeited, o.intervention_notes, o.intervention_updated_at,
      o.delivery_address, o.restaurant_id, o.driver_id,
      r.name AS restaurant_name,
      COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), 'Unknown Customer') AS customer_name,
      u.phone_number AS customer_phone,
      NULLIF(TRIM(COALESCE(du.first_name, '') || ' ' || COALESCE(du.last_name, '')), '') AS driver_name,
      du.phone_number AS driver_phone,
      du.profile_image_url AS driver_image,
      d.vehicle_type AS driver_vehicle_type,
      d.vehicle_model AS driver_vehicle_model,
      d.vehicle_color AS driver_vehicle_color,
      d.vehicle_registration AS driver_vehicle_plate,
      d.average_rating AS driver_rating,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)::int AS item_count
    FROM orders o
    JOIN restaurants r ON o.restaurant_id = r.id
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    LEFT JOIN users du ON d.user_id = du.id
    ${where}
    ${orderClause}
    LIMIT $${pIdx} OFFSET $${pIdx + 1}
  `, params);

  if (rows.length > 0) {
    const orderIds = rows.map((row) => row.id);
    const { rows: itemRows } = await db.query(`
      SELECT
        oi.id, oi.order_id, oi.quantity, oi.unit_price, oi.total_price,
        oi.special_instructions, oi.selected_options, oi.allergen_notes,
        mi.name AS item_name, mi.image_url
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY oi.created_at ASC
    `, [orderIds]);

    const itemsByOrder = new Map();
    for (const item of itemRows) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
      itemsByOrder.get(item.order_id).push(item);
    }
    rows.forEach((row) => {
      row.items = itemsByOrder.get(row.id) || [];
    });
  }

  return { orders: rows, total, currentPage: safePage, totalPages };
}

async function fetchOrderDetail(orderId, managerProfile) {
  if (!orderId || !managerProfile) return null;
  await Restaurant.ensureApplicationColumns();
  await Order.ensureInterventionSchema();

  const isAdmin = Restaurant.isPlatformAdmin(managerProfile);
  const params = [orderId];
  let accessWhere = '';

  if (!isAdmin) {
    accessWhere = 'AND (r.manager_id = $2 OR r.owner_user_id = $3)';
    params.push(managerProfile.id, managerProfile.user_id);
  }

  const { rows: [order] } = await db.query(`
    SELECT
      o.*,
      r.name AS restaurant_name,
      r.phone_number AS restaurant_phone,
      r.address AS restaurant_address,
      COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), 'Unknown Customer') AS customer_name,
      u.phone_number AS customer_phone,
      NULLIF(TRIM(COALESCE(du.first_name, '') || ' ' || COALESCE(du.last_name, '')), '') AS driver_name,
      du.phone_number AS driver_phone,
      du.profile_image_url AS driver_image,
      d.vehicle_type AS driver_vehicle_type,
      d.vehicle_model AS driver_vehicle_model,
      d.vehicle_color AS driver_vehicle_color,
      d.vehicle_registration AS driver_vehicle_plate,
      d.average_rating AS driver_rating,
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
      ) AS incidents
    FROM orders o
    JOIN restaurants r ON o.restaurant_id = r.id
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN drivers d ON o.driver_id = d.id
    LEFT JOIN users du ON d.user_id = du.id
    WHERE o.id = $1
    ${accessWhere}
  `, params);

  if (!order) return null;

  delete order.verification_code;
  delete order.code_expires_at;
  delete order.code_used_at;

  try {
    const support = await Order.getSupportContact();
    order.support_phone = support.support_phone;
    order.support_name = support.support_name;
  } catch {
    order.support_phone = process.env.SUPPORT_PHONE || null;
    order.support_name = 'Happy Deliveries Dispatch';
  }

  const { rows: items } = await db.query(`
    SELECT
      oi.id, oi.quantity, oi.unit_price, oi.total_price,
      oi.special_instructions, oi.selected_options, oi.allergen_notes,
      mi.name AS item_name, mi.image_url
    FROM order_items oi
    JOIN menu_items mi ON oi.menu_item_id = mi.id
    WHERE oi.order_id = $1
    ORDER BY oi.created_at
  `, [orderId]);

  return { order, items };
}

function parseBool(val, def = false) {
  if (val === undefined || val === null || val === '') return def;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val === 'true' || val === '1' || val === 'on';
  return Boolean(val);
}

module.exports = {
  resolveAccessibleRestaurants,
  resolveAccessibleRestaurantIds,
  verifyRestaurantAccess,
  verifyMenuAccess,
  verifyMenuItemAccess,
  fetchPaginatedOrders,
  fetchOrderDetail,
  parseBool,
};
