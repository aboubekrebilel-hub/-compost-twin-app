(function () {
  const { t, getAdminPassword, updateOnlineBadge, formatDateTime } = window.CompostCommon;

  const state = {
    devicesById: new Map(),
    selectedDeviceId: null,
    latestPh: null,
    controlStatesByDevice: new Map(),
    controlConfigsByDevice: new Map(),
    range: '24h',
    customFrom: null,
    customTo: null,
    charts: {},
    pollTimer: null,
    sse: null,
    transport: 'sse',
  };

  function getHealthStatus(metric, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    if (metric === 'temperature') {
      if (value >= 40 && value <= 65) return { cls: '', label: t('optimal') };
      if (value >= 20 && value <= 72) return { cls: 'warn', label: t('watch') };
      return { cls: 'danger', label: t('critical') };
    }
    if (metric === 'soil_moisture') {
      if (value >= 45 && value <= 65) return { cls: '', label: t('optimal') };
      if (value >= 30 && value <= 75) return { cls: 'warn', label: t('watch') };
      return { cls: 'danger', label: t('critical') };
    }
    if (metric === 'oxygen') {
      if (value >= 10) return { cls: '', label: t('optimal') };
      if (value >= 5) return { cls: 'warn', label: t('watch') };
      return { cls: 'danger', label: t('critical') };
    }
    if (metric === 'ph') {
      if (value >= 6.0 && value <= 8.0) return { cls: '', label: t('optimal') };
      if (value >= 5.0 && value <= 8.8) return { cls: 'warn', label: t('watch') };
      return { cls: 'danger', label: t('critical') };
    }
    return null;
  }

  function renderHealthPill(elId, metric, value) {
    const el = document.getElementById(elId);
    if (!el) return;
    const status = getHealthStatus(metric, value);
    if (!status) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'inline-block';
    el.className = `health-pill ${status.cls}`.trim();
    el.textContent = status.label;
  }

  function renderDeviceSelect() {
    const select = document.getElementById('deviceSelect');
    if (!select) return;

    const ids = Array.from(state.devicesById.keys()).sort();
    if (ids.length === 0) {
      select.innerHTML = '<option value="">—</option>';
      return;
    }

    if (!state.selectedDeviceId || !state.devicesById.has(state.selectedDeviceId)) {
      state.selectedDeviceId = ids[0];
    }

    select.innerHTML = '';
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      opt.selected = id === state.selectedDeviceId;
      select.appendChild(opt);
    }
  }

  function renderKpis() {
    const reading = state.selectedDeviceId
      ? state.devicesById.get(state.selectedDeviceId)
      : null;

    const tempEl = document.getElementById('kpiTemp');
    const moistEl = document.getElementById('kpiMoisture');
    const oxyEl = document.getElementById('kpiOxygen');
    const lastUpdateEl = document.getElementById('lastUpdateValue');

    if (reading) {
      tempEl.textContent = reading.temperature != null ? Number(reading.temperature).toFixed(1) : '--';
      moistEl.textContent = reading.soil_moisture != null ? Number(reading.soil_moisture).toFixed(1) : '--';
      oxyEl.textContent = reading.oxygen != null ? Number(reading.oxygen).toFixed(1) : '--';
      lastUpdateEl.textContent = formatDateTime(reading.created_at);

      renderHealthPill('pillTemp', 'temperature', reading.temperature);
      renderHealthPill('pillMoisture', 'soil_moisture', reading.soil_moisture);
      renderHealthPill('pillOxygen', 'oxygen', reading.oxygen);
      updateOnlineBadge(reading.created_at);
    } else {
      tempEl.textContent = '--';
      moistEl.textContent = '--';
      oxyEl.textContent = '--';
      lastUpdateEl.textContent = t('never');
      renderHealthPill('pillTemp', 'temperature', null);
      renderHealthPill('pillMoisture', 'soil_moisture', null);
      renderHealthPill('pillOxygen', 'oxygen', null);
      updateOnlineBadge(null);
    }

    const phEl = document.getElementById('kpiPh');
    const phMetaEl = document.getElementById('kpiPhMeta');
    if (state.latestPh && state.latestPh.ph != null) {
      phEl.textContent = Number(state.latestPh.ph).toFixed(2);
      const timeStr = formatDateTime(state.latestPh.created_at);
      phMetaEl.textContent = state.latestPh.note
        ? `${state.latestPh.note} · ${timeStr}`
        : timeStr;
      renderHealthPill('pillPh', 'ph', state.latestPh.ph);
    } else {
      phEl.textContent = '—';
      phMetaEl.textContent = t('noPhYet');
      renderHealthPill('pillPh', 'ph', null);
    }

    const transportEl = document.getElementById('transportLabel');
    if (transportEl) {
      transportEl.textContent =
        state.transport === 'sse' ? t('transportSse') : t('transportPoll');
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot) return;
    if (Array.isArray(snapshot.devices)) {
      state.devicesById.clear();
      for (const dev of snapshot.devices) {
        if (dev && dev.device_id) {
          state.devicesById.set(dev.device_id, dev);
        }
      }
    }
    if (snapshot.latest_ph !== undefined) {
      state.latestPh = snapshot.latest_ph;
    }
    if (Array.isArray(snapshot.control_states)) {
      for (const cs of snapshot.control_states) {
        if (cs && cs.device_id) {
          cacheControlState(cs);
        }
      }
    }
    renderDeviceSelect();
    renderKpis();
    renderMotorControl();
  }

  function activeControlDeviceId() {
    return state.selectedDeviceId || 'station-01';
  }

  function cacheControlState(cs) {
    if (!cs || !cs.device_id) return;
    const now = Date.now();
    state.controlStatesByDevice.set(cs.device_id, {
      ...cs,
      _receivedAtMs: now,
      _relay1BaseRemaining: cs.relay1_remaining_sec || 0,
      _relay2BaseRemaining: cs.relay2_remaining_sec || 0,
      _nextMixBaseSec: cs.next_mix_in_sec || 0,
    });
  }

  function isCurrentDeviceOnline() {
    const devId = activeControlDeviceId();
    const reading = state.devicesById.get(devId);
    if (reading && reading.created_at) {
      return Date.now() - new Date(reading.created_at).getTime() <= 30000;
    }
    const cs = state.controlStatesByDevice.get(devId);
    return Boolean(cs && cs.online);
  }

  function formatMmSs(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function translateMixReason(reason) {
    if (reason === 'temperature') return t('reasonTemperature');
    if (reason === 'oxygen') return t('reasonOxygen');
    if (reason === 'moisture') return t('reasonMoisture');
    return t('reasonManual');
  }

  function renderMotorControl() {
    const card = document.getElementById('motorControlCard');
    if (!card) return;

    const devId = activeControlDeviceId();
    const cs = state.controlStatesByDevice.get(devId);
    const online = isCurrentDeviceOnline();

    const offlineAlert = document.getElementById('motorOfflineAlert');
    if (offlineAlert) offlineAlert.style.display = online ? 'none' : 'block';

    const waterAlert = document.getElementById('addWaterAlert');
    if (waterAlert) {
      waterAlert.style.display = cs && cs.alerts && cs.alerts.add_water ? 'block' : 'none';
    }

    const elapsedSec = cs ? Math.floor((Date.now() - cs._receivedAtMs) / 1000) : 0;

    [1, 2].forEach((ch) => {
      const startBtn = document.getElementById(`relay${ch}StartBtn`);
      const stopBtn = document.getElementById(`relay${ch}StopBtn`);
      const durSelect = document.getElementById(`relay${ch}Duration`);
      const badge = document.getElementById(`relay${ch}Badge`);
      const isOn = Boolean(cs && cs[`relay${ch}`]);
      const baseRem = cs ? cs[`_relay${ch}BaseRemaining`] : 0;
      const rem = isOn ? Math.max(0, baseRem - elapsedSec) : 0;

      if (badge) {
        badge.classList.toggle('on', isOn);
        badge.textContent = isOn
          ? `${t('relayOn')}${rem > 0 ? ` · ${rem}s` : ''}`
          : t('relayOff');
      }

      if (startBtn) startBtn.disabled = !online;
      if (stopBtn) stopBtn.disabled = !online;
      if (durSelect) {
        durSelect.disabled = !online;
        const maxRun = cs && cs.max_run_sec ? cs.max_run_sec : 60;
        Array.from(durSelect.options).forEach((opt) => {
          opt.disabled = Number(opt.value) > maxRun;
        });
      }
    });

    const lastMixEl = document.getElementById('lastMixValue');
    if (lastMixEl) {
      if (cs && cs.last_mix && cs.last_mix.at) {
        lastMixEl.textContent = `${formatDateTime(cs.last_mix.at)} · ${translateMixReason(cs.last_mix.reason)}`;
      } else {
        lastMixEl.textContent = t('noMixYet');
      }
    }

    const nextMixEl = document.getElementById('nextMixValue');
    if (nextMixEl) {
      const nextRem = cs ? Math.max(0, cs._nextMixBaseSec - elapsedSec) : 0;
      nextMixEl.textContent = nextRem > 0 ? formatMmSs(nextRem) : t('nextMixReady');
    }
  }

  function applyConfigToForm(cfg) {
    if (!cfg) return;
    const enabledEl = document.getElementById('autoEnabledInput');
    const tempEl = document.getElementById('cfgTempMax');
    const oxyEl = document.getElementById('cfgOxygenMin');
    const moistMaxEl = document.getElementById('cfgMoistureMax');
    const moistMinEl = document.getElementById('cfgMoistureMinAlert');
    const runSecEl = document.getElementById('cfgRunSec');
    const cooldownEl = document.getElementById('cfgCooldownMin');

    if (enabledEl) enabledEl.checked = Boolean(cfg.auto_enabled);
    if (tempEl) tempEl.value = cfg.temp_max;
    if (oxyEl) oxyEl.value = cfg.oxygen_min;
    if (moistMaxEl) moistMaxEl.value = cfg.moisture_max;
    if (moistMinEl) moistMinEl.value = cfg.moisture_min_alert;
    if (runSecEl) {
      const cs = state.controlStatesByDevice.get(activeControlDeviceId());
      if (cs && cs.max_run_sec) runSecEl.max = String(cs.max_run_sec);
      runSecEl.value = cfg.run_sec;
    }
    if (cooldownEl) cooldownEl.value = cfg.cooldown_min;
  }

  async function fetchControlData() {
    const devId = activeControlDeviceId();
    try {
      const [stateRes, cfgRes] = await Promise.all([
        fetch(`/api/control/state?device_id=${encodeURIComponent(devId)}`),
        fetch(`/api/control/config?device_id=${encodeURIComponent(devId)}`),
      ]);
      if (stateRes.ok) {
        cacheControlState(await stateRes.json());
        renderMotorControl();
      }
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        state.controlConfigsByDevice.set(cfg.device_id, cfg);
        applyConfigToForm(cfg);
      }
    } catch {
      // ignore transient network errors
    }
  }

  function handleIncomingReading(reading) {
    if (!reading || !reading.device_id) return;
    state.devicesById.set(reading.device_id, reading);
    renderDeviceSelect();
    renderKpis();
    renderMotorControl();
  }

  async function fetchLatestFallback() {
    try {
      const res = await fetch('/api/latest');
      if (!res.ok) return;
      const snapshot = await res.json();
      applySnapshot(snapshot);
      await fetchControlData();
    } catch {
      // Keep current display on temporary network hiccup
    }
  }

  function startPollingFallback() {
    state.transport = 'poll';
    renderKpis();
    if (state.pollTimer) return;
    fetchLatestFallback();
    state.pollTimer = setInterval(fetchLatestFallback, 5000);
  }

  function stopPollingFallback() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function connectSse() {
    if (typeof EventSource === 'undefined') {
      startPollingFallback();
      return;
    }

    if (state.sse) {
      state.sse.close();
    }

    const sse = new EventSource('/api/stream');
    state.sse = sse;

    sse.addEventListener('open', () => {
      state.transport = 'sse';
      stopPollingFallback();
      renderKpis();
    });

    sse.addEventListener('snapshot', (e) => {
      try {
        applySnapshot(JSON.parse(e.data));
      } catch {
        // ignore malformed frame
      }
    });

    sse.addEventListener('reading', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.reading) {
          handleIncomingReading(payload.reading);
        }
      } catch {
        // ignore malformed frame
      }
    });

    sse.addEventListener('ph', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.latest_ph) {
          state.latestPh = payload.latest_ph;
          renderKpis();
          loadCharts();
        }
      } catch {
        // ignore
      }
    });

    sse.addEventListener('reset', () => {
      state.devicesById.clear();
      state.latestPh = null;
      renderDeviceSelect();
      renderKpis();
      renderMotorControl();
      loadCharts();
    });

    sse.addEventListener('control_state', (e) => {
      try {
        cacheControlState(JSON.parse(e.data));
        renderMotorControl();
      } catch {
        // ignore malformed frame
      }
    });

    sse.addEventListener('control_config', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.config) {
          state.controlConfigsByDevice.set(payload.config.device_id, payload.config);
          if (payload.config.device_id === activeControlDeviceId()) {
            applyConfigToForm(payload.config);
          }
        }
      } catch {
        // ignore malformed frame
      }
    });

    sse.onerror = () => {
      // Fall back to 5s polling while EventSource attempts reconnect or fails
      startPollingFallback();
    };
  }

  function computeRangeBounds() {
    const now = new Date();
    if (state.range === 'custom' && (state.customFrom || state.customTo)) {
      return {
        from: state.customFrom ? new Date(state.customFrom).toISOString() : null,
        to: state.customTo ? new Date(state.customTo).toISOString() : null,
      };
    }

    const hoursMap = { '1h': 1, '24h': 24, '7d': 24 * 7 };
    const hours = hoursMap[state.range] || 24;
    const fromDate = new Date(now.getTime() - hours * 3600 * 1000);
    return {
      from: fromDate.toISOString(),
      to: now.toISOString(),
    };
  }

  function createOrUpdateChart(canvasId, label, labels, data, color, fillRgba) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    if (state.charts[canvasId]) {
      const chart = state.charts[canvasId];
      chart.data.labels = labels;
      chart.data.datasets[0].label = label;
      chart.data.datasets[0].data = data;
      chart.update('none');
      return;
    }

    state.charts[canvasId] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label,
            data,
            borderColor: color,
            backgroundColor: fillRgba,
            borderWidth: 2,
            pointRadius: data.length > 60 ? 0 : 3,
            pointHoverRadius: 5,
            fill: true,
            tension: 0.3,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(13, 39, 31, 0.95)',
            titleColor: '#FFFFFF',
            bodyColor: '#B7D3C6',
            borderColor: 'rgba(76, 175, 122, 0.45)',
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            ticks: { color: '#B7D3C6', maxTicksLimit: 6, maxRotation: 0 },
            grid: { color: 'rgba(183, 211, 198, 0.08)' },
          },
          y: {
            ticks: { color: '#B7D3C6' },
            grid: { color: 'rgba(183, 211, 198, 0.1)' },
          },
        },
      },
    });
  }

  function formatChartLabel(iso) {
    const d = new Date(iso);
    if (state.range === '7d') {
      return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function loadCharts() {
    const { from, to } = computeRangeBounds();
    const params = new URLSearchParams({ limit: '500', page: '1' });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (state.selectedDeviceId) params.set('device_id', state.selectedDeviceId);

    try {
      const res = await fetch(`/api/readings?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json();
      const rows = (json.data || []).slice().reverse();

      const sensorRows = rows.filter((r) => r.source === 'sensor');
      const sensorLabels = sensorRows.map((r) => formatChartLabel(r.created_at));

      createOrUpdateChart(
        'chartTemp',
        t('chartTemp'),
        sensorLabels,
        sensorRows.map((r) => (r.temperature != null ? r.temperature : null)),
        '#4CAF7A',
        'rgba(76, 175, 122, 0.18)'
      );
      createOrUpdateChart(
        'chartMoisture',
        t('chartMoisture'),
        sensorLabels,
        sensorRows.map((r) => (r.soil_moisture != null ? r.soil_moisture : null)),
        '#6EE7B7',
        'rgba(110, 231, 183, 0.16)'
      );
      createOrUpdateChart(
        'chartOxygen',
        t('chartOxygen'),
        sensorLabels,
        sensorRows.map((r) => (r.oxygen != null ? r.oxygen : null)),
        '#93C5FD',
        'rgba(147, 197, 253, 0.16)'
      );

      const phRows = rows.filter((r) => r.ph !== null && r.ph !== undefined);
      createOrUpdateChart(
        'chartPh',
        t('chartPh'),
        phRows.map((r) => formatChartLabel(r.created_at)),
        phRows.map((r) => r.ph),
        '#F2B84B',
        'rgba(242, 184, 75, 0.18)'
      );
    } catch {
      // ignore transient chart load errors
    }
  }

  function setupRangeButtons() {
    const customBox = document.getElementById('customRangeBox');
    document.querySelectorAll('.range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.range = btn.dataset.range;
        if (customBox) {
          customBox.classList.toggle('visible', state.range === 'custom');
        }
        if (state.range !== 'custom') {
          loadCharts();
        }
      });
    });

    const applyCustomBtn = document.getElementById('applyCustomRange');
    if (applyCustomBtn) {
      applyCustomBtn.addEventListener('click', () => {
        state.customFrom = document.getElementById('chartFromInput').value || null;
        state.customTo = document.getElementById('chartToInput').value || null;
        loadCharts();
      });
    }
  }

  function setupManualPhForm() {
    const form = document.getElementById('dashPhForm');
    if (!form) return;

    const feedback = document.getElementById('dashPhFeedback');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      feedback.style.display = 'none';

      const value = Number(document.getElementById('dashPhValue').value);
      const note = document.getElementById('dashPhNote').value.trim();
      const timeVal = document.getElementById('dashPhTime').value;

      const payload = {
        value,
        note: note || undefined,
        timestamp: timeVal ? new Date(timeVal).toISOString() : undefined,
        device_id: state.selectedDeviceId || 'station-01',
      };

      try {
        const res = await fetch('/api/ph', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': getAdminPassword(),
          },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          feedback.className = 'alert alert-error';
          feedback.textContent = data.error || 'Error saving pH';
          feedback.style.display = 'block';
          return;
        }
        form.reset();
        feedback.className = 'alert alert-success';
        feedback.textContent = t('phSavedMsg');
        feedback.style.display = 'block';
        state.latestPh = data.data;
        renderKpis();
        loadCharts();
      } catch (err) {
        feedback.className = 'alert alert-error';
        feedback.textContent = err.message;
        feedback.style.display = 'block';
      }
    });
  }

  function setupMotorControl() {
    const cmdFeedback = document.getElementById('motorCmdFeedback');
    const cfgFeedback = document.getElementById('autoConfigFeedback');

    async function sendRelayCommand(channel, relayState) {
      if (cmdFeedback) cmdFeedback.style.display = 'none';
      const durSelect = document.getElementById(`relay${channel}Duration`);
      const durationSec = durSelect ? Number(durSelect.value) : 60;
      const body = {
        device_id: activeControlDeviceId(),
        channel,
        state: relayState,
      };
      if (relayState === 'on') {
        body.duration_sec = durationSec;
      }

      try {
        const res = await fetch('/api/control', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': getAdminPassword(),
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          if (cmdFeedback) {
            cmdFeedback.className = 'alert alert-error';
            cmdFeedback.textContent = data.details ? data.details.join(' ') : data.error || 'Command error';
            cmdFeedback.style.display = 'block';
          }
          return;
        }
        cacheControlState(data.state);
        renderMotorControl();
        if (cmdFeedback) {
          cmdFeedback.className = 'alert alert-success';
          cmdFeedback.textContent = t('motorCmdSuccess', {
            ch: channel,
            state: relayState.toUpperCase(),
          });
          cmdFeedback.style.display = 'block';
        }
      } catch (err) {
        if (cmdFeedback) {
          cmdFeedback.className = 'alert alert-error';
          cmdFeedback.textContent = err.message;
          cmdFeedback.style.display = 'block';
        }
      }
    }

    [1, 2].forEach((ch) => {
      const startBtn = document.getElementById(`relay${ch}StartBtn`);
      const stopBtn = document.getElementById(`relay${ch}StopBtn`);
      if (startBtn) startBtn.addEventListener('click', () => sendRelayCommand(ch, 'on'));
      if (stopBtn) stopBtn.addEventListener('click', () => sendRelayCommand(ch, 'off'));
    });

    const configForm = document.getElementById('autoConfigForm');
    if (configForm) {
      configForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (cfgFeedback) cfgFeedback.style.display = 'none';

        const payload = {
          device_id: activeControlDeviceId(),
          auto_enabled: document.getElementById('autoEnabledInput').checked,
          temp_max: Number(document.getElementById('cfgTempMax').value),
          oxygen_min: Number(document.getElementById('cfgOxygenMin').value),
          moisture_max: Number(document.getElementById('cfgMoistureMax').value),
          moisture_min_alert: Number(document.getElementById('cfgMoistureMinAlert').value),
          run_sec: Number(document.getElementById('cfgRunSec').value),
          cooldown_min: Number(document.getElementById('cfgCooldownMin').value),
        };

        try {
          const res = await fetch('/api/control/config', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'x-admin-password': getAdminPassword(),
            },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            if (cfgFeedback) {
              cfgFeedback.className = 'alert alert-error';
              cfgFeedback.textContent = data.details ? data.details.join(' ') : data.error || 'Save error';
              cfgFeedback.style.display = 'block';
            }
            return;
          }
          state.controlConfigsByDevice.set(data.config.device_id, data.config);
          applyConfigToForm(data.config);
          if (cfgFeedback) {
            cfgFeedback.className = 'alert alert-success';
            cfgFeedback.textContent = t('configSavedMsg');
            cfgFeedback.style.display = 'block';
          }
        } catch (err) {
          if (cfgFeedback) {
            cfgFeedback.className = 'alert alert-error';
            cfgFeedback.textContent = err.message;
            cfgFeedback.style.display = 'block';
          }
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const deviceSelect = document.getElementById('deviceSelect');
    if (deviceSelect) {
      deviceSelect.addEventListener('change', (e) => {
        state.selectedDeviceId = e.target.value;
        renderKpis();
        renderMotorControl();
        fetchControlData();
        loadCharts();
      });
    }

    setupRangeButtons();
    setupManualPhForm();
    setupMotorControl();

    fetchLatestFallback();
    connectSse();
    loadCharts();

    // Re-evaluate 30s online/offline threshold & countdown timers every second
    setInterval(() => {
      renderKpis();
      renderMotorControl();
    }, 1000);
    // Refresh history charts periodically
    setInterval(loadCharts, 60000);

    window.addEventListener('langChanged', () => {
      renderKpis();
      renderMotorControl();
      loadCharts();
    });

    window.addEventListener('adminAuthChanged', () => {
      fetchControlData();
      renderMotorControl();
    });
  });
})();
