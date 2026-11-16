const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const db = require('../config/database');
const { sanitizeOrderForDriver, sanitizeOrderItemsForDriver } = require('../utils/driverOrderSanitizer');
const { emitManagerEvent, emitUserEvent } = require('../socket');

// Create order
exports.createOrder = async (req, res) => {
  try {
    let customer = await Customer.findByUserId(req.user.id);
    if (!customer) {
      customer = await Customer.create(req.user.id);
    }
    const newOrder = await Order.create(customer.id, req.body);
    // Notify only managers about the new order; drivers will see it only after manager accepts AND customer completes payment.
    const restaurantResult = await db.query('SELECT name FROM restaurants WHERE id = $1', [req.body.restaurant_id]);
    const restaurantName = restaurantResult.rows[0]?.name || 'New order';
    console.log("🔔 Emitting new order notification to managers only...");
    emitManagerEvent(req.body.restaurant_id, 'new_order', {
      orderId: newOrder.id,
      restaurantName,
      total: newOrder.total_amount,
      order_number: newOrder.order_number,
      order: {
        ...newOrder,
        restaurant_name: restaurantName
      }
    });
    res.status(201).json({ success: true, data: newOrder });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get order details
exports.getOrder = async (req, res) => {
  try {
    const order = await Order.findById(
      req.params.id,
      req.user.id,
      req.user.role
    );
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    const items = await Order.getOrderItems(req.params.id);

    let responseOrder = order;
    let responseItems = items;

    if (req.user.role === 'driver') {
      responseOrder = sanitizeOrderForDriver(order);
      responseItems = sanitizeOrderItemsForDriver(items, order.status);
    } else if (req.user.role !== 'customer') {
      delete responseOrder.verification_code;
      delete responseOrder.code_expires_at;
      delete responseOrder.code_used_at;
    }
    
    res.json({
      success: true,
      data: {
        ...responseOrder,
        items: responseItems
      }
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get my orders
exports.getMyOrders = async (req, res) => {
  try {
    const { status, start_date, end_date, page, limit } = req.query;
    
    const filters = {
      status,
      start_date,
      end_date,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20
    };
    
    let orders = await Order.getOrdersByUser(
      req.user.id,
      req.user.role,
      filters
    );

    if (req.user.role === 'driver') {
      orders = orders.map(sanitizeOrderForDriver);
    } else if (req.user.role !== 'customer') {
      orders = orders.map((order) => {
        const filteredOrder = { ...order };
        delete filteredOrder.verification_code;
        delete filteredOrder.code_expires_at;
        delete filteredOrder.code_used_at;
        return filteredOrder;
      });
    }
    
    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('Get my orders error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
// Verify delivery code and mark order as delivered
exports.verifyDeliveryCode = async (req, res) => {
  try {
    const driver = await Driver.findByUserId(req.user.id);
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Delivery code is required'
      });
    }

    const order = await Order.verifyDeliveryCode(req.params.id, driver.id, code);

    res.json({
      success: true,
      data: sanitizeOrderForDriver(order)
    });
  } catch (error) {
    console.error('Verify delivery code error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};
// Accept order (driver)
exports.acceptOrder = async (req, res) => {
  try {
    const driver = await Driver.findByUserId(req.user.id);
    
    const order = await Order.acceptOrder(
      req.params.id,
      driver.id
    );
    
    res.json({
      success: true,
      data: sanitizeOrderForDriver(order)
    });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// Decline order (driver)
exports.declineOrder = async (req, res) => {
  try {
    const driver = await Driver.findByUserId(req.user.id);
    
    const result = await Order.declineOrder(
      req.params.id,
      driver.id
    );

    emitUserEvent(req.user.id, 'order_unavailable', {
      orderId: req.params.id,
      reason: 'declined'
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Decline order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update order status (driver, manager, or system)
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const orderId = req.params.id;
    const userRole = req.user.role;
    
    // Get the order first to validate state
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    // Validate status transitions based on role
    let driver = null;
    let allowed = false;
    
    if (userRole === 'driver') {
      driver = await Driver.findByUserId(req.user.id);
      
      // Drivers can only update orders they accepted
      if (order.driver_id !== driver.id) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to update this order'
        });
      }
      
      // Valid driver transitions: accepted_by_driver / order_ready → picked_up → on_the_way → arrived
      const validDriverTransitions = {
        'accepted_by_driver': ['picked_up', 'on_the_way', 'arrived'],
        'order_ready': ['picked_up', 'on_the_way', 'arrived'],
        'picked_up': ['on_the_way', 'arrived'],
        'on_the_way': ['arrived'],
        'arrived': [],
        'delivered': []
      };
      
      if (status === 'delivered') {
        return res.status(400).json({
          success: false,
          error: 'Delivery must be verified with the customer delivery code. Use the Scan Delivery Code action instead.'
        });
      }

      if (validDriverTransitions[order.status]?.includes(status)) {
        allowed = true;
      }
    } else if (userRole === 'restaurant_manager') {
      // Verify manager owns the restaurant
      const managerRes = await db.query(
        `SELECT r.id, rm.id AS manager_id FROM restaurants r
         JOIN restaurant_managers rm ON r.manager_id = rm.id
         WHERE r.id = $1 AND rm.user_id = $2`,
        [order.restaurant_id, req.user.id]
      );
      
      if (managerRes.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to update this order'
        });
      }

      const managerId = managerRes.rows[0].manager_id;
      
      // Valid manager transitions
      const validManagerTransitions = {
        'pending': ['ordering_at_restaurant', 'cancelled'],
        'ordering_at_restaurant': ['order_ready', 'cancelled'],
        'order_ready': ['picked_up', 'cancelled'],
        'accepted_by_driver': ['order_ready', 'cancelled']
      };
      
      if (validManagerTransitions[order.status]?.includes(status)) {
        allowed = true;
      }

      if (allowed && status === 'order_ready' && order.payment_status !== 'completed') {
        return res.status(400).json({
          success: false,
          error: 'Cannot mark order ready before customer payment is completed'
        });
      }

      if (allowed && status === 'ordering_at_restaurant' && order.status === 'pending') {
        const acceptedOrder = await Order.acceptByManager(orderId, managerId);
        return res.json({ success: true, data: acceptedOrder });
      }

      if (allowed && status === 'cancelled') {
        const rejectedOrder = await Order.rejectByManager(orderId, managerId, req.body.reason || 'Cancelled by restaurant');
        return res.json({ success: true, data: rejectedOrder });
      }
    }
    
    if (!allowed) {
      return res.status(400).json({
        success: false,
        error: `Invalid status transition from ${order.status} to ${status} for ${userRole}`
      });
    }
    
    const lat = req.body.lat ?? req.body.latitude;
    const lng = req.body.lng ?? req.body.longitude;
    const locationCoords = (lat !== undefined && lng !== undefined) ? { lat, lng } : null;

    const updatedOrder = await Order.updateStatus(
      orderId,
      status,
      driver ? driver.id : null,
      locationCoords
    );
    
    res.json({
      success: true,
      data: userRole === 'driver' ? sanitizeOrderForDriver(updatedOrder) : updatedOrder
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get live tracking data for an order
exports.getOrderTracking = async (req, res) => {
  try {
    const order = await Order.findById(
      req.params.id,
      req.user.id,
      req.user.role
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    let history = [];
    try {
      const trackRes = await db.query(
        `SELECT location, accuracy, speed, created_at
         FROM delivery_tracking
         WHERE order_id = $1
         ORDER BY created_at DESC
         LIMIT 25`,
        [order.id]
      );
      history = trackRes.rows;
    } catch {
      // ignore if table not present
    }

    res.json({
      success: true,
      data: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        driver_id: order.driver_id,
        driver_first_name: order.driver_first_name,
        driver_last_name: order.driver_last_name,
        driver_phone: order.driver_phone,
        driver_image: order.driver_image,
        driver_vehicle_type: order.driver_vehicle_type,
        driver_vehicle_model: order.driver_vehicle_model,
        driver_vehicle_color: order.driver_vehicle_color,
        driver_vehicle_plate: order.driver_vehicle_plate,
        driver_location: order.driver_location,
        driver_last_location_update: order.driver_last_location_update,
        restaurant_name: order.restaurant_name,
        restaurant_address: order.restaurant_address,
        restaurant_location: order.restaurant_location,
        delivery_address: order.delivery_address,
        verification_code: req.user.role === 'customer' ? order.verification_code : undefined,
        code_expires_at: req.user.role === 'customer' ? order.code_expires_at : undefined,
        code_used_at: req.user.role === 'customer' ? order.code_used_at : undefined,
        history
      }
    });
  } catch (error) {
    console.error('Get order tracking error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Cancel order (customer before pickup)
exports.cancelOrder = async (req, res) => {
  try {
    const reason = req.body?.reason || 'Cancelled by customer';
    const cancelledOrder = await Order.cancelByCustomer(req.params.id, req.user.id, reason);
    res.json({
      success: true,
      data: cancelledOrder
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// Rate delivered order (customer)
exports.rateOrder = async (req, res) => {
  try {
    const { restaurant_rating, driver_rating } = req.body || {};
    const ratedOrder = await Order.rateOrder(req.params.id, req.user.id, {
      restaurant_rating,
      driver_rating
    });
    res.json({
      success: true,
      data: ratedOrder
    });
  } catch (error) {
    console.error('Rate order error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};