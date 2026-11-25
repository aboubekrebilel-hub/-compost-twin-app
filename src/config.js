require('dotenv').config();

/**
 * Parse a positive integer from environment variables with a safe fallback.
 */
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  port: parsePositiveInt(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
  supabaseKey: (process.env.SUPABASE_KEY || '').trim(),
  deviceApiKey: (process.env.DEVICE_API_KEY || '').trim(),
  adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),
  storeIntervalSec: parsePositiveInt(process.env.STORE_INTERVAL_SEC, 60),
  maxRunSec: parsePositiveInt(process.env.MAX_RUN_SEC, 60),
  googleSheetWebhook: (process.env.GOOGLE_SHEET_WEBHOOK || '').trim(),
  corsOrigin: (process.env.CORS_ORIGIN || '*').trim(),
};

module.exports = config;
