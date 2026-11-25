const { roundTwo } = require('../utils/validators');

/**
 * Keeps the latest sensor reading per device in memory for instant SSE/API delivery,
 * and accumulates incoming ~5s readings to flush ONE averaged row per device every
 * STORE_INTERVAL_SEC seconds to Supabase (and optional Google Sheets webhook).
 */
class ReadingBuffer {
  constructor({ store, storeIntervalSec = 60, googleSheetWebhook = '', syncFn }) {
    this.store = store;
    this.storeIntervalSec = storeIntervalSec;
    this.googleSheetWebhook = googleSheetWebhook;
    this.syncFn = syncFn;

    this.latestByDevice = new Map();
    this.latestPh = null;
    this.accumulator = new Map();
    this.timer = null;
    this.isFlushing = false;
  }

  /**
   * Record a validated ESP32 sensor reading in memory (no immediate DB write).
   */
  recordSensorReading(reading) {
    this.latestByDevice.set(reading.device_id, reading);

    const existing = this.accumulator.get(reading.device_id);
    if (!existing) {
      this.accumulator.set(reading.device_id, {
        device_id: reading.device_id,
        count: 1,
        sumTemp: reading.temperature,
        sumMoisture: reading.soil_moisture,
        sumOxygen: reading.oxygen,
        lastTimestamp: reading.created_at,
      });
    } else {
      existing.count += 1;
      existing.sumTemp += reading.temperature;
      existing.sumMoisture += reading.soil_moisture;
      existing.sumOxygen += reading.oxygen;
      existing.lastTimestamp = reading.created_at;
    }

    return reading;
  }

  /**
   * Update in-memory latest pH when a manual pH entry is saved.
   */
  recordManualPh(phRow) {
    this.latestPh = phRow;
  }

  /**
   * Clear in-memory caches (used after delete-all so /api/latest reflects empty DB).
   */
  clearCache() {
    this.latestByDevice.clear();
    this.latestPh = null;
    this.accumulator.clear();
  }

  /**
   * Return latest readings from memory, falling back to DB after a server restart.
   */
  async getLatestSnapshot() {
    let devices = Array.from(this.latestByDevice.values());

    if (devices.length === 0 && this.store.isConfigured()) {
      try {
        const dbDevices = await this.store.getLatestPerDevice();
        for (const row of dbDevices) {
          this.latestByDevice.set(row.device_id, row);
        }
        devices = dbDevices;
      } catch (err) {
        console.warn(`[ReadingBuffer] DB fallback for latest devices failed: ${err.message}`);
      }
    }

    if (!this.latestPh && this.store.isConfigured()) {
      try {
        this.latestPh = await this.store.getLatestPh();
      } catch (err) {
        console.warn(`[ReadingBuffer] DB fallback for latest pH failed: ${err.message}`);
      }
    }

    devices.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return {
      devices,
      latest: devices[0] || null,
      latest_ph: this.latestPh,
      store_interval_sec: this.storeIntervalSec,
      server_time: new Date().toISOString(),
    };
  }

  /**
   * Flush accumulated readings: compute 1 averaged row per device and store in DB.
   */
  async flush() {
    if (this.isFlushing || this.accumulator.size === 0) {
      return [];
    }

    if (!this.store.isConfigured()) {
      return [];
    }

    this.isFlushing = true;
    const snapshotEntries = Array.from(this.accumulator.entries());
    this.accumulator.clear();

    const averagedRows = snapshotEntries.map(([deviceId, acc]) => ({
      device_id: deviceId,
      temperature: roundTwo(acc.sumTemp / acc.count),
      soil_moisture: roundTwo(acc.sumMoisture / acc.count),
      oxygen: roundTwo(acc.sumOxygen / acc.count),
      ph: null,
      note: null,
      source: 'sensor',
      created_at: new Date().toISOString(),
    }));

    try {
      const inserted = await this.store.insertMany(averagedRows);
      if (this.googleSheetWebhook && typeof this.syncFn === 'function') {
        for (const row of inserted) {
          this.syncFn(row, this.googleSheetWebhook).catch(() => {});
        }
      }
      return inserted;
    } catch (err) {
      console.error(`[ReadingBuffer] Flush failed: ${err.message}`);
      return [];
    } finally {
      this.isFlushing = false;
    }
  }

  start() {
    if (this.timer) return;
    const intervalMs = this.storeIntervalSec * 1000;
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[ReadingBuffer] Scheduled flush error:', err);
      });
    }, intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { ReadingBuffer };
