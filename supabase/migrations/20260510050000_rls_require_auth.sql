-- ═══════════════════════════════════════════════════════════
-- RLS Hardening (Phase 3): require authenticated session for all data
-- ═══════════════════════════════════════════════════════════
-- قبل: كل الجداول مفتوحة لـ anon عبر `using(true)` — أي شخص معه
-- الـ anon key يقرأ/يكتب أي شيء.
-- بعد: لا أحد يقرأ/يكتب إلا بعد signInWithPassword (JWT حقيقي).
--
-- الـ JS الآن يستخدم:
--   1) rpc_login (يبقى متاحاً لـ anon — يتحقّق من الباسوورد)
--   2) signInWithPassword → يحصل على JWT
--   3) كل القراءات/الكتابات تتم بدور authenticated
--
-- ملاحظة: لا نُقيِّد بدور (admin/employee/...) في هذه المرحلة.
-- التقييد الدقيق سيأتي في مرحلة لاحقة بعد التحقق الميداني.

-- helper: نضمن وجود البوليسي قبل الحذف، ثم نُنشئها بشروط أقوى
do $$
declare
    t   text;
    pol text;
    tbls text[] := array[
        'employees','officers','leaves','notes','statistics',
        'employee_files','officer_files','leave_permissions',
        'custom_archive_types','notifications',
        'other_requests','admin_notifications_store','app_settings',
        'audit_log','fcm_tokens'
    ];
begin
    foreach t in array tbls loop
        -- تأكد أن الجدول موجود
        if to_regclass('public.' || t) is null then continue; end if;

        -- تأكد أن RLS مفعّل
        execute format('alter table public.%I enable row level security', t);

        -- اسم البوليسي القديم النموذجي
        pol := 'allow_all_' || t;
        execute format('drop policy if exists %I on public.%I', pol, t);
        -- بعض الإصدارات السابقة استخدمت "auth_*" — احذف أيضاً إن وُجد
        execute format('drop policy if exists %I on public.%I', 'auth_' || t, t);

        -- بوليسي جديد: لا قراءة/كتابة إلا بجلسة authenticated
        execute format(
            'create policy %I on public.%I for all to authenticated using (true) with check (true)',
            'auth_' || t, t
        );
    end loop;
end $$;

-- accounts خاصة: لا نُغيّرها هنا — بقيت محمية بـ migration 20260510020000
-- (RPC SECURITY DEFINER فقط). أي سياسة على accounts ستُلغى ضمنياً
-- لأن anon لا يستطيع select/insert/update/delete على الجدول مباشرة.
