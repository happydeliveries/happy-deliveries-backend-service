const Restaurant = require('../models/Restaurant');
const RestaurantManager = require('../models/RestaurantManager');
const Order = require('../models/Order');
const db = require('../config/database');

// =============================================================================
// Constants — aligned 1:1 with your schema enums
// =============================================================================

const COMPLETED_STATUS = 'delivered';

const ACTIVE_ORDER_STATUSES = [
  'pending',
  'accepted_by_driver',
  'ordering_at_restaurant',
  'order_ready',
  'picked_up',
  'on_the_way',
  'arrived'
];

const STATUS_KEYS = [
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

const STATUS_LABELS = [
  'Pending',
  'Accepted',
  'Ordering',
  'Ready',
  'Picked Up',
  'On the Way',
  'Arrived',
  'Delivered',
  'Cancelled',
  'No Drivers'
];

// =============================================================================
// Helpers
// =============================================================================

const getManagerRestaurantIds = async (userId) => {
  const manager = await RestaurantManager.findByUserId(userId);
  if (!manager) return null;

  const restaurants = await Restaurant.findByManager(manager.id);
  return restaurants?.map(r => r.id) || [];
};

const buildEmptyStats = () => ({
  total_revenue: 0,
  total_orders: 0,
  avg_rating: 0,
  active_orders: 0,
  total_restaurants: 0,
  revenue_change: 0,
  orders_change: 0,
  total_reviews: 0,
  average_order_value: 0
});

// =============================================================================
// GET /api/manager/dashboard/stats
// =============================================================================

exports.getDashboardStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, stats: buildEmptyStats() });
    }

    // ── Today ──
    const todayQ = `
      SELECT
        COUNT(*)::int                                    AS total_orders,
        COALESCE(SUM(CASE WHEN status = $2 THEN total_amount ELSE 0 END), 0) AS total_revenue,
        COALESCE(AVG(CASE WHEN status = $2 THEN total_amount END), 0)        AS average_order_value
      FROM orders
      WHERE restaurant_id = ANY($1)
        AND DATE(placed_at) = CURRENT_DATE
    `;
    const todayRes = await db.query(todayQ, [restaurantIds, COMPLETED_STATUS]);
    const today = todayRes.rows[0];

    // ── Active orders ──
    const activeQ = `
      SELECT COUNT(*)::int AS active_orders
      FROM orders
      WHERE restaurant_id = ANY($1)
        AND status = ANY($2)
    `;
    const activeRes = await db.query(activeQ, [restaurantIds, ACTIVE_ORDER_STATUSES]);

    // ── Week-over-week (last 7 days vs previous 7 days) ──
    const wowQ = `
      SELECT
        COALESCE(SUM(CASE WHEN placed_at >= CURRENT_DATE - INTERVAL '7 days'  AND status = $2 THEN total_amount ELSE 0 END), 0) AS current_revenue,
        COALESCE(SUM(CASE WHEN placed_at >= CURRENT_DATE - INTERVAL '14 days' AND placed_at < CURRENT_DATE - INTERVAL '7 days' AND status = $2 THEN total_amount ELSE 0 END), 0) AS previous_revenue,
        COUNT(CASE WHEN placed_at >= CURRENT_DATE - INTERVAL '7 days'  THEN 1 END)::int AS current_orders,
        COUNT(CASE WHEN placed_at >= CURRENT_DATE - INTERVAL '14 days' AND placed_at < CURRENT_DATE - INTERVAL '7 days' THEN 1 END)::int AS previous_orders
      FROM orders
      WHERE restaurant_id = ANY($1)
        AND placed_at >= CURRENT_DATE - INTERVAL '14 days'
    `;
    const wowRes = await db.query(wowQ, [restaurantIds, COMPLETED_STATUS]);
    const wow = wowRes.rows[0];

    const revenueChange = wow.previous_revenue > 0
      ? ((wow.current_revenue - wow.previous_revenue) / wow.previous_revenue) * 100
      : (wow.current_revenue > 0 ? 100 : 0);

    const ordersChange = wow.previous_orders > 0
      ? ((wow.current_orders - wow.previous_orders) / wow.previous_orders) * 100
      : (wow.current_orders > 0 ? 100 : 0);

    // ── Ratings & reviews (from orders.restaurant_rating) ──
    const ratingQ = `
      SELECT
        COALESCE(AVG(restaurant_rating), 0) AS avg_rating,
        COUNT(CASE WHEN restaurant_rating IS NOT NULL THEN 1 END)::int AS total_reviews
      FROM orders
      WHERE restaurant_id = ANY($1)
    `;
    const ratingRes = await db.query(ratingQ, [restaurantIds]);
    const rating = ratingRes.rows[0];

    res.json({
      success: true,
      stats: {
        total_revenue:       parseFloat(today.total_revenue).toFixed(2),
        total_orders:        today.total_orders,
        avg_rating:          parseFloat(rating.avg_rating).toFixed(2),
        active_orders:       activeRes.rows[0].active_orders,
        total_restaurants:   restaurantIds.length,
        revenue_change:      parseFloat(revenueChange.toFixed(1)),
        orders_change:       parseFloat(ordersChange.toFixed(1)),
        total_reviews:       rating.total_reviews,
        average_order_value: parseFloat(today.average_order_value).toFixed(2)
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// GET /api/manager/dashboard/revenue?period=(week|month|year)
// =============================================================================

exports.getRevenueChartData = async (req, res) => {
  try {
    const userId = req.user.id;
    const period = req.query.period || 'week';
    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, labels: [], data: [] });
    }

    let query;
    let lookback;
    let labelCount;

    if (period === 'week') {
      lookback = 6;
      labelCount = 7;
      query = `
        SELECT
          TO_CHAR(DATE(placed_at), 'YYYY-MM-DD') AS date_key,
          COALESCE(SUM(total_amount), 0)         AS revenue
        FROM orders
        WHERE restaurant_id = ANY($1)
          AND placed_at >= CURRENT_DATE - INTERVAL '1 day' * $2
          AND placed_at <  CURRENT_DATE + INTERVAL '1 day'
          AND status = $3
        GROUP BY DATE(placed_at)
        ORDER BY DATE(placed_at)
      `;
    } else if (period === 'month') {
      lookback = 29;
      labelCount = 30;
      query = `
        SELECT
          TO_CHAR(DATE(placed_at), 'YYYY-MM-DD') AS date_key,
          COALESCE(SUM(total_amount), 0)         AS revenue
        FROM orders
        WHERE restaurant_id = ANY($1)
          AND placed_at >= CURRENT_DATE - INTERVAL '1 day' * $2
          AND placed_at <  CURRENT_DATE + INTERVAL '1 day'
          AND status = $3
        GROUP BY DATE(placed_at)
        ORDER BY DATE(placed_at)
      `;
    } else if (period === 'year') {
      lookback = 11;
      labelCount = 12;
      query = `
        SELECT
          TO_CHAR(DATE_TRUNC('month', placed_at), 'YYYY-MM') AS date_key,
          COALESCE(SUM(total_amount), 0)                     AS revenue
        FROM orders
        WHERE restaurant_id = ANY($1)
          AND placed_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' * $2
          AND status = $3
        GROUP BY DATE_TRUNC('month', placed_at)
        ORDER BY DATE_TRUNC('month', placed_at)
      `;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid period. Use week, month, or year.'
      });
    }

    const result = await db.query(query, [restaurantIds, lookback, COMPLETED_STATUS]);
    const revenueMap = new Map(result.rows.map(r => [r.date_key, parseFloat(r.revenue)]));

    const labels = [];
    const data = [];

    for (let i = labelCount - 1; i >= 0; i--) {
      const d = new Date();

      if (period === 'year') {
        d.setMonth(d.getMonth() - i);
        const year  = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const key   = `${year}-${month}`;
        labels.push(d.toLocaleDateString('en-US', { month: 'short' }));
        data.push(revenueMap.get(key) || 0);
      } else {
        d.setDate(d.getDate() - i);
        const year  = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day   = String(d.getDate()).padStart(2, '0');
        const key   = `${year}-${month}-${day}`;
        labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        data.push(revenueMap.get(key) || 0);
      }
    }

    res.json({ success: true, labels, data });
  } catch (error) {
    console.error('Get revenue chart data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// GET /api/manager/dashboard/orders
// =============================================================================

exports.getOrdersChartData = async (req, res) => {
  try {
    const userId = req.user.id;
    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, labels: [], data: [] });
    }

    const query = `
      SELECT status, COUNT(*)::int AS count
      FROM orders
      WHERE restaurant_id = ANY($1)
        AND DATE(placed_at) = CURRENT_DATE
      GROUP BY status
    `;

    const result = await db.query(query, [restaurantIds]);
    const counts = Object.fromEntries(result.rows.map(r => [r.status, r.count]));

    const data = STATUS_KEYS.map(status => counts[status] || 0);

    res.json({
      success: true,
      labels: STATUS_LABELS,
      data
    });
  } catch (error) {
    console.error('Get orders chart data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// GET /api/manager/dashboard/recent-orders
// =============================================================================

exports.getRecentOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, orders: [] });
    }

    const query = `
      SELECT
        o.id,
        o.order_number,
        o.total_amount,
        o.status,
        o.placed_at,
        r.name                    AS restaurant_name,
        u.first_name || ' ' || u.last_name AS customer_name
      FROM orders o
      JOIN restaurants r   ON o.restaurant_id = r.id
      JOIN customers cust  ON o.customer_id   = cust.id
      JOIN users u         ON cust.user_id    = u.id
      WHERE o.restaurant_id = ANY($1)
      ORDER BY o.placed_at DESC
      LIMIT $2
    `;

    const result = await db.query(query, [restaurantIds, limit]);

    const orders = result.rows.map(order => ({
      id:             order.id,
      order_number:   order.order_number,
      total_amount:   parseFloat(order.total_amount),
      status:         order.status,
      placed_at:      order.placed_at,
      restaurant_name: order.restaurant_name,
      customer_name:   order.customer_name
    }));

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Get recent orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// GET /api/manager/dashboard/active-orders-count
// =============================================================================

exports.getActiveOrdersCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    const query = `
      SELECT COUNT(*)::int AS active_count
      FROM orders
      WHERE restaurant_id = ANY($1)
        AND status = ANY($2)
    `;

    const result = await db.query(query, [restaurantIds, ACTIVE_ORDER_STATUSES]);

    res.json({
      success: true,
      count: result.rows[0].active_count
    });
  } catch (error) {
    console.error('Get active orders count error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// GET /api/restaurants/my
// =============================================================================

exports.getMyRestaurants = async (req, res) => {
  try {
    const userId = req.user.id;
    const manager = await RestaurantManager.findByUserId(userId);

    if (!manager) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    const restaurants = await Restaurant.findByManager(manager.id);

    const enhancedRestaurants = await Promise.all(
      restaurants.map(async (restaurant) => {
        const statsQ = `
          SELECT
            COUNT(*)::int AS total_orders,
            COALESCE(SUM(CASE WHEN status = $2 THEN total_amount ELSE 0 END), 0) AS total_revenue,
            COALESCE(AVG(restaurant_rating), 0) AS average_rating,
            COUNT(CASE WHEN restaurant_rating IS NOT NULL THEN 1 END)::int AS total_reviews
          FROM orders
          WHERE restaurant_id = $1
        `;

        const statsRes = await db.query(statsQ, [restaurant.id, COMPLETED_STATUS]);
        const s = statsRes.rows[0];

        return {
          ...restaurant,
          total_orders:    s.total_orders,
          total_revenue:   parseFloat(s.total_revenue).toFixed(2),
          average_rating:  parseFloat(s.average_rating).toFixed(2),
          total_reviews:   s.total_reviews
        };
      })
    );

    res.json({
      success: true,
      restaurants: enhancedRestaurants
    });
  } catch (error) {
    console.error('Get my restaurants error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// GET /api/manager/orders
// Filter by restaurant, status, date with pagination
// =============================================================================

exports.getAllOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = (page - 1) * limit;

    const restaurantId = req.query.restaurant;
    const status = req.query.status;
    const date = req.query.date;

    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, orders: [], totalOrders: 0, totalPages: 0, currentPage: 1 });
    }

    // Build WHERE clause dynamically
    let whereConditions = ['o.restaurant_id = ANY($1)'];
    let params = [restaurantIds];
    let paramIndex = 2;

    // Filter by specific restaurant if provided
    if (restaurantId && restaurantId !== 'all') {
      whereConditions.push(`o.restaurant_id = $${paramIndex}`);
      params.push(restaurantId);
      paramIndex++;
    }

    // Filter by status if provided
    if (status && status !== 'all') {
      whereConditions.push(`o.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    // Filter by date if provided
    if (date) {
      whereConditions.push(`DATE(o.placed_at) = $${paramIndex}`);
      params.push(date);
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM orders o
      WHERE ${whereClause}
    `;
    const countResult = await db.query(countQuery, params);
    const totalOrders = countResult.rows[0].total;
    const totalPages = Math.ceil(totalOrders / limit);

    // Get paginated orders
    const query = `
      SELECT
        o.id,
        o.order_number,
        o.total_amount,
        o.subtotal,
        o.delivery_fee,
        o.tax_amount,
        o.status,
        o.placed_at,
        o.accepted_at,
        o.ready_for_pickup_at,
        o.picked_up_at,
        o.delivered_at,
        r.name AS restaurant_name,
        u.first_name || ' ' || u.last_name AS customer_name,
        u.phone_number AS customer_phone,
        c.current_location,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id)::int AS item_count
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      JOIN customers cust ON o.customer_id = cust.id
      JOIN users u ON cust.user_id = u.id
      WHERE ${whereClause}
      ORDER BY o.placed_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);
    const result = await db.query(query, params);

    const orders = result.rows.map(order => ({
      id: order.id,
      order_number: order.order_number,
      total_amount: parseFloat(order.total_amount),
      subtotal: parseFloat(order.subtotal),
      delivery_fee: parseFloat(order.delivery_fee),
      tax_amount: parseFloat(order.tax_amount),
      status: order.status,
      placed_at: order.placed_at,
      accepted_at: order.accepted_at,
      ready_for_pickup_at: order.ready_for_pickup_at,
      picked_up_at: order.picked_up_at,
      delivered_at: order.delivered_at,
      restaurant_name: order.restaurant_name,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      item_count: order.item_count
    }));

    res.json({
      success: true,
      orders,
      totalOrders,
      totalPages,
      currentPage: page,
      itemsPerPage: limit
    });
  } catch (error) {
    console.error('Get all orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =============================================================================
// POST /api/manager/orders/:id/publish
// =============================================================================

exports.publishOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const managerId = req.user.id;
    
    const order = await Order.publishOrder(orderId, managerId);
    
    res.json({
      success: true,
      message: 'Order published to available drivers',
      data: order
    });
  } catch (error) {
    console.error('Publish order error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// =============================================================================
// GET /api/manager/orders/pending
// =============================================================================

exports.getPendingOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const restaurantIds = await getManagerRestaurantIds(userId);

    if (restaurantIds === null) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant manager profile not found'
      });
    }

    if (restaurantIds.length === 0) {
      return res.json({ success: true, orders: [] });
    }

    const query = `
      SELECT
        o.id,
        o.order_number,
        o.total_amount,
        o.status,
        o.placed_at,
        o.delivery_address,
        o.special_instructions,
        r.name AS restaurant_name,
        u.first_name || ' ' || u.last_name AS customer_name,
        u.phone_number AS customer_phone,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id)::int AS item_count
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      JOIN customers cust ON o.customer_id = cust.id
      JOIN users u ON cust.user_id = u.id
      WHERE o.restaurant_id = ANY($1)
        AND o.status = 'pending'
      ORDER BY o.placed_at ASC
    `;

    const result = await db.query(query, [restaurantIds]);

    const orders = result.rows.map(order => ({
      id: order.id,
      order_number: order.order_number,
      total_amount: parseFloat(order.total_amount),
      status: order.status,
      placed_at: order.placed_at,
      delivery_address: order.delivery_address,
      special_instructions: order.special_instructions,
      restaurant_name: order.restaurant_name,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      item_count: order.item_count
    }));

    res.json({
      success: true,
      orders
    });
  } catch (error) {
    console.error('Get pending orders error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.rejectOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const managerId = req.user.id;
    const order = await Order.rejectByManager(orderId, managerId);
    res.json({
      success: true,
      message: 'Order rejected and cancelled.',
      data: order
    });
  } catch (error) {
    console.error('Reject order error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

module.exports = exports;