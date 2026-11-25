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

async function startTestServer(overrides = {}) {
  const store = overrides.store || createMockStore();
  const syncedRows = [];
  const { app, buffer, sseHub } = createApp({
    config: {
      deviceApiKey: 'test-device-key',
      adminPassword: 'test-admin-password',
      storeIntervalSec: 60,
      googleSheetWebhook: 'https://example.invalid/webhook',
      ...(overrides.config || {}),
    },
    store,
    syncFn: async (row) => {
      syncedRows.push(row);
      return { ok: true };
    },
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    store,
    buffer,
    sseHub,
    syncedRows,
    async close() {
      buffer.stop();
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
