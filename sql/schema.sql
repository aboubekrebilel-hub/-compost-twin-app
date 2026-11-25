-- CompostTwin Station - Supabase Postgres Schema
-- Run this SQL in the Supabase SQL Editor before starting the server.

create table if not exists public.readings (
  id bigint generated always as identity primary key,
  device_id text not null,
  temperature double precision,
  soil_moisture double precision,
  oxygen double precision,
  ph double precision,
  note text,
  source text not null check (source in ('sensor', 'manual')),
  created_at timestamptz not null default now()
);

-- Indexes for fast pagination, latest-row fallback, and date-range queries
create index if not exists idx_readings_created_at_desc
  on public.readings (created_at desc);

create index if not exists idx_readings_device_created_at
  on public.readings (device_id, created_at desc);

create index if not exists idx_readings_ph_created_at
  on public.readings (created_at desc)
  where ph is not null;

-- Note:
-- If using the Supabase service_role key on the backend, RLS is bypassed safely on the server.
-- If using the anon key on the backend, ensure RLS policies allow the backend operations
-- or disable RLS on `readings` since all access goes through the Express API.

-- ============================================================================
-- Additive migration for Motor Control & Automatic Mixing
-- ============================================================================

create table if not exists public.control_log (
  id bigint generated always as identity primary key,
  device_id text not null,
  channel integer not null check (channel in (1, 2)),
  state text not null check (state in ('on', 'off')),
  reason text not null check (reason in ('manual', 'temperature', 'oxygen', 'moisture')),
  created_at timestamptz not null default now()
);

create index if not exists idx_control_log_device_created_at
  on public.control_log (device_id, created_at desc);

create table if not exists public.control_config (
  device_id text primary key,
  auto_enabled boolean not null default false,
  temp_max double precision not null default 65,
  oxygen_min double precision not null default 10,
  moisture_max double precision not null default 65,
  moisture_min_alert double precision not null default 35,
  run_sec integer not null default 60,
  cooldown_min integer not null default 30,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
