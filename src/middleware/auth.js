const crypto = require('crypto');
const { AppError } = require('./errorHandler');

/**
 * Constant-time string comparison using SHA-256 digests so lengths never leak.
 */
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Middleware protecting ESP32 sensor ingestion via `x-api-key` header.
 */
function createDeviceAuthMiddleware(getExpectedKey) {
  return function requireDeviceApiKey(req, res, next) {
    const expected = getExpectedKey();
    if (!expected) {
      return next(new AppError(503, 'Server DEVICE_API_KEY is not configured.'));
    }

    const provided = req.get('x-api-key');
    if (!timingSafeEqualString(provided, expected)) {
      return next(new AppError(401, 'Invalid or missing x-api-key header.'));
    }

    return next();
  };
}

/**
 * Middleware protecting admin endpoints via `x-admin-password` header.
 */
function createAdminAuthMiddleware(getExpectedPassword) {
  return function requireAdminPassword(req, res, next) {
    const expected = getExpectedPassword();
    if (!expected) {
      return next(new AppError(503, 'Server ADMIN_PASSWORD is not configured.'));
    }

    const provided = req.get('x-admin-password');
    if (!timingSafeEqualString(provided, expected)) {
      return next(new AppError(401, 'Invalid or missing x-admin-password header.'));
    }

    return next();
  };
}

module.exports = {
  timingSafeEqualString,
  createDeviceAuthMiddleware,
  createAdminAuthMiddleware,
};
