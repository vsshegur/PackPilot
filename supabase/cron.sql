create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace both placeholder values before running this file.
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'dispatch_project_url');
select vault.create_secret('REPLACE_WITH_THE_SAME_LONG_CLEANUP_SECRET', 'dispatch_cleanup_secret');

select cron.schedule(
  'delete-expired-seller-pdfs',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_project_url' limit 1)
      || '/functions/v1/delete-expired-pdfs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cleanup_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
