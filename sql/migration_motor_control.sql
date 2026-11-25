-- CompostTwin Station - Additive Migration for Motor Control & Automatic Mixing
-- Safe to run on an existing production Supabase Postgres database.
-- Additive only: no columns or tables are dropped, renamed, or altered.

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
