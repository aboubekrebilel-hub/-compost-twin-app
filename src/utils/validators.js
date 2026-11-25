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
 * Validate ESP32 sensor payload: { device_id, temperature, soil_moisture, oxygen }.
 */
function validateSensorReading(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const rawDeviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
  if (!rawDeviceId || rawDeviceId.length > 64 || !DEVICE_ID_REGEX.test(rawDeviceId)) {
    errors.push('device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
  }

  if (!isFiniteNumberInRange(body.temperature, -20, 100)) {
    errors.push('temperature must be a finite number between -20 and 100 (°C).');
  }

  if (!isFiniteNumberInRange(body.soil_moisture, 0, 100)) {
    errors.push('soil_moisture must be a finite number between 0 and 100 (%).');
  }

  if (!isFiniteNumberInRange(body.oxygen, 0, 100)) {
    errors.push('oxygen must be a finite number between 0 and 100 (%).');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      device_id: rawDeviceId,
      temperature: roundTwo(body.temperature),
      soil_moisture: roundTwo(body.soil_moisture),
      oxygen: roundTwo(body.oxygen),
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

  let deviceId = 'station-01';
  if (body.device_id !== undefined && body.device_id !== null && body.device_id !== '') {
    if (typeof body.device_id !== 'string' || !DEVICE_ID_REGEX.test(body.device_id.trim()) || body.device_id.trim().length > 64) {
      errors.push('device_id must be a 1-64 char string matching [a-zA-Z0-9._-]+.');
    } else {
      deviceId = body.device_id.trim();
    }
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
      device_id: deviceId,
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
  validateSensorReading,
  validateManualPh,
  parseDateRange,
  parsePagination,
};
