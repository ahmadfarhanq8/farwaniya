-- ═══════════════════════════════════════════════════════════
-- جدولة إرسال تذكير بصمة التواجد تلقائياً
-- الأحد - الخميس الساعة 9:45 و 10:15 (توقيت الكويت UTC+3)
-- ─────────────────────────────────────────────────────────
-- تفعيل امتداد pg_cron (مرة واحدة فقط)
create extension if not exists pg_cron;

-- ─────────────────────────────────────────────────────────
-- تذكير الساعة 9:45 الكويت (6:45 UTC) — الأحد=0, الإثنين=1, ..., الخميس=4
-- ─────────────────────────────────────────────────────────
select cron.schedule(
  'attendance-reminder-0945',
  '45 6 * * 0,1,2,3,4',
  $$
    select net.http_post(
      url    := current_setting('app.supabase_url') || '/functions/v1/attendance-reminder',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body   := '{}'::jsonb
    );
  $$
);

-- ─────────────────────────────────────────────────────────
-- تذكير الساعة 10:15 الكويت (7:15 UTC)
-- ─────────────────────────────────────────────────────────
select cron.schedule(
  'attendance-reminder-1015',
  '15 7 * * 0,1,2,3,4',
  $$
    select net.http_post(
      url    := current_setting('app.supabase_url') || '/functions/v1/attendance-reminder',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body   := '{}'::jsonb
    );
  $$
);

-- ─────────────────────────────────────────────────────────
-- للتحقق من الجداول الزمنية المسجّلة
-- select * from cron.job;
-- ─────────────────────────────────────────────────────────
