/**
 * managerWeb.js — Happy Delivery · Restaurant Manager Web Dashboard
 *
 * Covers every SSR page, every API endpoint, and every edge-case the
 * EJS templates need.  Models are NEVER modified here; only the router
 * logic is implemented.
 *
 * Route map 
 * ─────────
 * GET  /manager/login
 * POST /manager/login
 * GET  /manager/logout
 * GET  /manager/dashboard
 * GET  /manager/restaurants
 * GET  /manager/restaurants/add
 * GET  /manager/restaurants/edit/:id
 * GET  /manager/restaurants/:id          (manage view)
 * GET  /manager/menus
 * GET  /manager/orders
 * GET  /manager/analytics
 * GET  /manager/settings
 *
 * API  /api/manager/dashboard/stats
 * API  /api/manager/dashboard/revenue
 * API  /api/manager/dashboard/orders
 * API  /api/manager/dashboard/recent-orders
 * API  /api/manager/dashboard/active-orders-count
 *
 * API  /api/manager/restaurants/my
 * API  /api/manager/restaurants/:id        GET
 * API  /api/manager/restaurants            POST
 * API  /api/manager/restaurants/:id        PUT
 * API  /api/manager/restaurants/:id        DELETE
 * API  /api/manager/restaurants/:id/toggle-status   PATCH
 * API  /api/manager/restaurants/:id/toggle-accepting PATCH
 *
 * API  /api/manager/menus                  GET  (by restaurantId query)
 * API  /api/manager/menus                  POST
 * API  /api/manager/menus/:id              PUT
 * API  /api/manager/menus/:id              DELETE
 *
 * API  /api/manager/menu-items             POST
 * API  /api/manager/menu-items/:id         GET
 * API  /api/manager/menu-items/:id         PUT
 * API  /api/manager/menu-items/:id         DELETE
 * API  /api/manager/menu-items/:id/toggle-availability PATCH
 *
 * API  /api/manager/orders                 GET  (with filters + pagination)
 * API  /api/manager/orders/stats           GET
 * API  /api/manager/orders/:id             GET
 *
 * API  /api/manager/analytics/overview     GET
 * API  /api/manager/analytics/revenue      GET
 * API  /api/manager/analytics/top-items    GET
 *
 * API  /api/manager/settings/profile       PUT
 * API  /api/manager/settings/password      PUT
 *
 * Token bridge:
 *   The add/edit restaurant EJS forms use `Authorization: Bearer <token>`.
 *   The session-based middleware accepts both, so those forms work out-of-the-box
 *   with the session cookie (the Authorization header is simply ignored when the
 *   session is already valid).
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../src/config/database');
const bcrypt = require('bcryptjs');

// ─── Models (lazy-loaded to survive missing optional deps) ──
const getModel = {
    User: () => require('../src/models/User'),
    RestaurantManager: () => require('../src/models/RestaurantManager'),
    Restaurant: () => require('../src/models/Restaurant'),
    Menu: () => require('../src/models/Menu'),
    Order: () => require('../src/models/Order'),
    Driver: () => require('../src/models/Driver'),
    EmailService: () => require('../src/utils/emailService'),
};

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

/** Redirect to login when the browser navigates to a protected page. */
const isLoggedIn = (req, res, next) => {
    if (req.session?.user?.role === 'restaurant_manager') return next();
    res.redirect('/manager/login');
};

/** Return 401 JSON for protected API calls. */
const isLoggedInApi = (req, res, next) => {
    if (req.session?.user?.role === 'restaurant_manager') return next();
    res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all restaurants belonging to managerId.
 * Falls back to a raw SQL query if the model method fails.
 */
async function fetchRestaurants(managerId) {
    try {
        const Restaurant = getModel.Restaurant();
        if (typeof Restaurant.findByManager === 'function') {
            const rows = await Restaurant.findByManager(managerId);
            if (Array.isArray(rows) && rows.length > 0) return rows;
        }
    } catch (e) {
        console.warn('[managerWeb] Restaurant.findByManager failed, using SQL fallback:', e.message);
    }
    const { rows } = await db.query(
        'SELECT * FROM restaurants WHERE manager_id = $1 ORDER BY created_at DESC',
        [managerId]
    );
    return rows;
}

/** Return an array of UUID strings for the manager's restaurants. */
async function fetchRestaurantIds(managerId) {
    const restaurants = await fetchRestaurants(managerId);
    return restaurants.map(r => r.id);
}

/**
 * Resolve managerId from a session.  Returns null when no manager record exists.
 */
async function resolveManager(req) {
    const RM = getModel.RestaurantManager();
    const manager = await RM.findByUserId(req.session.user.id);
    return manager || null;
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────

async function buildDashboardStats(managerId, restaurants) {
    const empty = {
        total_revenue: '0.00',
        total_orders: 0,
        avg_rating: '0.0',
        active_orders: 0,
        total_reviews: 0,
        revenue_change: 0,
        orders_change: 0,
        total_restaurants: 0,
    };
    if (!restaurants?.length) return empty;

    const ids = restaurants.map(r => r.id);

    const [tOrders, tRevenue, lwOrders, lwRevenue, active] = await Promise.all([
        db.query(`
            SELECT COUNT(*) AS c FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND placed_at >= CURRENT_DATE
              AND placed_at  < CURRENT_DATE + INTERVAL '1 day'
        `, [ids]),
        db.query(`
            SELECT COALESCE(SUM(total_amount), 0) AS s FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND placed_at >= CURRENT_DATE
              AND placed_at  < CURRENT_DATE + INTERVAL '1 day'
              AND status = 'delivered'
        `, [ids]),
        db.query(`
            SELECT COUNT(*) AS c FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND placed_at >= CURRENT_DATE - INTERVAL '7 days'
              AND placed_at  < CURRENT_DATE - INTERVAL '6 days'
        `, [ids]),
        db.query(`
            SELECT COALESCE(SUM(total_amount), 0) AS s FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND placed_at >= CURRENT_DATE - INTERVAL '7 days'
              AND placed_at  < CURRENT_DATE - INTERVAL '6 days'
              AND status = 'delivered'
        `, [ids]),
        db.query(`
            SELECT COUNT(*) AS c FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND status IN (
                'pending','accepted_by_driver','ordering_at_restaurant',
                'order_ready','picked_up','on_the_way'
              )
        `, [ids]),
    ]);

    const totalOrders = parseInt(tOrders.rows[0].c, 10);
    const totalRevenue = parseFloat(tRevenue.rows[0].s);
    const lwOrdersCount = parseInt(lwOrders.rows[0].c, 10);
    const lwRevenueTotal = parseFloat(lwRevenue.rows[0].s);

    const ordersChange = lwOrdersCount > 0
        ? Math.round(((totalOrders - lwOrdersCount) / lwOrdersCount) * 100)
        : (totalOrders > 0 ? 100 : 0);
    const revenueChange = lwRevenueTotal > 0
        ? Math.round(((totalRevenue - lwRevenueTotal) / lwRevenueTotal) * 100)
        : (totalRevenue > 0 ? 100 : 0);

    const totalReviews = restaurants.reduce((s, r) => s + (parseInt(r.total_ratings, 10) || 0), 0);
    const avgRating = (
        restaurants.reduce((s, r) => s + parseFloat(r.average_rating || 0), 0)
        / restaurants.length
    ).toFixed(1);

    return {
        total_revenue: totalRevenue.toFixed(2),
        total_orders: totalOrders,
        avg_rating: avgRating,
        active_orders: parseInt(active.rows[0].c, 10),
        total_reviews: totalReviews,
        revenue_change: revenueChange,
        orders_change: ordersChange,
        total_restaurants: restaurants.length,
    };
}

/** Fetch the 10 most recent orders for a manager's restaurants. */
async function fetchRecentOrders(managerId, restaurants) {
    if (!restaurants?.length) return [];
    const ids = restaurants.map(r => r.id);
    try {
        const { rows } = await db.query(`
            SELECT
                o.id, o.order_number, o.status, o.total_amount,
                o.placed_at, o.delivery_address, o.payment_status,
                r.name   AS restaurant_name,
                COALESCE(u.first_name || ' ' || u.last_name, 'Unknown Customer') AS customer_name
            FROM orders o
            JOIN  restaurants r ON o.restaurant_id = r.id
            LEFT JOIN customers c ON o.customer_id  = c.id
            LEFT JOIN users     u ON c.user_id       = u.id
            WHERE o.restaurant_id = ANY($1::uuid[])
            ORDER BY o.placed_at DESC
            LIMIT 10
        `, [ids]);
        return rows;
    } catch (err) {
        console.error('[fetchRecentOrders]', err.message);
        return [];
    }
}

/** Fetch top 5 selling menu items for today. */
async function fetchTopItems(managerId, restaurants) {
    if (!restaurants?.length) return [];
    const ids = restaurants.map(r => r.id);
    try {
        const { rows } = await db.query(`
            SELECT
                mi.id, mi.name, mi.category,
                COUNT(oi.id)        AS order_count,
                SUM(oi.quantity)    AS total_quantity_sold
            FROM menu_items  mi
            JOIN order_items oi ON mi.id = oi.menu_item_id
            JOIN orders       o ON oi.order_id = o.id
            WHERE mi.restaurant_id = ANY($1::uuid[])
              AND o.placed_at >= CURRENT_DATE
              AND o.placed_at  < CURRENT_DATE + INTERVAL '1 day'
            GROUP BY mi.id, mi.name, mi.category
            ORDER BY order_count DESC
            LIMIT 5
        `, [ids]);
        return rows;
    } catch (err) {
        console.error('[fetchTopItems]', err.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SSR PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Login / Logout ────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
    if (req.session?.user?.role === 'restaurant_manager') return res.redirect('/manager/dashboard');
    res.render('manager/login', { title: 'Manager Login', error: null, success: null });
});

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const User = getModel.User();
        const user = await User.findByEmail(email);

        if (!user || user.role !== 'restaurant_manager') {
            return res.render('manager/login', {
                title: 'Manager Login',
                error: 'Invalid email or password',
                success: null,
            });
        }

        const valid = await User.verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.render('manager/login', {
                title: 'Manager Login',
                error: 'Invalid email or password',
                success: null,
            });
        }

        const RM = getModel.RestaurantManager();
        const manager = await RM.findByUserId(user.id);

        req.session.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            first_name: user.first_name,
            last_name: user.last_name,
            manager_id: manager?.id ?? null,
        };

        res.redirect('/manager/dashboard');
    } catch (err) {
        console.error('[POST /manager/login]', err);
        res.render('manager/login', {
            title: 'Manager Login',
            error: 'An unexpected error occurred. Please try again.',
            success: null,
        });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/manager/login'));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/dashboard', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const restaurants = await fetchRestaurants(manager.id);
        const dashboardStats = await buildDashboardStats(manager.id, restaurants);
        const recentOrders = await fetchRecentOrders(manager.id, restaurants);
        const topItems = await fetchTopItems(manager.id, restaurants);

        res.render('manager/dashboard', {
            title: 'Dashboard', currentPage: 'dashboard',
            manager: req.session.user,
            restaurants, dashboardStats, recentOrders, topItems,
        });
    } catch (err) {
        console.error('[GET /manager/dashboard]', err);
        res.redirect('/manager/login');
    }
});

// ── Restaurants ───────────────────────────────────────────────────────────────

router.get('/restaurants', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const restaurants = await fetchRestaurants(manager.id);

        res.render('manager/restaurants', {
            title: 'My Restaurants',
            currentPage: 'restaurants',
            manager: req.session.user,
            restaurants: restaurants,
        });
    } catch (err) {
        console.error('[GET /manager/restaurants]', err);
        res.redirect('/manager/login');
    }
});

router.get('/restaurants/add', isLoggedIn, async (req, res) => {
    try {
        res.render('manager/add-restaurant', {
            title: 'Add Restaurant', currentPage: 'restaurants',
            manager: req.session.user,
        });
    } catch (err) {
        console.error('[GET /manager/restaurants/add]', err);
        res.redirect('/manager/restaurants');
    }
});

router.get('/restaurants/edit/:id', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const { rows } = await db.query(
            `SELECT *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
             FROM restaurants WHERE id = $1 AND manager_id = $2`,
            [req.params.id, manager.id]
        );

        if (!rows.length) {
            return res.redirect('/manager/restaurants');
        }

        res.render('manager/edit-restaurant', {
            title: `Edit ${rows[0].name}`, currentPage: 'restaurants',
            manager: req.session.user,
            restaurant: rows[0],
        });
    } catch (err) {
        console.error('[GET /manager/restaurants/edit/:id]', err);
        res.redirect('/manager/restaurants');
    }
});

/** Manage / detail view for a single restaurant (redirects to edit for now). */
router.get('/restaurants/:id', isLoggedIn, async (req, res) => {
    res.redirect(`/manager/restaurants/edit/${req.params.id}`);
});

/** POST edit restaurant — handles the edit-restaurant.ejs form submission */
router.post('/restaurants/edit/:id', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        // Ownership check
        const { rows: ownerRows } = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [req.params.id, manager.id]
        );
        if (!ownerRows.length) return res.redirect('/manager/restaurants');

        const b = req.body;

        // opening_hours: wrap display string into JSON object matching DB format
        let openingHours = '{"display":"08:00 - 21:00"}';
        if (b.opening_hours_display && b.opening_hours_display.trim()) {
            openingHours = JSON.stringify({ display: b.opening_hours_display.trim() });
        }

        // HTML checkboxes send 'on' when checked, undefined when unchecked
        const toBool = (v) => v === 'on' || v === 'true' || v === '1';

        // ── Build dynamic UPDATE ──
        const setClause = [];
        const values = [];
        let idx = 1;

        const add = (col, val) => {
            setClause.push(`${col} = $${idx++}`);
            values.push(val);
        };

        // Core columns that definitely exist in your DB
        add('name', b.name);
        add('description', b.description || null);
        add('cuisine_type', b.cuisine_type || null);
        add('phone_number', b.phone_number || null);
        add('email', b.email || null);
        add('address', b.address);
        add('opening_hours', openingHours);
        add('preparation_time_minutes', b.preparation_time_minutes ? parseInt(b.preparation_time_minutes, 10) : 20);
        add('delivery_radius_km', b.delivery_radius ? parseFloat(b.delivery_radius) : 5);
        add('is_active', toBool(b.is_active));
        add('is_accepting_orders', toBool(b.is_accepting_orders));
        add('logo_url', b.logo_url || null);
        add('cover_image_url', b.cover_image_url || null);

        // PostGIS location (lat/lng from form)
        if (b.latitude && b.longitude && b.latitude !== '' && b.longitude !== '') {
            setClause.push(`location = ST_SetSRID(ST_MakePoint($${idx},$${idx + 1}), 4326)`);
            values.push(parseFloat(b.longitude), parseFloat(b.latitude));
            idx += 2;
        }

        values.push(req.params.id);
        await db.query(
            `UPDATE restaurants SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
            values
        );

        return res.redirect('/manager/restaurants');
    } catch (err) {
        console.error('[POST /manager/restaurants/edit/:id]', err);
        return res.redirect(`/manager/restaurants/edit/${req.params.id}`);
    }
});

router.post('/restaurants/delete/:id', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.redirect('/manager/login');

        const { rows } = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [req.params.id, manager.id]
        );
        if (!rows.length) return res.redirect('/manager/restaurants');

        await db.query('DELETE FROM restaurants WHERE id = $1', [req.params.id]);
        return res.redirect('/manager/restaurants');
    } catch (err) {
        console.error('[POST /manager/restaurants/delete/:id]', err);
        return res.redirect('/manager/restaurants');
    }
});

router.post('/restaurants/add', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const b = req.body;

        // Validate required fields
        if (!b.name || !b.address || !b.latitude || !b.longitude) {
            return res.redirect('/manager/restaurants');
        }

        // opening_hours: wrap display string into JSON object matching DB format
        const openingHours = JSON.stringify({
            display: b.opening_hours_display && b.opening_hours_display.trim()
                ? b.opening_hours_display.trim()
                : '08:00 - 21:00'
        });

        // HTML checkboxes send 'on' when checked, undefined when unchecked
        const toBool = (v) => v === 'on' || v === 'true' || v === '1';

        const { rows } = await db.query(`
            INSERT INTO restaurants (
                manager_id, name, description, cuisine_type, phone_number, email,
                address, location, delivery_radius_km, logo_url, cover_image_url,
                opening_hours, is_active, is_accepting_orders, preparation_time_minutes,
                average_rating, total_ratings, total_orders, commission_percentage
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, ST_SetSRID(ST_MakePoint($8, $9), 4326), $10, $11, $12,
                $13, $14, $15, $16,
                '5.00', 5, 0, '15.00'
            )
            RETURNING id
        `, [
            manager.id,
            b.name,
            b.description || null,
            b.cuisine_type || null,
            b.phone_number || null,
            b.email || null,
            b.address,
            parseFloat(b.longitude),
            parseFloat(b.latitude),
            b.delivery_radius_km ? parseFloat(b.delivery_radius_km) : 5,
            b.logo_url || null,
            b.cover_image_url || null,
            openingHours,
            toBool(b.is_active),
            toBool(b.is_accepting_orders),
            b.preparation_time_minutes ? parseInt(b.preparation_time_minutes, 10) : 20,
        ]);

        return res.redirect('/manager/restaurants');
    } catch (err) {
        console.error('[POST /manager/restaurants/add]', err);
        return res.redirect('/manager/restaurants');
    }
});

router.post('/restaurants/:id/toggle-status', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.redirect('/manager/login');

        const { rows } = await db.query(
            `UPDATE restaurants
             SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND manager_id = $2
             RETURNING id`,
            [req.params.id, manager.id]
        );

        return res.redirect('/manager/restaurants');
    } catch (err) {
        console.error('[POST /manager/restaurants/:id/toggle-status]', err);
        return res.redirect('/manager/restaurants');
    }
});

// ── Menus ─────────────────────────────────────────────────────────────────────

router.get('/menus', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const restaurants = await fetchRestaurants(manager.id);
        let menus = [];
        let selectedRestaurant = null;

        if (restaurants.length) {
            selectedRestaurant = restaurants[0];
            try {
                menus = await getModel.Menu().findByRestaurant(selectedRestaurant.id);
            } catch (e) {
                console.warn('[GET /manager/menus] Menu.findByRestaurant failed:', e.message);
            }
        }

        res.render('manager/menus', {
            title: 'Menu Management', currentPage: 'menus',
            manager: req.session.user,
            restaurants, menus, selectedRestaurant,
        });
    } catch (err) {
        console.error('[GET /manager/menus]', err);
        res.redirect('/manager/login');
    }
});

// ── Orders ────────────────────────────────────────────────────────────────────

router.get('/orders', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const restaurants = await fetchRestaurants(manager.id);
        res.render('manager/orders', {
            title: 'Order Management', currentPage: 'orders',
            manager: req.session.user, restaurants,
        });
    } catch (err) {
        console.error('[GET /manager/orders]', err);
        res.redirect('/manager/login');
    }
});

// ── Analytics ─────────────────────────────────────────────────────────────────

router.get('/analytics', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        const restaurants = await fetchRestaurants(manager.id);
        res.render('manager/analytics', {
            title: 'Analytics', currentPage: 'analytics',
            manager: req.session.user, restaurants,
        });
    } catch (err) {
        console.error('[GET /manager/analytics]', err);
        res.redirect('/manager/login');
    }
});

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        res.render('manager/settings', {
            title: 'Settings', currentPage: 'settings',
            manager: req.session.user,
        });
    } catch (err) {
        console.error('[GET /manager/settings]', err);
        res.redirect('/manager/login');
    }
});

// ── Public Driver Registration Web Portal ─────────────────────────────────────

router.get('/driver-register', (req, res) => {
    res.render('driver/register', {
        title: 'Driver Registration Portal · Happy Delivery',
    });
});

// ── Manage Drivers (Manager Portal) ───────────────────────────────────────────

router.get('/drivers', isLoggedIn, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) { req.session.destroy(); return res.redirect('/manager/login'); }

        res.render('manager/drivers', {
            title: 'Manage Drivers',
            currentPage: 'drivers',
            manager: req.session.user,
        });
    } catch (err) {
        console.error('[GET /manager/drivers]', err);
        res.redirect('/manager/login');
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD API
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/api/dashboard/stats', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });
        const restaurants = await fetchRestaurants(manager.id);
        const stats = await buildDashboardStats(manager.id, restaurants);
        res.json({ success: true, stats });
    } catch (err) {
        console.error('[API dashboard/stats]', err);
        res.status(500).json({ success: false, error: 'Failed to load stats' });
    }
});

router.get('/api/dashboard/revenue', isLoggedInApi, async (req, res) => {
    try {
        const { period = 'week' } = req.query;
        const manager = await resolveManager(req);
        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) return res.json({ success: true, labels: [], data: [] });

        const ids = restaurants.map(r => r.id);
        let labels = [], data = [];

        if (period === 'week') {
            const { rows } = await db.query(`
                SELECT DATE(placed_at) AS d, COALESCE(SUM(total_amount), 0) AS s
                FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND placed_at >= CURRENT_DATE - INTERVAL '6 days'
                  AND placed_at  < CURRENT_DATE + INTERVAL '1 day'
                  AND status = 'delivered'
                GROUP BY DATE(placed_at) ORDER BY d
            `, [ids]);
            const map = new Map(rows.map(r => [r.d.toISOString().split('T')[0], parseFloat(r.s)]));
            for (let i = 6; i >= 0; i--) {
                const d = new Date(); d.setDate(d.getDate() - i);
                const ds = d.toISOString().split('T')[0];
                labels.push(d.toLocaleDateString('en-ZA', { weekday: 'short' }));
                data.push(map.get(ds) || 0);
            }
        } else if (period === 'month') {
            const { rows } = await db.query(`
                SELECT DATE(placed_at) AS d, COALESCE(SUM(total_amount), 0) AS s
                FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND placed_at >= CURRENT_DATE - INTERVAL '29 days'
                  AND placed_at  < CURRENT_DATE + INTERVAL '1 day'
                  AND status = 'delivered'
                GROUP BY DATE(placed_at) ORDER BY d
            `, [ids]);
            const map = new Map(rows.map(r => [r.d.toISOString().split('T')[0], parseFloat(r.s)]));
            for (let i = 29; i >= 0; i--) {
                const d = new Date(); d.setDate(d.getDate() - i);
                const ds = d.toISOString().split('T')[0];
                labels.push(`${d.getDate()}/${d.getMonth() + 1}`);
                data.push(map.get(ds) || 0);
            }
        } else {
            // year
            const { rows } = await db.query(`
                SELECT DATE_TRUNC('month', placed_at) AS d, COALESCE(SUM(total_amount), 0) AS s
                FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND placed_at >= DATE_TRUNC('year', CURRENT_DATE)
                  AND placed_at  < CURRENT_DATE + INTERVAL '1 day'
                  AND status = 'delivered'
                GROUP BY DATE_TRUNC('month', placed_at) ORDER BY d
            `, [ids]);
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const map = new Map(rows.map(r => [new Date(r.d).getMonth(), parseFloat(r.s)]));
            for (let i = 0; i < 12; i++) { labels.push(monthNames[i]); data.push(map.get(i) || 0); }
        }

        res.json({ success: true, labels, data });
    } catch (err) {
        console.error('[API dashboard/revenue]', err);
        res.status(500).json({ success: false, error: 'Failed to load revenue chart' });
    }
});

router.get('/api/dashboard/orders', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) return res.json({ success: true, labels: [], data: [] });

        const ids = restaurants.map(r => r.id);
        const { rows } = await db.query(`
            SELECT status, COUNT(*) AS c
            FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND placed_at >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY status
        `, [ids]);

        const statusLabels = {
            pending: 'Pending',
            accepted_by_driver: 'Accepted',
            ordering_at_restaurant: 'Preparing',
            order_ready: 'Ready',
            picked_up: 'Picked Up',
            on_the_way: 'On the Way',
            arrived: 'Arrived',
            delivered: 'Delivered',
            cancelled: 'Cancelled',
        };
        const bgColors = [
            '#4a6fa5', '#17a2b8', '#28a745', '#20c997',
            '#ffc107', '#fd7e14', '#e83e8c', '#343a40', '#dc3545',
        ];

        const labels = rows.map(r => statusLabels[r.status] || r.status);
        const data = rows.map(r => parseInt(r.c, 10));

        res.json({ success: true, labels, data, backgroundColor: bgColors.slice(0, data.length) });
    } catch (err) {
        console.error('[API dashboard/orders]', err);
        res.status(500).json({ success: false, error: 'Failed to load orders chart' });
    }
});

router.get('/api/dashboard/recent-orders', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) return res.json({ success: true, orders: [] });

        const ids = restaurants.map(r => r.id);
        const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
        const date = req.query.date; // optional YYYY-MM-DD filter

        let sql = `
            SELECT
                o.id, o.order_number, o.status, o.total_amount,
                o.placed_at, o.delivery_address, o.payment_status,
                r.name  AS restaurant_name,
                COALESCE(u.first_name || ' ' || u.last_name, 'Unknown Customer') AS customer_name
            FROM orders o
            JOIN  restaurants r ON o.restaurant_id = r.id
            LEFT JOIN customers c ON o.customer_id  = c.id
            LEFT JOIN users     u ON c.user_id       = u.id
            WHERE o.restaurant_id = ANY($1::uuid[])
        `;
        const params = [ids];

        if (date) {
            sql += ` AND DATE(o.placed_at) = $${params.length + 1}`;
            params.push(date);
        }
        sql += ` ORDER BY o.placed_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const { rows } = await db.query(sql, params);
        res.json({ success: true, orders: rows });
    } catch (err) {
        console.error('[API dashboard/recent-orders]', err);
        res.status(500).json({ success: false, error: 'Failed to load recent orders' });
    }
});

router.get('/api/dashboard/active-orders-count', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) return res.json({ success: true, count: 0 });

        const ids = restaurants.map(r => r.id);
        const { rows } = await db.query(`
            SELECT COUNT(*) AS c FROM orders
            WHERE restaurant_id = ANY($1::uuid[])
              AND status IN (
                'pending','accepted_by_driver','ordering_at_restaurant',
                'order_ready','picked_up','on_the_way'
              )
        `, [ids]);

        res.json({ success: true, count: parseInt(rows[0].c, 10) });
    } catch (err) {
        console.error('[API dashboard/active-orders-count]', err);
        res.status(500).json({ success: false, error: 'Failed to load active count' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RESTAURANT API  (session-auth; also accepts Bearer token from the EJS forms)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * List restaurants with rolled-up order / revenue stats.
 * Used by restaurants-complete.ejs  →  GET /api/manager/restaurants/my
 */
router.get('/api/restaurants/my', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { rows } = await db.query(`
            SELECT
                r.*,
                COALESCE(o.total_orders,  0)    AS total_orders,
                COALESCE(o.total_revenue, 0)    AS total_revenue,
                ST_X(r.location::geometry)       AS lng,
                ST_Y(r.location::geometry)       AS lat
            FROM restaurants r
            LEFT JOIN (
                SELECT restaurant_id,
                       COUNT(*)                   AS total_orders,
                       COALESCE(SUM(total_amount), 0) AS total_revenue
                FROM orders
                WHERE status = 'delivered'
                GROUP BY restaurant_id
            ) o ON r.id = o.restaurant_id
            WHERE r.manager_id = $1
            ORDER BY r.created_at DESC
        `, [manager.id]);

        res.json({ success: true, restaurants: rows });
    } catch (err) {
        console.error('[API restaurants/my]', err);
        res.status(500).json({ success: false, error: 'Failed to load restaurants' });
    }
});

/** GET single restaurant (ownership-checked). */
router.get('/api/restaurants/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { rows } = await db.query(
            `SELECT *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
             FROM restaurants WHERE id = $1 AND manager_id = $2`,
            [req.params.id, manager.id]
        );

        if (!rows.length) return res.status(404).json({ success: false, error: 'Restaurant not found' });
        res.json({ success: true, restaurant: rows[0] });
    } catch (err) {
        console.error('[API GET restaurants/:id]', err);
        res.status(500).json({ success: false, error: 'Failed to load restaurant' });
    }
});

/** CREATE restaurant — called by add-restaurant.ejs */
router.post('/api/restaurants', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const {
            name, description, cuisine_type, phone_number, email,
            address, latitude, longitude, delivery_radius_km,
            logo_url, cover_image_url, opening_hours,
            is_active, is_accepting_orders, preparation_time_minutes,
        } = req.body;

        if (!name || !address || latitude == null || longitude == null) {
            return res.status(400).json({
                success: false,
                error: 'name, address, latitude, and longitude are required',
            });
        }

        // opening_hours may arrive as JSON string or object
        let hoursJson = opening_hours;
        if (typeof opening_hours === 'object') hoursJson = JSON.stringify(opening_hours);
        if (!hoursJson) hoursJson = JSON.stringify({ display: 'Not specified' });

        // cuisine_type may arrive as comma-separated string
        let cuisineVal = cuisine_type;

        const { rows } = await db.query(`
            INSERT INTO restaurants (
                manager_id, name, description, cuisine_type, phone_number, email,
                address, location, delivery_radius_km, logo_url, cover_image_url,
                opening_hours, is_active, is_accepting_orders, preparation_time_minutes
            ) VALUES (
                $1,$2,$3,$4,$5,$6,
                $7, ST_SetSRID(ST_MakePoint($8,$9), 4326), $10,$11,$12,
                $13,$14,$15,$16
            )
            RETURNING *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
        `, [
            manager.id,
            name,
            description || null,
            cuisineVal || null,
            phone_number || null,
            email || null,
            address,
            parseFloat(longitude),
            parseFloat(latitude),
            parseInt(delivery_radius_km, 10) || 5,
            logo_url || null,
            cover_image_url || null,
            hoursJson,
            parseBool(is_active, true),
            parseBool(is_accepting_orders, true),
            parseInt(preparation_time_minutes, 10) || 20,
        ]);

        res.status(201).json({ success: true, restaurant: rows[0] });
    } catch (err) {
        console.error('[API POST restaurants]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** UPDATE restaurant — called by edit-restaurant.ejs */
router.put('/api/restaurants/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const check = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [req.params.id, manager.id]
        );
        if (!check.rows.length) return res.status(404).json({ success: false, error: 'Restaurant not found or access denied' });

        const {
            name, description, cuisine_type, phone_number, email,
            address, latitude, longitude, delivery_radius_km,
            logo_url, cover_image_url, opening_hours,
            is_active, is_accepting_orders, preparation_time_minutes,
        } = req.body;

        const setClause = [];
        const values = [];
        let idx = 1;

        const add = (col, val) => {
            if (val !== undefined && val !== null && val !== '') {
                setClause.push(`${col} = $${idx++}`);
                values.push(val);
            }
        };

        add('name', name);
        add('description', description);
        add('cuisine_type', cuisine_type);
        add('phone_number', phone_number);
        add('email', email);
        add('address', address);
        add('delivery_radius_km', delivery_radius_km != null ? parseInt(delivery_radius_km, 10) : null);
        add('logo_url', logo_url);
        add('cover_image_url', cover_image_url);
        add('preparation_time_minutes', preparation_time_minutes != null ? parseInt(preparation_time_minutes, 10) : null);

        if (opening_hours) {
            const hoursVal = typeof opening_hours === 'object' ? JSON.stringify(opening_hours) : opening_hours;
            add('opening_hours', hoursVal);
        }
        if (is_active !== undefined && is_active !== '')
            add('is_active', parseBool(is_active, true));
        if (is_accepting_orders !== undefined && is_accepting_orders !== '')
            add('is_accepting_orders', parseBool(is_accepting_orders, true));

        if (latitude != null && longitude != null && latitude !== '' && longitude !== '') {
            setClause.push(`location = ST_SetSRID(ST_MakePoint($${idx},$${idx + 1}), 4326)`);
            values.push(parseFloat(longitude), parseFloat(latitude));
            idx += 2;
        }

        if (!setClause.length) return res.status(400).json({ success: false, error: 'No fields to update' });

        values.push(req.params.id);
        const { rows } = await db.query(
            `UPDATE restaurants SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx}
             RETURNING *, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat`,
            values
        );

        res.json({ success: true, restaurant: rows[0] });
    } catch (err) {
        console.error('[API PUT restaurants/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** DELETE restaurant */
router.delete('/api/restaurants/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const check = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [req.params.id, manager.id]
        );
        if (!check.rows.length) return res.status(404).json({ success: false, error: 'Restaurant not found or access denied' });

        await db.query('DELETE FROM restaurants WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Restaurant deleted successfully' });
    } catch (err) {
        console.error('[API DELETE restaurants/:id]', err);
        res.status(500).json({ success: false, error: 'Failed to delete restaurant' });
    }
});

/** Toggle is_active */
router.patch('/api/restaurants/:id/toggle-status', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { rows } = await db.query(
            `UPDATE restaurants SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND manager_id = $2 RETURNING *`,
            [req.params.id, manager.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Restaurant not found' });
        res.json({ success: true, restaurant: rows[0] });
    } catch (err) {
        console.error('[API toggle-status]', err);
        res.status(500).json({ success: false, error: 'Failed to toggle status' });
    }
});

/** Toggle is_accepting_orders */
router.patch('/api/restaurants/:id/toggle-accepting', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { rows } = await db.query(
            `UPDATE restaurants
             SET is_accepting_orders = NOT is_accepting_orders, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND manager_id = $2 RETURNING *`,
            [req.params.id, manager.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Restaurant not found' });
        res.json({ success: true, restaurant: rows[0] });
    } catch (err) {
        console.error('[API toggle-accepting]', err);
        res.status(500).json({ success: false, error: 'Failed to toggle accepting orders' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MENU  API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/manager/menus?restaurantId=<uuid>
 * Returns menus with nested items for the given restaurant (ownership checked).
 */
router.get('/api/menus', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { restaurantId } = req.query;
        if (!restaurantId) return res.status(400).json({ success: false, error: 'restaurantId is required' });

        // Ownership check
        const owns = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [restaurantId, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        let menus;
        try {
            menus = await getModel.Menu().findByRestaurant(restaurantId, { onlyActive: false });
        } catch (e) {
            // Raw SQL fallback
            const { rows } = await db.query(
                `SELECT m.id, m.restaurant_id, m.name, m.description, m.is_active, m.display_order,
                        COALESCE(
                          json_agg(
                            json_build_object(
                              'id',                       mi.id,
                              'menu_id',                  mi.menu_id,
                              'restaurant_id',            mi.restaurant_id,
                              'name',                     mi.name,
                              'description',              mi.description,
                              'price',                    mi.price,
                              'discounted_price',         mi.discounted_price,
                              'image_url',                mi.image_url,
                              'is_available',             mi.is_available,
                              'is_veg',                   COALESCE(mi.is_veg, false),
                              'is_popular',               COALESCE(mi.is_popular, false),
                              'category',                 COALESCE(mi.category, 'General'),
                              'calories',                 mi.calories,
                              'preparation_time_minutes', mi.preparation_time_minutes,
                              'ingredients',              COALESCE(mi.ingredients, '[]'::jsonb),
                              'customizations',           COALESCE(mi.customizations, '[]'::jsonb),
                              'tags',                     COALESCE(mi.tags, ARRAY[]::text[])
                            ) ORDER BY CASE WHEN mi.is_popular = true THEN 0 ELSE 1 END, mi.created_at
                          ) FILTER (WHERE mi.id IS NOT NULL), '[]'
                        ) AS items
                 FROM menus m
                 LEFT JOIN menu_items mi ON m.id = mi.menu_id
                 WHERE m.restaurant_id = $1
                 GROUP BY m.id
                 ORDER BY m.display_order, m.created_at`,
                [restaurantId]
            );
            menus = rows;
        }

        res.json({ success: true, menus });
    } catch (err) {
        console.error('[API GET menus]', err);
        res.status(500).json({ success: false, error: 'Failed to load menus' });
    }
});

/** POST /api/manager/menus — create a new menu for a restaurant */
router.post('/api/menus', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { restaurantId, name, description, display_order = 0 } = req.body;
        if (!restaurantId || !name) return res.status(400).json({ success: false, error: 'restaurantId and name are required' });

        const owns = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [restaurantId, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        let menu;
        try {
            menu = await getModel.Menu().create(restaurantId, { name, description, is_active: true, display_order });
        } catch (e) {
            const { rows } = await db.query(
                `INSERT INTO menus (restaurant_id, name, description, is_active, display_order)
                 VALUES ($1,$2,$3,true,$4) RETURNING *`,
                [restaurantId, name, description || null, display_order]
            );
            menu = rows[0];
        }

        res.status(201).json({ success: true, menu });
    } catch (err) {
        console.error('[API POST menus]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** PUT /api/manager/menus/:id */
router.put('/api/menus/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        // Ownership via restaurants join
        const owns = await db.query(
            `SELECT m.id FROM menus m
             JOIN restaurants r ON m.restaurant_id = r.id
             WHERE m.id = $1 AND r.manager_id = $2`,
            [req.params.id, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        const { name, description, is_active, display_order } = req.body;
        const { rows } = await db.query(
            `UPDATE menus
             SET name          = COALESCE($2, name),
                 description   = COALESCE($3, description),
                 is_active     = COALESCE($4, is_active),
                 display_order = COALESCE($5, display_order),
                 updated_at    = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [req.params.id, name || null, description || null,
            is_active != null ? parseBool(is_active, true) : null,
            display_order != null ? parseInt(display_order, 10) : null]
        );

        res.json({ success: true, menu: rows[0] });
    } catch (err) {
        console.error('[API PUT menus/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** DELETE /api/manager/menus/:id */
router.delete('/api/menus/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const owns = await db.query(
            `SELECT m.id FROM menus m
             JOIN restaurants r ON m.restaurant_id = r.id
             WHERE m.id = $1 AND r.manager_id = $2`,
            [req.params.id, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        // Cascade delete items first (in case FK constraint doesn't do it)
        await db.query('DELETE FROM menu_items WHERE menu_id = $1', [req.params.id]);
        await db.query('DELETE FROM menus       WHERE id     = $1', [req.params.id]);

        res.json({ success: true, message: 'Menu deleted' });
    } catch (err) {
        console.error('[API DELETE menus/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MENU ITEMS API
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /api/manager/menu-items/:id */
router.get('/api/menu-items/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const owns = await db.query(
            `SELECT mi.id FROM menu_items mi
             JOIN restaurants r ON mi.restaurant_id = r.id
             WHERE mi.id = $1 AND r.manager_id = $2`,
            [req.params.id, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        let item;
        try {
            item = await getModel.Menu().getMenuItemById(req.params.id);
        } catch (e) {
            const { rows } = await db.query('SELECT * FROM menu_items WHERE id = $1', [req.params.id]);
            item = rows[0];
        }

        if (!item) return res.status(404).json({ success: false, error: 'Item not found' });
        res.json({ success: true, item });
    } catch (err) {
        console.error('[API GET menu-items/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** POST /api/manager/menu-items — add an item to a menu */
router.post('/api/menu-items', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { menuId, restaurantId, name, price } = req.body;
        if (!menuId || !restaurantId || !name || price == null) {
            return res.status(400).json({ success: false, error: 'menuId, restaurantId, name and price are required' });
        }

        const owns = await db.query(
            'SELECT id FROM restaurants WHERE id = $1 AND manager_id = $2',
            [restaurantId, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        let item;
        try {
            item = await getModel.Menu().createMenuItem(menuId, restaurantId, req.body);
        } catch (e) {
            const {
                description, discounted_price, category = 'General',
                is_available = true, is_veg = false, is_popular = false,
                calories = 0, preparation_time_minutes = 15,
                image_url = null, ingredients = [], customizations = [], tags = [],
            } = req.body;

            const { rows } = await db.query(`
                INSERT INTO menu_items (
                    menu_id, restaurant_id, name, description, price, discounted_price,
                    category, is_available, is_veg, is_popular, calories, preparation_time_minutes,
                    image_url, ingredients, customizations, tags
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)
                RETURNING *`,
                [
                    menuId, restaurantId, name,
                    description || null,
                    parseFloat(price),
                    discounted_price ? parseFloat(discounted_price) : null,
                    category,
                    parseBool(is_available, true),
                    parseBool(is_veg, false),
                    parseBool(is_popular, false),
                    parseInt(calories, 10) || 0,
                    parseInt(preparation_time_minutes, 10) || 15,
                    image_url,
                    JSON.stringify(Array.isArray(ingredients) ? ingredients : []),
                    JSON.stringify(Array.isArray(customizations) ? customizations : []),
                    Array.isArray(tags) ? tags : [],
                ]
            );
            item = rows[0];
        }

        res.status(201).json({ success: true, item });
    } catch (err) {
        console.error('[API POST menu-items]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** PUT /api/manager/menu-items/:id */
router.put('/api/menu-items/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const owns = await db.query(
            `SELECT mi.id FROM menu_items mi
             JOIN restaurants r ON mi.restaurant_id = r.id
             WHERE mi.id = $1 AND r.manager_id = $2`,
            [req.params.id, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        // ----- build safe update from allowed fields -----
        const allowed = [
            'name', 'description', 'price', 'discounted_price', 'category',
            'is_available', 'is_veg', 'calories', 'preparation_time_minutes',
            'image_url', 'ingredients', 'customizations', 'tags', 'is_popular',
        ];
        const updates = {};
        allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        // ----- try the model helper first -----
        let item;
        try {
            item = await getModel.Menu().updateMenuItem(req.params.id, updates);
        } catch (modelErr) {
            // ---- fallback: build a manual UPDATE (only if the helper failed) ----
            const jsonbCols = ['ingredients', 'customizations'];
            const keys = Object.keys(updates);
            const vals = Object.values(updates).map((v, i) => {
                if (jsonbCols.includes(keys[i])) {
                    return typeof v === 'string' ? v : JSON.stringify(v ?? []);
                }
                if (keys[i] === 'tags') {
                    return Array.isArray(v) ? v : [];
                }
                if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                    return JSON.stringify(v);
                }
                return v;
            });

            const setCl = keys.map((k, i) => (jsonbCols.includes(k) ? `${k} = $${i + 2}::jsonb` : `${k} = $${i + 2}`)).join(', ');
            const { rows } = await db.query(
                `UPDATE menu_items SET ${setCl}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
                [req.params.id, ...vals]
            );
            item = rows[0];
        }

        res.json({ success: true, item });
    } catch (err) {
        console.error('[API PUT menu-items/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** DELETE /api/manager/menu-items/:id */
router.delete('/api/menu-items/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const owns = await db.query(
            `SELECT mi.id FROM menu_items mi
             JOIN restaurants r ON mi.restaurant_id = r.id
             WHERE mi.id = $1 AND r.manager_id = $2`,
            [req.params.id, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        await db.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Item deleted' });
    } catch (err) {
        console.error('[API DELETE menu-items/:id]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** PATCH /api/manager/menu-items/:id/toggle-availability */
router.patch('/api/menu-items/:id/toggle-availability', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const owns = await db.query(
            `SELECT mi.id FROM menu_items mi
             JOIN restaurants r ON mi.restaurant_id = r.id
             WHERE mi.id = $1 AND r.manager_id = $2`,
            [req.params.id, manager.id]
        );
        if (!owns.rows.length) return res.status(403).json({ success: false, error: 'Access denied' });

        const { rows } = await db.query(
            `UPDATE menu_items SET is_available = NOT is_available, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [req.params.id]
        );
        res.json({ success: true, item: rows[0] });
    } catch (err) {
        console.error('[API toggle-availability]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORDERS API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/manager/orders
 * Query params: restaurant (uuid|all), status, date (YYYY-MM-DD), page, limit
 */
router.get('/api/orders', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) return res.json({ success: true, orders: [], total: 0, currentPage: 1, totalPages: 0 });

        const allIds = restaurants.map(r => r.id);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(parseInt(req.query.limit, 10) || 15, 100);
        const offset = (page - 1) * limit;
        const { restaurant, status, date } = req.query;

        // Determine which restaurant IDs to query
        let ids = allIds;
        if (restaurant && restaurant !== 'all') {
            if (!allIds.includes(restaurant)) return res.status(403).json({ success: false, error: 'Access denied' });
            ids = [restaurant];
        }

        const params = [ids];
        let where = 'WHERE o.restaurant_id = ANY($1::uuid[])';
        let pIdx = 2;

        if (status && status !== 'all') {
            where += ` AND o.status = $${pIdx++}`;
            params.push(status);
        }
        if (date) {
            where += ` AND DATE(o.placed_at) = $${pIdx++}`;
            params.push(date);
        }

        const countRes = await db.query(
            `SELECT COUNT(*) AS c FROM orders o ${where}`,
            params
        );
        const total = parseInt(countRes.rows[0].c, 10);
        const totalPages = Math.ceil(total / limit);

        // Append LIMIT / OFFSET
        params.push(limit, offset);

        const { rows } = await db.query(`
            SELECT
                o.id, o.order_number, o.status, o.total_amount, o.payment_status,
                o.placed_at, o.delivery_address,
                r.name  AS restaurant_name,
                COALESCE(u.first_name || ' ' || u.last_name, 'Unknown Customer') AS customer_name,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
            FROM orders o
            JOIN  restaurants r ON o.restaurant_id = r.id
            LEFT JOIN customers c ON o.customer_id  = c.id
            LEFT JOIN users     u ON c.user_id       = u.id
            ${where}
            ORDER BY o.placed_at DESC
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
        `, params);

        res.json({ success: true, orders: rows, total, currentPage: page, totalPages });
    } catch (err) {
        console.error('[API GET orders]', err);
        res.status(500).json({ success: false, error: 'Failed to load orders' });
    }
});

/** GET /api/orders/pending — orders awaiting manager publication */
router.get('/api/orders/pending', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) return res.json({ success: true, orders: [] });

        const restaurantIds = restaurants.map(r => r.id);
        const { rows } = await db.query(
            `SELECT
                o.id,
                o.order_number,
                o.total_amount,
                o.status,
                o.placed_at,
                r.name AS restaurant_name,
                COALESCE(u.first_name || ' ' || u.last_name, 'Unknown Customer') AS customer_name,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id)::int AS item_count
            FROM orders o
            JOIN restaurants r ON o.restaurant_id = r.id
            LEFT JOIN customers c ON o.customer_id = c.id
            LEFT JOIN users u ON c.user_id = u.id
            WHERE o.restaurant_id = ANY($1)
              AND o.status = 'pending'
            ORDER BY o.placed_at ASC`,
            [restaurantIds]
        );
        res.json({ success: true, orders: rows });
    } catch (err) {
        console.error('[API GET orders/pending]', err);
        res.status(500).json({ success: false, error: 'Failed to load pending orders' });
    }
});

/** POST /api/orders/:id/publish (and /accept) — manager accepts a pending order so the customer can pay */
router.post(['/api/orders/:id/publish', '/api/orders/:id/accept'], isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const Order = getModel.Order();
        const order = await Order.acceptByManager(req.params.id, req.session.user.id);
        const io = req.app.get('io');
        if (io) {
            io.to('restaurant_managers').emit('order_updated', {
                orderId: order.id,
                status: order.status,
                order
            });
        }
        res.json({
            success: true,
            message: 'Order accepted! Waiting for customer payment before dispatching to drivers.',
            order
        });
    } catch (err) {
        console.error('[API POST orders/:id/accept]', err);
        res.status(400).json({ success: false, error: err.message });
    }
});

/** POST /api/orders/:id/reject — manager rejects and cancels a pending order */
router.post('/api/orders/:id/reject', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const Order = getModel.Order();
        const order = await Order.rejectByManager(req.params.id, req.session.user.id);
        const io = req.app.get('io');
        if (io) {
            io.to('restaurant_managers').emit('order_updated', {
                orderId: order.id,
                status: 'cancelled',
                order
            });
        }
        res.json({
            success: true,
            message: 'Order rejected and cancelled.',
            order
        });
    } catch (err) {
        console.error('[API POST orders/:id/reject]', err);
        res.status(400).json({ success: false, error: err.message });
    }
});

/** PATCH /api/orders/:id/status — update order status from manager pages */
router.patch('/api/orders/:id/status', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const status = req.body.status;
        if (!status) {
            return res.status(400).json({ success: false, error: 'Missing status' });
        }

        const Order = getModel.Order();
        if (status === 'cancelled') {
            const cancelledOrder = await Order.rejectByManager(req.params.id, req.session.user.id);
            return res.json({ success: true, order: cancelledOrder });
        }
        if (status === 'ordering_at_restaurant') {
            const acceptedOrder = await Order.acceptByManager(req.params.id, req.session.user.id);
            return res.json({ success: true, order: acceptedOrder });
        }

        const order = await Order.findById(req.params.id, req.session.user.id, 'restaurant_manager');
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found or access denied' });
        }

        const updatedOrder = await Order.updateStatus(req.params.id, status, null);
        res.json({ success: true, order: updatedOrder });
    } catch (err) {
        console.error('[API PATCH orders/:id/status]', err);
        res.status(400).json({ success: false, error: err.message });
    }
});

/** GET /api/manager/orders/stats — summary stats for the orders page */
router.get('/api/orders/stats', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const restaurants = await fetchRestaurants(manager.id);
        if (!restaurants.length) {
            return res.json({ success: true, stats: { active: 0, pending: 0, revenue: '0.00', total_today: 0 } });
        }

        const ids = restaurants.map(r => r.id);

        const [active, pending, revenue, total] = await Promise.all([
            db.query(`
                SELECT COUNT(*) AS c FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND status IN ('pending','accepted_by_driver','ordering_at_restaurant','order_ready','picked_up','on_the_way')
            `, [ids]),
            db.query(`
                SELECT COUNT(*) AS c FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND status = 'pending'
            `, [ids]),
            db.query(`
                SELECT COALESCE(SUM(total_amount), 0) AS s FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND DATE(placed_at) = CURRENT_DATE
                  AND status = 'delivered'
            `, [ids]),
            db.query(`
                SELECT COUNT(*) AS c FROM orders
                WHERE restaurant_id = ANY($1::uuid[])
                  AND DATE(placed_at) = CURRENT_DATE
            `, [ids]),
        ]);

        res.json({
            success: true,
            stats: {
                active: parseInt(active.rows[0].c, 10),
                pending: parseInt(pending.rows[0].c, 10),
                revenue: parseFloat(revenue.rows[0].s).toFixed(2),
                total_today: parseInt(total.rows[0].c, 10),
            },
        });
    } catch (err) {
        console.error('[API orders/stats]', err);
        res.status(500).json({ success: false, error: 'Failed to load order stats' });
    }
});

/** GET /api/manager/orders/:id — full order detail with items */
router.get('/api/orders/:id', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        if (!manager) return res.status(403).json({ success: false, error: 'Manager not found' });

        const { rows: [order] } = await db.query(`
            SELECT
                o.*,
                r.name  AS restaurant_name,
                COALESCE(u.first_name || ' ' || u.last_name, 'Unknown Customer') AS customer_name,
                u.phone_number AS customer_phone
            FROM orders o
            JOIN  restaurants r ON o.restaurant_id = r.id
            LEFT JOIN customers c ON o.customer_id  = c.id
            LEFT JOIN users     u ON c.user_id       = u.id
            WHERE o.id = $1 AND r.manager_id = $2
        `, [req.params.id, manager.id]);

        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

        const { rows: items } = await db.query(`
            SELECT
                oi.id, oi.quantity, oi.unit_price, oi.total_price,
                oi.special_instructions, oi.selected_options, oi.allergen_notes,
                mi.name AS item_name, mi.image_url
            FROM order_items oi
            JOIN menu_items  mi ON oi.menu_item_id = mi.id
            WHERE oi.order_id = $1
            ORDER BY oi.created_at
        `, [req.params.id]);

        res.json({ success: true, order, items });
    } catch (err) {
        console.error('[API GET orders/:id]', err);
        res.status(500).json({ success: false, error: 'Failed to load order details' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ANALYTICS API
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/api/analytics/overview', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        const restaurants = await fetchRestaurants(manager.id);
        const stats = await buildDashboardStats(manager.id, restaurants);
        res.json({ success: true, overview: stats });
    } catch (err) {
        console.error('[API analytics/overview]', err);
        res.status(500).json({ success: false, error: 'Failed to load analytics' });
    }
});

router.get('/api/analytics/revenue', isLoggedInApi, async (req, res) => {
    // Delegate to the dashboard revenue endpoint logic
    req.query.period = req.query.period || 'month';
    // Re-use the same handler by forwarding
    return router.handle(
        Object.assign(req, { url: '/api/dashboard/revenue', path: '/api/dashboard/revenue' }),
        res,
        () => res.status(500).json({ success: false, error: 'Internal routing error' })
    );
});

router.get('/api/analytics/top-items', isLoggedInApi, async (req, res) => {
    try {
        const manager = await resolveManager(req);
        const restaurants = await fetchRestaurants(manager.id);
        const period = req.query.period || '30'; // days
        if (!restaurants.length) return res.json({ success: true, items: [] });

        const ids = restaurants.map(r => r.id);
        const { rows } = await db.query(`
            SELECT
                mi.id, mi.name, mi.category, mi.price, mi.image_url,
                r.name      AS restaurant_name,
                COUNT(oi.id)         AS order_count,
                SUM(oi.quantity)     AS total_sold,
                SUM(oi.total_price)  AS total_revenue
            FROM menu_items  mi
            JOIN order_items oi ON mi.id = oi.menu_item_id
            JOIN orders       o ON oi.order_id = o.id
            JOIN restaurants  r ON mi.restaurant_id = r.id
            WHERE mi.restaurant_id = ANY($1::uuid[])
              AND o.placed_at >= CURRENT_DATE - ($2 || ' days')::interval
              AND o.status = 'delivered'
            GROUP BY mi.id, mi.name, mi.category, mi.price, mi.image_url, r.name
            ORDER BY order_count DESC
            LIMIT 20
        `, [ids, parseInt(period, 10) || 30]);

        res.json({ success: true, items: rows });
    } catch (err) {
        console.error('[API analytics/top-items]', err);
        res.status(500).json({ success: false, error: 'Failed to load top items' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SETTINGS API
// ═══════════════════════════════════════════════════════════════════════════════

/** PUT /api/manager/settings/profile — update name/email */
router.put('/api/settings/profile', isLoggedInApi, async (req, res) => {
    try {
        const { first_name, last_name, email } = req.body;
        const User = getModel.User();

        const updates = {};
        if (first_name?.trim()) updates.first_name = first_name.trim();
        if (last_name?.trim()) updates.last_name = last_name.trim();
        if (email?.trim()) updates.email = email.trim().toLowerCase();

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        // Check email uniqueness if changing
        if (updates.email && updates.email !== req.session.user.email) {
            const exists = await User.emailExists(updates.email);
            if (exists) return res.status(409).json({ success: false, error: 'Email already in use' });
        }

        const updatedUser = await User.update(req.session.user.id, updates);

        // Refresh session
        req.session.user = {
            ...req.session.user,
            first_name: updatedUser.first_name,
            last_name: updatedUser.last_name,
            email: updatedUser.email,
        };

        res.json({ success: true, user: updatedUser });
    } catch (err) {
        console.error('[API settings/profile]', err);
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
});

/** PUT /api/manager/settings/password */
router.put('/api/settings/password', isLoggedInApi, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ success: false, error: 'Both current and new password are required' });
        }
        if (new_password.length < 8) {
            return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
        }

        const User = getModel.User();
        const user = await User.findById(req.session.user.id);
        const valid = await User.verifyPassword(current_password, user.password_hash);

        if (!valid) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(new_password, salt);
        await User.update(req.session.user.id, { password_hash });

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.error('[API settings/password]', err);
        res.status(500).json({ success: false, error: 'Failed to update password' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC DRIVER REGISTRATION PORTAL API & MANAGER DRIVER OVERSIGHT API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /manager/api/driver-applications
 * Public endpoint for prospective drivers to submit (or resubmit) their application.
 */
router.post('/api/driver-applications', async (req, res) => {
    try {
        const b = req.body || {};
        const email = (b.email || '').trim().toLowerCase();
        const password = b.password || '';
        const first_name = (b.first_name || '').trim();
        const last_name = (b.last_name || '').trim();
        const phone_number = (b.phone_number || '').trim();
        const driver_license_number = (b.driver_license_number || '').trim();
        const license_expiry_date = b.license_expiry_date || '';
        const vehicle_type = (b.vehicle_type || '').trim();
        const vehicle_model = (b.vehicle_model || '').trim();
        const vehicle_Registration = (b.vehicle_Registration || b.vehicle_registration || '').trim();

        if (!first_name || !last_name || !email || !phone_number || !password) {
            return res.status(400).json({
                success: false,
                error: 'Please complete all personal account fields (First Name, Last Name, Email, Phone Number, and Password).',
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 6 characters long.',
            });
        }

        if (!driver_license_number || !license_expiry_date || !vehicle_type || !vehicle_model || !vehicle_Registration) {
            return res.status(400).json({
                success: false,
                error: 'Please complete all required Driver License and Vehicle fields.',
            });
        }

        const User = getModel.User();
        const Driver = getModel.Driver();
        const EmailService = getModel.EmailService();

        const existingUser = await User.findByEmail(email);

        // If an account with this email already exists, allow a driver to update & resubmit their application if password matches
        if (existingUser) {
            if (existingUser.role !== 'driver') {
                return res.status(409).json({
                    success: false,
                    error: 'This email address is already registered to a non-driver account.',
                });
            }

            const validPass = await User.verifyPassword(password, existingUser.password_hash);
            if (!validPass) {
                return res.status(409).json({
                    success: false,
                    error: 'An application with this email already exists. Enter your existing account password to update and resubmit your application, or use the Check Application Status tab.',
                });
            }

            const existingDriver = await Driver.findByUserId(existingUser.id);
            if (!existingDriver) {
                const createdProfile = await Driver.create(existingUser.id, {
                    ...b,
                    vehicle_Registration,
                });
                const fullDriver = await Driver.findByIdWithUser(createdProfile.id);
                await EmailService.sendDriverApplicationReceivedEmail(existingUser, fullDriver);
                return res.status(201).json({
                    success: true,
                    resubmitted: true,
                    message: 'Your driver application has been submitted and is pending manager review.',
                    driver: fullDriver,
                });
            }

            if (existingDriver.approval_status === 'approved' && existingUser.is_active) {
                return res.status(400).json({
                    success: false,
                    error: 'Your driver account is already approved! You can sign in directly on the Happy Delivery mobile app.',
                });
            }

            const updatedDriver = await Driver.updateApplication(existingDriver.id, {
                ...b,
                first_name,
                last_name,
                phone_number,
                vehicle_Registration,
            });

            try {
                await EmailService.sendDriverApplicationReceivedEmail(
                    { first_name, last_name, email },
                    updatedDriver
                );
            } catch (emailErr) {
                console.warn('[POST /api/driver-applications resubmit email]', emailErr.message);
            }

            const io = req.app?.get('io');
            if (io) {
                io.to('restaurant_managers').emit('new_driver_application', {
                    driver: updatedDriver,
                    resubmitted: true,
                });
            }

            return res.json({
                success: true,
                resubmitted: true,
                message: 'Your updated driver application has been resubmitted for review! You will receive an email once management reviews your updated details.',
                driver: updatedDriver,
            });
        }

        // Create new driver user (inactive until manager approves)
        const newUser = await User.create({
            email,
            password,
            role: 'driver',
            first_name,
            last_name,
            phone_number,
            is_active: false,
        });

        let createdDriver;
        try {
            createdDriver = await Driver.create(newUser.id, {
                ...b,
                vehicle_Registration,
            });
        } catch (driverErr) {
            // Rollback user if driver creation failed (e.g. duplicate driver license number)
            await db.query('DELETE FROM users WHERE id = $1', [newUser.id]).catch(() => {});
            const msg = driverErr.message?.includes('driver_license_number')
                ? 'A driver application with this Driver License Number already exists.'
                : driverErr.message;
            return res.status(400).json({
                success: false,
                error: msg || 'Failed to save driver application details.',
            });
        }

        const fullDriver = await Driver.findByIdWithUser(createdDriver.id);

        try {
            await EmailService.sendDriverApplicationReceivedEmail(newUser, fullDriver);
        } catch (emailErr) {
            console.warn('[POST /api/driver-applications email]', emailErr.message);
        }

        const io = req.app?.get('io');
        if (io) {
            io.to('restaurant_managers').emit('new_driver_application', {
                driver: fullDriver,
                resubmitted: false,
            });
        }

        return res.status(201).json({
            success: true,
            message: 'Your driver application has been submitted! Management will review your registration and email you once your account is approved.',
            driver: fullDriver,
        });
    } catch (err) {
        console.error('[POST /api/driver-applications]', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Failed to submit driver application',
        });
    }
});

/**
 * POST /manager/api/driver-applications/status
 * Public endpoint for a driver applicant to check their approval status & load details for resubmission.
 */
router.post('/api/driver-applications/status', async (req, res) => {
    try {
        const email = (req.body?.email || '').trim().toLowerCase();
        const password = req.body?.password || '';

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Please enter both your email address and password.',
            });
        }

        const User = getModel.User();
        const Driver = getModel.Driver();

        const user = await User.findByEmail(email);
        if (!user || user.role !== 'driver') {
            return res.status(404).json({
                success: false,
                error: 'No driver application was found with that email address.',
            });
        }

        const valid = await User.verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({
                success: false,
                error: 'Invalid password for this driver application.',
            });
        }

        const driver = await Driver.findByEmailWithUser(email);
        if (!driver) {
            return res.status(404).json({
                success: false,
                error: 'Driver profile record not found.',
            });
        }

        res.json({
            success: true,
            driver,
        });
    } catch (err) {
        console.error('[POST /api/driver-applications/status]', err);
        res.status(500).json({
            success: false,
            error: 'Failed to check application status.',
        });
    }
});

/**
 * GET /manager/api/drivers
 * Manager endpoint to list all driver applications & active drivers with stats.
 */
router.get('/api/drivers', isLoggedInApi, async (req, res) => {
    try {
        const Driver = getModel.Driver();
        const [drivers, stats] = await Promise.all([
            Driver.getAllForManager({
                status: req.query.status || 'all',
                search: req.query.search || '',
                vehicle_type: req.query.vehicle_type || 'all',
            }),
            Driver.getManagerStats(),
        ]);

        res.json({
            success: true,
            drivers,
            stats,
        });
    } catch (err) {
        console.error('[GET /manager/api/drivers]', err);
        res.status(500).json({
            success: false,
            error: 'Failed to load drivers list',
        });
    }
});

/**
 * GET /manager/api/drivers/:id
 * Manager endpoint to inspect a single driver's full registration & application details.
 */
router.get('/api/drivers/:id', isLoggedInApi, async (req, res) => {
    try {
        const Driver = getModel.Driver();
        const driver = await Driver.findByIdWithUser(req.params.id);
        if (!driver) {
            return res.status(404).json({
                success: false,
                error: 'Driver application not found',
            });
        }

        res.json({
            success: true,
            driver,
        });
    } catch (err) {
        console.error('[GET /manager/api/drivers/:id]', err);
        res.status(500).json({
            success: false,
            error: 'Failed to load driver details',
        });
    }
});

/**
 * POST /manager/api/drivers/:id/approve
 * Manager approves a driver registration -> activates user account and sends approval email.
 */
router.post('/api/drivers/:id/approve', isLoggedInApi, async (req, res) => {
    try {
        const Driver = getModel.Driver();
        const EmailService = getModel.EmailService();
        const notes = (req.body?.notes || '').trim();

        const existing = await Driver.findByIdWithUser(req.params.id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Driver application not found',
            });
        }

        const approvedDriver = await Driver.approveApplication(
            req.params.id,
            req.session.user.id,
            notes || null
        );

        let emailResult = null;
        try {
            emailResult = await EmailService.sendDriverApprovedEmail(approvedDriver, notes || null);
        } catch (emailErr) {
            console.warn('[POST /api/drivers/:id/approve email]', emailErr.message);
        }

        const io = req.app?.get('io');
        if (io) {
            io.to('restaurant_managers').emit('driver_application_updated', {
                driver_id: approvedDriver.id,
                approval_status: 'approved',
                driver: approvedDriver,
            });
        }

        res.json({
            success: true,
            message: `Driver account for ${approvedDriver.first_name} ${approvedDriver.last_name} has been approved and an email notification was sent to ${approvedDriver.email}.`,
            driver: approvedDriver,
            emailResult,
        });
    } catch (err) {
        console.error('[POST /manager/api/drivers/:id/approve]', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Failed to approve driver application',
        });
    }
});

/**
 * POST /manager/api/drivers/:id/reject
 * Manager rejects a driver registration with a detailed reason -> deactivates login & emails reason to driver.
 */
router.post('/api/drivers/:id/reject', isLoggedInApi, async (req, res) => {
    try {
        const Driver = getModel.Driver();
        const EmailService = getModel.EmailService();
        const reason = (req.body?.reason || '').trim();

        if (!reason) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a reason explaining what was wrong with the application so we can email it to the driver.',
            });
        }

        const existing = await Driver.findByIdWithUser(req.params.id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Driver application not found',
            });
        }

        const rejectedDriver = await Driver.rejectApplication(
            req.params.id,
            req.session.user.id,
            reason
        );

        let emailResult = null;
        try {
            emailResult = await EmailService.sendDriverRejectedEmail(rejectedDriver, reason);
        } catch (emailErr) {
            console.warn('[POST /api/drivers/:id/reject email]', emailErr.message);
        }

        const io = req.app?.get('io');
        if (io) {
            io.to('restaurant_managers').emit('driver_application_updated', {
                driver_id: rejectedDriver.id,
                approval_status: 'rejected',
                driver: rejectedDriver,
            });
        }

        res.json({
            success: true,
            message: `Application for ${rejectedDriver.first_name} ${rejectedDriver.last_name} was marked as rejected and an email explaining what needs to be fixed was sent to ${rejectedDriver.email}.`,
            driver: rejectedDriver,
            emailResult,
        });
    } catch (err) {
        console.error('[POST /manager/api/drivers/:id/reject]', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Failed to reject driver application',
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely convert various truthy representations to a real boolean.
 * @param {*} val      - input value
 * @param {boolean} def - default when val is undefined/null/empty
 */
function parseBool(val, def = false) {
    if (val === undefined || val === null || val === '') return def;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val === 'true' || val === '1' || val === 'on';
    return Boolean(val);
}

module.exports = router;