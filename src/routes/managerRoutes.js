const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const managerController = require('../controllers/managerController');
const menuController = require('../controllers/menuController');
const restaurantController = require('../controllers/restaurantController');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Wrap async route handlers so any thrown error is forwarded
 * to the Express error-handling middleware.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Validate ?period=week|month|year */
const validatePeriod = (req, res, next) => {
  const valid = ['week', 'month', 'year'];
  const period = req.query.period;
  if (period && !valid.includes(period)) {
    return res.status(400).json({
      success: false,
      error: `Invalid period. Allowed values: ${valid.join(', ')}`
    });
  }
  next();
};

/** Validate ?limit=1..50 */
const validateLimit = (req, res, next) => {
  const limit = parseInt(req.query.limit, 10);
  if (req.query.limit && (isNaN(limit) || limit < 1 || limit > 50)) {
    return res.status(400).json({
      success: false,
      error: 'limit must be an integer between 1 and 50'
    });
  }
  next();
};

// ============================================================================
// Middleware stack — everything below requires a restaurant_manager session
// ============================================================================

router.use(auth);
router.use(authorize('restaurant_manager'));

// ============================================================================
// Restaurant management routes
// ============================================================================

/**
 * @route   GET /api/manager/restaurants/:restaurantId/menus
 * @desc    Get all menus for a specific restaurant
 */
router.get(
  '/restaurants/:restaurantId/menus',
  asyncHandler(restaurantController.getRestaurantMenus)
);

// ============================================================================
// Dashboard widget routes
// ============================================================================

/**
 * @route   GET /api/manager/dashboard/stats
 * @desc    Real-time KPIs: revenue, orders, active orders,
 *          ratings, and week-over-week changes.
 */
router.get(
  '/dashboard/stats',
  asyncHandler(managerController.getDashboardStats)
);

/**
 * @route   GET /api/manager/dashboard/revenue
 * @query   ?period=week|month|year   (default: week)
 * @desc    Time-series revenue data for line/bar charts.
 */
router.get(
  '/dashboard/revenue',
  validatePeriod,
  asyncHandler(managerController.getRevenueChartData)
);

/**
 * @route   GET /api/manager/dashboard/orders
 * @desc    Today's order-status distribution for doughnut/pie charts.
 */
router.get(
  '/dashboard/orders',
  asyncHandler(managerController.getOrdersChartData)
);

/**
 * @route   GET /api/manager/dashboard/recent-orders
 * @query   ?limit=1..50   (default: 10)
 * @desc    Latest orders with customer & restaurant names.
 */
router.get(
  '/dashboard/recent-orders',
  validateLimit,
  asyncHandler(managerController.getRecentOrders)
);

/**
 * @route   GET /api/manager/dashboard/active-orders-count
 * @desc    Count of orders currently in-flight (pending → arrived).
 */
router.get(
  '/dashboard/active-orders-count',
  asyncHandler(managerController.getActiveOrdersCount)
);

// ============================================================================
// Restaurant management routes
// ============================================================================

/**
 * @route   GET /api/manager/restaurants/my
 * @desc    List of restaurants managed by the current user,
 *          enriched with per-restaurant stats.
 */
router.get(
  '/restaurants/my',
  asyncHandler(managerController.getMyRestaurants)
);

	// ============================================================================
	// Menu management routes (for manager interface)
	// ============================================================================

	/**
	 * @route   POST /api/manager/menus
	 * @desc    Create a new menu
	 */
	router.post(
	  '/menus',
	  asyncHandler(menuController.createMenu)
	);

	/**
	 * @route   GET /api/manager/menus/:menuId/items
	 * @desc    Get all items for a specific menu
	 */
	router.get(
	  '/menus/:menuId/items',
	  asyncHandler(menuController.getMenuItemsByMenuId)
	);

	/**
	 * @route   POST /api/manager/items
	 * @desc    Create a new menu item
	 */
	router.post(
	  '/items',
	  asyncHandler(menuController.createMenuItem)
	);

	/**
	 * @route   GET /api/manager/items/:itemId
	 * @desc    Get single menu item details
	 */
	router.get(
	  '/items/:itemId',
	  asyncHandler(menuController.getMenuItemById)
	);

	/**
	 * @route   PUT /api/manager/items/:itemId
	 * @desc    Update menu item details
	 */
	router.put(
	  '/items/:itemId',
	  asyncHandler(menuController.updateMenuItem)
	);

	/**
	 * @route   PUT /api/manager/items/:itemId/availability
	 * @desc    Toggle menu item availability (available/unavailable)
	 */
	router.put(
	  '/items/:itemId/availability',
	  asyncHandler(menuController.toggleMenuItemAvailability)
	);

	/**
	 * @route   PUT /api/manager/items/:itemId/popular
	 * @desc    Toggle menu item popular status
	 */
	router.put(
	  '/items/:itemId/popular',
	  asyncHandler(menuController.toggleMenuItemPopular)
	);

	/**
	 * @route   DELETE /api/manager/items/:itemId
	 * @desc    Delete a menu item
	 */
	router.delete(
	  '/items/:itemId',
	  asyncHandler(menuController.deleteMenuItem)
	);

	/**
	 * @route   PUT /api/manager/items/bulk-update
	 * @desc    Bulk update menu items
	 */
	router.put(
	  '/items/bulk-update',
	  asyncHandler(menuController.bulkUpdateMenuItems)
	);

	/**
	 * @route   DELETE /api/manager/items/bulk-delete
	 * @desc    Bulk delete menu items
	 */
	router.delete(
	  '/items/bulk-delete',
	  asyncHandler(menuController.bulkDeleteMenuItems)
	);

	// ============================================================================
	// Existing menu item routes (keeping for backward compatibility)
	// ============================================================================

	/**
	 * @route   GET /api/manager/menu/items/:itemId
	 * @desc    Get single menu item details for editing
	 */
	router.get(
	  '/menu/items/:itemId',
	  asyncHandler(menuController.getMenuItemById)
	);

	/**
	 * @route   PUT /api/manager/menu/items/:itemId
	 * @desc    Update menu item details
	 */
	router.put(
	  '/menu/items/:itemId',
	  asyncHandler(menuController.updateMenuItem)
	);

	/**
	 * @route   PUT /api/manager/menu/items/:itemId/availability
	 * @desc    Toggle menu item availability (available/unavailable)
	 */
	router.put(
	  '/menu/items/:itemId/availability',
	  asyncHandler(menuController.toggleMenuItemAvailability)
	);

// ============================================================================
// Order management routes
// ============================================================================

/**
 * @route   GET /api/manager/orders/pending
 * @desc    Get all pending orders for manager's restaurants (awaiting publication)
 */
router.get(
  '/orders/pending',
  asyncHandler(managerController.getPendingOrders)
);

/**
 * @route   POST /api/manager/orders/:id/publish
 * @desc    Accept order so customer can complete payment
 */
router.post(
  '/orders/:id/publish',
  asyncHandler(managerController.publishOrder)
);

router.post(
  '/orders/:id/accept',
  asyncHandler(managerController.publishOrder)
);

router.post(
  '/orders/:id/reject',
  asyncHandler(managerController.rejectOrder)
);

module.exports = router;