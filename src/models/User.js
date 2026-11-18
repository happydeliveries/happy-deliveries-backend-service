const crypto = require('crypto');
const db = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let verificationSchemaEnsured = false;

class User {
  static async ensureEmailVerificationSchema() {
    if (verificationSchemaEnsured) return;
    try {
      await db.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false,
          ADD COLUMN IF NOT EXISTS email_verification_code VARCHAR(12),
          ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(128),
          ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ
      `);

      // One-time backfill: mark all pre-existing DB accounts as verified without affecting future registrations
      const migrationKey = 'migration_existing_users_verified_v1';
      const { rows: [existingFlag] } = await db.query(
        `SELECT key FROM platform_settings WHERE key = $1 LIMIT 1`,
        [migrationKey]
      ).catch(() => ({ rows: [] }));

      if (!existingFlag) {
        await db.query(`
          UPDATE users
          SET email_verified = true,
              email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP)
          WHERE email_verified IS NOT true
        `);
        await db.query(
          `INSERT INTO platform_settings (key, value, updated_at)
           VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO NOTHING`,
          [migrationKey, JSON.stringify({ completed: true, at: new Date().toISOString() })]
        ).catch(() => {});
      }
      verificationSchemaEnsured = true;
    } catch (err) {
      console.warn('[User.ensureEmailVerificationSchema] Warning:', err.message);
      verificationSchemaEnsured = true;
    }
  }

  // Create new user (requires email verification before account can be active unless explicitly seeded verified)
  static async create(userData) {
    await this.ensureEmailVerificationSchema();
    const {
      email,
      phone_number,
      password,
      role,
      first_name,
      last_name,
      profile_image_url = null,
      email_verified = false,
      is_active,
    } = userData;

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const isVerifiedFlag = Boolean(email_verified);
    const activeFlag = isVerifiedFlag && is_active !== undefined ? Boolean(is_active) : (isVerifiedFlag && role !== 'driver');

    const query = `
      INSERT INTO users (
        email, phone_number, password_hash, role, first_name, last_name,
        profile_image_url, is_active, email_verified, email_verified_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, email, phone_number, role, first_name, last_name, profile_image_url, is_active, email_verified, created_at
    `;

    const result = await db.query(query, [
      String(email || '').trim().toLowerCase(),
      phone_number || null,
      password_hash,
      role,
      first_name,
      last_name,
      profile_image_url || null,
      activeFlag,
      isVerifiedFlag,
      isVerifiedFlag ? new Date() : null,
    ]);
    return result.rows[0];
  }

  static async issueEmailVerification(userId) {
    await this.ensureEmailVerificationSchema();
    const code = String(crypto.randomInt(100000, 1000000));
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(
      `UPDATE users
       SET email_verification_code = $2,
           email_verification_token = $3,
           email_verification_expires_at = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId, code, token, expiresAt]
    );

    return { code, token, expiresAt };
  }

  static async verifyEmail({ email = null, code = null, token = null }) {
    await this.ensureEmailVerificationSchema();
    const cleanToken = token ? String(token).trim() : null;
    const cleanCode = code ? String(code).trim() : null;
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;

    let user = null;
    if (cleanToken) {
      const { rows } = await db.query(
        `SELECT * FROM users WHERE email_verification_token = $1 LIMIT 1`,
        [cleanToken]
      );
      user = rows[0] || null;
      if (!user && cleanEmail) {
        const fallback = await this.findByEmail(cleanEmail);
        if (fallback?.email_verified) {
          user = fallback;
        }
      }
    } else if (cleanEmail) {
      user = await this.findByEmail(cleanEmail);
    }

    if (!user) {
      const err = new Error('Verification record not found or link has expired. Request a new verification email.');
      err.statusCode = 404;
      throw err;
    }

    if (user.email_verified) {
      return {
        user,
        alreadyVerified: true,
        pendingApproval: user.is_active === false,
      };
    }

    if (!cleanToken) {
      if (!cleanCode || String(user.email_verification_code || '') !== cleanCode) {
        const err = new Error('Invalid verification code. Please check the 6-digit code in your email.');
        err.statusCode = 400;
        throw err;
      }
    }

    if (
      user.email_verification_expires_at &&
      new Date(user.email_verification_expires_at).getTime() < Date.now()
    ) {
      const err = new Error('This verification code has expired. Please request a new verification email.');
      err.statusCode = 400;
      throw err;
    }

    // Determine whether this role can be immediately active after verifying email
    let shouldActivateUser = false;
    let pendingApproval = false;
    let approvedPartnerRestaurantIds = [];

    if (user.role === 'customer') {
      shouldActivateUser = true;
    } else if (user.role === 'driver') {
      const drvRes = await db.query(
        `SELECT approval_status FROM drivers WHERE user_id = $1 LIMIT 1`,
        [user.id]
      ).catch(() => ({ rows: [] }));
      const appStatus = drvRes.rows[0]?.approval_status || 'pending';
      shouldActivateUser = appStatus === 'approved';
      pendingApproval = !shouldActivateUser;
    } else if (user.role === 'restaurant_manager') {
      const rmRes = await db.query(
        `SELECT id, account_type, approval_status FROM restaurant_managers WHERE user_id = $1 LIMIT 1`,
        [user.id]
      ).catch(() => ({ rows: [] }));
      const rm = rmRes.rows[0];
      if (!rm || rm.account_type !== 'restaurant_partner') {
        shouldActivateUser = true;
      } else {
        const restRes = await db.query(
          `SELECT id, approval_status FROM restaurants WHERE owner_user_id = $1 OR manager_id = $2`,
          [user.id, rm.id]
        ).catch(() => ({ rows: [] }));
        const approvedRows = restRes.rows.filter((r) => r.approval_status === 'approved');
        shouldActivateUser = approvedRows.length > 0 || rm.approval_status === 'approved';
        approvedPartnerRestaurantIds = approvedRows.map((r) => r.id);
        pendingApproval = !shouldActivateUser;
      }
    } else {
      shouldActivateUser = true;
    }

    const { rows: updatedRows } = await db.query(
      `UPDATE users
       SET email_verified = true,
           email_verified_at = CURRENT_TIMESTAMP,
           email_verification_code = NULL,
           email_verification_token = NULL,
           email_verification_expires_at = NULL,
           is_active = CASE WHEN $2 THEN true ELSE is_active END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, email, phone_number, role, first_name, last_name, profile_image_url, is_active, email_verified, email_verified_at`,
      [user.id, shouldActivateUser]
    );

    if (shouldActivateUser && approvedPartnerRestaurantIds.length > 0) {
      await db.query(
        `UPDATE restaurants
         SET is_active = true,
             is_accepting_orders = true,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::uuid[]) AND approval_status = 'approved'`,
        [approvedPartnerRestaurantIds]
      ).catch(() => {});
    }

    return {
      user: updatedRows[0],
      alreadyVerified: false,
      pendingApproval,
    };
  }

  // Find user by email
  static async findByEmail(email) {
    await this.ensureEmailVerificationSchema();
    const query = 'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1';
    const result = await db.query(query, [String(email || '').trim()]);
    return result.rows[0];
  }

  // Find user by ID
  static async findById(id) {
    await this.ensureEmailVerificationSchema();
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await db.query(query, [id]);
    return result.rows[0];
  }

  // Update user (never return password_hash)
  static async update(id, updateData) {
    await this.ensureEmailVerificationSchema();
    const allowedFields = ['first_name', 'last_name', 'phone_number', 'profile_image_url'];
    const entries = Object.entries(updateData || {}).filter(
      ([field, val]) => allowedFields.includes(field) && val !== undefined
    );

    if (entries.length === 0) {
      const existing = await db.query(
        `SELECT id, email, phone_number, role, first_name, last_name, profile_image_url, is_active, email_verified, created_at, updated_at
         FROM users WHERE id = $1`,
        [id]
      );
      return existing.rows[0];
    }

    const setClause = entries.map(([field], index) => `${field} = $${index + 2}`).join(', ');
    const values = entries.map(([, val]) => val);
    const query = `
      UPDATE users
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, email, phone_number, role, first_name, last_name, profile_image_url, is_active, email_verified, created_at, updated_at
    `;

    const result = await db.query(query, [id, ...values]);
    return result.rows[0];
  }

  // Generate JWT token
  static generateToken(user) {
    return jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
  }

  // Verify password
  static async verifyPassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
  }

  // Check if email exists
  static async emailExists(email) {
    const query = 'SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(email) = LOWER($1))';
    const result = await db.query(query, [String(email || '').trim()]);
    return result.rows[0].exists;
  }
}

module.exports = User;
