-- Runs due weather monitors every 5 minutes by calling the deployed app (Vercel has no in-process
-- scheduler and its Hobby cron is daily-only). Run once in the Supabase SQL Editor.
--
-- Prerequisites:
--   1. Extensions pg_cron and pg_net enabled.
--   2. A Vault secret named `weather_cron_secret` whose value equals the app's CRON_SECRET
--      (Dashboard -> Integrations -> Vault -> Add new secret). The secret never appears here.

select cron.schedule(
  'weather-monitors-due',
  '*/5 * * * *',
  $job$
  select net.http_get(
    url := 'https://weather-app-rose-six-56.vercel.app/api/cron/weather-monitors',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'weather_cron_secret'), '')
    ),
    timeout_milliseconds := 120000
  );
  $job$
);

-- Check it is firing (status 200 = ran; 401 = Vault secret missing or wrong):
-- select status_code, created from net._http_response order by created desc limit 5;
