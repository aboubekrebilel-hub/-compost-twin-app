const ONLINE_THRESHOLD_MS = 30 * 1000;

/**
 * Build safe default configuration for automatic mixing per device.
 */
function buildDefaultConfig(deviceId, maxRunSec = 60) {
  return {
    device_id: deviceId,
    auto_enabled: false,
    temp_max: 65,
    oxygen_min: 10,
    moisture_max: 65,
    moisture_min_alert: 35,
    run_sec: Math.min(60, maxRunSec),
    cooldown_min: 30,
    updated_at: null,
  };
}

/**
 * Manages in-memory relay states, safety auto-off timers, automatic mixing rules,
 * cooldown tracking, and low-moisture alerts per device.
 * All relay states default to `false` on startup (fail-safe).
 */
class MotorControlService {
  constructor({ controlStore, readingBuffer, sseHub, maxRunSec = 60 }) {
    this.controlStore = controlStore;
    this.readingBuffer = readingBuffer;
    this.sseHub = sseHub;
    this.maxRunSec = maxRunSec;

    this.states = new Map();
    this.configs = new Map();
    this.hydratedDevices = new Set();
  }

  /**
   * Load persisted configs (and recent auto-mix timestamps) from DB at startup.
   * Never throws if tables or rows do not exist yet.
   */
  async init() {
    if (!this.controlStore || !this.controlStore.isConfigured()) return;

    try {
      const rows = await this.controlStore.getAllConfigs();
      for (const row of rows) {
        if (row && row.device_id) {
          this.configs.set(row.device_id, this.normalizeConfig(row));
          await this.hydrateLastMixFromLog(row.device_id);
        }
      }
    } catch (err) {
      console.warn(`[MotorControl] Startup init fallback to defaults: ${err.message}`);
    }
  }

  normalizeConfig(row) {
    const defaults = buildDefaultConfig(row.device_id, this.maxRunSec);
    return {
      device_id: row.device_id,
      auto_enabled: Boolean(row.auto_enabled),
      temp_max: Number.isFinite(Number(row.temp_max)) ? Number(row.temp_max) : defaults.temp_max,
      oxygen_min: Number.isFinite(Number(row.oxygen_min)) ? Number(row.oxygen_min) : defaults.oxygen_min,
      moisture_max: Number.isFinite(Number(row.moisture_max)) ? Number(row.moisture_max) : defaults.moisture_max,
      moisture_min_alert: Number.isFinite(Number(row.moisture_min_alert))
        ? Number(row.moisture_min_alert)
        : defaults.moisture_min_alert,
      run_sec: Math.min(
        this.maxRunSec,
        Number.isFinite(Number(row.run_sec)) && Number(row.run_sec) > 0
          ? Number(row.run_sec)
          : defaults.run_sec
      ),
      cooldown_min: Number.isFinite(Number(row.cooldown_min)) && Number(row.cooldown_min) > 0
        ? Number(row.cooldown_min)
        : defaults.cooldown_min,
      updated_at: row.updated_at || null,
    };
  }

  getOrCreateState(deviceId) {
    let entry = this.states.get(deviceId);
    if (!entry) {
      entry = {
        device_id: deviceId,
        relay1: false,
        relay2: false,
        relay1Timer: null,
        relay2Timer: null,
        relay1ExpiresAt: null,
        relay2ExpiresAt: null,
        relay1Reason: null,
        relay2Reason: null,
        updated_at: null,
        lastMix: null,
        addWaterAlert: false,
      };
      this.states.set(deviceId, entry);
    }
    return entry;
  }

  async hydrateLastMixFromLog(deviceId) {
    if (this.hydratedDevices.has(deviceId)) return;
    this.hydratedDevices.add(deviceId);

    if (!this.controlStore || !this.controlStore.isConfigured()) return;
    const entry = this.getOrCreateState(deviceId);
    if (entry.lastMix) return;

    const lastLog = await this.controlStore.getLastAutoMixLog(deviceId);
    if (!lastLog) return;

    const logMs = new Date(lastLog.created_at).getTime();
    if (Number.isNaN(logMs)) return;

    if (lastLog.state === 'off') {
      entry.lastMix = {
        at: lastLog.created_at,
        ended_at: lastLog.created_at,
        reason: lastLog.reason,
      };
    } else {
      // If server restarted while motor was ON, approximate end time using maxRunSec
      const cfg = this.configs.get(deviceId) || buildDefaultConfig(deviceId, this.maxRunSec);
      const endedAt = new Date(logMs + Math.min(cfg.run_sec, this.maxRunSec) * 1000).toISOString();
      entry.lastMix = {
        at: lastLog.created_at,
        ended_at: endedAt,
        reason: lastLog.reason,
      };
    }
  }

  isDeviceOnline(deviceId) {
    const latest = this.readingBuffer.getLatestForDevice(deviceId);
    if (!latest || !latest.created_at) return false;
    const ageMs = Date.now() - new Date(latest.created_at).getTime();
    return ageMs >= -5000 && ageMs <= ONLINE_THRESHOLD_MS;
  }

  getRemainingSeconds(expiresAt) {
    if (!expiresAt) return 0;
    const diff = Math.ceil((expiresAt - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }

  getNextMixRemainingSeconds(deviceId) {
    const entry = this.getOrCreateState(deviceId);
    if (entry.relay1 || !entry.lastMix || !entry.lastMix.ended_at) {
      return 0;
    }
    const cfg = this.configs.get(deviceId) || buildDefaultConfig(deviceId, this.maxRunSec);
    const endedMs = new Date(entry.lastMix.ended_at).getTime();
    if (Number.isNaN(endedMs)) return 0;
    const nextAllowedMs = endedMs + cfg.cooldown_min * 60 * 1000;
    const remainingSec = Math.ceil((nextAllowedMs - Date.now()) / 1000);
    return remainingSec > 0 ? remainingSec : 0;
  }

  serializeState(deviceId) {
    const entry = this.getOrCreateState(deviceId);
    const latest = this.readingBuffer.getLatestForDevice(deviceId);
    return {
      device_id: deviceId,
      online: this.isDeviceOnline(deviceId),
      last_seen: latest ? latest.created_at : null,
      relay1: entry.relay1,
      relay2: entry.relay2,
      relay1_remaining_sec: entry.relay1 ? this.getRemainingSeconds(entry.relay1ExpiresAt) : 0,
      relay2_remaining_sec: entry.relay2 ? this.getRemainingSeconds(entry.relay2ExpiresAt) : 0,
      relay1_reason: entry.relay1 ? entry.relay1Reason : null,
      relay2_reason: entry.relay2 ? entry.relay2Reason : null,
      updated_at: entry.updated_at,
      last_mix: entry.lastMix,
      next_mix_in_sec: this.getNextMixRemainingSeconds(deviceId),
      alerts: {
        add_water: entry.addWaterAlert,
      },
      max_run_sec: this.maxRunSec,
    };
  }

  getAllSerializedStates() {
    const deviceIds = new Set([
      ...this.states.keys(),
      ...this.configs.keys(),
      ...this.readingBuffer.latestByDevice.keys(),
    ]);
    const list = [];
    for (const id of deviceIds) {
      list.push(this.serializeState(id));
    }
    return list;
  }

  /**
   * Public read-only state for a device (hydrates last_mix from DB if needed).
   */
  async getState(deviceId) {
    if (!this.configs.has(deviceId)) {
      await this.getConfig(deviceId);
    }
    await this.hydrateLastMixFromLog(deviceId);
    return this.serializeState(deviceId);
  }

  /**
   * Tiny ESP32 polling payload: strictly { relay1: bool, relay2: bool }.
   */
  getDeviceCommands(deviceId) {
    const entry = this.getOrCreateState(deviceId);
    return {
      relay1: Boolean(entry.relay1),
      relay2: Boolean(entry.relay2),
    };
  }

  async getConfig(deviceId) {
    if (this.configs.has(deviceId)) {
      return this.configs.get(deviceId);
    }

    if (this.controlStore && this.controlStore.isConfigured()) {
      const dbRow = await this.controlStore.getConfig(deviceId);
      if (dbRow) {
        const normalized = this.normalizeConfig(dbRow);
        this.configs.set(deviceId, normalized);
        return normalized;
      }
    }

    const fallback = buildDefaultConfig(deviceId, this.maxRunSec);
    this.configs.set(deviceId, fallback);
    return fallback;
  }

  async updateConfig(validConfig) {
    const toSave = {
      ...validConfig,
      run_sec: Math.min(validConfig.run_sec, this.maxRunSec),
      updated_at: new Date().toISOString(),
    };

    let saved = toSave;
    if (this.controlStore && this.controlStore.isConfigured()) {
      saved = await this.controlStore.upsertConfig(toSave);
    }

    const normalized = this.normalizeConfig(saved);
    this.configs.set(normalized.device_id, normalized);

    if (this.sseHub) {
      this.sseHub.broadcast('control_config', { config: normalized });
      this.sseHub.broadcast('control_state', this.serializeState(normalized.device_id));
    }

    return normalized;
  }

  clearChannelTimer(entry, channel) {
    const timerKey = channel === 1 ? 'relay1Timer' : 'relay2Timer';
    if (entry[timerKey]) {
      clearTimeout(entry[timerKey]);
      entry[timerKey] = null;
    }
  }

  /**
   * Turn a relay channel ON for `durationSec` (hard-capped at `maxRunSec`) or OFF immediately.
   */
  async setRelay({ deviceId, channel, state, durationSec, reason = 'manual' }) {
    await this.hydrateLastMixFromLog(deviceId);
    const entry = this.getOrCreateState(deviceId);
    const relayKey = channel === 1 ? 'relay1' : 'relay2';
    const expiresKey = channel === 1 ? 'relay1ExpiresAt' : 'relay2ExpiresAt';
    const reasonKey = channel === 1 ? 'relay1Reason' : 'relay2Reason';
    const timerKey = channel === 1 ? 'relay1Timer' : 'relay2Timer';

    const nowIso = new Date().toISOString();
    this.clearChannelTimer(entry, channel);

    if (state === 'off') {
      const wasAutoRun = channel === 1 && entry.relay1 && entry.relay1Reason && entry.relay1Reason !== 'manual';
      entry[relayKey] = false;
      entry[expiresKey] = null;
      entry[reasonKey] = null;
      entry.updated_at = nowIso;

      if (wasAutoRun && entry.lastMix && !entry.lastMix.ended_at) {
        entry.lastMix = { ...entry.lastMix, ended_at: nowIso };
      }

      if (this.controlStore) {
        this.controlStore
          .logCommand({ device_id: deviceId, channel, state: 'off', reason, created_at: nowIso })
          .catch(() => {});
      }

      const snapshot = this.serializeState(deviceId);
      if (this.sseHub) {
        this.sseHub.broadcast('control_state', snapshot);
      }
      return snapshot;
    }

    // Hard safety cap: never allow longer than MAX_RUN_SEC
    const safeDurationSec = Math.max(1, Math.min(durationSec || this.maxRunSec, this.maxRunSec));
    const expiresAt = Date.now() + safeDurationSec * 1000;

    entry[relayKey] = true;
    entry[expiresKey] = expiresAt;
    entry[reasonKey] = reason;
    entry.updated_at = nowIso;

    if (channel === 1 && reason !== 'manual') {
      entry.lastMix = {
        at: nowIso,
        ended_at: null,
        reason,
      };
    }

    if (this.controlStore) {
      this.controlStore
        .logCommand({ device_id: deviceId, channel, state: 'on', reason, created_at: nowIso })
        .catch(() => {});
    }

    entry[timerKey] = setTimeout(() => {
      entry[timerKey] = null;
      const offIso = new Date().toISOString();
      entry[relayKey] = false;
      entry[expiresKey] = null;
      entry[reasonKey] = null;
      entry.updated_at = offIso;

      if (channel === 1 && reason !== 'manual' && entry.lastMix && !entry.lastMix.ended_at) {
        entry.lastMix = { ...entry.lastMix, ended_at: offIso };
      }

      if (this.controlStore) {
        this.controlStore
          .logCommand({ device_id: deviceId, channel, state: 'off', reason, created_at: offIso })
          .catch(() => {});
      }

      if (this.sseHub) {
        this.sseHub.broadcast('control_state', this.serializeState(deviceId));
      }
    }, safeDurationSec * 1000);

    if (typeof entry[timerKey].unref === 'function') {
      entry[timerKey].unref();
    }

    const snapshot = this.serializeState(deviceId);
    if (this.sseHub) {
      this.sseHub.broadcast('control_state', snapshot);
    }
    return snapshot;
  }

  /**
   * Evaluate automatic mixing rule when a sensor reading arrives.
   * Wrapped in try/catch so it never slows down or breaks POST /api/readings.
   */
  evaluateReading(reading) {
    try {
      if (!reading || !reading.device_id) return { triggered: false };

      const deviceId = reading.device_id;
      const entry = this.getOrCreateState(deviceId);
      const cfg = this.configs.get(deviceId) || buildDefaultConfig(deviceId, this.maxRunSec);
      const prevAlert = entry.addWaterAlert;

      // Check reading freshness (<= 30s old)
      const readingMs = new Date(reading.created_at).getTime();
      const ageMs = Date.now() - readingMs;
      const isFresh = Number.isFinite(readingMs) && ageMs >= -5000 && ageMs <= ONLINE_THRESHOLD_MS;

      const hasMoisture = typeof reading.soil_moisture === 'number';
      if (hasMoisture) {
        entry.addWaterAlert = reading.soil_moisture < cfg.moisture_min_alert;
      }

      // If auto mode is disabled, only update/broadcast low-moisture alert if it changed
      if (!cfg.auto_enabled) {
        if (prevAlert !== entry.addWaterAlert && this.sseHub) {
          this.sseHub.broadcast('control_state', this.serializeState(deviceId));
        }
        return { triggered: false, reason: 'auto_disabled', add_water: entry.addWaterAlert };
      }

      // If soil moisture is critically low, NEVER run mixing motor; only raise "add water" alert
      if (hasMoisture && reading.soil_moisture < cfg.moisture_min_alert) {
        if (prevAlert !== entry.addWaterAlert && this.sseHub) {
          this.sseHub.broadcast('control_state', this.serializeState(deviceId));
        }
        return { triggered: false, reason: 'add_water_alert', add_water: true };
      }

      if (!isFresh) {
        return { triggered: false, reason: 'stale_reading' };
      }

      if (entry.relay1) {
        return { triggered: false, reason: 'already_running' };
      }

      if (this.getNextMixRemainingSeconds(deviceId) > 0) {
        if (prevAlert !== entry.addWaterAlert && this.sseHub) {
          this.sseHub.broadcast('control_state', this.serializeState(deviceId));
        }
        return { triggered: false, reason: 'cooldown' };
      }

      // Evaluate thresholds, ignoring missing (null) sensor fields
      let triggerReason = null;
      if (typeof reading.temperature === 'number' && reading.temperature > cfg.temp_max) {
        triggerReason = 'temperature';
      } else if (typeof reading.oxygen === 'number' && reading.oxygen < cfg.oxygen_min) {
        triggerReason = 'oxygen';
      } else if (hasMoisture && reading.soil_moisture > cfg.moisture_max) {
        triggerReason = 'moisture';
      }

      if (!triggerReason) {
        if (prevAlert !== entry.addWaterAlert && this.sseHub) {
          this.sseHub.broadcast('control_state', this.serializeState(deviceId));
        }
        return { triggered: false, reason: 'within_thresholds' };
      }

      // Fire automatic mixing on relay1 (capped by MAX_RUN_SEC)
      this.setRelay({
        deviceId,
        channel: 1,
        state: 'on',
        durationSec: Math.min(cfg.run_sec, this.maxRunSec),
        reason: triggerReason,
      }).catch((err) => {
        console.warn(`[MotorControl] Auto trigger error: ${err.message}`);
      });

      return { triggered: true, reason: triggerReason };
    } catch (err) {
      console.warn(`[MotorControl] evaluateReading error: ${err.message}`);
      return { triggered: false, error: err.message };
    }
  }

  stopAllTimers() {
    for (const entry of this.states.values()) {
      this.clearChannelTimer(entry, 1);
      this.clearChannelTimer(entry, 2);
      entry.relay1 = false;
      entry.relay2 = false;
      entry.relay1ExpiresAt = null;
      entry.relay2ExpiresAt = null;
    }
  }
}

module.exports = { MotorControlService, buildDefaultConfig };
