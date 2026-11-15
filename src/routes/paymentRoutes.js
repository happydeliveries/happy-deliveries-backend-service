const express = require('express');
const router = express.Router();
const {
  initializePaystackPayment,
  verifyPaystackPayment,
  renderPaystackCheckoutPage,
  handlePaystackCallback,
  handlePaystackWebhook,
  processPayment,
  getPaymentDetails,
  getMyPayments
} = require('../controllers/paymentController');
const { auth, authorize } = require('../middleware/auth');

// Public Paystack checkout, callback & webhook routes
router.get('/paystack/checkout/:reference', renderPaystackCheckoutPage);
router.get('/paystack/callback', handlePaystackCallback);
router.post('/paystack/webhook', handlePaystackWebhook);

// Authenticated Customer Paystack routes
router.post('/paystack/initialize', auth, authorize('customer'), initializePaystackPayment);
router.post('/paystack/verify', auth, authorize('customer'), verifyPaystackPayment);

// Customer routes
router.post('/process', auth, authorize('customer'), processPayment);
router.get('/my', auth, authorize('customer'), getMyPayments);
router.get('/:order_id', auth, getPaymentDetails);

module.exports = router;
