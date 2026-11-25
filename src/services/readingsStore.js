const { createClient } = require('@supabase/supabase-js');
const { AppError } = require('../middleware/errorHandler');

/**
 * Create a Supabase-backed readings repository.
 */
function createReadingsStore({ supabaseUrl, supabaseKey }) {
  let client = null;

  function getClient() {
    if (!supabaseUrl || !supabaseKey) {
      throw new AppError(
        503,
        'Supabase is not configured. Please set SUPABASE_URL and SUPABASE_KEY in .env.'
      );
    }
    if (!client) {
      client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return client;
  }

  function mapSupabaseError(error, context) {
    console.error(`[Supabase:${context}]`, error);
    return new AppError(502, `Database error during ${context}: ${error.message}`);
  }

  return {
    isConfigured() {
      return Boolean(supabaseUrl && supabaseKey);
    },

    async insertReading(row) {
      const db = getClient();
      const { data, error } = await db
        .from('readings')
        .insert([row])
        .select('*')
        .single();

      if (error) throw mapSupabaseError(error, 'insertReading');
      return data;
    },

    async insertMany(rows) {
      if (!rows || rows.length === 0) return [];
      const db = getClient();
      const { data, error } = await db
        .from('readings')
        .insert(rows)
        .select('*');

      if (error) throw mapSupabaseError(error, 'insertMany');
      return data || [];
    },

    /**
     * Fallback after server restart: find the most recent sensor row per device.
     */
    async getLatestPerDevice() {
      const db = getClient();
      const { data, error } = await db
        .from('readings')
        .select('*')
        .eq('source', 'sensor')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw mapSupabaseError(error, 'getLatestPerDevice');

      const seen = new Map();
      for (const row of data || []) {
        if (!seen.has(row.device_id)) {
          seen.set(row.device_id, row);
        }
      }
      return Array.from(seen.values());
    },

    /**
     * Find the latest reading with a non-null pH value.
     */
    async getLatestPh() {
      const db = getClient();
      const { data, error } = await db
        .from('readings')
        .select('*')
        .not('ph', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw mapSupabaseError(error, 'getLatestPh');
      return data && data.length > 0 ? data[0] : null;
    },

    /**
     * Query paginated historical readings with optional date-range & device filters.
     */
    async queryReadings({ from, to, deviceId, page = 1, limit = 50 }) {
      const db = getClient();
      let query = db
        .from('readings')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);
      if (deviceId) query = query.eq('device_id', deviceId);

      const start = (page - 1) * limit;
      const end = start + limit - 1;
      query = query.range(start, end);

      const { data, error, count } = await query;
      if (error) throw mapSupabaseError(error, 'queryReadings');

      const total = count || 0;
      return {
        data: data || [],
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    },

    /**
     * Fetch matching rows for CSV/XLSX export (capped at 10,000 rows for free-tier safety).
     */
    async exportReadings({ from, to, deviceId, maxRows = 10000 }) {
      const db = getClient();
      let query = db
        .from('readings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(maxRows);

      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);
      if (deviceId) query = query.eq('device_id', deviceId);

      const { data, error } = await query;
      if (error) throw mapSupabaseError(error, 'exportReadings');
      return data || [];
    },

    async deleteReadingById(id) {
      const db = getClient();
      const { data, error } = await db
        .from('readings')
        .delete()
        .eq('id', id)
        .select('id');

      if (error) throw mapSupabaseError(error, 'deleteReadingById');
      return data ? data.length : 0;
    },

    async deleteReadingsByRange({ from, to }) {
      const db = getClient();
      let query = db.from('readings').delete();
      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);

      const { data, error } = await query.select('id');
      if (error) throw mapSupabaseError(error, 'deleteReadingsByRange');
      return data ? data.length : 0;
    },

    async deleteAllReadings() {
      const db = getClient();
      const { data, error } = await db
        .from('readings')
        .delete()
        .gt('id', 0)
        .select('id');

      if (error) throw mapSupabaseError(error, 'deleteAllReadings');
      return data ? data.length : 0;
    },
  };
}

module.exports = { createReadingsStore };
