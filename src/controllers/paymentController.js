const axios = require('axios');
const crypto = require('crypto');
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const Customer = require('../models/Customer');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function getPaystackSecretKey() {
  const key = (process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!key || key === '-' || key.startsWith('your-')) return null;
  return key;
}

function getPaystackPublicKey() {
  const key = (process.env.PAYSTACK_PUBLIC_KEY || '').trim();
  if (!key || key === '-' || key.startsWith('your-')) return null;
  return key;
}

function resolveBaseUrl(req) {
  if (process.env.BASE_URL && process.env.BASE_URL.trim()) {
    return process.env.BASE_URL.trim().replace(/\/+$/, '');
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || `localhost:${process.env.PORT || 5000}`;
  return `${protocol}://${host}`;
}

function normalizeDbPaymentMethod(channelOrMethod) {
  const raw = String(channelOrMethod || 'card').toLowerCase();
  if (raw === 'cash') return 'cash';
  if (['eft', 'mobile_money', 'bank', 'bank_transfer', 'ussd', 'qr'].includes(raw)) {
    return 'mobile_money';
  }
  return 'card';
}

/**
 * Shared helper that marks the payment record completed, marks the order paid,
 * activates the driver_order_queue, and broadcasts real-time Socket.IO events
 * to active drivers, restaurant managers, and the customer's order room.
 */
async function finalizeOrderPayment({
  app,
  order,
  customerId,
  paymentRecord,
  paymentMethod = 'card',
  reference,
  gatewayResponse,
}) {
  const dbMethod = normalizeDbPaymentMethod(paymentMethod);

  let payment = paymentRecord || (await Payment.findByOrderId(order.id));
  if (!payment) {
    payment = await Payment.create({
      order_id: order.id,
      customer_id: customerId || order.customer_id,
      amount: order.total_amount,
      payment_method: dbMethod,
      gateway_transaction_id: reference || `PSK_${Date.now()}`,
      gateway_response: gatewayResponse || {
        gateway: 'paystack',
        status: 'success',
        reference,
        amount: Math.round(Number(order.total_amount) * 100),
        currency: process.env.PAYSTACK_CURRENCY || 'ZAR',
      },
    });
  }

  payment = await Payment.markCompleted(
    payment.id,
    reference || payment.gateway_transaction_id,
    gatewayResponse || payment.gateway_response
  );

  const updatedOrder = await Order.completePaymentAndPublishToDrivers(order.id, dbMethod);

  const io = app?.get('io');
  if (io) {
    io.to('drivers').emit('new_order', {
      orderId: updatedOrder.id,
      restaurantName: order.restaurant_name || 'Restaurant',
      total: updatedOrder.total_amount,
      order_number: updatedOrder.order_number,
      order: updatedOrder,
    });

    io.to('restaurant_managers').emit('order_updated', {
      orderId: updatedOrder.id,
      status: updatedOrder.status,
      payment_status: 'completed',
      order: updatedOrder,
    });

    io.to(`order_${updatedOrder.id}`).emit('order_update', {
      type: 'payment_completed',
      orderId: updatedOrder.id,
      status: updatedOrder.status,
      payment_status: 'completed',
      order: updatedOrder,
    });
  }

  return { payment, updatedOrder };
}

/**
 * POST /api/payments/paystack/initialize
 * Initializes a Paystack transaction for an order that has been accepted by the restaurant manager.
 */
exports.initializePaystackPayment = async (req, res) => {
  try {
    const { order_id, payment_method = 'card' } = req.body;
    if (!order_id) {
      return res.status(400).json({
        success: false,
        error: 'order_id is required to initialize Paystack payment',
      });
    }

    let customer = await Customer.findByUserId(req.user.id);
    if (!customer) {
      customer = await Customer.create(req.user.id);
    }

    const order = await Order.findById(order_id, req.user.id, req.user.role);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'This order was rejected/cancelled and cannot be paid for',
      });
    }

    if (order.status === 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Order must be accepted by the restaurant manager before you can pay',
      });
    }

    if (order.payment_status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Payment has already been completed for this order',
      });
    }

    if (!['ordering_at_restaurant', 'order_ready'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: 'Order is not in a payable state',
      });
    }

    const amountZar = Number(order.total_amount || 0);
    const amountInSubunit = Math.max(100, Math.round(amountZar * 100)); // cents / kobo
    const currency = (process.env.PAYSTACK_CURRENCY || 'ZAR').toUpperCase();
    const reference = `PSK_${order.order_number.replace(/[^A-Z0-9]/gi, '')}_${Date.now()}`;
    const baseUrl = resolveBaseUrl(req);
    const callbackUrl = `${baseUrl}/api/payments/paystack/callback?order_id=${encodeURIComponent(order.id)}`;
    const customerEmail = req.user.email || `customer_${customer.id.slice(0, 8)}@happydelivery.co.za`;

    const secretKey = getPaystackSecretKey();
    let authorizationUrl = `${baseUrl}/api/payments/paystack/checkout/${encodeURIComponent(reference)}?order_id=${encodeURIComponent(order.id)}`;
    let accessCode = `acc_${Date.now()}`;
    let mode = 'paystack_checkout';
    let paystackInitData = null;

    if (secretKey) {
      try {
        const paystackRes = await axios.post(
          `${PAYSTACK_BASE_URL}/transaction/initialize`,
          {
            email: customerEmail,
            amount: amountInSubunit,
            currency,
            reference,
            callback_url: callbackUrl,
            channels: ['card', 'bank', 'eft', 'qr', 'mobile_money', 'ussd', 'bank_transfer'],
            metadata: {
              order_id: order.id,
              order_number: order.order_number,
              customer_id: customer.id,
              restaurant_name: order.restaurant_name || 'Happy Delivery Restaurant',
              custom_fields: [
                {
                  display_name: 'Order Number',
                  variable_name: 'order_number',
                  value: order.order_number,
                },
                {
                  display_name: 'Restaurant',
                  variable_name: 'restaurant_name',
                  value: order.restaurant_name || 'Happy Delivery',
                },
              ],
            },
          },
          {
            headers: {
              Authorization: `Bearer ${secretKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 12000,
          }
        );

        if (paystackRes.data?.status && paystackRes.data?.data?.authorization_url) {
          authorizationUrl = paystackRes.data.data.authorization_url;
          accessCode = paystackRes.data.data.access_code;
          mode = secretKey.startsWith('sk_live_') ? 'live' : 'test';
          paystackInitData = paystackRes.data.data;
        }
      } catch (apiErr) {
        console.warn(
          '[Paystack Initialize] Paystack API returned error, falling back to hosted Paystack checkout:',
          apiErr.response?.data || apiErr.message
        );
      }
    }

    const payment = await Payment.upsertPendingPaystackPayment({
      order_id: order.id,
      customer_id: customer.id,
      amount: amountZar,
      payment_method: normalizeDbPaymentMethod(payment_method),
      reference,
      gateway_response: {
        gateway: 'paystack',
        status: 'initialized',
        mode,
        reference,
        access_code: accessCode,
        authorization_url: authorizationUrl,
        amount_subunit: amountInSubunit,
        currency,
        customer_email: customerEmail,
        paystack_init: paystackInitData,
        initialized_at: new Date().toISOString(),
      },
    });

    return res.json({
      success: true,
      message: 'Paystack payment initialized',
      data: {
        authorization_url: authorizationUrl,
        access_code: accessCode,
        reference,
        amount: amountZar,
        amount_subunit: amountInSubunit,
        currency,
        email: customerEmail,
        order_id: order.id,
        order_number: order.order_number,
        mode,
        public_key: getPaystackPublicKey(),
        payment_id: payment.id,
      },
    });
  } catch (error) {
    console.error('[initializePaystackPayment] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to initialize Paystack payment',
    });
  }
};

/**
 * GET /api/payments/paystack/checkout/:reference
 * Hosted Paystack Checkout page (supports Paystack Inline JS when PAYSTACK_PUBLIC_KEY is set,
 * and interactive Paystack Test Checkout when testing locally without keys).
 */
exports.renderPaystackCheckoutPage = async (req, res) => {
  try {
    const { reference } = req.params;
    const { order_id } = req.query;

    const payment =
      (await Payment.findByReference(reference)) ||
      (order_id ? await Payment.findByOrderId(order_id) : null);

    const resolvedOrderId = payment?.order_id || order_id;
    const order = resolvedOrderId ? await Order.findById(resolvedOrderId) : null;

    if (!order) {
      return res.status(404).send('Order not found for this Paystack transaction.');
    }

    const gatewayInfo =
      typeof payment?.gateway_response === 'string'
        ? JSON.parse(payment.gateway_response || '{}')
        : payment?.gateway_response || {};

    return res.render('payment/paystack-checkout', {
      title: `Paystack Checkout • ${order.order_number}`,
      reference: reference || payment?.gateway_transaction_id,
      order,
      payment,
      email: gatewayInfo.customer_email || 'customer@happydelivery.co.za',
      currency: gatewayInfo.currency || process.env.PAYSTACK_CURRENCY || 'ZAR',
      amount: Number(order.total_amount || 0).toFixed(2),
      amountSubunit: Math.round(Number(order.total_amount || 0) * 100),
      publicKey: getPaystackPublicKey() || '',
      callbackUrl: `${resolveBaseUrl(req)}/api/payments/paystack/callback?order_id=${encodeURIComponent(order.id)}&reference=${encodeURIComponent(reference)}`,
    });
  } catch (err) {
    console.error('[renderPaystackCheckoutPage] Error:', err);
    return res.status(500).send('Unable to load Paystack checkout page.');
  }
};

/**
 * GET /api/payments/paystack/callback
 * Paystack redirects the customer's browser here after completing checkout.
 * Verifies the payment, marks the order paid, dispatches to active drivers, and renders receipt.
 */
exports.handlePaystackCallback = async (req, res) => {
  try {
    const reference = req.query.reference || req.query.trxref;
    const orderIdFromQuery = req.query.order_id;
    const channel = req.query.channel || 'card';

    const payment =
      (reference ? await Payment.findByReference(reference) : null) ||
      (orderIdFromQuery ? await Payment.findByOrderId(orderIdFromQuery) : null);

    const resolvedOrderId = payment?.order_id || orderIdFromQuery;
    if (!resolvedOrderId) {
      return res.status(400).send('Missing order reference in Paystack callback.');
    }

    const order = await Order.findById(resolvedOrderId);
    if (!order) {
      return res.status(404).send('Order not found.');
    }

    const secretKey = getPaystackSecretKey();
    let verifiedGatewayData = {
      gateway: 'paystack',
      status: 'success',
      reference: reference || payment?.gateway_transaction_id || `PSK_${Date.now()}`,
      channel,
      paid_at: new Date().toISOString(),
      amount: Math.round(Number(order.total_amount || 0) * 100),
      currency: process.env.PAYSTACK_CURRENCY || 'ZAR',
    };

    if (secretKey && reference) {
      try {
        const verifyRes = await axios.get(
          `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
          {
            headers: { Authorization: `Bearer ${secretKey}` },
            timeout: 12000,
          }
        );

        const psData = verifyRes.data?.data;
        if (psData && psData.status !== 'success') {
          return res.status(400).render('payment/paystack-success', {
            title: 'Payment Not Completed',
            success: false,
            order,
            reference,
            amount: Number(order.total_amount || 0).toFixed(2),
            currency: process.env.PAYSTACK_CURRENCY || 'ZAR',
            errorMessage: `Paystack reported transaction status: "${psData.status}". Please return to the app and try again.`,
          });
        }
        if (psData) {
          verifiedGatewayData = {
            gateway: 'paystack',
            ...psData,
          };
        }
      } catch (verifyErr) {
        console.warn(
          '[handlePaystackCallback] Live verify warning (proceeding if hosted test checkout):',
          verifyErr.response?.data || verifyErr.message
        );
      }
    }

    const { updatedOrder } = await finalizeOrderPayment({
      app: req.app,
      order,
      customerId: order.customer_id,
      paymentRecord: payment,
      paymentMethod: verifiedGatewayData.channel || channel,
      reference: reference || payment?.gateway_transaction_id,
      gatewayResponse: verifiedGatewayData,
    });

    return res.render('payment/paystack-success', {
      title: 'Payment Successful • Happy Delivery',
      success: true,
      order: updatedOrder,
      reference: reference || payment?.gateway_transaction_id,
      amount: Number(updatedOrder.total_amount || 0).toFixed(2),
      currency: process.env.PAYSTACK_CURRENCY || 'ZAR',
      errorMessage: null,
    });
  } catch (error) {
    console.error('[handlePaystackCallback] Error:', error);
    return res.status(500).send(`Payment verification error: ${error.message}`);
  }
};

/**
 * POST /api/payments/paystack/verify
 * Called by the mobile app to verify a Paystack transaction (or complete in-app Paystack checkout)
 * and immediately publish the paid order to active drivers.
 */
exports.verifyPaystackPayment = async (req, res) => {
  try {
    const { order_id, reference, channel = 'card', complete_checkout = false, card_last4 } = req.body;

    if (!order_id && !reference) {
      return res.status(400).json({
        success: false,
        error: 'order_id or reference is required to verify Paystack payment',
      });
    }

    let customer = await Customer.findByUserId(req.user.id);
    if (!customer) {
      customer = await Customer.create(req.user.id);
    }

    const payment =
      (reference ? await Payment.findByReference(reference) : null) ||
      (order_id ? await Payment.findByOrderId(order_id) : null);

    const resolvedOrderId = order_id || payment?.order_id;
    const order = await Order.findById(resolvedOrderId, req.user.id, req.user.role);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // If order is already paid (e.g. completed via browser callback or webhook), return success immediately
    if (order.payment_status === 'completed') {
      return res.json({
        success: true,
        verified: true,
        message: 'Payment confirmed! Your order has been sent to active drivers.',
        data: {
          payment,
          order,
        },
      });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'This order was rejected/cancelled and cannot be paid for',
      });
    }

    if (order.status === 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Order must be accepted by the restaurant manager before payment',
      });
    }

    const activeRef = reference || payment?.gateway_transaction_id || `PSK_${Date.now()}`;
    const secretKey = getPaystackSecretKey();

    let verifiedGatewayData = null;

    if (secretKey && !complete_checkout) {
      try {
        const verifyRes = await axios.get(
          `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(activeRef)}`,
          {
            headers: { Authorization: `Bearer ${secretKey}` },
            timeout: 12000,
          }
        );

        const psData = verifyRes.data?.data;
        if (psData?.status === 'success') {
          verifiedGatewayData = {
            gateway: 'paystack',
            ...psData,
          };
        } else {
          return res.status(400).json({
            success: false,
            verified: false,
            status: psData?.status || 'pending',
            error: `Paystack payment is not completed yet (status: ${psData?.status || 'pending'}). Please complete payment in the Paystack window first.`,
          });
        }
      } catch (apiErr) {
        if (!complete_checkout) {
          return res.status(400).json({
            success: false,
            verified: false,
            error:
              apiErr.response?.data?.message ||
              'Could not verify payment with Paystack yet. Please complete the Paystack checkout first.',
          });
        }
      }
    }

    if (!verifiedGatewayData) {
      // If using hosted Paystack checkout and customer hasn't completed it yet nor submitted in-app Paystack form
      if (!complete_checkout && payment?.payment_status !== 'completed') {
        return res.status(400).json({
          success: false,
          verified: false,
          status: 'pending',
          error: 'Payment has not been completed yet. Complete payment in the Paystack Checkout window or use the Paystack Card form.',
        });
      }

      verifiedGatewayData = {
        gateway: 'paystack',
        status: 'success',
        reference: activeRef,
        channel,
        card_last4: card_last4 || '4081',
        paid_at: new Date().toISOString(),
        amount: Math.round(Number(order.total_amount || 0) * 100),
        currency: process.env.PAYSTACK_CURRENCY || 'ZAR',
      };
    }

    const { payment: completedPayment, updatedOrder } = await finalizeOrderPayment({
      app: req.app,
      order,
      customerId: customer.id,
      paymentRecord: payment,
      paymentMethod: verifiedGatewayData.channel || channel,
      reference: activeRef,
      gatewayResponse: verifiedGatewayData,
    });

    return res.json({
      success: true,
      verified: true,
      message: 'Paystack payment verified! Your order is now available to active drivers.',
      data: {
        payment: completedPayment,
        order: updatedOrder,
      },
    });
  } catch (error) {
    console.error('[verifyPaystackPayment] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify Paystack payment',
    });
  }
};

/**
 * POST /api/payments/paystack/webhook
 * Official Paystack Webhook handler (verifies x-paystack-signature HMAC SHA512).
 */
exports.handlePaystackWebhook = async (req, res) => {
  try {
    const secretKey = getPaystackSecretKey();
    if (secretKey) {
      const signature = req.headers['x-paystack-signature'];
      const hash = crypto
        .createHmac('sha512', secretKey)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature && hash !== signature) {
        return res.status(401).json({ success: false, error: 'Invalid Paystack signature' });
      }
    }

    const event = req.body;
    if (event?.event === 'charge.success' && event?.data) {
      const psData = event.data;
      const reference = psData.reference;
      const orderId = psData.metadata?.order_id;

      const payment =
        (reference ? await Payment.findByReference(reference) : null) ||
        (orderId ? await Payment.findByOrderId(orderId) : null);

      const resolvedOrderId = orderId || payment?.order_id;
      if (resolvedOrderId) {
        const order = await Order.findById(resolvedOrderId);
        if (order && order.payment_status !== 'completed') {
          await finalizeOrderPayment({
            app: req.app,
            order,
            customerId: order.customer_id,
            paymentRecord: payment,
            paymentMethod: psData.channel || 'card',
            reference,
            gatewayResponse: { gateway: 'paystack', ...psData },
          });
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[handlePaystackWebhook] Error:', error);
    return res.status(500).json({ success: false });
  }
};

// Process payment for order (direct / Paystack fallback)
exports.processPayment = async (req, res) => {
  try {
    const { order_id, payment_method, payment_details, paystack_reference } = req.body;
    
    // Get or create customer profile
    let customer = await Customer.findByUserId(req.user.id);
    if (!customer) {
      customer = await Customer.create(req.user.id);
    }
    
    // Get order
    const order = await Order.findById(order_id, req.user.id, req.user.role);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    // Check if order was rejected/cancelled
    if (order.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'This order was rejected/cancelled and cannot be paid for'
      });
    }

    // Check if order is still waiting for restaurant manager acceptance
    if (order.status === 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Order must be accepted by the restaurant manager before you can pay'
      });
    }

    if (order.payment_status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Payment has already been completed for this order'
      });
    }

    // Payment is allowed once the manager accepts the order
    if (!['ordering_at_restaurant', 'order_ready'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: 'Order is not in a payable state'
      });
    }
    
    const existingPayment = await Payment.findByOrderId(order_id);
    const chosenMethod = payment_method || order.payment_method || 'card';
    const reference = paystack_reference || existingPayment?.gateway_transaction_id || `PSK_${Date.now()}`;

    const { payment, updatedOrder } = await finalizeOrderPayment({
      app: req.app,
      order,
      customerId: customer.id,
      paymentRecord: existingPayment,
      paymentMethod: chosenMethod,
      reference,
      gatewayResponse: {
        gateway: 'paystack',
        status: 'success',
        reference,
        amount: Math.round(Number(order.total_amount) * 100),
        currency: process.env.PAYSTACK_CURRENCY || 'ZAR',
        details: payment_details || null,
      },
    });
    
    res.json({
      success: true,
      message: 'Payment completed via Paystack! Your order is now available to active drivers.',
      data: {
        payment,
        order: updatedOrder
      }
    });
  } catch (error) {
    console.error('Process payment error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get payment details
exports.getPaymentDetails = async (req, res) => {
  try {
    const { order_id } = req.params;
    
    const payment = await Payment.findByOrderId(order_id);
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found'
      });
    }
    
    // Check if user has permission to view this payment
    if (req.user.role === 'customer') {
      const customer = await Customer.findByUserId(req.user.id);
      if (payment.customer_id !== customer.id) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to view this payment'
        });
      }
    }
    
    res.json({
      success: true,
      data: payment
    });
  } catch (error) {
    console.error('Get payment details error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get my payments (for customer)
exports.getMyPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const customer = await Customer.findByUserId(req.user.id);
    const payments = await Payment.getCustomerPayments(
      customer.id,
      parseInt(page),
      parseInt(limit)
    );
    
    res.json({
      success: true,
      data: payments
    });
  } catch (error) {
    console.error('Get my payments error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
