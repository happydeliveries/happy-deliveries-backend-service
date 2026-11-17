const db = require('../config/database');
const { applyAvailabilityToRestaurant } = require('../utils/restaurantHours');

let categoriesSchemaPromise = null;

class Menu {
  /**
   * Ensures menu_items.categories (text[]) and its GIN index exist and backfills
   * legacy single-string category rows idempotently once per process.
   */
  static async ensureCategoriesSchema() {
    if (!categoriesSchemaPromise) {
      categoriesSchemaPromise = (async () => {
        try {
          await db.query(`
            ALTER TABLE menu_items
            ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}'::text[]
          `);
          await db.query(`
            CREATE INDEX IF NOT EXISTS idx_menu_items_categories
            ON menu_items USING GIN (categories)
          `);
          await db.query(`
            UPDATE menu_items
            SET categories = CASE
              WHEN NULLIF(TRIM(category), '') IS NOT NULL
                THEN regexp_split_to_array(TRIM(category), '\\s*,\\s*')
              ELSE ARRAY['General']::text[]
            END
            WHERE categories IS NULL OR cardinality(categories) = 0
          `);
        } catch (err) {
          categoriesSchemaPromise = null;
          throw err;
        }
      })();
    }
    return categoriesSchemaPromise;
  }

  /**
   * Parses categories from array, JSON string, or comma-separated text and
   * returns deduplicated { categories, category } with legacy primary fallback.
   */
  static normalizeCategoriesInput(categoriesInput, categoryInput, { defaultToGeneral = true } = {}) {
    const parseRaw = (raw) => {
      if (raw === undefined || raw === null) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
          } catch (_) {
            // Fall through to comma split
          }
        }
        return trimmed.split(',');
      }
      return [String(raw)];
    };

    const primaryList = parseRaw(categoriesInput);
    const fallbackList = parseRaw(categoryInput);
    const combined = primaryList.length > 0 ? primaryList : fallbackList;

    const seen = new Set();
    const categories = [];
    for (const entry of combined) {
      const clean = String(entry || '').trim();
      if (!clean) continue;
      const slug = clean.toLowerCase();
      if (seen.has(slug)) continue;
      seen.add(slug);
      categories.push(clean);
    }

    if (categories.length === 0 && defaultToGeneral) {
      categories.push('General');
    }

    return {
      categories,
      category: categories[0] || (defaultToGeneral ? 'General' : ''),
    };
  }

  /**
   * SQL expression yielding a non-empty text[] of categories for a menu_items row,
   * falling back to splitting legacy menu_items.category if categories[] is empty.
   */
  static sqlCategoriesExpr(alias = 'mi', emptyFallback = "ARRAY['General']::text[]") {
    const prefix = alias ? `${alias}.` : '';
    return `
      COALESCE(
        NULLIF(${prefix}categories, '{}'::text[]),
        CASE
          WHEN NULLIF(TRIM(${prefix}category), '') IS NOT NULL
            THEN regexp_split_to_array(TRIM(${prefix}category), '\\s*,\\s*')
          ELSE ${emptyFallback}
        END
      )
    `;
  }

  static formatMenuItem(item) {
    if (!item) return item;
    const { categories, category } = Menu.normalizeCategoriesInput(item.categories, item.category);
    return {
      ...item,
      category,
      categories,
    };
  }

  /**
   * Normalizes partial menu_item updates (jsonb fields, tags[], category/categories sync)
   * and constructs parameterized SQL SET clauses for single and bulk updates.
   */
  static buildUpdateSetClause(rawUpdates, startParamIdx = 2) {
    const ALLOWED_COLUMNS = new Set([
      'name',
      'description',
      'price',
      'discounted_price',
      'image_url',
      'category',
      'categories',
      'tags',
      'is_available',
      'is_popular',
      'ingredients',
      'customizations',
      'calories',
      'preparation_time_minutes',
      'is_veg',
    ]);

    const normalized = {};
    Object.keys(rawUpdates || {}).forEach((key) => {
      if (ALLOWED_COLUMNS.has(key) && rawUpdates[key] !== undefined) {
        normalized[key] = rawUpdates[key];
      }
    });

    const hasCategories = Object.prototype.hasOwnProperty.call(rawUpdates || {}, 'categories') && rawUpdates.categories !== undefined;
    const hasCategory = Object.prototype.hasOwnProperty.call(rawUpdates || {}, 'category') && rawUpdates.category !== undefined;

    if (hasCategories || hasCategory) {
      const { categories, category } = Menu.normalizeCategoriesInput(
        hasCategories ? rawUpdates.categories : undefined,
        hasCategory ? rawUpdates.category : undefined
      );
      normalized.categories = categories;
      normalized.category = category;
    }

    const fields = Object.keys(normalized);
    const values = Object.values(normalized);
    const jsonFields = ['ingredients', 'customizations'];

    fields.forEach((field, index) => {
      if (jsonFields.includes(field)) {
        if (typeof values[index] !== 'string') {
          values[index] = JSON.stringify(values[index] ?? []);
        }
      } else if (field === 'tags' || field === 'categories') {
        if (!Array.isArray(values[index])) {
          values[index] = typeof values[index] === 'string' && values[index].trim()
            ? values[index].split(',').map(t => t.trim()).filter(Boolean)
            : [];
        }
      }
    });

    const setClause = fields.map((field, index) => {
      const pIdx = index + startParamIdx;
      if (jsonFields.includes(field)) {
        return `${field} = $${pIdx}::jsonb`;
      }
      return `${field} = $${pIdx}`;
    }).join(', ');

    return { fields, values, setClause };
  }

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

  // Get menus by restaurant with nested items (includes customizations, category, categories, is_popular, etc.)
  static async findByRestaurant(restaurantId, options = {}) {
    await Menu.ensureCategoriesSchema();
    const onlyActive = options.onlyActive === true;
    const catExpr = Menu.sqlCategoriesExpr('mi');
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
              'category', COALESCE(NULLIF(TRIM(mi.category), ''), (${catExpr})[1], 'General'),
              'categories', ${catExpr},
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

  // Create menu item (Supports multi-categories, image_url, is_popular, customizations, ingredients, tags)
  static async createMenuItem(menuId, restaurantId, itemData) {
    await Menu.ensureCategoriesSchema();
    const {
      name,
      description,
      price,
      discounted_price,
      category,
      categories,
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

    const normalizedCat = Menu.normalizeCategoriesInput(categories, category);
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
        discounted_price, category, categories, tags, is_available, 
        is_veg, is_popular, ingredients, customizations, calories, 
        preparation_time_minutes, image_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17)
      RETURNING *
    `;
    
    const result = await db.query(query, [
      menuId,
      restaurantId,
      name,
      description || null,
      parseFloat(price),
      discounted_price != null && discounted_price !== '' ? parseFloat(discounted_price) : null,
      normalizedCat.category,
      normalizedCat.categories,
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
    
    return Menu.formatMenuItem(result.rows[0]);
  }

  // Get menu items by menu (Standard list)
  static async getMenuItems(menuId, filters = {}) {
    await Menu.ensureCategoriesSchema();
    const { category, min_price, max_price, tags, is_available = true } = filters;
    const catExpr = Menu.sqlCategoriesExpr('mi');
    
    let query = `
      SELECT mi.* FROM menu_items mi
      WHERE mi.menu_id = $1 
        AND mi.is_available = $2
    `;
    
    const params = [menuId, is_available];
    let paramIndex = 3;
    
    if (category) {
      query += `
        AND EXISTS (
          SELECT 1 FROM unnest(${catExpr}) AS cat
          WHERE LOWER(TRIM(cat)) = LOWER(TRIM($${paramIndex}))
        )
      `;
      params.push(category);
      paramIndex++;
    }
    
    if (min_price) {
      query += ` AND mi.price >= $${paramIndex}`;
      params.push(min_price);
      paramIndex++;
    }
    
    if (max_price) {
      query += ` AND mi.price <= $${paramIndex}`;
      params.push(max_price);
      paramIndex++;
    }
    
    if (tags && tags.length > 0) {
      query += ` AND mi.tags && $${paramIndex}`;
      params.push(tags);
      paramIndex++;
    }
    
    query += ` ORDER BY 
      CASE WHEN mi.is_popular = true THEN 0 ELSE 1 END,
      mi.category,
      mi.name`;
    
    const result = await db.query(query, params);
    return result.rows.map(Menu.formatMenuItem);
  }

  // Update menu item details
  static async updateMenuItem(itemId, updateData) {
    await Menu.ensureCategoriesSchema();
    const { fields, values, setClause } = Menu.buildUpdateSetClause(updateData, 2);
    if (fields.length === 0) {
      return Menu.getMenuItemById(itemId);
    }

    const query = `UPDATE menu_items SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`;
    
    const result = await db.query(query, [itemId, ...values]);
    return Menu.formatMenuItem(result.rows[0]);
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
  static async searchItems(searchTerm, lat, lng, optionsOrRadius = 20) {
    await Menu.ensureCategoriesSchema();
    const opts = typeof optionsOrRadius === 'object' && optionsOrRadius !== null
      ? optionsOrRadius
      : { radiusKm: optionsOrRadius };
    const radiusKm = Number.isFinite(Number(opts.radiusKm)) ? Number(opts.radiusKm) : 20;
    const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 50;
    const minRating = Number.isFinite(Number(opts.minRating)) ? Number(opts.minRating) : null;
    const popularOnly = opts.popularOnly === true;
    const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const term = typeof searchTerm === 'string' ? searchTerm.trim() : '';
    const catExpr = Menu.sqlCategoriesExpr('mi', "ARRAY[]::text[]");

    const values = [];
    let paramIdx = 1;

    let distanceSelect = 'NULL::double precision as distance_meters';
    let distanceWhere = '';
    if (hasCoords) {
      values.push(Number(lng), Number(lat), radiusKm);
      distanceSelect = `
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      `;
      distanceWhere = `
        AND ST_DWithin(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3 * 1000
        )
      `;
      paramIdx = 4;
    }

    let termWhere = '';
    if (term) {
      values.push(`%${term}%`);
      termWhere = `
        AND (
          mi.name ILIKE $${paramIdx}
          OR COALESCE(mi.description, '') ILIKE $${paramIdx}
          OR COALESCE(mi.category, '') ILIKE $${paramIdx}
          OR EXISTS (
            SELECT 1 FROM unnest(${catExpr}) AS cat
            WHERE cat ILIKE $${paramIdx}
          )
          OR r.name ILIKE $${paramIdx}
        )
      `;
      paramIdx += 1;
    }

    let ratingWhere = '';
    if (minRating !== null) {
      values.push(minRating);
      ratingWhere = ` AND COALESCE(r.average_rating, 0) >= $${paramIdx}`;
      paramIdx += 1;
    }

    const popularWhere = popularOnly ? ' AND mi.is_popular = true' : '';
    values.push(limit);

    const query = `
      SELECT 
        mi.*,
        r.id as restaurant_id,
        r.name as restaurant_name,
        r.logo_url as restaurant_logo,
        r.average_rating as restaurant_rating,
        r.opening_hours,
        r.is_active,
        r.is_accepting_orders,
        ${distanceSelect}
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE mi.is_available = true
        AND r.is_active = true
        AND COALESCE(r.approval_status, 'approved') = 'approved'
        ${distanceWhere}
        ${termWhere}
        ${ratingWhere}
        ${popularWhere}
      ORDER BY ${hasCoords ? 'distance_meters ASC,' : ''} mi.is_popular DESC, mi.created_at DESC
      LIMIT $${paramIdx}
    `;

    const result = await db.query(query, values);
    return result.rows.map((row) => Menu.formatMenuItem(applyAvailabilityToRestaurant(row)));
  }

  // Get single menu item by ID (For editing)
  static async getMenuItemById(itemId) {
    await Menu.ensureCategoriesSchema();
    const query = 'SELECT * FROM menu_items WHERE id = $1';
    const result = await db.query(query, [itemId]);
    return Menu.formatMenuItem(result.rows[0]);
  }

  // Get menu by ID
  static async getMenuById(menuId) {
    const query = 'SELECT * FROM menus WHERE id = $1';
    const result = await db.query(query, [menuId]);
    return result.rows[0];
  }

  // Get multiple menu items by IDs
  static async getMenuItemsByIds(itemIds) {
    await Menu.ensureCategoriesSchema();
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return [];
    }

    const query = 'SELECT * FROM menu_items WHERE id = ANY($1)';
    const result = await db.query(query, [itemIds]);
    return result.rows.map(Menu.formatMenuItem);
  }

  // Update multiple menu items
  static async updateMenuItems(itemIds, updates) {
    await Menu.ensureCategoriesSchema();
    if (!Array.isArray(itemIds) || itemIds.length === 0 || typeof updates !== 'object') {
      return [];
    }

    const { fields, values, setClause } = Menu.buildUpdateSetClause(updates, 2);
    if (fields.length === 0) {
      return Menu.getMenuItemsByIds(itemIds);
    }
    const query = `UPDATE menu_items SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1) RETURNING *`;

    const result = await db.query(query, [itemIds, ...values]);
    return result.rows.map(Menu.formatMenuItem);
  }

  // Get popular items (strictly items marked popular)
  static async getPopularItems(lat, lng, filters = {}) {
    await Menu.ensureCategoriesSchema();
    const { radiusKm = 20, limit = 20 } = filters;
    const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const values = hasCoords ? [Number(lng), Number(lat), Number(radiusKm) || 20, limit] : [limit];

    const query = hasCoords
      ? `
        SELECT
          mi.*,
          r.id as restaurant_id,
          r.name as restaurant_name,
          r.logo_url as restaurant_logo,
          r.average_rating as restaurant_rating,
          r.opening_hours,
          r.is_active,
          r.is_accepting_orders,
          ST_Distance(
            r.location::geography,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
          ) as distance_meters
        FROM menu_items mi
        JOIN restaurants r ON mi.restaurant_id = r.id
        WHERE mi.is_available = true
          AND mi.is_popular = true
          AND r.is_active = true
          AND COALESCE(r.approval_status, 'approved') = 'approved'
          AND ST_DWithin(
            r.location::geography,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3 * 1000
          )
        ORDER BY
          COALESCE(r.average_rating, 0) DESC,
          distance_meters ASC,
          mi.created_at DESC
        LIMIT $4
      `
      : `
        SELECT
          mi.*,
          r.id as restaurant_id,
          r.name as restaurant_name,
          r.logo_url as restaurant_logo,
          r.average_rating as restaurant_rating,
          r.opening_hours,
          r.is_active,
          r.is_accepting_orders
        FROM menu_items mi
        JOIN restaurants r ON mi.restaurant_id = r.id
        WHERE mi.is_available = true
          AND mi.is_popular = true
          AND r.is_active = true
          AND COALESCE(r.approval_status, 'approved') = 'approved'
        ORDER BY
          COALESCE(r.average_rating, 0) DESC,
          mi.created_at DESC
        LIMIT $1
      `;

    const result = await db.query(query, values);
    return result.rows.map((row) => Menu.formatMenuItem(applyAvailabilityToRestaurant(row)));
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

  // Get items by category (matches any element of multi-category list or legacy category)
  static async getItemsByCategory(category, lat, lng, filters = {}) {
    await Menu.ensureCategoriesSchema();
    const { radiusKm = 10, limit = 20 } = filters;
    const catExpr = Menu.sqlCategoriesExpr('mi', "ARRAY[]::text[]");
    
    const query = `
      SELECT 
        mi.*,
        r.name as restaurant_name,
        r.logo_url as restaurant_logo,
        r.opening_hours,
        r.is_active,
        r.is_accepting_orders,
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE mi.is_available = true
        AND r.is_active = true
        AND COALESCE(r.approval_status, 'approved') = 'approved'
        AND r.is_accepting_orders = true
        AND EXISTS (
          SELECT 1 FROM unnest(${catExpr}) AS cat
          WHERE TRIM(cat) ILIKE $4
        )
        AND ST_DWithin(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3 * 1000
        )
      ORDER BY distance_meters ASC
      LIMIT $5
    `;
    
    const result = await db.query(query, [lng, lat, radiusKm, `%${String(category || '').trim()}%`, limit]);
    return result.rows
      .map((row) => Menu.formatMenuItem(applyAvailabilityToRestaurant(row)))
      .filter((row) => row.is_open_now);
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
      WHERE m.is_active = true
        AND r.is_active = true
        AND COALESCE(r.approval_status, 'approved') = 'approved'
      ORDER BY m.name, m.display_order
      LIMIT $1
    `;
    const result = await db.query(query, [limit]);
    return result.rows;
  }

  static async getFoodCategories(lat = null, lng = null, maxDistance = 90) {
    await Menu.ensureCategoriesSchema();
    const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const radiusMeters = (Number(maxDistance) || 90) * 1000;
    const values = hasCoords ? [Number(lng), Number(lat), radiusMeters] : [];
    const catExpr = Menu.sqlCategoriesExpr('mi', "ARRAY[]::text[]");

    const distanceCondition = hasCoords
      ? `
        AND ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) <= LEAST($3::numeric, COALESCE(r.delivery_radius_km * 1000, $3)::numeric)
      `
      : '';

    const query = `
      WITH normalized AS (
        SELECT DISTINCT
          mi.id AS item_id,
          LOWER(TRIM(raw_cat)) AS slug,
          TRIM(raw_cat) AS display_name,
          r.id AS restaurant_id,
          NULLIF(TRIM(mi.image_url), '') AS item_image,
          NULLIF(TRIM(r.cover_image_url), '') AS restaurant_cover
        FROM menu_items mi
        JOIN restaurants r ON mi.restaurant_id = r.id
        CROSS JOIN LATERAL unnest(${catExpr}) AS raw_cat
        WHERE mi.is_available = true
          AND r.is_active = true
          AND COALESCE(r.approval_status, 'approved') = 'approved'
          AND raw_cat IS NOT NULL
          AND TRIM(raw_cat) <> ''
          ${distanceCondition}
      )
      SELECT
        MAX(display_name) AS name,
        slug,
        COUNT(DISTINCT item_id)::int AS item_count,
        COUNT(DISTINCT restaurant_id)::int AS restaurant_count,
        ARRAY_AGG(DISTINCT restaurant_id) AS restaurant_ids,
        COALESCE(MAX(item_image), MAX(restaurant_cover)) AS image_url
      FROM normalized
      GROUP BY slug
      ORDER BY restaurant_count DESC, item_count DESC, name ASC
    `;

    const result = await db.query(query, values);
    return result.rows;
  }

  static async getAllDiscoveryItems(limit = 20, lat = null, lng = null, maxDistance = 90) {
    await Menu.ensureCategoriesSchema();
    const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const radiusMeters = (Number(maxDistance) || 90) * 1000;
    const values = hasCoords ? [Number(lng), Number(lat), radiusMeters, limit] : [limit];
    const catExpr = Menu.sqlCategoriesExpr('mi');

    const distanceSelect = hasCoords
      ? `
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters,
      `
      : '';

    const distanceCondition = hasCoords
      ? `
        AND ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) <= LEAST($3::numeric, COALESCE(r.delivery_radius_km * 1000, $3)::numeric)
      `
      : '';

    const limitParam = hasCoords ? '$4' : '$1';

    const query = `
      SELECT 
        mi.id, mi.menu_id, mi.name, mi.description, mi.price, mi.discounted_price, mi.image_url,
        mi.category, ${catExpr} AS categories, mi.is_veg, mi.is_popular, mi.calories, mi.preparation_time_minutes,
        mi.ingredients, mi.customizations, mi.tags,
        ${distanceSelect}
        r.id as restaurant_id,
        r.name as restaurant_name,
        r.logo_url as restaurant_logo,
        r.average_rating as restaurant_rating,
        r.opening_hours,
        r.is_active,
        r.is_accepting_orders
      FROM menu_items mi
      JOIN restaurants r ON mi.restaurant_id = r.id
      WHERE mi.is_available = true
        AND mi.is_popular = true
        AND r.is_active = true
        AND COALESCE(r.approval_status, 'approved') = 'approved'
        ${distanceCondition}
      ORDER BY ${hasCoords ? 'distance_meters ASC,' : ''} COALESCE(r.average_rating, 0) DESC, mi.created_at DESC
      LIMIT ${limitParam}
    `;
    const result = await db.query(query, values);
    return result.rows.map((row) => Menu.formatMenuItem(applyAvailabilityToRestaurant(row)));
  }
}

module.exports = Menu;