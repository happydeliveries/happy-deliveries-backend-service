const db = require('../config/database');

let schemaChecked = false;

class Driver {
  static async ensureApplicationColumns() {
    if (schemaChecked) return;
    try {
      await db.query(`
        ALTER TABLE drivers
          ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) DEFAULT 'approved',
          ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
          ADD COLUMN IF NOT EXISTS application_data JSONB DEFAULT '{}'::jsonb,
          ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS reviewed_by UUID
      `);
      schemaChecked = true;
    } catch (err) {
      // Fallback relies on bank_account_details JSONB + users.is_active if ALTER is not permitted
      console.warn('[Driver.ensureApplicationColumns] Using JSONB fallback:', err.message);
      schemaChecked = true;
    }
  }

  static normalizeDriverRecord(row) {
    if (!row) return null;
    const rawBank = typeof row.bank_account_details === 'string'
      ? (() => { try { return JSON.parse(row.bank_account_details); } catch { return {}; } })()
      : (row.bank_account_details || {});
    const rawApp = typeof row.application_data === 'string'
      ? (() => { try { return JSON.parse(row.application_data); } catch { return {}; } })()
      : (row.application_data || {});

    const meta = { ...rawBank, ...rawApp };

    // Determine approval_status reliably
    let approvalStatus = row.approval_status || meta.approval_status;
    if (!approvalStatus) {
      approvalStatus = row.user_is_active === false ? 'pending' : 'approved';
    }
    // If explicitly marked pending/rejected in meta, honor that over default column value
    if (meta.approval_status && (meta.approval_status === 'pending' || meta.approval_status === 'rejected' || meta.approval_status === 'approved')) {
      approvalStatus = meta.approval_status;
    }

    const rejectionReason = row.rejection_reason ?? meta.rejection_reason ?? null;
    const reviewedAt = row.reviewed_at ?? meta.reviewed_at ?? null;

    return {
      ...row,
      approval_status: approvalStatus,
      rejection_reason: rejectionReason,
      reviewed_at: reviewedAt,
      application_details: {
        id_number: meta.id_number || '',
        date_of_birth: meta.date_of_birth || '',
        street_address: meta.street_address || '',
        city: meta.city || '',
        postal_code: meta.postal_code || '',
        emergency_contact_name: meta.emergency_contact_name || '',
        emergency_contact_phone: meta.emergency_contact_phone || '',
        emergency_contact_relationship: meta.emergency_contact_relationship || '',
        license_code: meta.license_code || 'Code B',
        prdp_number: meta.prdp_number || '',
        vehicle_make: meta.vehicle_make || '',
        vehicle_year: meta.vehicle_year || '',
        has_insulated_bag: meta.has_insulated_bag ?? true,
        bank_name: meta.bank_name || '',
        account_holder_name: meta.account_holder_name || '',
        account_number: meta.account_number || '',
        branch_code: meta.branch_code || '',
        account_type: meta.account_type || 'Savings',
        years_experience: meta.years_experience || '0-1',
        preferred_working_areas: meta.preferred_working_areas || '',
        applicant_notes: meta.applicant_notes || '',
        submitted_at: meta.submitted_at || row.created_at,
        approval_notes: meta.approval_notes || null,
      },
    };
  }

  // Create driver profile (new driver registrations start as pending approval)
  static async create(userId, driverData = {}) {
    await this.ensureApplicationColumns();

    const driver_license_number = (
      driverData.driver_license_number ||
      driverData.driverLicense ||
      `LIC-${Date.now().toString().slice(-6)}`
    ).trim();

    const license_expiry_date =
      driverData.license_expiry_date ||
      driverData.licenseExpiryDate ||
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const vehicle_type = (driverData.vehicle_type || driverData.vehicleType || 'Motorcycle').trim();
    const vehicle_registration = (
      driverData.vehicle_registration ||
      driverData.vehicle_Registration ||
      driverData.vehicleRegistration ||
      'PENDING'
    ).trim().toUpperCase();
    const vehicle_color = (driverData.vehicle_color || driverData.vehicleColor || '').trim();
    const vehicle_model = (
      driverData.vehicle_model ||
      driverData.vehicleModel ||
      [driverData.vehicle_make, driverData.vehicle_model_name].filter(Boolean).join(' ') ||
      ''
    ).trim();
    const service_radius_km = parseInt(driverData.service_radius_km, 10) || 10;

    const approvalStatus = driverData.approval_status || 'pending';

    const applicationMetadata = {
      approval_status: approvalStatus,
      rejection_reason: null,
      submitted_at: new Date().toISOString(),
      id_number: driverData.id_number || driverData.idNumber || '',
      date_of_birth: driverData.date_of_birth || driverData.dateOfBirth || '',
      street_address: driverData.street_address || driverData.streetAddress || '',
      city: driverData.city || '',
      postal_code: driverData.postal_code || driverData.postalCode || '',
      emergency_contact_name: driverData.emergency_contact_name || driverData.emergencyContactName || '',
      emergency_contact_phone: driverData.emergency_contact_phone || driverData.emergencyContactPhone || '',
      emergency_contact_relationship: driverData.emergency_contact_relationship || driverData.emergencyContactRelationship || '',
      license_code: driverData.license_code || driverData.licenseCode || 'Code B',
      prdp_number: driverData.prdp_number || driverData.prdpNumber || '',
      vehicle_make: driverData.vehicle_make || driverData.vehicleMake || '',
      vehicle_year: driverData.vehicle_year || driverData.vehicleYear || '',
      has_insulated_bag: driverData.has_insulated_bag !== undefined ? Boolean(driverData.has_insulated_bag) : true,
      bank_name: driverData.bank_name || driverData.bankName || '',
      account_holder_name: driverData.account_holder_name || driverData.accountHolderName || '',
      account_number: driverData.account_number || driverData.accountNumber || '',
      branch_code: driverData.branch_code || driverData.branchCode || '',
      account_type: driverData.account_type || driverData.accountType || 'Savings',
      years_experience: driverData.years_experience || driverData.yearsExperience || '1-3 years',
      preferred_working_areas: driverData.preferred_working_areas || driverData.preferredWorkingAreas || '',
      applicant_notes: driverData.applicant_notes || driverData.applicantNotes || '',
    };

    // Ensure user account starts inactive until approved by manager
    if (approvalStatus !== 'approved') {
      await db.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
    }

    try {
      const query = `
        INSERT INTO drivers (
          user_id, 
          driver_license_number, 
          license_expiry_date, 
          vehicle_type, 
          vehicle_registration,
          vehicle_color,
          vehicle_model,
          current_status,
          is_available,
          service_radius_km,
          bank_account_details,
          approval_status,
          application_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'offline', false, $8, $9, $10, $11)
        RETURNING *
      `;
      const result = await db.query(query, [
        userId,
        driver_license_number,
        license_expiry_date,
        vehicle_type,
        vehicle_registration,
        vehicle_color,
        vehicle_model,
        service_radius_km,
        JSON.stringify(applicationMetadata),
        approvalStatus,
        JSON.stringify(applicationMetadata),
      ]);
      return this.normalizeDriverRecord(result.rows[0]);
    } catch (err) {
      // Fallback if custom columns don't exist
      const fallbackQuery = `
        INSERT INTO drivers (
          user_id, 
          driver_license_number, 
          license_expiry_date, 
          vehicle_type, 
          vehicle_registration,
          vehicle_color,
          vehicle_model,
          current_status,
          is_available,
          service_radius_km,
          bank_account_details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'offline', false, $8, $9)
        RETURNING *
      `;
      const result = await db.query(fallbackQuery, [
        userId,
        driver_license_number,
        license_expiry_date,
        vehicle_type,
        vehicle_registration,
        vehicle_color,
        vehicle_model,
        service_radius_km,
        JSON.stringify(applicationMetadata),
      ]);
      return this.normalizeDriverRecord(result.rows[0]);
    }
  }

  // Get driver by user ID
  static async findByUserId(userId) {
    await this.ensureApplicationColumns();
    const query = `
      SELECT d.*, u.email, u.phone_number, u.first_name, u.last_name, u.is_active AS user_is_active, u.created_at AS user_created_at
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE d.user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    return this.normalizeDriverRecord(result.rows[0]);
  }

  // Get driver by driver ID with user details
  static async findByIdWithUser(driverId) {
    await this.ensureApplicationColumns();
    const query = `
      SELECT d.*, u.email, u.phone_number, u.first_name, u.last_name, u.is_active AS user_is_active, u.created_at AS user_created_at
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE d.id = $1
    `;
    const result = await db.query(query, [driverId]);
    return this.normalizeDriverRecord(result.rows[0]);
  }

  // Get driver by email with user details
  static async findByEmailWithUser(email) {
    await this.ensureApplicationColumns();
    const query = `
      SELECT d.*, u.email, u.phone_number, u.first_name, u.last_name, u.is_active AS user_is_active, u.created_at AS user_created_at
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE LOWER(u.email) = LOWER($1)
    `;
    const result = await db.query(query, [email]);
    return this.normalizeDriverRecord(result.rows[0]);
  }

  // Get all drivers & applications for manager portal
  static async getAllForManager(filters = {}) {
    await this.ensureApplicationColumns();
    const query = `
      SELECT d.*, u.email, u.phone_number, u.first_name, u.last_name, u.is_active AS user_is_active, u.created_at AS user_created_at
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      ORDER BY d.created_at DESC
    `;
    const result = await db.query(query);
    let list = result.rows.map((r) => this.normalizeDriverRecord(r));

    const { status, vehicle_type, search } = filters;
    if (status && status !== 'all') {
      list = list.filter((d) => d.approval_status === status);
    }
    if (vehicle_type && vehicle_type !== 'all') {
      list = list.filter((d) => (d.vehicle_type || '').toLowerCase() === vehicle_type.toLowerCase());
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((d) => {
        const fullName = `${d.first_name || ''} ${d.last_name || ''}`.toLowerCase();
        return (
          fullName.includes(q) ||
          (d.email || '').toLowerCase().includes(q) ||
          (d.phone_number || '').toLowerCase().includes(q) ||
          (d.driver_license_number || '').toLowerCase().includes(q) ||
          (d.vehicle_registration || '').toLowerCase().includes(q) ||
          (d.vehicle_model || '').toLowerCase().includes(q) ||
          (d.application_details?.id_number || '').toLowerCase().includes(q)
        );
      });
    }

    // Sort pending first, then newest
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
      pending: all.filter((d) => d.approval_status === 'pending').length,
      approved: all.filter((d) => d.approval_status === 'approved').length,
      rejected: all.filter((d) => d.approval_status === 'rejected').length,
      online: all.filter((d) => d.approval_status === 'approved' && d.current_status === 'available').length,
    };
  }

  // Approve driver application
  static async approveApplication(driverId, reviewerUserId = null, notes = '') {
    await this.ensureApplicationColumns();
    const existing = await this.findByIdWithUser(driverId);
    if (!existing) throw new Error('Driver application not found');

    const updatedMeta = {
      ...(existing.application_details || {}),
      approval_status: 'approved',
      rejection_reason: null,
      approval_notes: notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerUserId,
    };

    // Activate user login
    await db.query(
      `UPDATE users SET is_active = true, email_verified = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [existing.user_id]
    );

    try {
      await db.query(
        `UPDATE drivers
         SET approval_status = 'approved',
             rejection_reason = NULL,
             reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = $2,
             is_available = true,
             bank_account_details = $3,
             application_data = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [driverId, reviewerUserId, JSON.stringify(updatedMeta)]
      );
    } catch {
      await db.query(
        `UPDATE drivers
         SET is_available = true,
             bank_account_details = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [driverId, JSON.stringify(updatedMeta)]
      );
    }

    return this.findByIdWithUser(driverId);
  }

  // Reject driver application with reason
  static async rejectApplication(driverId, reviewerUserId = null, reason = '') {
    await this.ensureApplicationColumns();
    const existing = await this.findByIdWithUser(driverId);
    if (!existing) throw new Error('Driver application not found');

    const cleanReason = (reason || '').trim() || 'Application details did not meet verification requirements.';

    const updatedMeta = {
      ...(existing.application_details || {}),
      approval_status: 'rejected',
      rejection_reason: cleanReason,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerUserId,
    };

    // Keep user login inactive
    await db.query(
      `UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [existing.user_id]
    );

    try {
      await db.query(
        `UPDATE drivers
         SET approval_status = 'rejected',
             rejection_reason = $2,
             reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = $3,
             is_available = false,
             current_status = 'offline',
             bank_account_details = $4,
             application_data = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [driverId, cleanReason, reviewerUserId, JSON.stringify(updatedMeta)]
      );
    } catch {
      await db.query(
        `UPDATE drivers
         SET is_available = false,
             current_status = 'offline',
             bank_account_details = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [driverId, JSON.stringify(updatedMeta)]
      );
    }

    return this.findByIdWithUser(driverId);
  }

  // Resubmit / update driver application
  static async updateApplication(driverId, updateData = {}) {
    await this.ensureApplicationColumns();
    const existing = await this.findByIdWithUser(driverId);
    if (!existing) throw new Error('Driver application not found');

    const prevDetails = existing.application_details || {};
    const updatedMeta = {
      ...prevDetails,
      approval_status: 'pending',
      rejection_reason: null,
      submitted_at: new Date().toISOString(),
      id_number: updateData.id_number ?? prevDetails.id_number ?? '',
      date_of_birth: updateData.date_of_birth ?? prevDetails.date_of_birth ?? '',
      street_address: updateData.street_address ?? prevDetails.street_address ?? '',
      city: updateData.city ?? prevDetails.city ?? '',
      postal_code: updateData.postal_code ?? prevDetails.postal_code ?? '',
      emergency_contact_name: updateData.emergency_contact_name ?? prevDetails.emergency_contact_name ?? '',
      emergency_contact_phone: updateData.emergency_contact_phone ?? prevDetails.emergency_contact_phone ?? '',
      emergency_contact_relationship: updateData.emergency_contact_relationship ?? prevDetails.emergency_contact_relationship ?? '',
      license_code: updateData.license_code ?? prevDetails.license_code ?? 'Code B',
      prdp_number: updateData.prdp_number ?? prevDetails.prdp_number ?? '',
      vehicle_make: updateData.vehicle_make ?? prevDetails.vehicle_make ?? '',
      vehicle_year: updateData.vehicle_year ?? prevDetails.vehicle_year ?? '',
      has_insulated_bag: updateData.has_insulated_bag !== undefined ? Boolean(updateData.has_insulated_bag) : prevDetails.has_insulated_bag,
      bank_name: updateData.bank_name ?? prevDetails.bank_name ?? '',
      account_holder_name: updateData.account_holder_name ?? prevDetails.account_holder_name ?? '',
      account_number: updateData.account_number ?? prevDetails.account_number ?? '',
      branch_code: updateData.branch_code ?? prevDetails.branch_code ?? '',
      account_type: updateData.account_type ?? prevDetails.account_type ?? 'Savings',
      years_experience: updateData.years_experience ?? prevDetails.years_experience ?? '1-3 years',
      preferred_working_areas: updateData.preferred_working_areas ?? prevDetails.preferred_working_areas ?? '',
      applicant_notes: updateData.applicant_notes ?? prevDetails.applicant_notes ?? '',
    };

    const licenseNum = (updateData.driver_license_number || existing.driver_license_number).trim();
    const licenseExp = updateData.license_expiry_date || existing.license_expiry_date;
    const vehType = (updateData.vehicle_type || existing.vehicle_type).trim();
    const vehReg = (updateData.vehicle_registration || updateData.vehicle_Registration || updateData.vehicleRegistration || existing.vehicle_registration).trim().toUpperCase();
    const vehColor = (updateData.vehicle_color || existing.vehicle_color).trim();
    const vehModel = (updateData.vehicle_model || existing.vehicle_model).trim();
    const radius = parseInt(updateData.service_radius_km, 10) || existing.service_radius_km || 10;

    if (updateData.first_name || updateData.last_name || updateData.phone_number) {
      await db.query(
        `UPDATE users
         SET first_name = COALESCE($2, first_name),
             last_name = COALESCE($3, last_name),
             phone_number = COALESCE($4, phone_number),
             is_active = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          existing.user_id,
          updateData.first_name || null,
          updateData.last_name || null,
          updateData.phone_number || null,
        ]
      );
    }

    try {
      await db.query(
        `UPDATE drivers
         SET driver_license_number = $2,
             license_expiry_date = $3,
             vehicle_type = $4,
             vehicle_registration = $5,
             vehicle_color = $6,
             vehicle_model = $7,
             service_radius_km = $8,
             approval_status = 'pending',
             rejection_reason = NULL,
             bank_account_details = $9,
             application_data = $9,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          driverId,
          licenseNum,
          licenseExp,
          vehType,
          vehReg,
          vehColor,
          vehModel,
          radius,
          JSON.stringify(updatedMeta),
        ]
      );
    } catch {
      await db.query(
        `UPDATE drivers
         SET driver_license_number = $2,
             license_expiry_date = $3,
             vehicle_type = $4,
             vehicle_registration = $5,
             vehicle_color = $6,
             vehicle_model = $7,
             service_radius_km = $8,
             bank_account_details = $9,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          driverId,
          licenseNum,
          licenseExp,
          vehType,
          vehReg,
          vehColor,
          vehModel,
          radius,
          JSON.stringify(updatedMeta),
        ]
      );
    }

    return this.findByIdWithUser(driverId);
  }

  // Update driver location (stored as PostgreSQL POINT(lng, lat) -> x = lng, y = lat)
  static async updateLocation(driverId, lat, lng) {
    const query = `
      UPDATE drivers 
      SET 
        current_location = POINT($3, $2),
        last_location_update = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING current_location, last_location_update
    `;
    
    const result = await db.query(query, [driverId, Number(lat), Number(lng)]);
    return result.rows[0];
  }

  // Update driver status
  static async updateStatus(driverId, status) {
    const validStatuses = ['available', 'busy', 'offline', 'on_delivery'];
    
    if (!validStatuses.includes(status)) {
      throw new Error('Invalid status');
    }
    
    const query = `
      UPDATE drivers 
      SET 
        current_status = $2,
        is_available = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    
    const isAvailable = status === 'available';
    const result = await db.query(query, [driverId, status, isAvailable]);
    return result.rows[0];
  }

  // Get available drivers near location
  static async findAvailableDrivers(lat, lng, radiusKm = 10) {
    const query = `
      SELECT 
        d.*,
        u.first_name, u.last_name, u.phone_number,
        ST_Distance(
          ST_SetSRID(ST_MakePoint(d.current_location[0], d.current_location[1]), 4326)::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) as distance_meters
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE d.is_available = true
        AND d.current_status = 'available'
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(d.current_location[0], d.current_location[1]), 4326)::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3 * 1000
        )
      ORDER BY distance_meters
      LIMIT 20
    `;
    const result = await db.query(query, [lng, lat, radiusKm]);
    return result.rows;
  }

  // Get driver earnings
  static async getEarnings(driverId, startDate, endDate) {
    const query = `
      SELECT 
        SUM(e.net_amount) as total_earnings,
        COUNT(e.id) as total_deliveries,
        DATE(e.created_at) as delivery_date
      FROM earnings e
      WHERE e.driver_id = $1
        AND e.created_at BETWEEN $2 AND $3
      GROUP BY DATE(e.created_at)
      ORDER BY delivery_date DESC
    `;
    
    const result = await db.query(query, [driverId, startDate, endDate]);
    return result.rows;
  }

  // Add this to your Driver class in Driver.js
  // Add this to your Driver class in Driver.js
  static async updateVehicleInfo(driverId, vehicleData) {
    const { 
      vehicle_type, 
      vehicle_model, 
      vehicle_color, 
      vehicle_registration,
      driver_license_number 
    } = vehicleData;

    const query = `
      UPDATE drivers 
      SET 
        vehicle_type = $2,
        vehicle_model = $3,
        vehicle_color = $4,
        vehicle_registration = $5,
        driver_license_number = $6,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await db.query(query, [
      driverId, 
      vehicle_type, 
      vehicle_model, 
      vehicle_color, 
      vehicle_registration,
      driver_license_number
    ]);
    return result.rows[0];
  }

  static async getOrderHistory(driverId) {
    const query = `
      SELECT 
        o.*, 
        r.name as restaurant_name,
        r.address as restaurant_address
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE o.driver_id = $1
      ORDER BY o.placed_at DESC
    `;
    
    const result = await db.query(query, [driverId]);
    return result.rows;
  }

  // Get available orders for driver (only paid orders that have been accepted by manager and not yet taken)
  static async getAvailableOrders(driverId) {
    const query = `
      SELECT 
        o.*,
        r.name as restaurant_name,
        r.address as restaurant_address,
        ST_X(r.location::geometry) as restaurant_longitude,
        ST_Y(r.location::geometry) as restaurant_latitude,
        c.first_name as customer_first_name,
        c.last_name as customer_last_name,
        COALESCE(c.first_name || ' ' || c.last_name, 'Customer') as customer_name,
        CASE
          WHEN d.current_location IS NOT NULL AND r.location IS NOT NULL THEN
            ST_Distance(
              ST_SetSRID(ST_MakePoint(d.current_location[0], d.current_location[1]), 4326)::geography,
              r.location::geography
            )
          ELSE 0
        END as distance_to_restaurant,
        EXTRACT(EPOCH FROM (q.expires_at - NOW())) as time_left_seconds
      FROM driver_order_queue q
      JOIN orders o ON q.order_id = o.id
      JOIN restaurants r ON o.restaurant_id = r.id
      JOIN customers cust ON o.customer_id = cust.id
      JOIN users c ON cust.user_id = c.id
      JOIN drivers d ON d.id = $1
      WHERE q.is_active = true
        AND q.expires_at > NOW()
        AND o.status IN ('ordering_at_restaurant', 'order_ready')
        AND o.payment_status = 'completed'
        AND o.driver_id IS NULL
        AND d.is_available = true
        AND (q.seen_by_driver_ids IS NULL OR NOT (q.seen_by_driver_ids @> ARRAY[$1]::uuid[]))
        AND (q.declined_by_driver_ids IS NULL OR NOT (q.declined_by_driver_ids @> ARRAY[$1]::uuid[]))
      ORDER BY q.created_at ASC
      LIMIT 10
    `;
    const result = await db.query(query, [driverId]);
    return result.rows;
  }
}

module.exports = Driver;