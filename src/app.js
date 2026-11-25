const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const defaultConfig = require('./config');
const { createReadingsStore } = require('./services/readingsStore');
const { ReadingBuffer } = require('./services/readingBuffer');
const { SseHub } = require('./services/sseHub');
const { syncRowToGoogleSheets } = require('./services/googleSheets');
const {
  createDeviceAuthMiddleware,
  createAdminAuthMiddleware,
} = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { createReadingsRouter } = require('./routes/readings');
const { createExportRouter } = require('./routes/export');

/**
 * Build and configure the Express application.
 * Dependencies can be injected for automated testing.
 */
function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...(overrides.config || {}) };
  const store =
    overrides.store ||
    createReadingsStore({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
    });
  const syncFn = overrides.syncFn || syncRowToGoogleSheets;
  const sseHub = overrides.sseHub || new SseHub();
  const buffer =
    overrides.buffer ||
    new ReadingBuffer({
      store,
      storeIntervalSec: config.storeIntervalSec,
      googleSheetWebhook: config.googleSheetWebhook,
      syncFn,
    });

  const app = express();

  // Trust reverse proxy headers (required on Render for accurate rate-limit IPs)
  app.set('trust proxy', 1);

  // Security headers (allowing Chart.js CDN and Google Fonts in frontend)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    })
  );

  // CORS configuration
  const corsOrigins =
    config.corsOrigin === '*'
      ? '*'
      : config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: corsOrigins }));

  app.use(express.json({ limit: '100kb' }));

  // Rate limiters
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again shortly.' },
  });

  // ESP32 sends every ~5s (~12 req/min); allow generous burst
  const deviceLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Device rate limit exceeded.' },
  });

  // Strict brute-force protection on admin endpoints
  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin attempts, please wait a few minutes.' },
  });

  const requireDeviceApiKey = createDeviceAuthMiddleware(() => config.deviceApiKey);
  const requireAdminPassword = createAdminAuthMiddleware(() => config.adminPassword);

  // Health endpoint for Render & monitoring
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'CompostTwin Station',
      supabase_configured: store.isConfigured(),
      sse_clients: sseHub.clientCount(),
      store_interval_sec: config.storeIntervalSec,
      uptime_sec: Math.round(process.uptime()),
    });
  });

  // API routes
  app.use('/api', apiLimiter);
  app.use(
    '/api',
    createReadingsRouter({
      store,
      buffer,
      sseHub,
      requireDeviceApiKey,
      requireAdminPassword,
      deviceLimiter,
      adminLimiter,
      googleSheetWebhook: config.googleSheetWebhook,
      syncFn,
    })
  );
  app.use('/api', createExportRouter({ store }));

  // Static frontend assets
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Clean URL route for Data & Admin page
  app.get('/data', (req, res) => {
    res.sendFile(path.join(publicDir, 'data.html'));
  });

  // 404 for unknown API paths, fallback to index.html for unknown frontend paths
  app.use('/api', notFoundHandler);
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(errorHandler);

  return { app, buffer, sseHub, store, config };
}

module.exports = { createApp };
