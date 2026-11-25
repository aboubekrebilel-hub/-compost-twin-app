const { createApp } = require('./app');

const { app, buffer, sseHub, motorControl, config } = createApp();

// Load saved auto-mixing configs from Supabase (falls back safely if missing)
motorControl.init().catch((err) => {
  console.warn('[CompostTwin Station] MotorControl init warning:', err.message);
});

// Start periodic aggregation flush (1 averaged row per device every STORE_INTERVAL_SEC)
buffer.start();

const server = app.listen(config.port, () => {
  console.log(
    `[CompostTwin Station] Listening on port ${config.port} (flush interval: ${config.storeIntervalSec}s, max run: ${config.maxRunSec}s)`
  );
});

async function shutdown(signal) {
  console.log(`[CompostTwin Station] Received ${signal}, shutting down gracefully...`);
  buffer.stop();
  motorControl.stopAllTimers();
  try {
    await buffer.flush();
  } catch (err) {
    console.error('[CompostTwin Station] Final flush failed:', err.message);
  }
  sseHub.closeAll();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
