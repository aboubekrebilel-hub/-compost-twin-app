const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const {
  validateSensorReading,
  validateManualPh,
  parseDateRange,
  parsePagination,
} = require('../utils/validators');

/**
 * Wrap async route handlers so rejected promises reach Express errorHandler.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createReadingsRouter({
  store,
  buffer,
  sseHub,
  motorControl,
  requireDeviceApiKey,
  requireAdminPassword,
  deviceLimiter,
  adminLimiter,
  googleSheetWebhook,
  syncFn,
}) {
  const router = express.Router();

  // Public: latest reading per device (memory + DB fallback) + latest manual pH
  router.get(
    '/latest',
    asyncHandler(async (req, res) => {
      const snapshot = await buffer.getLatestSnapshot();
      res.json(snapshot);
    })
  );

  // Public: real-time SSE stream
  router.get(
    '/stream',
    asyncHandler(async (req, res) => {
      const snapshot = await buffer.getLatestSnapshot();
      if (motorControl) {
        snapshot.control_states = motorControl.getAllSerializedStates();
      }
      sseHub.addClient(req, res, snapshot);
    })
  );

  // Public: paginated stored history with optional date-range & device filters
  router.get(
    '/readings',
    asyncHandler(async (req, res) => {
      const dateRange = parseDateRange(req.query);
      if (!dateRange.valid) {
        throw new AppError(400, 'Invalid date filter.', dateRange.errors);
      }

      const pagination = parsePagination(req.query);
      if (!pagination.valid) {
        throw new AppError(400, 'Invalid pagination parameters.', pagination.errors);
      }

      const deviceId =
        typeof req.query.device_id === 'string' && req.query.device_id.trim()
          ? req.query.device_id.trim()
          : null;

      const result = await store.queryReadings({
        from: dateRange.from,
        to: dateRange.to,
        deviceId,
        page: pagination.page,
        limit: pagination.limit,
      });

      res.json(result);
    })
  );

  // ESP32 ingestion: validate, keep latest in memory, broadcast SSE, accumulate for 60s DB flush
  router.post(
    '/readings',
    deviceLimiter,
    requireDeviceApiKey,
    asyncHandler(async (req, res) => {
      const validation = validateSensorReading(req.body);
      if (!validation.valid) {
        throw new AppError(400, 'Validation failed for sensor reading.', validation.errors);
      }

      const reading = buffer.recordSensorReading(validation.data);

      sseHub.broadcast('reading', {
        reading,
        server_time: new Date().toISOString(),
      });

      if (motorControl) {
        try {
          motorControl.evaluateReading(reading);
        } catch (err) {
          console.warn('[Readings] Auto-mixing evaluation failed:', err.message);
        }
      }

      res.status(201).json({
        ok: true,
        buffered: true,
        store_interval_sec: buffer.storeIntervalSec,
        data: reading,
      });
    })
  );

  // Admin: verify password for UI login
  router.post('/admin/verify', adminLimiter, requireAdminPassword, (req, res) => {
    res.json({ ok: true });
  });

  // Admin: manual pH entry (stored directly in DB + broadcasted via SSE)
  router.post(
    '/ph',
    adminLimiter,
    requireAdminPassword,
    asyncHandler(async (req, res) => {
      const validation = validateManualPh(req.body);
      if (!validation.valid) {
        throw new AppError(400, 'Validation failed for manual pH entry.', validation.errors);
      }

      const inserted = await store.insertReading(validation.data);
      buffer.recordManualPh(inserted);

      sseHub.broadcast('ph', {
        latest_ph: inserted,
        server_time: new Date().toISOString(),
      });

      if (googleSheetWebhook && typeof syncFn === 'function') {
        syncFn(inserted, googleSheetWebhook).catch(() => {});
      }

      res.status(201).json({
        ok: true,
        data: inserted,
      });
    })
  );

  // Admin: delete ALL readings (must require explicit confirmation flag)
  router.delete(
    '/readings/all',
    adminLimiter,
    requireAdminPassword,
    asyncHandler(async (req, res) => {
      const confirmed =
        req.body?.confirm === true ||
        req.body?.confirm === 'true' ||
        req.query.confirm === 'true';

      if (!confirmed) {
        throw new AppError(
          400,
          'Explicit confirmation flag required (body { "confirm": true } or ?confirm=true).'
        );
      }

      const deletedCount = await store.deleteAllReadings();
      buffer.clearCache();

      sseHub.broadcast('reset', {
        deleted: deletedCount,
        server_time: new Date().toISOString(),
      });

      res.json({ ok: true, deleted: deletedCount });
    })
  );

  // Admin: delete a single reading by numeric ID
  router.delete(
    '/readings/:id',
    adminLimiter,
    requireAdminPassword,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new AppError(400, 'Reading ID must be a positive integer.');
      }

      const deletedCount = await store.deleteReadingById(id);
      if (deletedCount === 0) {
        throw new AppError(404, `Reading with id ${id} not found.`);
      }

      res.json({ ok: true, deleted: deletedCount, id });
    })
  );

  // Admin: delete readings by date range (?from=&to=)
  router.delete(
    '/readings',
    adminLimiter,
    requireAdminPassword,
    asyncHandler(async (req, res) => {
      const dateRange = parseDateRange(req.query);
      if (!dateRange.valid) {
        throw new AppError(400, 'Invalid date filter.', dateRange.errors);
      }

      if (!dateRange.from && !dateRange.to) {
        throw new AppError(
          400,
          'Provide at least one date bound ("from" or "to"). To wipe all data, use DELETE /api/readings/all.'
        );
      }

      const deletedCount = await store.deleteReadingsByRange({
        from: dateRange.from,
        to: dateRange.to,
      });

      res.json({
        ok: true,
        deleted: deletedCount,
        from: dateRange.from,
        to: dateRange.to,
      });
    })
  );

  return router;
}

module.exports = { createReadingsRouter };
