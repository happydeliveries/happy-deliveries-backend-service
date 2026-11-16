const db = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

class User {
  // Create new user
  static async create(userData) {
    const { email, phone_number, password, role, first_name, last_name, is_active } = userData;
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const activeFlag = is_active !== undefined ? Boolean(is_active) : role !== 'driver';
    
    const query = `
      INSERT INTO users (email, phone_number, password_hash, role, first_name, last_name, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, email, phone_number, role, first_name, last_name, is_active, created_at
    `;
    
    const result = await db.query(query, [email, phone_number, password_hash, role, first_name, last_name, activeFlag]);
    return result.rows[0];
  }

  // Find user by email
  static async findByEmail(email) {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await db.query(query, [email]);
    return result.rows[0];
  }

  // Find user by ID
  static async findById(id) {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await db.query(query, [id]);
    return result.rows[0];
  }

  // Update user (never return password_hash)
  static async update(id, updateData) {
    const allowedFields = ['first_name', 'last_name', 'phone_number', 'profile_image_url'];
    const entries = Object.entries(updateData || {}).filter(
      ([field, val]) => allowedFields.includes(field) && val !== undefined
    );

    if (entries.length === 0) {
      const existing = await db.query(
        `SELECT id, email, phone_number, role, first_name, last_name, profile_image_url, is_active, created_at, updated_at
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
      RETURNING id, email, phone_number, role, first_name, last_name, profile_image_url, is_active, created_at, updated_at
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
        role: user.role 
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
    const query = 'SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)';
    const result = await db.query(query, [email]);
    return result.rows[0].exists;
  }
}

module.exports = User;