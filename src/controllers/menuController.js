const Menu = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const RestaurantManager = require('../models/RestaurantManager');
const db = require('../config/database');

exports.getPopularItems = async (req, res) => {
  try {
    const { lat, lng, radius = 10 } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required'
      });
    }

    // Get popular items (you might want to implement popularity logic)
    const items = await Menu.searchItems('', parseFloat(lat), parseFloat(lng), {
      minRating: 4.0,
      limit: 20
    });

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Get popular items error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.searchItems = async (req, res) => {
  try {
    const { q, lat, lng, radius = 10 } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required'
      });
    }

    const items = await Menu.searchItems(
      q || '',
      parseFloat(lat),
      parseFloat(lng),
      { radiusKm: radius }
    );

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Search items error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getItemsByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const { lat, lng, radius = 10 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required'
      });
    }

    // You'll need to add a method to Menu model to get by category
    const items = await Menu.getItemsByCategory(
      category,
      parseFloat(lat),
      parseFloat(lng),
      { radiusKm: radius }
    );

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Get items by category error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get single menu item by ID (for editing)
exports.getMenuItemById = async (req, res) => {
  try {
    const { itemId } = req.params;

    const item = await Menu.getMenuItemById(itemId);

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    res.json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Get menu item by ID error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update menu item details
exports.updateMenuItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const form = req.body;

    // Handle both JSON and FormData
    const {
      name,
      description,
      price,
      category,
      discounted_price,
      image_url,
      is_available,
      is_veg,
      is_popular,
      ingredients,
      tags,
      customizations,
      calories,
      preparation_time_minutes
    } = form;

    // Build update data object, only including fields that were provided
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = parseFloat(price);
    if (category !== undefined) updateData.category = category;
    if (discounted_price !== undefined) updateData.discounted_price = discounted_price ? parseFloat(discounted_price) : null;
    if (image_url !== undefined) updateData.image_url = image_url;
    if (is_available !== undefined) updateData.is_available = is_available === 'true' || is_available === true;
    if (is_veg !== undefined) updateData.is_veg = is_veg === 'true' || is_veg === true;
    if (is_popular !== undefined) updateData.is_popular = is_popular === 'true' || is_popular === true;
    if (ingredients !== undefined) {
      updateData.ingredients = Array.isArray(ingredients)
        ? ingredients
        : (typeof ingredients === 'string' && ingredients.trim().startsWith('[')
            ? JSON.parse(ingredients)
            : (ingredients ? String(ingredients).split(',').map(i => i.trim()).filter(Boolean) : []));
    }
    if (tags !== undefined) {
      updateData.tags = Array.isArray(tags)
        ? tags
        : (typeof tags === 'string' && tags.trim().startsWith('[')
            ? JSON.parse(tags)
            : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []));
    }
    if (customizations !== undefined) {
      updateData.customizations = Array.isArray(customizations)
        ? customizations
        : (typeof customizations === 'string' && customizations.trim()
            ? JSON.parse(customizations)
            : []);
    }
    if (calories !== undefined) updateData.calories = parseInt(calories) || 0;
    if (preparation_time_minutes !== undefined) updateData.preparation_time_minutes = parseInt(preparation_time_minutes) || 15;

    // Prevent updating protected fields
    const protectedFields = ['id', 'menu_id', 'restaurant_id', 'created_at'];
    protectedFields.forEach(field => {
      delete updateData[field];
    });

    // Verify ownership
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    // Get the item to verify ownership
    const item = await Menu.getMenuItemById(itemId);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Menu item not found' });
    }

    const menu = await Menu.getMenuById(item.menu_id);
    if (!menu) {
      return res.status(404).json({ success: false, error: 'Associated menu not found' });
    }

    const restaurant = await Restaurant.findById(menu.restaurant_id);
    if (!restaurant || restaurant.manager_id !== managerProfile.id) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const updatedItem = await Menu.updateMenuItem(itemId, updateData);

    res.json({
      success: true,
      data: updatedItem
    });
  } catch (error) {
    console.error('Update menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Toggle menu item availability
exports.toggleMenuItemAvailability = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { is_available } = req.body;

    if (typeof is_available !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'is_available must be a boolean value'
      });
    }

    const item = await Menu.updateMenuItem(itemId, { is_available });

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    res.json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Toggle menu item availability error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get menu items by menu ID
exports.getMenuItemsByMenuId = async (req, res) => {
  try {
    const { menuId } = req.params;
    const { lat, lng, radius = 10, category, min_price, max_price, tags, is_available, search } = req.query;

    // Verify menu belongs to a restaurant owned by the current user
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    // Get the menu to verify ownership
    const menu = await Menu.getMenuById(menuId);
    if (!menu) {
      return res.status(404).json({ success: false, error: 'Menu not found' });
    }

    // Verify the restaurant belongs to this manager
    const restaurant = await Restaurant.findById(menu.restaurant_id);
    if (!restaurant || restaurant.manager_id !== managerProfile.id) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    // Build filters object
    const filters = {};
    if (category) filters.category = category;
    if (min_price) filters.min_price = parseFloat(min_price);
    if (max_price) filters.max_price = parseFloat(max_price);
    if (tags) filters.tags = tags.split(',').map(tag => tag.trim());
    if (is_available !== undefined) filters.is_available = is_available === 'true';
    if (search) filters.search = search;

    const items = await Menu.getMenuItems(menuId, filters);

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    console.error('Get menu items by menu ID error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Create menu
exports.createMenu = async (req, res) => {
  try {
    const { restaurantId, name, description, is_active = true, display_order = 0 } = req.body;

    // Verify restaurant ownership
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    if (restaurant.manager_id !== managerProfile.id) {
      return res.status(403).json({ success: false, error: 'Not authorized to create menu for this restaurant' });
    }

    const menu = await Menu.create(restaurantId, {
      name,
      description,
      is_active: is_active === 'true',
      display_order: parseInt(display_order) || 0
    });

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

// Create menu item
exports.createMenuItem = async (req, res) => {
  try {
    const form = req.body;

    // Handle both JSON and FormData
    const {
      menuId,
      restaurantId,
      name,
      description,
      price,
      category,
      discounted_price,
      image_url,
      is_available,
      is_veg,
      is_popular,
      ingredients,
      tags,
      customizations,
      calories,
      preparation_time_minutes
    } = form;

    // Preserve UUID string IDs
    const parsedMenuId = String(menuId).trim();
    const parsedRestaurantId = String(restaurantId).trim();
    const parsedPrice = parseFloat(price);
    const parsedDiscountedPrice = discounted_price ? parseFloat(discounted_price) : null;
    const parsedIsAvailable = is_available === 'true' || is_available === true || is_available === undefined;
    const parsedIsVeg = is_veg === 'true' || is_veg === true;
    const parsedIsPopular = is_popular === 'true' || is_popular === true;
    const parsedIngredients = Array.isArray(ingredients)
      ? ingredients
      : (typeof ingredients === 'string' && ingredients.trim().startsWith('[')
          ? JSON.parse(ingredients)
          : (ingredients ? String(ingredients).split(',').map(i => i.trim()).filter(Boolean) : []));
    const parsedTags = Array.isArray(tags)
      ? tags
      : (typeof tags === 'string' && tags.trim().startsWith('[')
          ? JSON.parse(tags)
          : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []));
    const parsedCustomizations = Array.isArray(customizations)
      ? customizations
      : (typeof customizations === 'string' && customizations.trim()
          ? JSON.parse(customizations)
          : []);
    const parsedCalories = parseInt(calories) || 0;
    const parsedPreparationTimeMinutes = parseInt(preparation_time_minutes) || 15;

    // Verify restaurant ownership
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    const restaurant = await Restaurant.findById(parsedRestaurantId);
    if (!restaurant) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    if (restaurant.manager_id !== managerProfile.id) {
      return res.status(403).json({ success: false, error: 'Not authorized to add item to this restaurant' });
    }

    // Verify menu belongs to this restaurant
    const menu = await Menu.getMenuById(parsedMenuId);
    if (!menu) {
      return res.status(404).json({ success: false, error: 'Menu not found' });
    }

    if (menu.restaurant_id !== parsedRestaurantId) {
      return res.status(400).json({ success: false, error: 'Menu does not belong to this restaurant' });
    }

    const item = await Menu.createMenuItem(parsedMenuId, parsedRestaurantId, {
      name,
      description,
      price: parsedPrice,
      discounted_price: parsedDiscountedPrice,
      category,
      image_url,
      is_available: parsedIsAvailable,
      is_veg: parsedIsVeg,
      is_popular: parsedIsPopular,
      ingredients: parsedIngredients,
      tags: parsedTags,
      customizations: parsedCustomizations,
      calories: parsedCalories,
      preparation_time_minutes: parsedPreparationTimeMinutes
    });

    res.status(201).json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Create menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Toggle menu item popular status
exports.toggleMenuItemPopular = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { is_popular } = req.body;

    if (typeof is_popular !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'is_popular must be a boolean value'
      });
    }

    const item = await Menu.updateMenuItem(itemId, { is_popular });

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    res.json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Toggle menu item popular error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Delete menu item
exports.deleteMenuItem = async (req, res) => {
  try {
    const { itemId } = req.params;

    // Verify ownership
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    // Get the item to verify ownership
    const item = await Menu.getMenuItemById(itemId);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Menu item not found' });
    }

    const menu = await Menu.getMenuById(item.menu_id);
    if (!menu) {
      return res.status(404).json({ success: false, error: 'Associated menu not found' });
    }

    const restaurant = await Restaurant.findById(menu.restaurant_id);
    if (!restaurant || restaurant.manager_id !== managerProfile.id) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    // Delete the item
    const result = await db.query('DELETE FROM menu_items WHERE id = $1', [itemId]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    res.json({
      success: true,
      data: { message: 'Menu item deleted successfully' }
    });
  } catch (error) {
    console.error('Delete menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Bulk update menu items
exports.bulkUpdateMenuItems = async (req, res) => {
  try {
    const { item_ids, updates } = req.body;

    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'item_ids must be a non-empty array'
      });
    }

    // Verify ownership of all items
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    // Check that all items belong to restaurants owned by this manager
    const items = await Menu.getMenuItemsByIds(item_ids);
    const unauthorizedItems = [];

    for (const item of items) {
      const menu = await Menu.getMenuById(item.menu_id);
      if (!menu) {
        unauthorizedItems.push(item.id);
        continue;
      }

      const restaurant = await Restaurant.findById(menu.restaurant_id);
      if (!restaurant || restaurant.manager_id !== managerProfile.id) {
        unauthorizedItems.push(item.id);
      }
    }

    if (unauthorizedItems.length > 0) {
      return res.status(403).json({
        success: false,
        error: `Not authorized to update items: ${unauthorizedItems.join(', ')}`
      });
    }

    // Update items
    const updatedItems = await Menu.updateMenuItems(item_ids, updates);

    res.json({
      success: true,
      data: {
        count: updatedItems.length,
        items: updatedItems
      }
    });
  } catch (error) {
    console.error('Bulk update menu items error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Bulk delete menu items
exports.bulkDeleteMenuItems = async (req, res) => {
  try {
    const { item_ids } = req.body;

    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'item_ids must be a non-empty array'
      });
    }

    // Verify ownership of all items
    const managerProfile = await RestaurantManager.findByUserId(req.user.id);
    if (!managerProfile) {
      return res.status(404).json({ success: false, error: 'Manager profile not found' });
    }

    // Check that all items belong to restaurants owned by this manager
    const items = await Menu.getMenuItemsByIds(item_ids);
    const unauthorizedItems = [];

    for (const item of items) {
      const menu = await Menu.getMenuById(item.menu_id);
      if (!menu) {
        unauthorizedItems.push(item.id);
        continue;
      }

      const restaurant = await Restaurant.findById(menu.restaurant_id);
      if (!restaurant || restaurant.manager_id !== managerProfile.id) {
        unauthorizedItems.push(item.id);
      }
    }

    if (unauthorizedItems.length > 0) {
      return res.status(403).json({
        success: false,
        error: `Not authorized to delete items: ${unauthorizedItems.join(', ')}`
      });
    }

    // Delete items
    const result = await db.query('DELETE FROM menu_items WHERE id = ANY($1)', [item_ids]);

    res.json({
      success: true,
      data: {
        count: result.rowCount,
        message: `Deleted ${result.rowCount} menu items successfully`
      }
    });
  } catch (error) {
    console.error('Bulk delete menu items error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
