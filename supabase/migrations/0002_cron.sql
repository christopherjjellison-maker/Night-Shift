-- Night Shift: hourly scheduler tick.
-- Requires the pg_cron and pg_net extensions (Database → Extensions in the Supabase dashboard).
-- Replace the two placeholders before running: your project ref, and the CRON_KEY you set as a function secret.
-- The scheduler itself decides per user (by their time zone) whether it's brief time or nudge time.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('night-shift-tick') where exists (select 1 from cron.job where jobname = 'night-shift-tick');

select cron.schedule(
  'night-shift-tick',
  '7 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/scheduler',
    headers := '{"Content-Type":"application/json","x-cron-key":"YOUR-CRON-KEY"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
