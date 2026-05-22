-- Fix: leave-end-reminder cron was missing Authorization header → 401 every day

select cron.unschedule('leave-end-reminder-daily');

select cron.schedule(
    'leave-end-reminder-daily',
    '0 5 * * *',
    $$
    select net.http_post(
        url     := current_setting('app.supabase_url') || '/functions/v1/leave-end-reminder',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || current_setting('app.service_role_key')
        ),
        body    := '{}'::jsonb
    );
    $$
);
