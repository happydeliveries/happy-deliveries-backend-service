const db = require('../config/database');
const bcrypt = require('bcryptjs');
const Menu = require('./Menu');
const { evaluateRestaurantAvailability, applyAvailabilityToRestaurant } = require('../utils/restaurantHours');
const { calculateRadialDeliveryFee } = require('../utils/deliveryPricing');

let schemaEnsurePromise = null;

class Restaurant {
  static async ensureApplicationColumns() {
    if (!schemaEnsurePromise) {
      schemaEnsurePromise = (async () => {
        try {
          await db.query(`
            ALTER TABLE restaurant_managers
              ADD COLUMN IF NOT EXISTS account_type VARCHAR(30) DEFAULT 'platform_admin',
              ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) DEFAULT 'approved'
          `);
          await db.query(`
            ALTER TABLE restaurants
              ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) DEFAULT 'approved',
              ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
              ADD COLUMN IF NOT EXISTS application_data JSONB DEFAULT '{}'::jsonb,
              ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
              ADD COLUMN IF NOT EXISTS reviewed_by UUID,
              ADD COLUMN IF NOT EXISTS owner_user_id UUID,
              ADD COLUMN IF NOT EXISTS registration_source VARCHAR(30) DEFAULT 'admin'
          `);
        } catch (err) {
          console.warn('[Restaurant.ensureApplicationColumns] Warning:', err.message);
        }
      })();
    }
    return schemaEnsurePromise;
  }

  static isPlatformAdmin(managerProfile) {
    return Boolean(managerProfile && managerProfile.account_type !== 'restaurant_partner');
  }

  static parseOpeningHoursDisplay(openingHours) {
    if (!openingHours) return '08:00 - 21:00';
    if (typeof openingHours === 'object') return openingHours.display || '08:00 - 21:00';
    try {
      const parsed = JSON.parse(openingHours);
      if (parsed && parsed.display) return parsed.display;
    } catch (_) {
      // plain string format
    }
    return String(openingHours);
  }

  static normalizeRestaurantRecord(row) {
    if (!row) return null;
    const rawApp = typeof row.application_data === 'string'
      ? (() => { try { return JSON.parse(row.application_data); } catch { return {}; } })()
      : (row.application_data || {});

    let approvalStatus = row.approval_status || rawApp.approval_status || 'approved';
    if (['pending', 'rejected', 'approved'].includes(rawApp.approval_status) && row.registration_source === 'self_registered' && !row.approval_status) {
      approvalStatus = rawApp.approval_status;
    }

    const avail = evaluateRestaurantAvailability({
      ...row,
      is_active: row.is_active,
      is_accepting_orders: row.is_accepting_orders,
      opening_hours: row.opening_hours,
    });

    return {
      ...row,
      lat: row.lat !== undefined && row.lat !== null ? Number(row.lat) : (row.latitude !== undefined ? Number(row.latitude) : null),
      lng: row.lng !== undefined && row.lng !== null ? Number(row.lng) : (row.longitude !== undefined ? Number(row.longitude) : null),
      opening_hours_display: avail.opening_hours_display,
      is_within_hours: avail.is_within_hours,
      is_open_now: avail.is_open_now,
      opens_at: avail.opens_at,
      closes_at: avail.closes_at,
      closed_reason: avail.is_open_now ? null : avail.status_message,
      approval_status: approvalStatus,
      rejection_reason: row.rejection_reason ?? rawApp.rejection_reason ?? null,
      reviewed_at: row.reviewed_at ?? rawApp.reviewed_at ?? null,
      registration_source: row.registration_source || rawApp.registration_source || 'admin',
      application_details: {
        owner_first_name: rawApp.owner_first_name || row.owner_first_name || row.manager_first_name || '',
        owner_last_name: rawApp.owner_last_name || row.owner_last_name || row.manager_last_name || '',
        owner_email: rawApp.owner_email || row.owner_email || row.manager_email || row.email || '',
        owner_phone: rawApp.owner_phone || row.owner_phone || row.phone_number || '',
        owner_id_number: rawApp.owner_id_number || '',
        business_registration_number: rawApp.business_registration_number || '',
        vat_number: rawApp.vat_number || '',
        city: rawApp.city || '',
        postal_code: rawApp.postal_code || '',
        bank_name: rawApp.bank_name || '',
        account_holder_name: rawApp.account_holder_name || '',
        account_number: rawApp.account_number || '',
        branch_code: rawApp.branch_code || '',
        account_type: rawApp.account_type || 'Cheque / Current',
        applicant_notes: rawApp.applicant_notes || '',
        approval_notes: rawApp.approval_notes || null,
        submitted_at: rawApp.submitted_at || row.created_at,
      },
    };
  }

  // Create restaurant (admin / direct creation)
  static async create(managerId, data) {
    await this.ensureApplicationColumns();
    const {
      name, description, cuisine_type, address,
      latitude, longitude, phone_number, email,
      opening_hours, preparation_time, preparation_time_minutes,
      delivery_radius_km, logo_url, cover_url, cover_image_url,
      owner_user_id, registration_source
    } = data;

    const cuisineText = Array.isArray(cuisine_type)
      ? cuisine_type.map(item => String(item).trim()).filter(Boolean).join(', ')
      : (cuisine_type || '');

    const latVal = Number.isFinite(Number(latitude)) ? Number(latitude) : -26.2041;
    const lngVal = Number.isFinite(Number(longitude)) ? Number(longitude) : 28.0473;
    const prepMins = parseInt(preparation_time_minutes ?? preparation_time, 10) || 20;
    const radiusKm = parseInt(delivery_radius_km, 10) || 5;

    const query = `
      INSERT INTO restaurants (
        manager_id, owner_user_id, name, description, cuisine_type, 
        address, location, phone_number, email,
        opening_hours, preparation_time_minutes, delivery_radius_km,
        logo_url, cover_image_url, total_ratings, is_active, is_accepting_orders,
        approval_status, registration_source
      )
      VALUES (
        $1, $2, $3, $4, $5, 
        $6, ST_SetSRID(ST_MakePoint($8, $7), 4326),
        $9, $10, $11, $12, $13, $14, $15,
        0, true, true,
        'approved', $16
      )
      RETURNING *
    `;

    const values = [
      managerId,
      owner_user_id || null,
      name,
      description || null,
      cuisineText,
      address,
      latVal,
      lngVal,
      phone_number || null,
      email || null,
      JSON.stringify({ display: opening_hours || '08:00 - 21:00' }),
      prepMins,
      radiusKm,
      logo_url || null,
      cover_image_url || cover_url || null,
      registration_source || 'admin'
    ];

    const result = await db.query(query, values);
    const created = result.rows[0];
    if (created) {
      await this.addRestaurantToManager(managerId, created.id).catch(() => {});
    }
    return created;
  }

  // Register a new restaurant partner application (starts pending until Happy approves)
  static async registerApplication(data = {}) {
    await this.ensureApplicationColumns();
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const ownerEmail = String(data.owner_email || data.email || '').trim().toLowerCase();
      const ownerPhone = String(data.owner_phone || data.phone_number || '').trim();
      const restaurantPhone = String(data.restaurant_phone || data.phone_number || ownerPhone || '').trim();
      const restaurantEmail = String(data.restaurant_email || ownerEmail).trim().toLowerCase();
      const firstName = String(data.first_name || data.owner_first_name || '').trim();
      const lastName = String(data.last_name || data.owner_last_name || '').trim();
      const restaurantName = String(data.restaurant_name || data.name || '').trim();
      const address = String(data.address || '').trim();

      if (!ownerEmail || !data.password || !firstName || !lastName || !restaurantName || !address) {
        throw new Error('Owner details, login email, password, restaurant name, and full address are required');
      }
      if (String(data.password).length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }

      const emailCheck = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [ownerEmail]);
      if (emailCheck.rows.length > 0) {
        throw new Error('An account with this email address already exists');
      }

      if (ownerPhone) {
        const phoneCheck = await client.query('SELECT id FROM users WHERE phone_number = $1', [ownerPhone]);
        if (phoneCheck.rows.length > 0) {
          throw new Error('This phone number is already registered with another account');
        }
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(String(data.password), salt);

      const userRes = await client.query(
        `INSERT INTO users (email, phone_number, password_hash, role, first_name, last_name, is_active, email_verified)
         VALUES ($1, $2, $3, 'restaurant_manager', $4, $5, false, false)
         RETURNING id, email, phone_number, role, first_name, last_name, is_active, created_at`,
        [ownerEmail, ownerPhone || null, passwordHash, firstName, lastName]
      );
      const user = userRes.rows[0];

      const rmRes = await client.query(
        `INSERT INTO restaurant_managers (user_id, restaurant_ids, account_type, approval_status)
         VALUES ($1, '{}'::uuid[], 'restaurant_partner', 'pending')
         RETURNING *`,
        [user.id]
      );
      const manager = rmRes.rows[0];

      const cuisineText = Array.isArray(data.cuisine_type)
        ? data.cuisine_type.map(c => String(c).trim()).filter(Boolean).join(', ')
        : String(data.cuisine_type || 'General').trim();
      const lat = Number.isFinite(Number(data.latitude)) ? Number(data.latitude) : -26.2041;
      const lng = Number.isFinite(Number(data.longitude)) ? Number(data.longitude) : 28.0473;
      const prepMinutes = parseInt(data.preparation_time_minutes, 10) || 25;
      const deliveryRadiusKm = parseInt(data.delivery_radius_km, 10) || 8;
      const openingHoursDisplay = String(data.opening_hours || data.opening_hours_display || '08:00 - 21:00').trim();

      const applicationMeta = {
        approval_status: 'pending',
        rejection_reason: null,
        registration_source: 'self_registered',
        submitted_at: new Date().toISOString(),
        owner_first_name: firstName,
        owner_last_name: lastName,
        owner_email: ownerEmail,
        owner_phone: ownerPhone,
        owner_id_number: String(data.owner_id_number || '').trim(),
        business_registration_number: String(data.business_registration_number || '').trim(),
        vat_number: String(data.vat_number || '').trim(),
        city: String(data.city || '').trim(),
        postal_code: String(data.postal_code || '').trim(),
        bank_name: String(data.bank_name || '').trim(),
        account_holder_name: String(data.account_holder_name || '').trim(),
        account_number: String(data.account_number || '').trim(),
        branch_code: String(data.branch_code || '').trim(),
        account_type: String(data.account_type || 'Cheque / Current').trim(),
        applicant_notes: String(data.applicant_notes || '').trim(),
      };

      const restRes = await client.query(
        `INSERT INTO restaurants (
          manager_id, owner_user_id, name, description, cuisine_type,
          phone_number, email, address, location, delivery_radius_km,
          logo_url, cover_image_url, opening_hours, preparation_time_minutes,
          is_active, is_accepting_orders, approval_status, registration_source,
          application_data
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, ST_SetSRID(ST_MakePoint($10, $9), 4326), $11,
          $12, $13, $14, $15,
          false, false, 'pending', 'self_registered',
          $16::jsonb
        )
        RETURNING *, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng`,
        [
          manager.id,
          user.id,
          restaurantName,
          String(data.description || '').trim() || null,
          cuisineText,
          restaurantPhone || null,
          restaurantEmail || null,
          address,
          lat,
          lng,
          deliveryRadiusKm,
          data.logo_url || null,
          data.cover_image_url || null,
          JSON.stringify({ display: openingHoursDisplay }),
          prepMinutes,
          JSON.stringify(applicationMeta),
        ]
      );
      const restaurant = restRes.rows[0];

      await client.query(
        `UPDATE restaurant_managers SET restaurant_ids = ARRAY[$2::uuid], updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [manager.id, restaurant.id]
      );

      await client.query('COMMIT');
      return {
        user,
        manager,
        restaurant: this.normalizeRestaurantRecord({
          ...restaurant,
          owner_first_name: user.first_name,
          owner_last_name: user.last_name,
          owner_email: user.email,
          owner_phone: user.phone_number,
          owner_is_active: user.is_active,
          account_type: manager.account_type,
        }),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async findApplicationByEmail(email) {
    await this.ensureApplicationColumns();
    const result = await db.query(
      `SELECT r.*,
              ST_Y(r.location::geometry) AS lat,
              ST_X(r.location::geometry) AS lng,
              rm.id AS manager_profile_id,
              COALESCE(rm.account_type, 'platform_admin') AS account_type,
              u.id AS user_id,
              u.email AS owner_email,
              u.password_hash AS owner_password_hash,
              u.first_name AS owner_first_name,
              u.last_name AS owner_last_name,
              u.phone_number AS owner_phone,
              u.is_active AS owner_is_active
       FROM restaurants r
       JOIN restaurant_managers rm ON r.manager_id = rm.id
       JOIN users u ON COALESCE(r.owner_user_id, rm.user_id) = u.id
       WHERE LOWER(u.email) = LOWER($1) OR LOWER(COALESCE(r.email, '')) = LOWER($1)
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [String(email || '').trim()]
    );
    if (!result.rows[0]) return null;
    return this.normalizeRestaurantRecord(result.rows[0]);
  }

  static async findByIdWithOwner(restaurantId) {
    await this.ensureApplicationColumns();
    const result = await db.query(
      `SELECT r.*,
              ST_Y(r.location::geometry) AS lat,
              ST_X(r.location::geometry) AS lng,
              rm.id AS manager_profile_id,
              COALESCE(rm.account_type, 'platform_admin') AS account_type,
              u.id AS owner_resolved_user_id,
              u.email AS owner_email,
              u.first_name AS owner_first_name,
              u.last_name AS owner_last_name,
              u.phone_number AS owner_phone,
              u.is_active AS owner_is_active,
              (SELECT COUNT(*)::int FROM menus m WHERE m.restaurant_id = r.id) AS menu_count,
              (SELECT COUNT(*)::int FROM menu_items mi WHERE mi.restaurant_id = r.id) AS item_count,
              (SELECT COUNT(*)::int FROM orders o WHERE o.restaurant_id = r.id) AS orders_count,
              COALESCE((SELECT SUM(o.total_amount) FROM orders o WHERE o.restaurant_id = r.id AND o.status = 'delivered'), 0) AS delivered_revenue
       FROM restaurants r
       JOIN restaurant_managers rm ON r.manager_id = rm.id
       JOIN users u ON COALESCE(r.owner_user_id, rm.user_id) = u.id
       WHERE r.id = $1`,
      [restaurantId]
    );
    return this.normalizeRestaurantRecord(result.rows[0]);
  }

  static async updateApplication(restaurantId, updateData = {}) {
    await this.ensureApplicationColumns();
    const existing = await this.findByIdWithOwner(restaurantId);
    if (!existing) throw new Error('Restaurant application not found');

    const prevDetails = existing.application_details || {};
    const ownerUserId = existing.owner_user_id || existing.owner_resolved_user_id;

    if (ownerUserId && (updateData.first_name || updateData.last_name || updateData.owner_phone)) {
      await db.query(
        `UPDATE users
         SET first_name = COALESCE($2, first_name),
             last_name = COALESCE($3, last_name),
             phone_number = COALESCE($4, phone_number),
             is_active = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          ownerUserId,
          updateData.first_name || updateData.owner_first_name || null,
          updateData.last_name || updateData.owner_last_name || null,
          updateData.owner_phone || updateData.phone_number || null,
        ]
      );
    }

    await db.query(
      `UPDATE restaurant_managers SET approval_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [existing.manager_id]
    );

    const updatedMeta = {
      ...prevDetails,
      approval_status: 'pending',
      rejection_reason: null,
      registration_source: existing.registration_source || 'self_registered',
      submitted_at: new Date().toISOString(),
      owner_first_name: updateData.first_name ?? updateData.owner_first_name ?? prevDetails.owner_first_name ?? '',
      owner_last_name: updateData.last_name ?? updateData.owner_last_name ?? prevDetails.owner_last_name ?? '',
      owner_phone: updateData.owner_phone ?? updateData.phone_number ?? prevDetails.owner_phone ?? '',
      owner_id_number: updateData.owner_id_number ?? prevDetails.owner_id_number ?? '',
      business_registration_number: updateData.business_registration_number ?? prevDetails.business_registration_number ?? '',
      vat_number: updateData.vat_number ?? prevDetails.vat_number ?? '',
      city: updateData.city ?? prevDetails.city ?? '',
      postal_code: updateData.postal_code ?? prevDetails.postal_code ?? '',
      bank_name: updateData.bank_name ?? prevDetails.bank_name ?? '',
      account_holder_name: updateData.account_holder_name ?? prevDetails.account_holder_name ?? '',
      account_number: updateData.account_number ?? prevDetails.account_number ?? '',
      branch_code: updateData.branch_code ?? prevDetails.branch_code ?? '',
      account_type: updateData.account_type ?? prevDetails.account_type ?? 'Cheque / Current',
      applicant_notes: updateData.applicant_notes ?? prevDetails.applicant_notes ?? '',
    };

    const cuisineText = Array.isArray(updateData.cuisine_type)
      ? updateData.cuisine_type.map(c => String(c).trim()).filter(Boolean).join(', ')
      : (updateData.cuisine_type ?? existing.cuisine_type);
    const lat = Number.isFinite(Number(updateData.latitude)) ? Number(updateData.latitude) : (existing.lat ?? -26.2041);
    const lng = Number.isFinite(Number(updateData.longitude)) ? Number(updateData.longitude) : (existing.lng ?? 28.0473);
    const openingHoursDisplay = updateData.opening_hours || updateData.opening_hours_display || existing.opening_hours_display || '08:00 - 21:00';

    await db.query(
      `UPDATE restaurants
       SET name = $2,
           description = $3,
           cuisine_type = $4,
           phone_number = $5,
           email = $6,
           address = $7,
           location = ST_SetSRID(ST_MakePoint($9, $8), 4326),
           delivery_radius_km = $10,
           preparation_time_minutes = $11,
           opening_hours = $12,
           logo_url = $13,
           cover_image_url = $14,
           approval_status = 'pending',
           rejection_reason = NULL,
           is_active = false,
           is_accepting_orders = false,
           application_data = $15::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        restaurantId,
        String(updateData.restaurant_name || updateData.name || existing.name).trim(),
        updateData.description !== undefined ? (String(updateData.description).trim() || null) : existing.description,
        cuisineText,
        updateData.restaurant_phone || updateData.phone_number || existing.phone_number,
        updateData.restaurant_email || updateData.email || existing.email,
        String(updateData.address || existing.address).trim(),
        lat,
        lng,
        parseInt(updateData.delivery_radius_km, 10) || existing.delivery_radius_km || 5,
        parseInt(updateData.preparation_time_minutes, 10) || existing.preparation_time_minutes || 20,
        JSON.stringify({ display: openingHoursDisplay }),
        updateData.logo_url !== undefined ? (updateData.logo_url || null) : existing.logo_url,
        updateData.cover_image_url !== undefined ? (updateData.cover_image_url || null) : existing.cover_image_url,
        JSON.stringify(updatedMeta),
      ]
    );

    return this.findByIdWithOwner(restaurantId);
  }

  static async getAllForManager(filters = {}) {
    await this.ensureApplicationColumns();
    const { rows } = await db.query(
      `SELECT r.*,
              ST_Y(r.location::geometry) AS lat,
              ST_X(r.location::geometry) AS lng,
              COALESCE(rm.account_type, 'platform_admin') AS account_type,
              u.id AS owner_resolved_user_id,
              u.email AS owner_email,
              u.first_name AS owner_first_name,
              u.last_name AS owner_last_name,
              u.phone_number AS owner_phone,
              u.is_active AS owner_is_active,
              (SELECT COUNT(*)::int FROM menus m WHERE m.restaurant_id = r.id) AS menu_count,
              (SELECT COUNT(*)::int FROM menu_items mi WHERE mi.restaurant_id = r.id) AS item_count,
              (SELECT COUNT(*)::int FROM orders o WHERE o.restaurant_id = r.id) AS orders_count,
              COALESCE((SELECT SUM(o.total_amount) FROM orders o WHERE o.restaurant_id = r.id AND o.status = 'delivered'), 0) AS delivered_revenue
       FROM restaurants r
       JOIN restaurant_managers rm ON r.manager_id = rm.id
       JOIN users u ON COALESCE(r.owner_user_id, rm.user_id) = u.id
       ORDER BY r.created_at DESC`
    );

    let list = rows.map(r => this.normalizeRestaurantRecord(r));
    const { status, source, cuisine, search } = filters;

    if (status && status !== 'all') {
      list = list.filter(r => r.approval_status === status);
    }
    if (source && source !== 'all') {
      list = list.filter(r => (r.registration_source || 'admin') === source);
    }
    if (cuisine && cuisine !== 'all') {
      const cLower = cuisine.toLowerCase();
      list = list.filter(r => String(r.cuisine_type || '').toLowerCase().includes(cLower));
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r => {
        const ownerName = `${r.owner_first_name || ''} ${r.owner_last_name || ''}`.toLowerCase();
        return (
          (r.name || '').toLowerCase().includes(q) ||
          (r.cuisine_type || '').toLowerCase().includes(q) ||
          (r.address || '').toLowerCase().includes(q) ||
          (r.email || '').toLowerCase().includes(q) ||
          (r.phone_number || '').toLowerCase().includes(q) ||
          ownerName.includes(q) ||
          (r.owner_email || '').toLowerCase().includes(q) ||
          (r.application_details?.business_registration_number || '').toLowerCase().includes(q)
        );
      });
    }

    const orderWeight = { pending: 0, rejected: 1, approved: 2 };
    list.sort((a, b) => {
      const wa = orderWeight[a.approval_status] ?? 3;
      const wb = orderWeight[b.approval_status] ?? 3;
      if (wa !== wb) return wa - wb;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return list;
  }

  static async getManagerStats() {
    const all = await this.getAllForManager();
    return {
      total: all.length,
      pending: all.filter(r => r.approval_status === 'pending').length,
      approved: all.filter(r => r.approval_status === 'approved').length,
      rejected: all.filter(r => r.approval_status === 'rejected').length,
      active: all.filter(r => r.approval_status === 'approved' && r.is_active).length,
      accepting_orders: all.filter(r => r.approval_status === 'approved' && r.is_active && r.is_accepting_orders).length,
    };
  }

  static async approveApplication(restaurantId, reviewerUserId = null, notes = '') {
    await this.ensureApplicationColumns();
    const existing = await this.findByIdWithOwner(restaurantId);
    if (!existing) throw new Error('Restaurant application not found');

    const updatedMeta = {
      ...(existing.application_details || {}),
      approval_status: 'approved',
      rejection_reason: null,
      approval_notes: notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerUserId,
    };

    const ownerUserId = existing.owner_user_id || existing.owner_resolved_user_id;
    if (ownerUserId) {
      await db.query(
        `UPDATE users SET is_active = true, email_verified = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [ownerUserId]
      );
    }

    await db.query(
      `UPDATE restaurant_managers SET approval_status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [existing.manager_id]
    );

    await db.query(
      `UPDATE restaurants
       SET approval_status = 'approved',
           rejection_reason = NULL,
           reviewed_at = CURRENT_TIMESTAMP,
           reviewed_by = $2,
           is_active = true,
           is_accepting_orders = true,
           application_data = $3::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [restaurantId, reviewerUserId, JSON.stringify(updatedMeta)]
    );

    return this.findByIdWithOwner(restaurantId);
  }

  static async rejectApplication(restaurantId, reviewerUserId = null, reason = '') {
    await this.ensureApplicationColumns();
    const existing = await this.findByIdWithOwner(restaurantId);
    if (!existing) throw new Error('Restaurant application not found');

    const cleanReason = (reason || '').trim() || 'Restaurant application details did not meet onboarding requirements.';
    const updatedMeta = {
      ...(existing.application_details || {}),
      approval_status: 'rejected',
      rejection_reason: cleanReason,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerUserId,
    };

    const ownerUserId = existing.owner_user_id || existing.owner_resolved_user_id;
    if (ownerUserId && existing.account_type === 'restaurant_partner') {
      await db.query(
        `UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [ownerUserId]
      );
    }

    await db.query(
      `UPDATE restaurant_managers SET approval_status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [existing.manager_id]
    );

    await db.query(
      `UPDATE restaurants
       SET approval_status = 'rejected',
           rejection_reason = $2,
           reviewed_at = CURRENT_TIMESTAMP,
           reviewed_by = $3,
           is_active = false,
           is_accepting_orders = false,
           application_data = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [restaurantId, cleanReason, reviewerUserId, JSON.stringify(updatedMeta)]
    );

    return this.findByIdWithOwner(restaurantId);
  }

  // Add restaurant to manager's lists
  static async addRestaurantToManager(managerId, restaurantId) {
    const query = `
      UPDATE restaurant_managers 
      SET restaurant_ids = COALESCE(restaurant_ids, '{}'::uuid[]) || $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    
    await db.query(query, [managerId, restaurantId]);
  }

  // Get restaurant by ID
  static async findById(id) {
    const query = `
      SELECT r.*, 
             ST_Y(r.location::geometry) AS latitude,
             ST_X(r.location::geometry) AS longitude,
             u.first_name as manager_first_name,
             u.last_name as manager_last_name,
             u.email as manager_email
      FROM restaurants r
      JOIN restaurant_managers rm ON r.manager_id = rm.id
      JOIN users u ON rm.user_id = u.id
      WHERE r.id = $1
    `;
    
    const result = await db.query(query, [id]);
    return result.rows[0] ? applyAvailabilityToRestaurant(result.rows[0]) : null;
  }

  // Get restaurants by manager
  static async findByManager(managerId) {
    const query = 'SELECT * FROM restaurants WHERE manager_id = $1 ORDER BY created_at DESC';
    const result = await db.query(query, [managerId]);
    return result.rows;
  }

  // Get all restaurants accessible by a manager profile (platform_admin sees all approved/managed stores; partner sees own)
  static async findAccessibleByManager(managerProfile, { includePending = false } = {}) {
    await this.ensureApplicationColumns();
    if (!managerProfile) return [];
    if (this.isPlatformAdmin(managerProfile)) {
      const whereClause = includePending
        ? ''
        : `WHERE COALESCE(approval_status, 'approved') = 'approved'`;
      const query = `
        SELECT *, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
        FROM restaurants
        ${whereClause}
        ORDER BY created_at DESC
      `;
      const result = await db.query(query);
      return result.rows;
    }

    const query = `
      SELECT *, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM restaurants
      WHERE manager_id = $1 OR owner_user_id = $2
      ORDER BY created_at DESC
    `;
    const result = await db.query(query, [managerProfile.id, managerProfile.user_id]);
    return result.rows;
  }

  // Search restaurants by location and filters

  static async search(lat, lng, filters = {}) {
  try {
    await Menu.ensureCategoriesSchema();
    const {
      cuisine,
      category,
      query: searchText,
      minRating,
      isOpen,
      maxDistance = 90
    } = filters;

    // Standardize radius to meters (90km = 90000 meters)
    const radiusMeters = (Number(maxDistance) || 90) * 1000;
    const catExpr = Menu.sqlCategoriesExpr('mi', "ARRAY[]::text[]");

    let query = `
      SELECT 
        r.id, r.name, r.description, r.cuisine_type, r.address, 
        r.average_rating, r.total_ratings, r.is_accepting_orders,
        r.logo_url, r.cover_image_url, r.opening_hours, r.preparation_time_minutes,
        r.delivery_radius_km,
        COALESCE(
          (
            SELECT ARRAY_AGG(DISTINCT TRIM(cat))
            FROM menu_items mi
            CROSS JOIN LATERAL unnest(${catExpr}) AS cat
            WHERE mi.restaurant_id = r.id
              AND mi.is_available = true
              AND cat IS NOT NULL
              AND TRIM(cat) <> ''
          ),
          ARRAY[]::text[]
        ) as food_categories,
        ST_X(r.location::geometry) as longitude, -- Extract as float
        ST_Y(r.location::geometry) as latitude,  -- Extract as float
        ST_Distance(
          r.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      FROM restaurants r
      WHERE r.is_active = true
        AND COALESCE(r.approval_status, 'approved') = 'approved'
      AND ST_Distance(
        r.location::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      ) <= LEAST($3::numeric, COALESCE(r.delivery_radius_km * 1000, $3)::numeric)
    `;

    const values = [Number(lng), Number(lat), radiusMeters]; // Always [Longitude, Latitude] for PostGIS

    const addParam = (val) => {
      values.push(val);
      return `$${values.length}`;
    };

    if (category && String(category).trim()) {
      const catExact = String(category).trim();
      const pExact = addParam(catExact);
      const pLike = addParam(`%${catExact}%`);
      query += `
        AND (
          EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.restaurant_id = r.id
              AND mi.is_available = true
              AND EXISTS (
                SELECT 1 FROM unnest(${catExpr}) AS cat
                WHERE LOWER(TRIM(cat)) = LOWER(TRIM(${pExact})) OR cat ILIKE ${pLike}
              )
          )
          OR COALESCE(r.cuisine_type::text, '') ILIKE ${pLike}
        )
      `;
    }

    const cuisineList = Array.isArray(cuisine)
      ? cuisine.map(c => String(c).trim()).filter(Boolean)
      : typeof cuisine === 'string' && cuisine.trim()
        ? cuisine.split(',').map(c => c.trim()).filter(Boolean)
        : [];

    if (cuisineList.length > 0) {
      const cuisineClauses = cuisineList.map((c) => {
        const pLike = addParam(`%${c}%`);
        return `(
          COALESCE(r.cuisine_type::text, '') ILIKE ${pLike}
          OR EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.restaurant_id = r.id
              AND mi.is_available = true
              AND EXISTS (
                SELECT 1 FROM unnest(${catExpr}) AS cat
                WHERE cat ILIKE ${pLike}
              )
          )
        )`;
      });
      query += ` AND (${cuisineClauses.join(' OR ')})`;
    }

    if (searchText && String(searchText).trim()) {
      const pSearch = addParam(`%${String(searchText).trim()}%`);
      query += `
        AND (
          r.name ILIKE ${pSearch}
          OR COALESCE(r.description, '') ILIKE ${pSearch}
          OR COALESCE(r.cuisine_type::text, '') ILIKE ${pSearch}
          OR EXISTS (
            SELECT 1 FROM menu_items mi
            WHERE mi.restaurant_id = r.id
              AND mi.is_available = true
              AND (
                mi.name ILIKE ${pSearch}
                OR COALESCE(mi.category, '') ILIKE ${pSearch}
                OR EXISTS (
                  SELECT 1 FROM unnest(${catExpr}) AS cat
                  WHERE cat ILIKE ${pSearch}
                )
              )
          )
        )
      `;
    }

    if (minRating !== null && minRating !== undefined && Number.isFinite(Number(minRating))) {
      const pRating = addParam(Number(minRating));
      query += ` AND COALESCE(r.average_rating, 0) >= ${pRating}`;
    }

    if (isOpen === true) {
      query += ` AND r.is_accepting_orders = true`;
    }

    query += ` ORDER BY COALESCE(r.is_accepting_orders, true) DESC, distance_meters ASC`;

    const result = await db.query(query, values);
    let rows = result.rows.map((row) => {
      const enriched = applyAvailabilityToRestaurant(row);
      const distKm = Number.isFinite(Number(enriched.distance_meters))
        ? +(Number(enriched.distance_meters) / 1000).toFixed(2)
        : null;
      return {
        ...enriched,
        distance_km: distKm,
        estimated_delivery_fee: distKm !== null
          ? calculateRadialDeliveryFee(distKm, enriched.delivery_radius_km)
          : null,
      };
    });

    if (isOpen === true) {
      rows = rows.filter((r) => r.is_open_now === true);
    }

    rows.sort((a, b) => {
      const openDiff = (b.is_open_now ? 1 : 0) - (a.is_open_now ? 1 : 0);
      if (openDiff !== 0) return openDiff;
      return (Number(a.distance_meters) || 0) - (Number(b.distance_meters) || 0);
    });

    return rows;

  } catch (error) {
    console.error('❌ Error in Restaurant.search:', error.message);
    throw error;
  }
}
  // Update restaurant details
  static async update(id, updateData = {}) {
    await this.ensureApplicationColumns();

    const allowedCols = [
      'name',
      'description',
      'cuisine_type',
      'phone_number',
      'email',
      'address',
      'delivery_radius_km',
      'logo_url',
      'cover_image_url',
      'opening_hours',
      'preparation_time_minutes',
      'is_active',
      'is_accepting_orders',
    ];

    const setParts = [];
    const values = [id];
    let pIdx = 2;

    for (const key of allowedCols) {
      if (updateData[key] === undefined) continue;
      let val = updateData[key];

      if (key === 'opening_hours') {
        if (val && typeof val === 'object') {
          val = JSON.stringify(val);
        } else if (typeof val === 'string') {
          const trimmed = val.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            val = JSON.stringify(typeof parsed === 'object' ? parsed : { display: trimmed });
          } catch {
            val = JSON.stringify({ display: trimmed });
          }
        }
      } else if (key === 'cuisine_type' && Array.isArray(val)) {
        val = val.map((item) => String(item).trim()).filter(Boolean).join(', ');
      } else if (key === 'delivery_radius_km') {
        const parsed = parseFloat(val);
        if (!Number.isFinite(parsed)) continue;
        val = parsed;
      } else if (key === 'preparation_time_minutes') {
        const parsed = parseInt(val, 10);
        if (!Number.isFinite(parsed)) continue;
        val = parsed;
      } else if (key === 'is_active' || key === 'is_accepting_orders') {
        val = Boolean(val === true || val === 'true' || val === 'on' || val === 1 || val === '1');
      }

      setParts.push(`${key} = $${pIdx++}`);
      values.push(val);
    }

    // Handle coordinate updates via lat/lng or [lng, lat] array using PostGIS geometry
    const rawLat = updateData.latitude ?? updateData.lat;
    const rawLng = updateData.longitude ?? updateData.lng;
    if (Array.isArray(updateData.location) && updateData.location.length >= 2) {
      const lng = parseFloat(updateData.location[0]);
      const lat = parseFloat(updateData.location[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        setParts.push(`location = ST_SetSRID(ST_MakePoint($${pIdx}, $${pIdx + 1}), 4326)`);
        values.push(lng, lat);
        pIdx += 2;
      }
    } else if (rawLat !== undefined && rawLng !== undefined && rawLat !== '' && rawLng !== '') {
      const lat = parseFloat(rawLat);
      const lng = parseFloat(rawLng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        setParts.push(`location = ST_SetSRID(ST_MakePoint($${pIdx}, $${pIdx + 1}), 4326)`);
        values.push(lng, lat);
        pIdx += 2;
      }
    }

    if (setParts.length === 0) {
      return this.findById(id);
    }

    const query = `
      UPDATE restaurants
      SET ${setParts.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
    `;

    const result = await db.query(query, values);
    return result.rows[0] ? applyAvailabilityToRestaurant(result.rows[0]) : null;
  }

  // Get restaurant statistics
  static async getStatistics(restaurantId, startDate, endDate) {
    const query = `
      SELECT 
        COUNT(*) as total_orders,
        SUM(o.total_amount) as total_revenue,
        AVG(o.restaurant_rating) as average_rating,
        COUNT(DISTINCT o.customer_id) as unique_customers,
        DATE(o.placed_at) as order_date,
        EXTRACT(HOUR FROM o.placed_at) as hour_of_day
      FROM orders o
      WHERE o.restaurant_id = $1
        AND o.placed_at BETWEEN $2 AND $3
        AND o.status = 'delivered'
      GROUP BY DATE(o.placed_at), EXTRACT(HOUR FROM o.placed_at)
      ORDER BY order_date DESC, hour_of_day
    `;
    
    const result = await db.query(query, [restaurantId, startDate, endDate]);
    return result.rows;
  }
}

module.exports = Restaurant;