const Restaurant = require('../models/Restaurant');
const Menu = require('../models/Menu');
const RestaurantManager = require('../models/RestaurantManager');

// Create restaurant
exports.createRestaurant = async (req, res) => {
  try {
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    const restaurant = await Restaurant.create(managerProfile.id, req.body);
    
    res.status(201).json({
      success: true,
      data: restaurant
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get restaurants by manager
exports.getMyRestaurants = async (req, res) => {
  try {
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }
    const restaurants = await Restaurant.findAccessibleByManager(managerProfile, { includePending: true });
    
    res.json({
      success: true,
      data: restaurants
    });
  } catch (error) {
    console.error('Get restaurants error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update restaurant details
exports.updateRestaurant = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Verify ownership (platform admins can manage any restaurant; partners only their own)
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    const restaurants = await Restaurant.findAccessibleByManager(managerProfile, { includePending: true });
    const isOwner = restaurants.some(r => r.id === id);

    if (!isOwner) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    // Handle cuisine_type string-to-array conversion if needed
    if (Array.isArray(updates.cuisine_type)) {
      updates.cuisine_type = updates.cuisine_type.map(i => String(i).trim()).filter(Boolean).join(', ');
    }

    const updatedRestaurant = await Restaurant.update(id, updates);
    res.json({ success: true, data: updatedRestaurant });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Search restaurants
exports.searchRestaurants = async (req, res) => {
  try {
    const { lat, lng, cuisine, category, query, q, minRating, maxDistance, isOpen } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required'
      });
    }
    
    const filters = {
      cuisine: cuisine ? cuisine.split(',') : null,
      category: category || null,
      query: query || q || null,
      minRating: minRating ? parseFloat(minRating) : null,
      maxDistance: maxDistance ? parseFloat(maxDistance) : 90,
      isOpen: isOpen === 'true'
    };
    
    const restaurants = await Restaurant.search(
      parseFloat(lat),
      parseFloat(lng),
      filters
    );
    
    res.json({
      success: true,
      data: restaurants
    });
  } catch (error) {
    console.error('Search restaurants error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get restaurant details
exports.getRestaurant = async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id);
    
    if (!restaurant) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant not found'
      });
    }
    
    res.json({
      success: true,
      data: restaurant
    });
  } catch (error) {
    console.error('Get restaurant error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getRestaurantOrders = async (req, res) => {
  try {
    const limit = req.query.limit || 10;
    // Your SQL query to fetch orders for this manager's restaurants
    // ORDER BY placed_at DESC LIMIT $1
    // ...
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Create menu
exports.createMenu = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    
    // Verify restaurant ownership
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    const restaurants = await Restaurant.findAccessibleByManager(managerProfile, { includePending: true });
    
    const restaurant = restaurants.find(r => r.id === restaurantId);
    if (!restaurant) {
      return res.status(403).json({
        success: false,
        error: 'You do not own this restaurant'
      });
    }
    
    const menu = await Menu.create(restaurantId, req.body);
    
    res.status(201).json({
      success: true,
      data: menu
    });
  } catch (error) {
    console.error('Create menu error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get restaurant menus 
exports.getRestaurantMenus = async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const menus = await Menu.findByRestaurant(req.params.restaurantId, {
      onlyActive: !includeInactive
    });
    
    res.json({
      success: true,
      data: menus
    });
  } catch (error) {
    console.error('Get menus error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getStats = async (req, res) => {
  try {
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    // FIX: Fetch the restaurants so the variable is defined
    const restaurants = await Restaurant.findAccessibleByManager(managerProfile);

    res.json({
      success: true,
      data: {
        totalRestaurants: restaurants.length, // Now 'restaurants' is defined
        totalOrders: 0,
        activeOrders: 0,
        totalEarnings: 0
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Add menu item
exports.addMenuItem = async (req, res) => {
  try {
    const { restaurantId, menuId } = req.params;
    
    // Verify restaurant ownership
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    const restaurants = await Restaurant.findAccessibleByManager(managerProfile, { includePending: true });
    
    const restaurant = restaurants.find(r => r.id === restaurantId);
    if (!restaurant) {
      return res.status(403).json({
        success: false,
        error: 'You do not own this restaurant'
      });
    }
    
    const menuItem = await Menu.createMenuItem(menuId, restaurantId, req.body);
    
    res.status(201).json({
      success: true,
      data: menuItem
    });
  } catch (error) {
    console.error('Add menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getManagerProfile = async (req, res) => {
  try {
    // req.user.id comes from your auth middleware
    const manager = await RestaurantManager.findByUserId(req.user.id);
    
    if (!manager) {
      return res.status(404).json({ 
        success: false, 
        error: 'Manager profile not found' 
      });
    }

    res.json({
      success: true,
      data: manager
    });
  } catch (error) {
    console.error('❌ Get manager profile error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Server error fetching profile' 
    });
  }
};

exports.getMenuItem = async (req, res) => {
  try {
    const item = await Menu.getMenuItemById(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, error: 'Item not found' });
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update menu item
exports.updateMenuItem = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    
    // Security: Verify ownership first
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    const restaurants = await Restaurant.findAccessibleByManager(managerProfile, { includePending: true });
    if (!restaurants.some(r => r.id === restaurantId)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const updatedItem = await Menu.updateMenuItem(req.params.itemId, req.body);
    res.json({ success: true, data: updatedItem });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getHomeFeed = async (req, res) => {
  try {
    const { lat, lng, maxDistance } = req.query;
    const parsedLat = lat !== undefined ? parseFloat(lat) : null;
    const parsedLng = lng !== undefined ? parseFloat(lng) : null;
    const radiusKm = maxDistance ? parseFloat(maxDistance) : 90;

    const [categories, items, menus] = await Promise.all([
      Menu.getFoodCategories(parsedLat, parsedLng, radiusKm),
      Menu.getAllDiscoveryItems(24, parsedLat, parsedLng, radiusKm), // Strictly is_popular = true items
      Menu.getDiscoveryMenus(8),
    ]);

    // Log the counts on the server side for debugging
    console.log(`Feed generated: ${categories.length} categories, ${items.length} popular items.`);

    res.json({
      success: true,
      data: { 
        categories,
        popularItems: items,
        discounts: items, // Backward-compatible alias populated strictly with popular items
        menus
      }
    });
  } catch (error) {
    console.error('Home feed error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.searchFood = async (req, res) => {
  try {
    const { query, q, lat, lng, radius = 90 } = req.query;
    const searchTerm = (query ?? q ?? '').toString().trim();
    const parsedLat = lat !== undefined ? parseFloat(lat) : null;
    const parsedLng = lng !== undefined ? parseFloat(lng) : null;
    const parsedRadius = parseFloat(radius) || 90;

    // Return popular nearby dishes when search input is empty so Dishes tab stays populated
    const items = searchTerm.length < 1
      ? await Menu.getPopularItems(parsedLat, parsedLng, { radiusKm: parsedRadius, limit: 30 })
      : await Menu.searchItems(searchTerm, parsedLat, parsedLng, { radiusKm: parsedRadius, limit: 50 });

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Search food error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};