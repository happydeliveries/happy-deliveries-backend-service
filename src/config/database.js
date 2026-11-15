const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

// Sanitize connection string
let connectionString = (process.env.DATABASE_URL || '').trim();
if (connectionString.startsWith("psql '") && connectionString.endsWith("'")) {
  connectionString = connectionString.slice(6, -1);
} else if ((connectionString.startsWith("'") && connectionString.endsWith("'")) ||
           (connectionString.startsWith('"') && connectionString.endsWith('"'))) {
  connectionString = connectionString.slice(1, -1);
}
connectionString = connectionString.replace('&channel_binding=require', '');
 
const useSsl = Boolean(
  process.env.DATABASE_URL ||
  connectionString.includes('neon.tech') ||
  process.env.DB_SSL === 'true'
);

const pool = new Pool({
  connectionString: connectionString || undefined,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  // Essential for serverless/cloud DBs (Neon Free Tier)
  connectionTimeoutMillis: 15000, // 15 seconds to allow Neon cold-start wake-up
  idleTimeoutMillis: 20000,       // Close idle connections before Neon's 5-minute suspend severing
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  max: 10,                        // Max clients in pool.
});

pool.on('error', (err) => {
  console.warn('Idle Neon client disconnected, pool will recreate connection:', err.message);
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to Neon PostgreSQL database');
    release();
  }
});

const RETRYABLE_ERROR_CODES = new Set(['57P01', '57P03', '08006', '08003']);

const isRetryableDbError = (err) => {
  if (!err) return false;
  if (err.code && RETRYABLE_ERROR_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return (
    msg.includes('Connection terminated') ||
    msg.includes('timeout') ||
    msg.includes('ECONNRESET')
  );
};

const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (isRetryableDbError(err)) {
      console.warn('Database query failed on cold-start/dropped connection, retrying once:', err.message);
      return await pool.query(text, params);
    }
    throw err;
  }
};

module.exports = {
  query,
  pool
};