const { createClient } = require('@supabase/supabase-js');
const { AppError } = require('../middleware/errorHandler');

/**
 * Supabase repository for `control_log` and `control_config`.
 * Designed to fail safely on startup/logging if migration SQL hasn't been applied yet.
 */
function createControlStore({ supabaseUrl, supabaseKey }) {
  let client = null;

  function getClient() {
    if (!supabaseUrl || !supabaseKey) {
      return null;
    }
    if (!client) {
      client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return client;
  }

  return {
    isConfigured() {
      return Boolean(supabaseUrl && supabaseKey);
    },

    /**
     * Log a relay state change into `control_log`. Never throws to callers.
     */
    async logCommand({ device_id, channel, state, reason, created_at }) {
      const db = getClient();
      if (!db) return null;

      try {
        const { data, error } = await db
          .from('control_log')
          .insert([
            {
              device_id,
              channel,
              state,
              reason,
              created_at: created_at || new Date().toISOString(),
            },
          ])
          .select('*')
          .single();

        if (error) {
          console.warn(`[ControlStore:logCommand] ${error.message}`);
          return null;
        }
        return data;
      } catch (err) {
        console.warn(`[ControlStore:logCommand] ${err.message}`);
        return null;
      }
    },

    /**
     * Load all persisted device configs at startup. Returns [] if table is missing.
     */
    async getAllConfigs() {
      const db = getClient();
      if (!db) return [];

      try {
        const { data, error } = await db.from('control_config').select('*');
        if (error) {
          console.warn(`[ControlStore:getAllConfigs] ${error.message}`);
          return [];
        }
        return data || [];
      } catch (err) {
        console.warn(`[ControlStore:getAllConfigs] ${err.message}`);
        return [];
      }
    },

    /**
     * Load config for a single device_id. Returns null if missing.
     */
    async getConfig(deviceId) {
      const db = getClient();
      if (!db) return null;

      try {
        const { data, error } = await db
          .from('control_config')
          .select('*')
          .eq('device_id', deviceId)
          .maybeSingle();

        if (error) {
          console.warn(`[ControlStore:getConfig] ${error.message}`);
          return null;
        }
        return data || null;
      } catch (err) {
        console.warn(`[ControlStore:getConfig] ${err.message}`);
        return null;
      }
    },

    /**
     * Persist config for a device in `control_config`.
     */
    async upsertConfig(configRow) {
      const db = getClient();
      if (!db) {
        throw new AppError(
          503,
          'Supabase is not configured. Please set SUPABASE_URL and SUPABASE_KEY in .env.'
        );
      }

      const { data, error } = await db
        .from('control_config')
        .upsert([configRow], { onConflict: 'device_id' })
        .select('*')
        .single();

      if (error) {
        console.error('[Supabase:upsertConfig]', error);
        throw new AppError(502, `Database error during upsertConfig: ${error.message}`);
      }
      return data;
    },

    /**
     * Fetch the latest automatic mix log entry for a device (restart cooldown fallback).
     */
    async getLastAutoMixLog(deviceId) {
      const db = getClient();
      if (!db) return null;

      try {
        const { data, error } = await db
          .from('control_log')
          .select('*')
          .eq('device_id', deviceId)
          .eq('channel', 1)
          .in('reason', ['temperature', 'oxygen', 'moisture'])
          .order('created_at', { ascending: false })
          .limit(1);

        if (error) {
          console.warn(`[ControlStore:getLastAutoMixLog] ${error.message}`);
          return null;
        }
        return data && data.length > 0 ? data[0] : null;
      } catch (err) {
        console.warn(`[ControlStore:getLastAutoMixLog] ${err.message}`);
        return null;
      }
    },
  };
}

module.exports = { createControlStore };
