-- Schedule leave-end-reminder edge function:
-- 05:00 UTC = 08:00 Kuwait (UTC+3) daily.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- إزالة الجدولة القديمة إن وُجدت (آمنة)
do $$
begin
    perform cron.unschedule('leave-end-reminder-daily');
exception when others then null;
end$$;

select
    cron.schedule(
        'leave-end-reminder-daily',
        '0 5 * * *',
        $cron$
        select net.http_post(
            url     := 'https://leyrntrcubvoduqslmua.supabase.co/functions/v1/leave-end-reminder',
            headers := '{"Content-Type":"application/json"}'::jsonb,
            body    := '{}'::jsonb
        );
        $cron$
    );
