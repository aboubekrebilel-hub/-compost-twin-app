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
