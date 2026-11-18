'use strict';

const express = require('express');
const router = express.Router();
const db = require('../src/config/database');
const User = require('../src/models/User');
const RestaurantManager = require('../src/models/RestaurantManager');
const Restaurant = require('../src/models/Restaurant');
const Menu = require('../src/models/Menu');
const Order = require('../src/models/Order');
const EmailService = require('../src/utils/emailService');
const {
  resolveAccessibleRestaurants,
  resolveAccessibleRestaurantIds,
  verifyRestaurantAccess,
  verifyMenuAccess,
  verifyMenuItemAccess,
  fetchPaginatedOrders,
  fetchOrderDetail,
  parseBool,
} = require('../src/utils/restaurantAccess');
const { handleSingleImageUpload } = require('../src/utils/imageUpload');

// ═══════════════════════════════════════════════════════════════════════════════
//  PARTNER AUTH HELPERS (Session-isolated via req.session.restaurantUser)
// ═══════════════════════════════════════════════════════════════════════════════

const isPartnerLoggedIn = (req, res, next) => {
  if (req.session?.restaurantUser?.id && req.session?.restaurantUser?.role === 'restaurant_manager') {
    return next();
  }
  res.redirect('/restaurant/login');
};

const isPartnerApiLoggedIn = (req, res, next) => {
  if (req.session?.restaurantUser?.id && req.session?.restaurantUser?.role === 'restaurant_manager') {
    return next();
  }
  res.status(401).json({ success: false, error: 'Unauthorized. Please sign in to the Restaurant Portal.' });
};

async function resolvePartnerSession(req) {
  const sessionUser = req.session?.restaurantUser;
  if (!sessionUser?.id) return null;

  await Restaurant.ensureApplicationColumns();
  const rm = await RestaurantManager.findByUserId(sessionUser.id);
  if (!rm) return null;

  // Strictly scope restaurant partners to their own restaurants; also allow preview if platform admin explicitly signs into partner portal for a specific restaurant
  const restaurants = await Restaurant.findByManager(rm.id);
  const ownedRestaurants = restaurants.length > 0
    ? restaurants
    : await db.query(
        `SELECT *, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM restaurants WHERE owner_user_id = $1 ORDER BY created_at DESC`,
        [sessionUser.id]
      ).then((r) => r.rows);

  const normalizedList = (await Promise.all(
    ownedRestaurants.map((r) => Restaurant.findByIdWithOwner(r.id))
  )).filter(Boolean);

  return {
    user: sessionUser,
    manager: {
      ...rm,
      user_id: sessionUser.id,
      account_type: rm.account_type || 'restaurant_partner',
    },
    restaurants: normalizedList,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC REGISTRATION & APPLICATION STATUS PORTAL
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', (req, res) => {
  if (req.session?.restaurantUser?.id) return res.redirect('/restaurant/dashboard');
  res.redirect('/restaurant/login');
});

router.get(['/register', '/apply'], (req, res) => {
  res.render('restaurant/register', {
    title: 'Restaurant Registration Portal · Happy Deliveries',
  });
});

/**
 * POST /restaurant/api/applications
 * Public endpoint for restaurants to submit a new application or resubmit an existing pending/rejected one.
 */
router.post('/api/applications', async (req, res) => {
  try {
    await Restaurant.ensureApplicationColumns();
    const b = req.body || {};
    const email = String(b.owner_email || b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const firstName = String(b.first_name || b.owner_first_name || '').trim();
    const lastName = String(b.last_name || b.owner_last_name || '').trim();
    const restaurantName = String(b.restaurant_name || b.name || '').trim();
    const address = String(b.address || '').trim();
    const restaurantPhone = String(b.restaurant_phone || b.phone_number || '').trim();

    if (!firstName || !lastName || !email || !password || !restaurantName || !address || !restaurantPhone) {
      return res.status(400).json({
        success: false,
        error: 'Please fill in all required owner, login email, password, restaurant name, phone, and address fields.',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long.',
      });
    }

    const existingUser = await User.findByEmail(email);

    // If an account with this email already exists, verify password & allow updating pending/rejected restaurant app
    if (existingUser) {
      if (existingUser.role !== 'restaurant_manager') {
        return res.status(409).json({
          success: false,
          error: 'This email address is already registered to another Happy Deliveries account.',
        });
      }

      const validPass = await User.verifyPassword(password, existingUser.password_hash);
      if (!validPass) {
        return res.status(409).json({
          success: false,
          error: 'A restaurant application with this email already exists. Enter your matching password to update/resubmit, or check status on the next tab.',
        });
      }

      const existingApp = await Restaurant.findApplicationByEmail(email);
      if (!existingApp || existingApp.account_type !== 'restaurant_partner') {
        return res.status(409).json({
          success: false,
          error: 'This email belongs to a platform manager account. Please sign in at /manager/login or use another restaurant email.',
        });
      }

      if (existingApp.approval_status === 'approved') {
        return res.status(400).json({
          success: false,
          error: 'Your restaurant is already approved! Please sign in to the Restaurant Partner Portal.',
        });
      }

      const updated = await Restaurant.updateApplication(existingApp.id, {
        ...b,
        first_name: firstName,
        last_name: lastName,
      });

      const io = req.app?.get('io');
      if (io) {
        io.to('restaurant_managers').emit('restaurant_application_resubmitted', {
          restaurant_id: updated.id,
          name: updated.name,
          owner_name: `${firstName} ${lastName}`,
          email,
          cuisine_type: updated.cuisine_type,
          updated_at: new Date().toISOString(),
        });
      }

      return res.json({
        success: true,
        resubmitted: true,
        message: 'Your restaurant application has been updated and resubmitted for Happy Deliveries admin review.',
        restaurant: updated,
      });
    }

    // Create brand-new restaurant partner application
    const created = await Restaurant.registerApplication({
      ...b,
      first_name: firstName,
      last_name: lastName,
      email,
      password,
    });

    try {
      const { code, token } = await User.issueEmailVerification(created.user.id);
      const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      const verifyUrl = `${proto}://${host}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
      await EmailService.sendEmailVerificationEmail(created.user, {
        code,
        verifyUrl,
        portalLabel: 'Happy Deliveries Restaurant Partner Portal',
      });
    } catch (emailErr) {
      console.warn('[POST /restaurant/api/applications verification email]', emailErr.message);
    }

    try {
      await EmailService.sendRestaurantApplicationReceivedEmail(created.user, created.restaurant);
    } catch (emailErr) {
      console.warn('[POST /restaurant/api/applications email]', emailErr.message);
    }

    const io = req.app?.get('io');
    if (io) {
      io.to('restaurant_managers').emit('new_restaurant_application', {
        restaurant_id: created.restaurant.id,
        name: created.restaurant.name,
        owner_name: `${firstName} ${lastName}`,
        email,
        cuisine_type: created.restaurant.cuisine_type,
        created_at: new Date().toISOString(),
      });
    }

    res.status(201).json({
      success: true,
      requires_email_verification: true,
      message: 'Application submitted! Please verify your email using the link sent to your inbox while Happy Deliveries management reviews your restaurant.',
      restaurant: created.restaurant,
    });
  } catch (err) {
    console.error('[POST /restaurant/api/applications]', err);
    res.status(400).json({
      success: false,
      error: err.message || 'Failed to submit restaurant application.',
    });
  }
});

/**
 * POST /restaurant/api/applications/status
 * Lets an applicant verify email + password and inspect live review status / rejection feedback.
 */
router.post('/api/applications/status', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const appRecord = await Restaurant.findApplicationByEmail(email);
    if (!appRecord) {
      return res.status(404).json({ success: false, error: 'No restaurant application found for that email address.' });
    }

    const validPass = await User.verifyPassword(password, appRecord.owner_password_hash);
    if (!validPass) {
      return res.status(401).json({ success: false, error: 'Incorrect password for this restaurant application.' });
    }

    const { owner_password_hash, ...safeRestaurant } = appRecord;
    res.json({
      success: true,
      restaurant: safeRestaurant,
    });
  } catch (err) {
    console.error('[POST /restaurant/api/applications/status]', err);
    res.status(500).json({ success: false, error: 'Failed to check application status.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RESTAURANT PARTNER LOGIN / LOGOUT & SSR PORTAL
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/login', (req, res) => {
  if (req.session?.restaurantUser?.id) return res.redirect('/restaurant/dashboard');
  res.render('restaurant/login', {
    title: 'Restaurant Partner Login · Happy Deliveries',
    error: null,
    success: null,
  });
});

router.post('/login', async (req, res) => {
  try {
    await Restaurant.ensureApplicationColumns();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const user = await User.findByEmail(email);
    if (!user || user.role !== 'restaurant_manager') {
      return res.render('restaurant/login', {
        title: 'Restaurant Partner Login · Happy Deliveries',
        error: 'Invalid email or password for a Restaurant Partner account.',
        success: null,
      });
    }

    const valid = await User.verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.render('restaurant/login', {
        title: 'Restaurant Partner Login · Happy Deliveries',
        error: 'Invalid email or password.',
        success: null,
      });
    }

    if (!user.email_verified) {
      return res.render('restaurant/login', {
        title: 'Restaurant Partner Login · Happy Deliveries',
        error: 'Please verify your email address before signing in. Check your inbox for the verification link or code.',
        success: null,
        unverifiedEmail: user.email,
      });
    }

    const rm = await RestaurantManager.findByUserId(user.id);
    if (!rm) {
      return res.render('restaurant/login', {
        title: 'Restaurant Partner Login · Happy Deliveries',
        error: 'Restaurant manager profile not found.',
        success: null,
      });
    }

    if (rm.account_type === 'restaurant_partner') {
      const appRecord = await Restaurant.findApplicationByEmail(email);
      const approvalStatus = appRecord?.approval_status || rm.approval_status || (user.is_active === false ? 'pending' : 'approved');

      if (approvalStatus === 'rejected') {
        return res.render('restaurant/login', {
          title: 'Restaurant Partner Login · Happy Deliveries',
          error: `Your restaurant application was not approved: "${appRecord?.rejection_reason || 'Please check your application status to fix and resubmit.'}"`,
          success: null,
        });
      }
      if (approvalStatus === 'pending' || user.is_active === false) {
        return res.render('restaurant/login', {
          title: 'Restaurant Partner Login · Happy Deliveries',
          error: 'Your restaurant application is still pending review by Happy Deliveries management. We will email you once approved.',
          success: null,
        });
      }
    }

    req.session.restaurantUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
      manager_id: rm.id,
      account_type: rm.account_type || 'restaurant_partner',
    };

    return res.redirect('/restaurant/dashboard');
  } catch (err) {
    console.error('[POST /restaurant/login]', err);
    return res.render('restaurant/login', {
      title: 'Restaurant Partner Login · Happy Deliveries',
      error: 'An unexpected error occurred. Please try again.',
      success: null,
    });
  }
});

router.get('/logout', (req, res) => {
  if (req.session) {
    delete req.session.restaurantUser;
  }
  res.redirect('/restaurant/login');
});

function renderPortalSection(section) {
  return async (req, res) => {
    try {
      const ctx = await resolvePartnerSession(req);
      if (!ctx || !ctx.restaurants.length) {
        delete req.session.restaurantUser;
        return res.redirect('/restaurant/login');
      }

      const activeId = req.query.restaurantId;
      const selectedRestaurant = ctx.restaurants.find((r) => r.id === activeId) || ctx.restaurants[0];
      const supportContact = await Order.getSupportContact().catch(() => ({
        support_phone: process.env.SUPPORT_PHONE || null,
        support_name: 'Happy Deliveries Dispatch',
      }));

      res.render('restaurant/portal', {
        title: `${selectedRestaurant.name} · Restaurant Partner Portal`,
        activeSection: section,
        partner: ctx.user,
        manager: ctx.manager,
        restaurants: ctx.restaurants,
        restaurant: selectedRestaurant,
        supportContact,
      });
    } catch (err) {
      console.error(`[GET /restaurant/${section}]`, err);
      res.redirect('/restaurant/login');
    }
  };
}

router.get('/dashboard', isPartnerLoggedIn, renderPortalSection('overview'));
router.get('/kitchen', isPartnerLoggedIn, renderPortalSection('kitchen'));
router.get('/orders', isPartnerLoggedIn, renderPortalSection('orders'));
router.get('/menus', isPartnerLoggedIn, renderPortalSection('menus'));
router.get('/settings', isPartnerLoggedIn, renderPortalSection('settings'));
router.get('/profile', isPartnerLoggedIn, renderPortalSection('settings'));

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTHENTICATED RESTAURANT PARTNER APIs
// ═══════════════════════════════════════════════════════════════════════════════

/** Helper: verify req.query/body restaurantId or default to first partner restaurant */
async function resolveTargetRestaurant(req, ctx) {
  const requestedId = req.params.restaurantId || req.query.restaurantId || req.body?.restaurantId;
  if (requestedId) {
    const match = ctx.restaurants.find((r) => r.id === requestedId);
    if (!match) return null;
    // Double check DB ownership
    return verifyRestaurantAccess(match.id, ctx.manager);
  }
  return ctx.restaurants[0] || null;
}

router.get('/api/portal/summary', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Partner session invalid' });

    const restaurant = await resolveTargetRestaurant(req, ctx);
    if (!restaurant) return res.status(403).json({ success: false, error: 'Restaurant access denied' });

    const [statsRes, menuCountRes, recentOrdersRes] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
          COUNT(*) FILTER (
            WHERE status IN ('pending','ordering_at_restaurant','accepted_by_driver','order_ready')
          )::int AS kitchen_orders,
          COUNT(*) FILTER (
            WHERE status IN ('pending','accepted_by_driver','ordering_at_restaurant','order_ready','picked_up','on_the_way')
          )::int AS active_orders,
          COUNT(*) FILTER (
            WHERE placed_at >= CURRENT_DATE AND placed_at < CURRENT_DATE + INTERVAL '1 day'
          )::int AS today_orders,
          COALESCE(SUM(total_amount) FILTER (
            WHERE placed_at >= CURRENT_DATE AND placed_at < CURRENT_DATE + INTERVAL '1 day' AND status = 'delivered'
          ), 0) AS today_revenue,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'delivered'), 0) AS total_revenue
        FROM orders
        WHERE restaurant_id = $1
      `, [restaurant.id]),
      db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM menus WHERE restaurant_id = $1) AS menu_count,
          (SELECT COUNT(*)::int FROM menu_items WHERE restaurant_id = $1) AS item_count,
          (SELECT COUNT(*)::int FROM menu_items WHERE restaurant_id = $1 AND is_available = true) AS available_item_count
      `, [restaurant.id]),
      fetchPaginatedOrders([restaurant.id], { page: 1, limit: 8 }),
    ]);

    const s = statsRes.rows[0] || {};
    const m = menuCountRes.rows[0] || {};

    res.json({
      success: true,
      restaurant,
      stats: {
        total_orders: s.total_orders || 0,
        pending_orders: s.pending_orders || 0,
        kitchen_orders: s.kitchen_orders || 0,
        active_orders: s.active_orders || 0,
        today_orders: s.today_orders || 0,
        today_revenue: parseFloat(s.today_revenue || 0).toFixed(2),
        total_revenue: parseFloat(s.total_revenue || 0).toFixed(2),
        menu_count: m.menu_count || 0,
        item_count: m.item_count || 0,
        available_item_count: m.available_item_count || 0,
      },
      recentOrders: recentOrdersRes.orders,
    });
  } catch (err) {
    console.error('[GET /restaurant/api/portal/summary]', err);
    res.status(500).json({ success: false, error: 'Failed to load portal summary' });
  }
});

router.post('/api/upload', isPartnerApiLoggedIn, handleSingleImageUpload);

/** PUT /restaurant/api/restaurant — update partner's restaurant info & operational settings */
router.put('/api/restaurant', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Partner session invalid' });

    const target = await resolveTargetRestaurant(req, ctx);
    if (!target) return res.status(403).json({ success: false, error: 'Restaurant access denied' });

    const b = req.body || {};
    const setClause = [];
    const values = [];
    let idx = 1;
    const add = (col, val) => {
      if (val !== undefined) {
        setClause.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };

    if (b.name && String(b.name).trim()) add('name', String(b.name).trim());
    if (b.description !== undefined) add('description', String(b.description).trim() || null);
    if (b.cuisine_type !== undefined) {
      const cuisineStr = Array.isArray(b.cuisine_type)
        ? b.cuisine_type.map(c => String(c).trim()).filter(Boolean).join(', ')
        : String(b.cuisine_type).trim();
      add('cuisine_type', cuisineStr || null);
    }
    if (b.phone_number !== undefined) add('phone_number', String(b.phone_number).trim() || null);
    if (b.email !== undefined) add('email', String(b.email).trim() || null);
    if (b.address && String(b.address).trim()) add('address', String(b.address).trim());
    if (b.delivery_radius_km !== undefined && b.delivery_radius_km !== '') {
      add('delivery_radius_km', Math.max(1, parseInt(b.delivery_radius_km, 10) || 5));
    }
    if (b.preparation_time_minutes !== undefined && b.preparation_time_minutes !== '') {
      add('preparation_time_minutes', Math.max(5, parseInt(b.preparation_time_minutes, 10) || 20));
    }
    if (b.opening_hours !== undefined || b.opening_hours_display !== undefined) {
      const hoursVal = b.opening_hours && typeof b.opening_hours === 'object'
        ? JSON.stringify(b.opening_hours)
        : JSON.stringify({ display: String(b.opening_hours_display || b.opening_hours || '08:00 - 21:00').trim() });
      add('opening_hours', hoursVal);
    }
    if (b.logo_url !== undefined) add('logo_url', String(b.logo_url).trim() || null);
    if (b.cover_image_url !== undefined) add('cover_image_url', String(b.cover_image_url).trim() || null);
    if (b.is_active !== undefined && b.is_active !== '') add('is_active', parseBool(b.is_active, true));
    if (b.is_accepting_orders !== undefined && b.is_accepting_orders !== '') {
      add('is_accepting_orders', parseBool(b.is_accepting_orders, true));
    }

    if (b.latitude !== undefined && b.longitude !== undefined && b.latitude !== '' && b.longitude !== '') {
      const lat = parseFloat(b.latitude);
      const lng = parseFloat(b.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        setClause.push(`location = ST_SetSRID(ST_MakePoint($${idx}, $${idx + 1}), 4326)`);
        values.push(lng, lat);
        idx += 2;
      }
    }

    if (!setClause.length) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(target.id);
    const { rows } = await db.query(
      `UPDATE restaurants SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${idx}
       RETURNING *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat`,
      values
    );

    const normalized = Restaurant.normalizeRestaurantRecord(rows[0]);
    res.json({ success: true, message: 'Restaurant details updated successfully.', restaurant: normalized });
  } catch (err) {
    console.error('[PUT /restaurant/api/restaurant]', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update restaurant' });
  }
});

router.patch('/api/restaurant/toggle-accepting', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    const target = ctx ? await resolveTargetRestaurant(req, ctx) : null;
    if (!target) return res.status(403).json({ success: false, error: 'Restaurant access denied' });

    const { rows } = await db.query(
      `UPDATE restaurants SET is_accepting_orders = NOT is_accepting_orders, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat`,
      [target.id]
    );
    res.json({ success: true, restaurant: Restaurant.normalizeRestaurantRecord(rows[0]) });
  } catch (err) {
    console.error('[PATCH /restaurant/api/restaurant/toggle-accepting]', err);
    res.status(500).json({ success: false, error: 'Failed to toggle order acceptance' });
  }
});

router.patch('/api/restaurant/toggle-active', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    const target = ctx ? await resolveTargetRestaurant(req, ctx) : null;
    if (!target) return res.status(403).json({ success: false, error: 'Restaurant access denied' });

    const { rows } = await db.query(
      `UPDATE restaurants SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat`,
      [target.id]
    );
    res.json({ success: true, restaurant: Restaurant.normalizeRestaurantRecord(rows[0]) });
  } catch (err) {
    console.error('[PATCH /restaurant/api/restaurant/toggle-active]', err);
    res.status(500).json({ success: false, error: 'Failed to toggle visibility' });
  }
});

// ── Menus & Menu Items CRUD (Partner-Scoped) ──────────────────────────────────

router.get('/api/menus', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    const target = ctx ? await resolveTargetRestaurant(req, ctx) : null;
    if (!target) return res.status(403).json({ success: false, error: 'Restaurant access denied' });

    const menus = await Menu.findByRestaurant(target.id, { onlyActive: false });
    res.json({ success: true, menus });
  } catch (err) {
    console.error('[GET /restaurant/api/menus]', err);
    res.status(500).json({ success: false, error: 'Failed to load menus' });
  }
});

router.post('/api/menus', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    const target = ctx ? await resolveTargetRestaurant(req, ctx) : null;
    if (!target) return res.status(403).json({ success: false, error: 'Restaurant access denied' });

    const { name, description, display_order = 0, is_active = true } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Menu name is required' });
    }

    const menu = await Menu.create(target.id, {
      name: String(name).trim(),
      description: String(description || '').trim() || null,
      is_active: parseBool(is_active, true),
      display_order: parseInt(display_order, 10) || 0,
    });
    res.status(201).json({ success: true, menu });
  } catch (err) {
    console.error('[POST /restaurant/api/menus]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/api/menus/:id', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const owns = await verifyMenuAccess(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!owns) return res.status(403).json({ success: false, error: 'Access denied' });

    const { name, description, is_active, display_order } = req.body || {};
    const { rows } = await db.query(
      `UPDATE menus
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           is_active = COALESCE($4, is_active),
           display_order = COALESCE($5, display_order),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        name ? String(name).trim() : null,
        description !== undefined ? String(description).trim() : null,
        is_active != null ? parseBool(is_active, true) : null,
        display_order != null ? parseInt(display_order, 10) : null,
      ]
    );
    res.json({ success: true, menu: rows[0] });
  } catch (err) {
    console.error('[PUT /restaurant/api/menus/:id]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/api/menus/:id', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const owns = await verifyMenuAccess(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!owns) return res.status(403).json({ success: false, error: 'Access denied' });

    await db.query('DELETE FROM menu_items WHERE menu_id = $1', [req.params.id]);
    await db.query('DELETE FROM menus WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Menu deleted' });
  } catch (err) {
    console.error('[DELETE /restaurant/api/menus/:id]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/menu-items', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const { menuId, name, price } = req.body || {};
    if (!menuId || !name || price == null) {
      return res.status(400).json({ success: false, error: 'menuId, name, and price are required' });
    }

    const ownsMenu = await verifyMenuAccess(menuId, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!ownsMenu) return res.status(403).json({ success: false, error: 'Access denied' });

    const item = await Menu.createMenuItem(menuId, ownsMenu.restaurant_id, {
      ...req.body,
      price: parseFloat(price),
      discounted_price: req.body.discounted_price ? parseFloat(req.body.discounted_price) : null,
      is_available: parseBool(req.body.is_available, true),
      is_veg: parseBool(req.body.is_veg, false),
      is_popular: parseBool(req.body.is_popular, false),
      calories: req.body.calories !== undefined && req.body.calories !== null && req.body.calories !== ''
        ? (parseInt(req.body.calories, 10) || 0)
        : null,
      preparation_time_minutes: parseInt(req.body.preparation_time_minutes, 10) || 15,
    });
    res.status(201).json({ success: true, item });
  } catch (err) {
    console.error('[POST /restaurant/api/menu-items]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/menu-items/:id', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const owns = await verifyMenuItemAccess(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!owns) return res.status(403).json({ success: false, error: 'Access denied' });

    const item = await Menu.getMenuItemById(req.params.id);
    if (!item) return res.status(404).json({ success: false, error: 'Item not found' });
    res.json({ success: true, item });
  } catch (err) {
    console.error('[GET /restaurant/api/menu-items/:id]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/api/menu-items/:id', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const owns = await verifyMenuItemAccess(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!owns) return res.status(403).json({ success: false, error: 'Access denied' });

    const allowed = [
      'name', 'description', 'price', 'discounted_price', 'category', 'categories',
      'is_available', 'is_veg', 'calories', 'preparation_time_minutes',
      'image_url', 'ingredients', 'customizations', 'tags', 'is_popular',
    ];
    const updates = {};
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    });
    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    if (updates.price !== undefined) updates.price = parseFloat(updates.price);
    if (updates.discounted_price !== undefined) {
      updates.discounted_price = updates.discounted_price === '' || updates.discounted_price === null
        ? null
        : parseFloat(updates.discounted_price);
    }
    if (updates.calories !== undefined) {
      updates.calories = updates.calories === '' || updates.calories === null
        ? null
        : (parseInt(updates.calories, 10) || 0);
    }
    if (updates.preparation_time_minutes !== undefined) {
      updates.preparation_time_minutes = parseInt(updates.preparation_time_minutes, 10) || 15;
    }
    if (updates.is_available !== undefined) updates.is_available = parseBool(updates.is_available, true);
    if (updates.is_veg !== undefined) updates.is_veg = parseBool(updates.is_veg, false);
    if (updates.is_popular !== undefined) updates.is_popular = parseBool(updates.is_popular, false);

    const item = await Menu.updateMenuItem(req.params.id, updates);
    res.json({ success: true, item });
  } catch (err) {
    console.error('[PUT /restaurant/api/menu-items/:id]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/api/menu-items/:id', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const owns = await verifyMenuItemAccess(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!owns) return res.status(403).json({ success: false, error: 'Access denied' });

    await db.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Menu item deleted' });
  } catch (err) {
    console.error('[DELETE /restaurant/api/menu-items/:id]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/api/menu-items/:id/toggle-availability', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const owns = await verifyMenuItemAccess(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!owns) return res.status(403).json({ success: false, error: 'Access denied' });

    const { rows } = await db.query(
      `UPDATE menu_items SET is_available = NOT is_available, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ success: true, item: rows[0] });
  } catch (err) {
    console.error('[PATCH /restaurant/api/menu-items/:id/toggle-availability]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Orders & Driver Visibility (Partner-Scoped) ───────────────────────────────

router.get('/api/orders/stats', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const ids = await resolveAccessibleRestaurantIds({ ...ctx.manager, account_type: 'restaurant_partner' }, { includePending: true });
    if (!ids.length) {
      return res.json({ success: true, stats: { active: 0, pending: 0, revenue: '0.00', total_today: 0 } });
    }

    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('pending','accepted_by_driver','ordering_at_restaurant','order_ready','picked_up','on_the_way')
        )::int AS active,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COALESCE(SUM(total_amount) FILTER (
          WHERE placed_at >= CURRENT_DATE
            AND placed_at < CURRENT_DATE + INTERVAL '1 day'
            AND status = 'delivered'
        ), 0) AS revenue,
        COUNT(*) FILTER (
          WHERE placed_at >= CURRENT_DATE
            AND placed_at < CURRENT_DATE + INTERVAL '1 day'
        )::int AS total_today
      FROM orders
      WHERE restaurant_id = ANY($1::uuid[])
    `, [ids]);

    const row = rows[0] || {};
    res.json({
      success: true,
      stats: {
        active: parseInt(row.active || 0, 10),
        pending: parseInt(row.pending || 0, 10),
        revenue: parseFloat(row.revenue || 0).toFixed(2),
        total_today: parseInt(row.total_today || 0, 10),
      },
    });
  } catch (err) {
    console.error('[GET /restaurant/api/orders/stats]', err);
    res.status(500).json({ success: false, error: 'Failed to load order stats' });
  }
});

router.get('/api/orders', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const allIds = ctx.restaurants.map((r) => r.id);
    if (!allIds.length) {
      return res.json({ success: true, orders: [], total: 0, currentPage: 1, totalPages: 0 });
    }

    const { restaurantId, status, date, page, limit } = req.query;
    let targetIds = allIds;
    if (restaurantId && restaurantId !== 'all') {
      if (!allIds.includes(restaurantId)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }
      targetIds = [restaurantId];
    }

    const result = await fetchPaginatedOrders(targetIds, { status, date, page, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GET /restaurant/api/orders]', err);
    res.status(500).json({ success: false, error: 'Failed to load orders' });
  }
});

router.get('/api/orders/:id', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const detail = await fetchOrderDetail(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!detail) return res.status(404).json({ success: false, error: 'Order not found' });

    res.json({ success: true, ...detail });
  } catch (err) {
    console.error('[GET /restaurant/api/orders/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load order detail' });
  }
});

router.post('/api/orders/:id/accept', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const detail = await fetchOrderDetail(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!detail) return res.status(403).json({ success: false, error: 'Order not found or access denied' });

    const order = await Order.acceptByManager(req.params.id, ctx.user.id);
    res.json({
      success: true,
      message: 'Order accepted! Customer can now complete payment and a driver will be dispatched.',
      order,
    });
  } catch (err) {
    console.error('[POST /restaurant/api/orders/:id/accept]', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/api/orders/:id/reject', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const detail = await fetchOrderDetail(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!detail) return res.status(403).json({ success: false, error: 'Order not found or access denied' });

    const order = await Order.rejectByManager(req.params.id, ctx.user.id);
    res.json({
      success: true,
      message: 'Order rejected and cancelled.',
      order,
    });
  } catch (err) {
    console.error('[POST /restaurant/api/orders/:id/reject]', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.patch('/api/orders/:id/status', isPartnerApiLoggedIn, async (req, res) => {
  try {
    const ctx = await resolvePartnerSession(req);
    if (!ctx) return res.status(403).json({ success: false, error: 'Unauthorized' });

    const status = req.body?.status;
    if (!status) return res.status(400).json({ success: false, error: 'Missing status' });

    const detail = await fetchOrderDetail(req.params.id, { ...ctx.manager, account_type: 'restaurant_partner' });
    if (!detail) return res.status(404).json({ success: false, error: 'Order not found or access denied' });
    const order = detail.order;

    const validTransitions = {
      pending: ['ordering_at_restaurant', 'cancelled'],
      ordering_at_restaurant: ['order_ready', 'cancelled'],
      accepted_by_driver: ['order_ready', 'cancelled'],
      order_ready: ['picked_up', 'cancelled'],
    };

    if (!validTransitions[order.status]?.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status transition from ${order.status} to ${status}`,
      });
    }

    if (status === 'order_ready' && order.payment_status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark order ready before customer payment is completed',
      });
    }

    if (status === 'cancelled') {
      const cancelled = await Order.rejectByManager(req.params.id, ctx.user.id);
      return res.json({ success: true, order: cancelled });
    }
    if (status === 'ordering_at_restaurant') {
      const accepted = await Order.acceptByManager(req.params.id, ctx.user.id);
      return res.json({ success: true, order: accepted });
    }

    const updatedOrder = await Order.updateStatus(req.params.id, status, null);
    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    console.error('[PATCH /restaurant/api/orders/:id/status]', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
