-- Saved weather monitors for deployments that set DATABASE_URL (see README, "Supabase").
--
-- Everything lives in the private `weather` schema, which the Supabase Data API does not expose.
-- Only the server-side login role `weather_app` can reach it, through the connection pooler.
-- Create that role first, outside migrations so its password hash stays out of history:
--   create role weather_app login noinherit password '<SCRAM verifier or password>';

create schema if not exists weather;
revoke all on schema weather from public, anon, authenticated;

create table weather.monitors (
  id uuid primary key,
  user_id text,
  name text not null,
  zip_code text not null,
  city text not null,
  state text not null,
  center_lat double precision not null,
  center_lng double precision not null,
  radius_miles double precision not null check (radius_miles > 0),
  interval_minutes integer not null check (interval_minutes > 0),
  enabled boolean not null default true,
  risk_types text[] not null,
  thresholds jsonb not null default '{}'::jsonb,
  emails text[] not null default '{}',
  email_mode text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_checked_at timestamptz,
  last_successful_check_at timestamptz,
  next_check_at timestamptz not null,
  last_run jsonb
);
create index monitors_due_idx on weather.monitors (next_check_at) where enabled;
create index monitors_created_idx on weather.monitors (created_at desc);

create table weather.alert_states (
  monitor_id uuid not null references weather.monitors (id) on delete cascade,
  id text not null,
  external_alert_id text not null,
  alert_type text not null,
  severity text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz,
  status text not null check (status in ('active', 'expired')),
  fingerprint text not null,
  payload jsonb not null,
  primary key (monitor_id, id)
);

create table weather.monitor_runs (
  id text primary key,
  monitor_id uuid not null references weather.monitors (id) on delete cascade,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  status text not null check (status in ('ok', 'partial', 'failed')),
  active_risk_count integer not null,
  highest_severity text,
  error_summary text,
  changes jsonb not null default '[]'::jsonb
);
create index monitor_runs_monitor_idx on weather.monitor_runs (monitor_id, completed_at desc);

-- Defense in depth: RLS on, and only the app role has a policy.
alter table weather.monitors enable row level security;
alter table weather.alert_states enable row level security;
alter table weather.monitor_runs enable row level security;
create policy "weather_app full access" on weather.monitors for all to weather_app using (true) with check (true);
create policy "weather_app full access" on weather.alert_states for all to weather_app using (true) with check (true);
create policy "weather_app full access" on weather.monitor_runs for all to weather_app using (true) with check (true);

revoke all on all tables in schema weather from public, anon, authenticated;
grant usage on schema weather to weather_app;
grant select, insert, update, delete on all tables in schema weather to weather_app;
