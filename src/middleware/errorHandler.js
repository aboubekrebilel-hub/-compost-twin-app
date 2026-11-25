/**
 * Custom operational HTTP error so routes and services can throw typed status codes.
 */
class AppError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * 404 handler for unmatched API routes.
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

/**
 * Centralized Express error handler.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }

  const statusCode = err instanceof AppError ? err.statusCode : err.statusCode || 500;
  const message =
    statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : err.message || 'Unexpected error.';

  if (statusCode >= 500) {
    console.error('[Error]', err);
  }

  const payload = { error: message };
  if (err.details) {
    payload.details = err.details;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  AppError,
  notFoundHandler,
  errorHandler,
};
