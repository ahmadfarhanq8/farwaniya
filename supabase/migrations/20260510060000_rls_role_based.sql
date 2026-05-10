-- ═══════════════════════════════════════════════════════════
-- RLS Hardening (Phase 4): role-based policies + login rate limit
-- ═══════════════════════════════════════════════════════════
-- المرحلة 3 ضمنت أن أي عملية تحتاج جلسة authenticated.
-- المرحلة 4 تُفصّل من يستطيع الكتابة بحسب الدور:
--   admin    : كل شيء
--   stats    : قراءة فقط (لكل الجداول)
--   employee : قراءة + كتابة سجلاته الشخصية فقط (leaves/permissions/...)
--   officer  : مثل employee لكن على سجلات الضباط
--
-- الدور يأتي من JWT.app_metadata.role (صادر عن provision-auth-user).

-- ───────── helpers ─────────
create or replace function public.app_role()
returns text language sql stable as $$
    select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
$$;

create or replace function public.app_person_id()
returns bigint language sql stable as $$
    select nullif(auth.jwt() -> 'app_metadata' ->> 'person_id', '')::bigint;
$$;

create or replace function public.app_account_id()
returns bigint language sql stable as $$
    select nullif(auth.jwt() -> 'app_metadata' ->> 'account_id', '')::bigint;
$$;

grant execute on function public.app_role()       to authenticated;
grant execute on function public.app_person_id()  to authenticated;
grant execute on function public.app_account_id() to authenticated;

-- ───────── أزل بوليسي المرحلة 3 من كل الجداول ─────────
do $$
declare
    t text;
    tbls text[] := array[
        'employees','officers','leaves','notes','statistics',
        'employee_files','officer_files','leave_permissions',
        'custom_archive_types','notifications',
        'other_requests','admin_notifications_store','app_settings',
        'audit_log','fcm_tokens'
    ];
begin
    foreach t in array tbls loop
        if to_regclass('public.' || t) is null then continue; end if;
        execute format('drop policy if exists %I on public.%I', 'auth_' || t, t);
    end loop;
end $$;

-- ═══════════════════════════════════════════════════════════
-- Pattern A: قراءة لكل authenticated، كتابة admin فقط
-- ═══════════════════════════════════════════════════════════
do $$
declare
    t text;
    tbls text[] := array[
        'employees','officers','statistics','custom_archive_types',
        'notifications','app_settings'
    ];
begin
    foreach t in array tbls loop
        if to_regclass('public.' || t) is null then continue; end if;
        execute format('create policy %I on public.%I for select to authenticated using (true)',
                       'pol_' || t || '_read', t);
        execute format('create policy %I on public.%I for all to authenticated using (public.app_role() = ''admin'') with check (public.app_role() = ''admin'')',
                       'pol_' || t || '_admin_write', t);
    end loop;
end $$;

-- ═══════════════════════════════════════════════════════════
-- notes: قراءة للجميع، كتابة لجميع authenticated (لوحة ملاحظات مشتركة)
-- ═══════════════════════════════════════════════════════════
create policy pol_notes_all on public.notes
    for all to authenticated using (true) with check (true);

-- ═══════════════════════════════════════════════════════════
-- Pattern B: leaves / leave_permissions / other_requests
-- قراءة للجميع — admin يكتب أي شيء — employee/officer يكتب سجلاته فقط
-- ═══════════════════════════════════════════════════════════
do $$
declare
    t text;
    tbls text[] := array['leaves','leave_permissions','other_requests'];
begin
    foreach t in array tbls loop
        if to_regclass('public.' || t) is null then continue; end if;

        execute format('create policy %I on public.%I for select to authenticated using (true)',
                       'pol_' || t || '_read', t);

        execute format('create policy %I on public.%I for all to authenticated using (public.app_role() = ''admin'') with check (public.app_role() = ''admin'')',
                       'pol_' || t || '_admin', t);

        execute format($f$
            create policy %I on public.%I
            for insert to authenticated
            with check (
                (public.app_role() = 'employee' and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer'  and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
        $f$, 'pol_' || t || '_self_insert', t);

        execute format($f$
            create policy %I on public.%I
            for update to authenticated
            using (
                (public.app_role() = 'employee' and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer'  and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
            with check (
                (public.app_role() = 'employee' and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer'  and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
        $f$, 'pol_' || t || '_self_update', t);
    end loop;
end $$;

-- ═══════════════════════════════════════════════════════════
-- employee_files / officer_files
-- قراءة للجميع — admin كل شيء — صاحب السجل يضيف/يعدّل/يحذف ملفاته
-- ═══════════════════════════════════════════════════════════
create policy pol_employee_files_read on public.employee_files
    for select to authenticated using (true);
create policy pol_employee_files_admin on public.employee_files
    for all to authenticated
    using (public.app_role() = 'admin')
    with check (public.app_role() = 'admin');
create policy pol_employee_files_self on public.employee_files
    for all to authenticated
    using (public.app_role() = 'employee' and employee_id = public.app_person_id())
    with check (public.app_role() = 'employee' and employee_id = public.app_person_id());

create policy pol_officer_files_read on public.officer_files
    for select to authenticated using (true);
create policy pol_officer_files_admin on public.officer_files
    for all to authenticated
    using (public.app_role() = 'admin')
    with check (public.app_role() = 'admin');
create policy pol_officer_files_self on public.officer_files
    for all to authenticated
    using (public.app_role() = 'officer' and officer_id = public.app_person_id())
    with check (public.app_role() = 'officer' and officer_id = public.app_person_id());

-- ═══════════════════════════════════════════════════════════
-- admin_notifications_store: صندوق بريد للأدمن
-- أي مستخدم يستطيع إنشاء طلب — الأدمن يقرأ/يحدّث/يحذف
-- ═══════════════════════════════════════════════════════════
create policy pol_admin_notif_admin on public.admin_notifications_store
    for all to authenticated
    using (public.app_role() = 'admin')
    with check (public.app_role() = 'admin');
create policy pol_admin_notif_insert on public.admin_notifications_store
    for insert to authenticated
    with check (true);

-- ═══════════════════════════════════════════════════════════
-- audit_log: قراءة admin فقط — كتابة لكل authenticated
-- (السجلات تُنشأ من JS عند العمليات الحساسة)
-- ═══════════════════════════════════════════════════════════
create policy pol_audit_log_admin_read on public.audit_log
    for select to authenticated
    using (public.app_role() = 'admin');
create policy pol_audit_log_insert on public.audit_log
    for insert to authenticated
    with check (true);

-- ═══════════════════════════════════════════════════════════
-- fcm_tokens: قراءة admin (للدوال الإدارية) — كتابة لكل authenticated
-- (Edge Functions تستخدم service_role وتتجاوز RLS)
-- ═══════════════════════════════════════════════════════════
create policy pol_fcm_admin on public.fcm_tokens
    for select to authenticated
    using (public.app_role() = 'admin');
create policy pol_fcm_write on public.fcm_tokens
    for all to authenticated
    using (true) with check (true);

-- ═══════════════════════════════════════════════════════════
-- Login Rate Limit: 5 محاولات فاشلة / دقيقة لكل username
-- بعد ذلك نُغلق الحساب لـ 5 دقائق.
-- ═══════════════════════════════════════════════════════════
create table if not exists public.login_attempts (
    username        text primary key,
    attempts        int  not null default 0,
    window_started  timestamptz not null default now(),
    locked_until    timestamptz
);
alter table public.login_attempts enable row level security;
-- لا أحد يصل لهذا الجدول مباشرة — فقط SECURITY DEFINER داخل rpc_login

create or replace function public.rpc_login(p_username text, p_password text)
returns table(id bigint, username text, role text, person_id bigint)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    rec        record;
    parts      text[];
    salt       text;
    expected   text;
    actual_h   text;
    la         record;
    now_ts     timestamptz := now();
    win        interval := interval '1 minute';
    lock_dur   interval := interval '5 minutes';
    max_try    int := 5;
    valid      boolean := false;
begin
    -- 1) فحص القفل
    select * into la from login_attempts where username = p_username;
    if found and la.locked_until is not null and la.locked_until > now_ts then
        return; -- محبوس مؤقتاً
    end if;

    -- 2) تحقّق من البيانات
    select a.id, a.username, a.role, a.person_id, a.password
      into rec
      from accounts a
     where a.username = p_username
     limit 1;

    if found then
        if rec.password like 'v1$%' then
            parts    := string_to_array(rec.password, '$');
            salt     := parts[2];
            expected := parts[3];
            actual_h := encode(digest(salt || ':' || p_password, 'sha256'), 'hex');
            valid    := (actual_h = expected);
        else
            valid := (rec.password = p_password);
            if valid then
                update accounts set password = fn_hash_password(p_password) where id = rec.id;
            end if;
        end if;
    end if;

    -- 3) سجّل النتيجة
    if valid then
        delete from login_attempts where username = p_username;
        return query select rec.id, rec.username, rec.role, rec.person_id;
        return;
    else
        if not found or la is null then
            insert into login_attempts(username, attempts, window_started)
                 values (p_username, 1, now_ts)
            on conflict (username) do update
                set attempts = case
                        when login_attempts.window_started < now_ts - win then 1
                        else login_attempts.attempts + 1
                    end,
                    window_started = case
                        when login_attempts.window_started < now_ts - win then now_ts
                        else login_attempts.window_started
                    end,
                    locked_until = case
                        when (case when login_attempts.window_started < now_ts - win then 1
                                   else login_attempts.attempts + 1 end) >= max_try
                        then now_ts + lock_dur
                        else null
                    end;
        end if;
        return;
    end if;
end;
$$;

grant execute on function public.rpc_login(text, text) to anon, authenticated;
