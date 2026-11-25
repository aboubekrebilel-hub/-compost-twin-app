#!/usr/bin/env node
require('dotenv').config();
const config = require('../src/config');
const { createReadingsStore } = require('../src/services/readingsStore');
const { roundTwo } = require('../src/utils/validators');

/**
 * Generates realistic 7-day compost cycle demo data (sensor averages + manual pH entries).
 * Run with: npm run seed
 */
async function runSeed() {
  const store = createReadingsStore({
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
  });

  if (!store.isConfigured()) {
    console.error('Error: SUPABASE_URL and SUPABASE_KEY must be set in .env before seeding.');
    process.exit(1);
  }

  const now = Date.now();
  const rows = [];
  const totalHours = 7 * 24; // 7 days at 1-hour resolution (168 sensor rows)
  const deviceId = 'station-01';

  for (let i = totalHours; i >= 0; i--) {
    const ts = new Date(now - i * 3600 * 1000);
    const progress = (totalHours - i) / totalHours; // 0 -> 1

    // Simulated thermophilic compost temperature curve (rises to ~58°C, stabilizes ~49°C)
    const diurnal = Math.sin((i / 24) * Math.PI * 2) * 1.6;
    const baseTemp = 36 + 22 * Math.sin(progress * Math.PI * 0.85) + diurnal;
    const moisture = 57 - progress * 6 + Math.cos(i / 12) * 1.8;
    const oxygen = 14.5 + Math.sin(i / 6) * 1.4;

    rows.push({
      device_id: deviceId,
      temperature: roundTwo(baseTemp),
      soil_moisture: roundTwo(moisture),
      oxygen: roundTwo(oxygen),
      ph: null,
      note: null,
      source: 'sensor',
      created_at: ts.toISOString(),
    });
  }

  // Add recent 15-minute points for crisp 1h / 24h charts
  for (let m = 55; m >= 5; m -= 5) {
    const ts = new Date(now - m * 60 * 1000);
    rows.push({
      device_id: deviceId,
      temperature: roundTwo(52.4 + Math.sin(m / 10) * 0.7),
      soil_moisture: roundTwo(53.2 + Math.cos(m / 12) * 0.6),
      oxygen: roundTwo(15.1 + Math.sin(m / 8) * 0.4),
      ph: null,
      note: null,
      source: 'sensor',
      created_at: ts.toISOString(),
    });
  }

  // Add manual pH log entries across the week
  const manualNotes = [
    { hoursAgo: 144, ph: 6.2, note: 'Initial green/brown mix check' },
    { hoursAgo: 96, ph: 6.6, note: 'Thermophilic peak — good aeration' },
    { hoursAgo: 48, ph: 7.05, note: 'After pile turning' },
    { hoursAgo: 12, ph: 7.15, note: 'Stabilization phase check' },
  ];

  for (const entry of manualNotes) {
    rows.push({
      device_id: deviceId,
      temperature: null,
      soil_moisture: null,
      oxygen: null,
      ph: entry.ph,
      note: entry.note,
      source: 'manual',
      created_at: new Date(now - entry.hoursAgo * 3600 * 1000).toISOString(),
    });
  }

  console.log(`[Seed] Inserting ${rows.length} demo readings into Supabase...`);
  const inserted = await store.insertMany(rows);
  console.log(`[Seed] Successfully inserted ${inserted.length} rows.`);
}

runSeed().catch((err) => {
  console.error('[Seed] Failed:', err.message);
  process.exit(1);
});
