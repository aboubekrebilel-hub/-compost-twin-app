const DEVICE_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * Check that a value is a finite number within [min, max].
 */
function isFiniteNumberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Round to 2 decimal places for clean storage and telemetry display.
 */
function roundTwo(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Validate a device_id string (1..64 chars matching [a-zA-Z0-9._-]+).
 */
function parseDeviceId(raw, defaultValue = null) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue ? { valid: true, value: defaultValue } : { valid: false };
  }
  if (typeof raw !== 'string') return { valid: false };
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64 || !DEVICE_ID_REGEX.test(trimmed)) {
    return { valid: false };
  }
  return { valid: true, value: trimmed };
}

/**
 * Validate ESP32 sensor payload: { device_id, temperature?, soil_moisture?, oxygen? }.
 * Supports partial readings (disconnected sensors may be omitted or null),
 * as long as device_id is valid and at least one valid sensor value is present.
 */
function validateSensorReading(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const parsedDevice = parseDeviceId(body.device_id);
  if (!parsedDevice.valid) {
    errors.push('device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
  }

  const hasTemp = body.temperature !== undefined && body.temperature !== null;
  const hasMoisture = body.soil_moisture !== undefined && body.soil_moisture !== null;
  const hasOxygen = body.oxygen !== undefined && body.oxygen !== null;

  if (hasTemp && !isFiniteNumberInRange(body.temperature, -20, 100)) {
    errors.push('temperature must be a finite number between -20 and 100 (°C).');
  }

  if (hasMoisture && !isFiniteNumberInRange(body.soil_moisture, 0, 100)) {
    errors.push('soil_moisture must be a finite number between 0 and 100 (%).');
  }

  if (hasOxygen && !isFiniteNumberInRange(body.oxygen, 0, 100)) {
    errors.push('oxygen must be a finite number between 0 and 100 (%).');
  }

  if (!hasTemp && !hasMoisture && !hasOxygen) {
    errors.push('At least one sensor field (temperature, soil_moisture, or oxygen) is required.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      device_id: parsedDevice.value,
      temperature: hasTemp ? roundTwo(body.temperature) : null,
      soil_moisture: hasMoisture ? roundTwo(body.soil_moisture) : null,
      oxygen: hasOxygen ? roundTwo(body.oxygen) : null,
      source: 'sensor',
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * Validate manual pH entry: { value (or ph), note?, timestamp? (or created_at?), device_id? }.
 */
function validateManualPh(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const rawPh = body.value !== undefined ? body.value : body.ph;
  const numericPh = typeof rawPh === 'string' && rawPh.trim() !== '' ? Number(rawPh) : rawPh;
  if (!isFiniteNumberInRange(numericPh, 0, 14)) {
    errors.push('pH value must be a finite number between 0 and 14.');
  }

  let note = null;
  if (body.note !== undefined && body.note !== null && body.note !== '') {
    if (typeof body.note !== 'string') {
      errors.push('note must be a string.');
    } else {
      note = body.note.trim();
      if (note.length > 500) {
        errors.push('note must be at most 500 characters.');
      }
    }
  }

  const parsedDevice = parseDeviceId(body.device_id, 'station-01');
  if (!parsedDevice.valid) {
    errors.push('device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
  }

  let createdAt = new Date().toISOString();
  const rawTimestamp = body.timestamp || body.created_at;
  if (rawTimestamp !== undefined && rawTimestamp !== null && rawTimestamp !== '') {
    const parsed = new Date(rawTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      errors.push('timestamp must be a valid ISO-8601 date string.');
    } else {
      createdAt = parsed.toISOString();
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      device_id: parsedDevice.value,
      temperature: null,
      soil_moisture: null,
      oxygen: null,
      ph: roundTwo(numericPh),
      note,
      source: 'manual',
      created_at: createdAt,
    },
  };
}

/**
 * Validate manual relay control command: { device_id, channel: 1|2, state: 'on'|'off', duration_sec? }.
 */
function validateControlCommand(body, maxRunSec = 60) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const parsedDevice = parseDeviceId(body.device_id);
  if (!parsedDevice.valid) {
    errors.push('device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
  }

  const channel = body.channel;
  if (channel !== 1 && channel !== 2) {
    errors.push('channel must be 1 or 2.');
  }

  const state = typeof body.state === 'string' ? body.state.trim().toLowerCase() : '';
  if (state !== 'on' && state !== 'off') {
    errors.push('state must be "on" or "off".');
  }

  let durationSec = maxRunSec;
  if (state === 'on' && body.duration_sec !== undefined && body.duration_sec !== null) {
    if (
      typeof body.duration_sec !== 'number' ||
      !Number.isInteger(body.duration_sec) ||
      body.duration_sec < 1 ||
      body.duration_sec > maxRunSec
    ) {
      errors.push(`duration_sec must be an integer between 1 and ${maxRunSec}.`);
    } else {
      durationSec = body.duration_sec;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      device_id: parsedDevice.value,
      channel,
      state,
      duration_sec: durationSec,
    },
  };
}

/**
 * Validate automatic mixing configuration:
 * { device_id?, auto_enabled, temp_max, oxygen_min, moisture_max, moisture_min_alert, run_sec, cooldown_min }
 */
function validateControlConfig(body, maxRunSec = 60) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const parsedDevice = parseDeviceId(body.device_id, 'station-01');
  if (!parsedDevice.valid) {
    errors.push('device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
  }

  if (typeof body.auto_enabled !== 'boolean') {
    errors.push('auto_enabled must be a boolean.');
  }

  if (!isFiniteNumberInRange(body.temp_max, 30, 90)) {
    errors.push('temp_max must be a finite number between 30 and 90 (°C).');
  }

  if (!isFiniteNumberInRange(body.oxygen_min, 1, 21)) {
    errors.push('oxygen_min must be a finite number between 1 and 21 (%).');
  }

  if (!isFiniteNumberInRange(body.moisture_max, 0, 100)) {
    errors.push('moisture_max must be a finite number between 0 and 100 (%).');
  }

  if (!isFiniteNumberInRange(body.moisture_min_alert, 0, 100)) {
    errors.push('moisture_min_alert must be a finite number between 0 and 100 (%).');
  }

  if (
    isFiniteNumberInRange(body.moisture_min_alert, 0, 100) &&
    isFiniteNumberInRange(body.moisture_max, 0, 100) &&
    body.moisture_min_alert > body.moisture_max
  ) {
    errors.push('moisture_min_alert must be less than or equal to moisture_max.');
  }

  const minRunSec = Math.min(5, maxRunSec);
  if (
    typeof body.run_sec !== 'number' ||
    !Number.isInteger(body.run_sec) ||
    body.run_sec < minRunSec ||
    body.run_sec > maxRunSec
  ) {
    errors.push(`run_sec must be an integer between ${minRunSec} and ${maxRunSec}.`);
  }

  if (
    typeof body.cooldown_min !== 'number' ||
    !Number.isInteger(body.cooldown_min) ||
    body.cooldown_min < 1 ||
    body.cooldown_min > 1440
  ) {
    errors.push('cooldown_min must be an integer between 1 and 1440.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      device_id: parsedDevice.value,
      auto_enabled: body.auto_enabled,
      temp_max: roundTwo(body.temp_max),
      oxygen_min: roundTwo(body.oxygen_min),
      moisture_max: roundTwo(body.moisture_max),
      moisture_min_alert: roundTwo(body.moisture_min_alert),
      run_sec: body.run_sec,
      cooldown_min: body.cooldown_min,
      updated_at: new Date().toISOString(),
    },
  };
}

/**
 * Parse and validate optional ISO date range query params (`from`, `to`).
 */
function parseDateRange(query) {
  const errors = [];
  let from = null;
  let to = null;

  if (query.from) {
    const d = new Date(query.from);
    if (Number.isNaN(d.getTime())) {
      errors.push('Invalid "from" date parameter.');
    } else {
      from = d.toISOString();
    }
  }

  if (query.to) {
    const d = new Date(query.to);
    if (Number.isNaN(d.getTime())) {
      errors.push('Invalid "to" date parameter.');
    } else {
      to = d.toISOString();
    }
  }

  if (from && to && from > to) {
    errors.push('"from" date must be earlier than or equal to "to" date.');
  }

  return { valid: errors.length === 0, errors, from, to };
}

/**
 * Parse and bound pagination params (`page`, `limit`).
 */
function parsePagination(query) {
  const pageRaw = query.page !== undefined ? Number.parseInt(query.page, 10) : 1;
  const limitRaw = query.limit !== undefined ? Number.parseInt(query.limit, 10) : 50;

  if (!Number.isFinite(pageRaw) || pageRaw < 1) {
    return { valid: false, errors: ['page must be an integer >= 1.'] };
  }
  if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > 2000) {
    return { valid: false, errors: ['limit must be an integer between 1 and 2000.'] };
  }

  return { valid: true, errors: [], page: pageRaw, limit: limitRaw };
}

module.exports = {
  roundTwo,
  parseDeviceId,
  validateSensorReading,
  validateManualPh,
  validateControlCommand,
  validateControlConfig,
  parseDateRange,
  parsePagination,
};
