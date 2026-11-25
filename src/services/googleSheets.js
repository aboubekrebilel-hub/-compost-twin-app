/**
 * Sync a single stored reading row to an optional Google Apps Script webhook.
 * Never throws so webhook latency/failures cannot disrupt sensor storage.
 */
async function syncRowToGoogleSheets(row, webhookUrl) {
  if (!webhookUrl) {
    return { skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: row.id ?? null,
        device_id: row.device_id,
        temperature: row.temperature,
        soil_moisture: row.soil_moisture,
        oxygen: row.oxygen,
        ph: row.ph,
        note: row.note ?? null,
        source: row.source,
        created_at: row.created_at,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`[GoogleSheets] Webhook returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: response.status };
    }

    return { ok: true };
  } catch (err) {
    console.warn(`[GoogleSheets] Sync failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { syncRowToGoogleSheets };
