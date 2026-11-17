const express = require('express');
const router = express.Router();
const {
  getDeliveryQuote,
  getSupportContact,
  createOrder,
  getOrder,
  getMyOrders,
  acceptOrder,
  declineOrder,
  updateOrderStatus,
  verifyDeliveryCode,
  reportCustomerUnreachable,
  getOrderTracking,
  getOrderRoute,
  cancelOrder,
  rateOrder
} = require('../controllers/orderController');
const { auth, authorize } = require('../middleware/auth');

// Public/customer delivery distance, radial fee & store hours quote + dispatch support phone
router.post('/delivery-quote', getDeliveryQuote);
router.get('/support-contact', getSupportContact);

// Customer routes
router.post('/', auth, authorize('customer'), createOrder);
router.post('/:id/cancel', auth, authorize('customer'), cancelOrder);
router.post('/:id/rate', auth, authorize('customer'), rateOrder);

// Specific routes MUST come before parameterized routes
router.get('/my', auth, authorize('customer', 'restaurant_manager', 'driver'), getMyOrders);

// Driver routes
router.post('/:id/accept', auth, authorize('driver'), acceptOrder);
router.post('/:id/decline', auth, authorize('driver'), declineOrder);
router.post('/:id/report-customer-unreachable', auth, authorize('driver'), reportCustomerUnreachable);

// Status update - accessible by drivers and managers
router.patch('/:id/status', auth, authorize('driver', 'restaurant_manager'), updateOrderStatus);

// Delivery code verification - drivers only
router.post('/:id/verify-code', auth, authorize('driver'), verifyDeliveryCode);

// Live tracking & OSRM route endpoints
router.get('/:id/tracking', auth, getOrderTracking);
router.get('/:id/route', auth, getOrderRoute);

// Parameterized routes last
router.get('/:id', auth, getOrder);

module.exports = router;