const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrder,
  getMyOrders,
  acceptOrder,
  declineOrder,
  updateOrderStatus,
  verifyDeliveryCode,
  getOrderTracking,
  cancelOrder,
  rateOrder
} = require('../controllers/orderController');
const { auth, authorize } = require('../middleware/auth');

// Customer routes
router.post('/', auth, authorize('customer'), createOrder);
router.post('/:id/cancel', auth, authorize('customer'), cancelOrder);
router.post('/:id/rate', auth, authorize('customer'), rateOrder);

// Specific routes MUST come before parameterized routes
router.get('/my', auth, authorize('customer', 'restaurant_manager', 'driver'), getMyOrders);

// Driver routes
router.post('/:id/accept', auth, authorize('driver'), acceptOrder);
router.post('/:id/decline', auth, authorize('driver'), declineOrder);

// Status update - accessible by drivers and managers
router.patch('/:id/status', auth, authorize('driver', 'restaurant_manager'), updateOrderStatus);

// Delivery code verification - drivers only
router.post('/:id/verify-code', auth, authorize('driver'), verifyDeliveryCode);

// Live tracking route
router.get('/:id/tracking', auth, getOrderTracking);

// Parameterized routes last
router.get('/:id', auth, getOrder);

module.exports = router;