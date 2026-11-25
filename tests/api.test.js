const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ExcelJS = require('exceljs');

const { createApp } = require('../src/app');

/**
 * In-memory mock repository matching the exact contract of readingsStore.js
 * so tests run offline without requiring live Supabase credentials.
 */
function createMockStore(initialRows = []) {
  let nextId = 1;
  const rows = initialRows.map((r) => ({ id: nextId++, ...r }));

  return {
    isConfigured: () => true,

    async insertReading(row) {
      const saved = { id: nextId++, ...row };
      rows.push(saved);
      return saved;
    },

    async insertMany(newRows) {
      const saved = newRows.map((r) => ({ id: nextId++, ...r }));
      rows.push(...saved);
      return saved;
    },

    async getLatestPerDevice() {
      const sorted = rows
        .filter((r) => r.source === 'sensor')
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const seen = new Map();
      for (const r of sorted) {
        if (!seen.has(r.device_id)) seen.set(r.device_id, r);
      }
      return Array.from(seen.values());
    },

    async getLatestPh() {
      const sorted = rows
        .filter((r) => r.ph !== null && r.ph !== undefined)
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return sorted[0] || null;
    },

    async queryReadings({ from, to, deviceId, page = 1, limit = 50 }) {
      const filtered = rows
        .filter((r) => {
          if (from && r.created_at < from) return false;
          if (to && r.created_at > to) return false;
          if (deviceId && r.device_id !== deviceId) return false;
          return true;
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const total = filtered.length;
      const start = (page - 1) * limit;
      return {
        data: filtered.slice(start, start + limit),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    },

    async exportReadings({ from, to, deviceId }) {
      return rows
        .filter((r) => {
          if (from && r.created_at < from) return false;
          if (to && r.created_at > to) return false;
          if (deviceId && r.device_id !== deviceId) return false;
          return true;
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    async deleteReadingById(id) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return 0;
      rows.splice(idx, 1);
      return 1;
    },

    async deleteReadingsByRange({ from, to }) {
      let deleted = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (from && r.created_at < from) continue;
        if (to && r.created_at > to) continue;
        rows.splice(i, 1);
        deleted++;
      }
      return deleted;
    },

    async deleteAllReadings() {
      const count = rows.length;
      rows.length = 0;
      return count;
    },

    _rows: rows,
  };
}

function createMockControlStore({ initialConfigs = [], initialLogs = [] } = {}) {
  let nextLogId = 1;
  const logs = initialLogs.map((l) => ({ id: nextLogId++, ...l }));
  const configs = new Map(initialConfigs.map((c) => [c.device_id, { ...c }]));

  return {
    isConfigured: () => true,

    async logCommand(entry) {
      const saved = { id: nextLogId++, ...entry };
      logs.push(saved);
      return saved;
    },

    async getAllConfigs() {
      return Array.from(configs.values());
    },

    async getConfig(deviceId) {
      return configs.get(deviceId) || null;
    },

    async upsertConfig(configRow) {
      const saved = { ...configRow, updated_at: new Date().toISOString() };
      configs.set(saved.device_id, saved);
      return saved;
    },

    async getLastAutoMixLog(deviceId) {
      const matching = logs
        .filter(
          (l) =>
            l.device_id === deviceId &&
            l.channel === 1 &&
            ['temperature', 'oxygen', 'moisture'].includes(l.reason)
        )
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return matching[0] || null;
    },

    _logs: logs,
    _configs: configs,
  };
}

async function startTestServer(overrides = {}) {
  const store = overrides.store || createMockStore();
  const controlStore = overrides.controlStore || createMockControlStore();
  const syncedRows = [];
  const { app, buffer, sseHub, motorControl } = createApp({
    config: {
      deviceApiKey: 'test-device-key',
      adminPassword: 'test-admin-password',
      storeIntervalSec: 60,
      maxRunSec: 60,
      googleSheetWebhook: 'https://example.invalid/webhook',
      ...(overrides.config || {}),
    },
    store,
    controlStore,
    syncFn: async (row) => {
      syncedRows.push(row);
      return { ok: true };
    },
  });

  await motorControl.init();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    store,
    controlStore,
    buffer,
    sseHub,
    motorControl,
    syncedRows,
    async close() {
      buffer.stop();
      motorControl.stopAllTimers();
      sseHub.closeAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('POST /api/readings enforces API key, validates input, buffers and averages on flush', async () => {
  const ctx = await startTestServer();
  try {
    // Unauthorized without header
    const unauth = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 's1', temperature: 50, soil_moisture: 55, oxygen: 15 }),
    });
    assert.equal(unauth.status, 401);

    // Invalid range rejected with 400
    const badRange = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 's1', temperature: 999, soil_moisture: 55, oxygen: 15 }),
    });
    assert.equal(badRange.status, 400);

    // Send 2 readings 5s apart — should NOT write immediately to DB
    const r1 = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01', temperature: 50, soil_moisture: 50, oxygen: 14 }),
    });
    assert.equal(r1.status, 201);

    const r2 = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01', temperature: 54, soil_moisture: 60, oxygen: 16 }),
    });
    assert.equal(r2.status, 201);

    assert.equal(ctx.store._rows.length, 0, 'Readings must stay buffered in memory until flush');

    // /api/latest immediately returns the latest in-memory reading
    const latestRes = await fetch(`${ctx.baseUrl}/api/latest`);
    assert.equal(latestRes.status, 200);
    const latestJson = await latestRes.json();
    assert.equal(latestJson.latest.temperature, 54);
    assert.equal(latestJson.latest.soil_moisture, 60);

    // Flush stores ONE averaged row per device and triggers Google Sheets sync
    const flushed = await ctx.buffer.flush();
    assert.equal(flushed.length, 1);
    assert.equal(ctx.store._rows.length, 1);
    assert.equal(ctx.store._rows[0].temperature, 52);
    assert.equal(ctx.store._rows[0].soil_moisture, 55);
    assert.equal(ctx.store._rows[0].oxygen, 15);
    assert.equal(ctx.syncedRows.length, 1);
  } finally {
    await ctx.close();
  }
});

test('GET /api/latest falls back to DB after restart', async () => {
  const preSeeded = createMockStore([
    {
      device_id: 'station-01',
      temperature: 47.5,
      soil_moisture: 51.2,
      oxygen: 14.8,
      ph: null,
      note: null,
      source: 'sensor',
      created_at: '2026-11-20T10:00:00.000Z',
    },
    {
      device_id: 'station-01',
      temperature: null,
      soil_moisture: null,
      oxygen: null,
      ph: 6.85,
      note: 'Restored pH',
      source: 'manual',
      created_at: '2026-11-20T11:00:00.000Z',
    },
  ]);

  const ctx = await startTestServer({ store: preSeeded });
  try {
    const res = await fetch(`${ctx.baseUrl}/api/latest`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.latest.temperature, 47.5);
    assert.equal(body.latest_ph.ph, 6.85);
    assert.equal(body.latest_ph.note, 'Restored pH');
  } finally {
    await ctx.close();
  }
});

test('GET /api/stream pushes live reading events via SSE', async () => {
  const ctx = await startTestServer();
  try {
    const controller = new AbortController();
    const ssePromise = fetch(`${ctx.baseUrl}/api/stream`, { signal: controller.signal });
    const res = await ssePromise;
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Read initial snapshot event
    const firstChunk = await reader.read();
    const firstText = decoder.decode(firstChunk.value);
    assert.match(firstText, /event: snapshot/);

    // Post a new sensor reading and assert SSE receives `event: reading`
    await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-sse', temperature: 58.1, soil_moisture: 54, oxygen: 15.2 }),
    });

    const secondChunk = await reader.read();
    const secondText = decoder.decode(secondChunk.value);
    assert.match(secondText, /event: reading/);
    assert.match(secondText, /station-sse/);

    controller.abort();
  } finally {
    await ctx.close();
  }
});

test('POST /api/ph, pagination, exports (CSV/XLSX), and admin delete endpoints work properly', async () => {
  const ctx = await startTestServer();
  try {
    // Reject manual pH without admin header
    const unauthPh = await fetch(`${ctx.baseUrl}/api/ph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 7.0 }),
    });
    assert.equal(unauthPh.status, 401);

    // Reject out-of-range pH
    const badPh = await fetch(`${ctx.baseUrl}/api/ph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ value: 15 }),
    });
    assert.equal(badPh.status, 400);

    // Valid manual pH
    const okPh = await fetch(`${ctx.baseUrl}/api/ph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ value: 6.9, note: 'Turned heap', timestamp: '2026-11-24T12:00:00.000Z' }),
    });
    assert.equal(okPh.status, 201);
    const createdPh = await okPh.json();
    assert.equal(createdPh.data.source, 'manual');

    // Also add one more row for pagination/export testing
    await ctx.store.insertReading({
      device_id: 'station-01',
      temperature: 55,
      soil_moisture: 52,
      oxygen: 14,
      ph: null,
      note: null,
      source: 'sensor',
      created_at: '2026-11-24T13:00:00.000Z',
    });

    // Pagination check
    const listRes = await fetch(`${ctx.baseUrl}/api/readings?page=1&limit=1`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.data.length, 1);
    assert.equal(listJson.pagination.total, 2);
    assert.equal(listJson.pagination.totalPages, 2);

    // CSV Export
    const csvRes = await fetch(`${ctx.baseUrl}/api/export.csv`);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type'), /text\/csv/);
    const csvBody = await csvRes.text();
    assert.match(csvBody, /device_id,temperature_c,soil_moisture_pct,oxygen_pct,ph,note,source,created_at/);
    assert.match(csvBody, /Turned heap/);

    // XLSX Export
    const xlsxRes = await fetch(`${ctx.baseUrl}/api/export.xlsx`);
    assert.equal(xlsxRes.status, 200);
    const arrayBuf = await xlsxRes.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(arrayBuf));
    const sheet = workbook.getWorksheet('Readings');
    assert.ok(sheet);
    assert.equal(sheet.rowCount, 3); // 1 header + 2 rows

    // Delete single row
    const delRow = await fetch(`${ctx.baseUrl}/api/readings/${createdPh.data.id}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': 'test-admin-password' },
    });
    assert.equal(delRow.status, 200);

    // Delete all without explicit confirm fails with 400
    const delAllNoConfirm = await fetch(`${ctx.baseUrl}/api/readings/all`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({}),
    });
    assert.equal(delAllNoConfirm.status, 400);

    // Delete all with explicit confirm succeeds
    const delAllOk = await fetch(`${ctx.baseUrl}/api/readings/all`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(delAllOk.status, 200);
    const delAllJson = await delAllOk.json();
    assert.equal(delAllJson.deleted, 1);
  } finally {
    await ctx.close();
  }
});

test('Manual motor control endpoints enforce auth, MAX_RUN_SEC, auto-off, and tiny device JSON', async () => {
  const ctx = await startTestServer({ config: { maxRunSec: 30 } });
  try {
    // Default state: relays off, device offline
    const initStateRes = await fetch(`${ctx.baseUrl}/api/control/state?device_id=station-01`);
    assert.equal(initStateRes.status, 200);
    const initState = await initStateRes.json();
    assert.equal(initState.relay1, false);
    assert.equal(initState.relay2, false);
    assert.equal(initState.online, false);

    // /api/device/commands requires x-api-key and returns exact tiny JSON
    const unauthCmd = await fetch(`${ctx.baseUrl}/api/device/commands?device_id=station-01`);
    assert.equal(unauthCmd.status, 401);

    const cmdRes = await fetch(`${ctx.baseUrl}/api/device/commands?device_id=station-01`, {
      headers: { 'x-api-key': 'test-device-key' },
    });
    assert.equal(cmdRes.status, 200);
    const cmdBody = await cmdRes.json();
    assert.deepEqual(cmdBody, { relay1: false, relay2: false });

    // POST /api/control requires admin password
    const unauthCtrl = await fetch(`${ctx.baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'station-01', channel: 1, state: 'on', duration_sec: 10 }),
    });
    assert.equal(unauthCtrl.status, 401);

    // Validation rejects invalid channel, invalid state, and duration > MAX_RUN_SEC
    const badChannel = await fetch(`${ctx.baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ device_id: 'station-01', channel: 3, state: 'on', duration_sec: 10 }),
    });
    assert.equal(badChannel.status, 400);

    const overMax = await fetch(`${ctx.baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ device_id: 'station-01', channel: 1, state: 'on', duration_sec: 31 }),
    });
    assert.equal(overMax.status, 400);

    // Turning relay2 ON for 1s auto-turns it off and logs in control_log
    const onRes = await fetch(`${ctx.baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ device_id: 'station-01', channel: 2, state: 'on', duration_sec: 1 }),
    });
    assert.equal(onRes.status, 200);
    const onJson = await onRes.json();
    assert.equal(onJson.state.relay2, true);
    assert.ok(onJson.state.relay2_remaining_sec >= 1);

    const cmdOn = await fetch(`${ctx.baseUrl}/api/device/commands?device_id=station-01`, {
      headers: { 'x-api-key': 'test-device-key' },
    });
    assert.deepEqual(await cmdOn.json(), { relay1: false, relay2: true });

    // Wait slightly over 1s for auto-off timer
    await new Promise((r) => setTimeout(r, 1150));

    const cmdAfter = await fetch(`${ctx.baseUrl}/api/device/commands?device_id=station-01`, {
      headers: { 'x-api-key': 'test-device-key' },
    });
    assert.deepEqual(await cmdAfter.json(), { relay1: false, relay2: false });

    assert.equal(ctx.controlStore._logs.length, 2);
    assert.equal(ctx.controlStore._logs[0].state, 'on');
    assert.equal(ctx.controlStore._logs[0].reason, 'manual');
    assert.equal(ctx.controlStore._logs[1].state, 'off');
  } finally {
    await ctx.close();
  }
});

test('Auto-mixing rules: validation, trigger, cooldown, add-water block, stale reading, and manual STOP', async () => {
  const ctx = await startTestServer({ config: { maxRunSec: 45 } });
  try {
    // Config validation rejects out-of-range values and run_sec > MAX_RUN_SEC
    const badCfg = await fetch(`${ctx.baseUrl}/api/control/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({
        device_id: 'station-01',
        auto_enabled: true,
        temp_max: 65,
        oxygen_min: 10,
        moisture_max: 65,
        moisture_min_alert: 35,
        run_sec: 50,
        cooldown_min: 30,
      }),
    });
    assert.equal(badCfg.status, 400);

    // Save valid auto-mixing config
    const saveCfg = await fetch(`${ctx.baseUrl}/api/control/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({
        device_id: 'station-01',
        auto_enabled: true,
        temp_max: 60,
        oxygen_min: 10,
        moisture_max: 65,
        moisture_min_alert: 35,
        run_sec: 45,
        cooldown_min: 30,
      }),
    });
    assert.equal(saveCfg.status, 200);

    // 1) Low moisture (<35%) blocks motor even if temperature > temp_max, and raises add_water alert
    await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01', temperature: 70, soil_moisture: 25, oxygen: 14 }),
    });
    let st = await (await fetch(`${ctx.baseUrl}/api/control/state?device_id=station-01`)).json();
    assert.equal(st.online, true);
    assert.equal(st.alerts.add_water, true);
    assert.equal(st.relay1, false);

    // 2) Stale reading (>30s old) passed directly to evaluateReading must NOT trigger
    const staleResult = ctx.motorControl.evaluateReading({
      device_id: 'station-01',
      temperature: 72,
      soil_moisture: 55,
      oxygen: 14,
      source: 'sensor',
      created_at: new Date(Date.now() - 120000).toISOString(),
    });
    assert.equal(staleResult.triggered, false);
    assert.equal(staleResult.reason, 'stale_reading');

    // 3) Fresh reading exceeding temp_max with safe moisture triggers relay1
    await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01', temperature: 66, soil_moisture: 50, oxygen: 14 }),
    });
    st = await (await fetch(`${ctx.baseUrl}/api/control/state?device_id=station-01`)).json();
    assert.equal(st.alerts.add_water, false);
    assert.equal(st.relay1, true);
    assert.equal(st.relay1_reason, 'temperature');
    assert.equal(st.last_mix.reason, 'temperature');

    // 4) Manual STOP during automatic run immediately stops relay1 & cancels auto timer
    const stopRes = await fetch(`${ctx.baseUrl}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'test-admin-password' },
      body: JSON.stringify({ device_id: 'station-01', channel: 1, state: 'off' }),
    });
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    assert.equal(stopJson.state.relay1, false);
    assert.ok(stopJson.state.last_mix.ended_at);
    assert.ok(stopJson.state.next_mix_in_sec > 0);

    // 5) Cooldown prevents immediate re-trigger on another hot reading
    await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01', temperature: 70, soil_moisture: 50, oxygen: 8 }),
    });
    st = await (await fetch(`${ctx.baseUrl}/api/control/state?device_id=station-01`)).json();
    assert.equal(st.relay1, false);
  } finally {
    await ctx.close();
  }
});

test('Partial readings: accept missing sensors, reject all-missing/invalid, average only present fields', async () => {
  const ctx = await startTestServer();
  try {
    // Reject payload when all 3 sensors are missing/null
    const emptySensors = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01' }),
    });
    assert.equal(emptySensors.status, 400);

    // Reject non-numeric partial sensor field
    const badPartial = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-01', temperature: 'hot', oxygen: 15 }),
    });
    assert.equal(badPartial.status, 400);

    // Accept reading 1: temperature + oxygen only (soil_moisture missing)
    const p1 = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-partial', temperature: 50, oxygen: 14 }),
    });
    assert.equal(p1.status, 201);
    const p1Body = await p1.json();
    assert.equal(p1Body.data.temperature, 50);
    assert.equal(p1Body.data.soil_moisture, null);
    assert.equal(p1Body.data.oxygen, 14);

    // Accept reading 2: temperature only (soil_moisture & oxygen null)
    const p2 = await fetch(`${ctx.baseUrl}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-device-key' },
      body: JSON.stringify({ device_id: 'station-partial', temperature: 60, soil_moisture: null, oxygen: null }),
    });
    assert.equal(p2.status, 201);

    // Flush must average temperature over 2 samples (55), oxygen over 1 sample (14), and store moisture as NULL
    const flushed = await ctx.buffer.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].temperature, 55);
    assert.equal(flushed[0].soil_moisture, null);
    assert.equal(flushed[0].oxygen, 14);
  } finally {
    await ctx.close();
  }
});
