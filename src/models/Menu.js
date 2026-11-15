const db = require('../config/database');

class Menu {

  // Create menu category 
  static async create(restaurantId, menuData) {
    const { name, description, is_active = true, display_order = 0 } = menuData;
    
    const query = `
      INSERT INTO menus (restaurant_id, name, description, is_active, display_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    
    const result = await db.query(query, [restaurantId, name, description, is_active, display_order]);
    return result.rows[0];
  }

  // Get menus by restaurant with nested items (includes customizations, category, is_popular, etc.)
  static async findByRestaurant(restaurantId, options = {}) {
    const onlyActive = options.onlyActive === true;
    const query = `
      SELECT 
        m.id, m.restaurant_id, m.name, m.description, m.is_active, m.display_order,
        COALESCE(
          json_agg(
            json_build_object(
              'id', mi.id,
              'menu_id', mi.menu_id,
              'restaurant_id', mi.restaurant_id,
              'name', mi.name,
              'description', mi.description,
              'price', mi.price,
              'discounted_price', mi.discounted_price,
              'image_url', mi.image_url,
              'category', COALESCE(mi.category, 'General'),
              'is_available', mi.is_available,
              'is_veg', COALESCE(mi.is_veg, false),
              'is_popular', COALESCE(mi.is_popular, false),
              'calories', mi.calories,
              'preparation_time_minutes', mi.preparation_time_minutes,
              'ingredients', COALESCE(mi.ingredients, '[]'::jsonb),
              'customizations', COALESCE(mi.customizations, '[]'::jsonb),
              'tags', COALESCE(mi.tags, ARRAY[]::text[])
            ) ORDER BY CASE WHEN mi.is_popular = true THEN 0 ELSE 1 END, mi.created_at
          ) FILTER (WHERE mi.id IS NOT NULL), 
          '[]'
        ) as items
      FROM menus m
      LEFT JOIN menu_items mi ON m.id = mi.menu_id
      WHERE m.restaurant_id = $1
        ${onlyActive ? 'AND m.is_active = true' : ''}
      GROUP BY m.id
      ORDER BY m.display_order, m.created_at
    `;
    
    const result = await db.query(query, [restaurantId]);
    return result.rows;
  }

  // Create menu item (Supports image_url, is_popular, customizations, ingredients, tags)
  static async createMenuItem(menuId, restaurantId, itemData) {
    const {
      name,
      description,
      price,
      discounted_price,
      category = 'General',
      tags = [],
      is_available = true,
      is_veg = false,
      is_popular = false,
      ingredients = [],
      customizations = [],
      calories = 0,
      preparation_time_minutes = 15,
      image_url
    } = itemData;

    const normalizedIngredients = typeof ingredients === 'string'
      ? ingredients
      : JSON.stringify(Array.isArray(ingredients) ? ingredients : []);
    const normalizedCustomizations = typeof customizations === 'string'
      ? customizations
      : JSON.stringify(Array.isArray(customizations) ? customizations : []);
    const normalizedTags = Array.isArray(tags)
      ? tags
      : (typeof tags === 'string' && tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : []);
    
    const query = `
      INSERT INTO menu_items (
        menu_id, restaurant_id, name, description, price, 
        discounted_price, category, tags, is_available, 
        is_veg, is_popular, ingredients, customizations, calories, 
        preparation_time_minutes, image_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16)
      RETURNING *
    `;
    
    const result = await db.query(query, [
      menuId,
      restaurantId,
      name,
      description || null,
      parseFloat(price),
      discounted_price != null && discounted_price !== '' ? parseFloat(discounted_price) : null,
      category || 'General',
      normalizedTags,
      Boolean(is_available),
      Boolean(is_veg),
      Boolean(is_popular),
      normalizedIngredients,
      normalizedCustomizations,
      calories != null && calories !== '' ? parseInt(calories, 10) : null,
      preparation_time_minutes != null && preparation_time_minutes !== '' ? parseInt(preparation_time_minutes, 10) : 15,
      image_url || null
    ]);
    
    return result.rows[0];
  }

  // Get menu items by menu (Standard list)
  static async getMenuItems(menuId, filters = {}) {
    const { category, min_price, max_price, tags, is_available = true } = filters;
    
    let query = `
      SELECT * FROM menu_items 
      WHERE menu_id = $1 
        AND is_available = $2
    `;
    
    const params = [menuId, is_available];
    let paramIndex = 3;
    
    if (category) {
      query += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }
    
    if (min_price) {
      query += ` AND price >= $${paramIndex}`;
      params.push(min_price);
      paramIndex++;
    }
    
    if (max_price) {
      query += ` AND price <= $${paramIndex}`;
      params.push(max_price);
      paramIndex++;
    }
    
    if (tags && tags.length > 0) {
      query += ` AND tags && $${paramIndex}`;
      params.push(tags);
      paramIndex++;
    }
    
    query += ` ORDER BY 
      CASE WHEN is_popular = true THEN 0 ELSE 1 END,
      category,
      name`;
    
    const result = await db.query(query, params);
    return result.rows;
  }

  // Update menu item details
  static async updateMenuItem(itemId, updateData) {
    const fields = Object.keys(updateData);
    const values = Object.values(updateData);
    
    // Ensure JSONB fields are stringified for PostgreSQL, while text[] (tags) remains a JS Array
    const jsonFields = ['ingredients', 'customizations'];
    fields.forEach((field, index) => {
      if (jsonFields.includes(field)) {
        if (typeof values[index] !== 'string') {
          values[index] = JSON.stringify(values[index] ?? []);
        }
      } else if (field === 'tags') {
        if (!Array.isArray(values[index])) {
          values[index] = typeof values[index] === 'string' && values[index].trim()
            ? values[index].split(',').map(t => t.trim()).filter(Boolean)
            : [];
        }
      }
    });
    
    const setClause = fields.map((field, index) => {
      if (jsonFields.includes(field)) {
        return `${field} = $${index + 2}::jsonb`;
      }
      return `${field} = $${index + 2}`;
    }).join(', ');
    const query = `UPDATE menu_items SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`;
    
    const result = await db.query(query, [itemId, ...values]);
    return result.rows[0];
  }

  // Update specific menu item image
  static async updateMenuItemImage(itemId, imageUrl) {
    const query = `
      UPDATE menu_items 
      SET image_url = $2 
      WHERE id = $1 
      RETURNING *
    `;
    
    const result = await db.query(query, [itemId, imageUrl]);
    return result.rows[0];
  }

  // Search menu items (PostGIS distance enabled)
  static async searchItems(searchTerm, lat, lng, radiusKm = 5) {
    const query = `
      SELECT 
        mi.*,
        r.name as restaurant_name,
        r.average_rating as restaurant_rating,
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
        ) as distance_meters
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE (mi.name ILIKE $1 OR mi.description ILIKE $1)
        AND mi.is_available = true
        AND r.is_active = true
        AND ST_DWithin(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
          $4 * 1000
        )
      ORDER BY distance_meters ASC
      LIMIT 50
    `;
    
    const result = await db.query(query, [`%${searchTerm}%`, lng, lat, radiusKm]);
    return result.rows;
  }

  // Get single menu item by ID (For editing)
  static async getMenuItemById(itemId) {
    const query = 'SELECT * FROM menu_items WHERE id = $1';
    const result = await db.query(query, [itemId]);
    return result.rows[0];
  }

  // Get menu by ID
  static async getMenuById(menuId) {
    const query = 'SELECT * FROM menus WHERE id = $1';
    const result = await db.query(query, [menuId]);
    return result.rows[0];
  }

  // Get multiple menu items by IDs
  static async getMenuItemsByIds(itemIds) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return [];
    }

    const query = 'SELECT * FROM menu_items WHERE id = ANY($1)';
    const result = await db.query(query, [itemIds]);
    return result.rows;
  }

  // Update multiple menu items
  static async updateMenuItems(itemIds, updates) {
    if (!Array.isArray(itemIds) || itemIds.length === 0 || typeof updates !== 'object') {
      return [];
    }

    const fields = Object.keys(updates);
    const values = Object.values(updates);

    // Ensure JSONB fields are stringified for PostgreSQL, while text[] (tags) remains a JS Array
    const jsonFields = ['ingredients', 'customizations'];
    fields.forEach((field, index) => {
      if (jsonFields.includes(field)) {
        if (typeof values[index] !== 'string') {
          values[index] = JSON.stringify(values[index] ?? []);
        }
      } else if (field === 'tags') {
        if (!Array.isArray(values[index])) {
          values[index] = typeof values[index] === 'string' && values[index].trim()
            ? values[index].split(',').map(t => t.trim()).filter(Boolean)
            : [];
        }
      }
    });

    const setClause = fields.map((field, index) => {
      if (jsonFields.includes(field)) {
        return `${field} = $${index + 2}::jsonb`;
      }
      return `${field} = $${index + 2}`;
    }).join(', ');
    const query = `UPDATE menu_items SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1) RETURNING *`;

    const result = await db.query(query, [itemIds, ...values]);
    return result.rows;
  }

  // Get popular items (high rated, frequently ordered)
  static async getPopularItems(lat, lng, filters = {}) {
    const { radiusKm = 10, limit = 20 } = filters;

    const query = `
      SELECT
        mi.*,
        r.name as restaurant_name,
        r.logo_url as restaurant_logo,
        r.average_rating as restaurant_rating,
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE mi.is_available = true
        AND r.is_active = true
        AND r.is_accepting_orders = true
        AND ST_DWithin(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3 * 1000
        )
      ORDER BY
        -- Add your popularity logic here (ratings, order count, etc.)
        mi.is_popular DESC,
        restaurant_rating DESC,
        distance_meters ASC
      LIMIT $4
    `;

    const result = await db.query(query, [lng, lat, radiusKm, limit]);
    return result.rows;
  }

  // static async getDiscoveryMenus(limit = 10) {
  //   const query = `
  //     SELECT m.id, m.name, m.description, r.name as restaurant_name, r.cover_image_url as image
  //     FROM menus m
  //     JOIN restaurants r ON m.restaurant_id = r.id
  //     WHERE m.is_active = true AND r.is_active = true
  //     ORDER BY m.display_order ASC
  //     LIMIT $1
  //   `;
  //   const result = await db.query(query, [limit]);
  //   return result.rows;
  // }

  // static async getDiscountedItems(limit = 10) {
  //   const query = `
  //     SELECT 
  //       mi.*, 
  //       r.name as restaurant_name,
  //       r.id as restaurant_id
  //     FROM menu_items mi
  //     JOIN restaurants r ON mi.restaurant_id = r.id
  //     WHERE mi.is_available = true 
  //       AND mi.discounted_price IS NOT NULL 
  //       AND mi.discounted_price < mi.price
  //     ORDER BY (mi.price - mi.discounted_price) DESC -- Show biggest savings first
  //     LIMIT $1
  //   `;
  //   const result = await db.query(query, [limit]);
  //   return result.rows;
  // }

  // Get items by category
  static async getItemsByCategory(category, lat, lng, filters = {}) {
    const { radiusKm = 10, limit = 20 } = filters;
    
    const query = `
      SELECT 
        mi.*,
        r.name as restaurant_name,
        r.logo_url as restaurant_logo,
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE mi.is_available = true
        AND r.is_active = true
        AND r.is_accepting_orders = true
        AND mi.category ILIKE $4
        AND ST_DWithin(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3 * 1000
        )
      ORDER BY distance_meters ASC
      LIMIT $5
    `;
    
    const result = await db.query(query, [lng, lat, radiusKm, `%${category}%`, limit]);
    return result.rows;
  }

  static async getDiscoveryMenus(limit = 8) {
    const query = `
      SELECT DISTINCT ON (m.name) 
        m.id, 
        m.name, 
        m.description, 
        m.restaurant_id,  -- ⚠️ MAKE SURE THIS LINE EXISTS!
        r.name as restaurant_name
      FROM menus m
      JOIN restaurants r ON m.restaurant_id = r.id
      WHERE m.is_active = true AND r.is_active = true
      ORDER BY m.name, m.display_order
      LIMIT $1
    `;
    const result = await db.query(query, [limit]);
    return result.rows;
  }

  static async getAllDiscoveryItems(limit = 10) {
    const query = `
      SELECT 
        mi.id, mi.menu_id, mi.name, mi.description, mi.price, mi.discounted_price, mi.image_url,
        mi.category, mi.is_veg, mi.is_popular, mi.calories, mi.preparation_time_minutes,
        mi.ingredients, mi.customizations, mi.tags,
        r.id as restaurant_id, r.name as restaurant_name
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE mi.is_available = true AND r.is_active = true
      ORDER BY CASE WHEN mi.is_popular = true THEN 0 ELSE 1 END, mi.created_at DESC
      LIMIT $1
    `;
    const result = await db.query(query, [limit]);
    return result.rows;
  }
}

module.exports = Menu;