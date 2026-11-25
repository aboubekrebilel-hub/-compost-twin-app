const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const {
  parseDeviceId,
  validateControlCommand,
  validateControlConfig,
} = require('../utils/validators');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createControlRouter({
  motorControl,
  readingBuffer,
  requireDeviceApiKey,
  requireAdminPassword,
  deviceLimiter,
  adminLimiter,
}) {
  const router = express.Router();

  function resolveDeviceId(raw) {
    const fallback = readingBuffer.getPrimaryDeviceId() || 'station-01';
    const parsed = parseDeviceId(raw, fallback);
    if (!parsed.valid) {
      throw new AppError(400, 'device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
    }
    return parsed.value;
  }

  // Public: current desired relay state & remaining seconds per channel
  router.get(
    '/control/state',
    asyncHandler(async (req, res) => {
      const deviceId = resolveDeviceId(req.query.device_id);
      const state = await motorControl.getState(deviceId);
      res.json(state);
    })
  );

  // Admin: manual START / STOP for channel 1 or 2
  router.post(
    '/control',
    adminLimiter,
    requireAdminPassword,
    asyncHandler(async (req, res) => {
      const validation = validateControlCommand(req.body, motorControl.maxRunSec);
      if (!validation.valid) {
        throw new AppError(400, 'Validation failed for control command.', validation.errors);
      }

      const { device_id, channel, state, duration_sec } = validation.data;
      const updated = await motorControl.setRelay({
        deviceId: device_id,
        channel,
        state,
        durationSec: duration_sec,
        reason: 'manual',
      });

      res.json({ ok: true, state: updated });
    })
  );

  // Public: read automatic mixing config for a device
  router.get(
    '/control/config',
    asyncHandler(async (req, res) => {
      const deviceId = resolveDeviceId(req.query.device_id);
      const config = await motorControl.getConfig(deviceId);
      res.json(config);
    })
  );

  // Admin: update automatic mixing thresholds & schedule
  router.put(
    '/control/config',
    adminLimiter,
    requireAdminPassword,
    asyncHandler(async (req, res) => {
      const validation = validateControlConfig(req.body, motorControl.maxRunSec);
      if (!validation.valid) {
        throw new AppError(400, 'Validation failed for control config.', validation.errors);
      }

      const saved = await motorControl.updateConfig(validation.data);
      res.json({ ok: true, config: saved });
    })
  );

  // ESP32 polling endpoint: tiny exact JSON {"relay1":true|false,"relay2":true|false}
  router.get(
    '/device/commands',
    deviceLimiter,
    requireDeviceApiKey,
    (req, res) => {
      const deviceId = resolveDeviceId(req.query.device_id);
      const commands = motorControl.getDeviceCommands(deviceId);
      res.json(commands);
    }
  );

  return router;
}

module.exports = { createControlRouter };
