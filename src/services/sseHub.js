/**
 * Manages Server-Sent Events (SSE) clients for real-time dashboard updates.
 */
class SseHub {
  constructor(heartbeatIntervalMs = 20000) {
    this.clients = new Set();
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimer = null;
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          this.clients.delete(res);
        }
      }
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Register a new SSE HTTP response stream and send an initial snapshot event.
   */
  addClient(req, res, initialSnapshot) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    this.clients.add(res);
    this.startHeartbeat();

    this.sendEvent(res, 'snapshot', initialSnapshot);

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  sendEvent(res, eventName, payload) {
    try {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  broadcast(eventName, payload) {
    for (const res of this.clients) {
      this.sendEvent(res, eventName, payload);
    }
  }

  clientCount() {
    return this.clients.size;
  }

  closeAll() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // Ignore already-closed connections
      }
    }
    this.clients.clear();
  }
}

module.exports = { SseHub };
