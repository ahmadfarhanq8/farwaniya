-- ═══════════════════════════════════════════════════════════════════════════
-- Demo Account for Apple App Review (Guideline 2.1a)
-- ═══════════════════════════════════════════════════════════════════════════
-- شغّل هذا السكربت من:  Supabase Dashboard → SQL Editor → New Query → RUN
-- يعتمد على migration 20260512000000_demo_data_isolation.sql الذي يضيف
-- عمود is_demo + سياسات عزل. يجب تشغيل الـ migration أولاً.
--
-- بيانات الدخول لـ App Store Connect → App Review Information:
--     Username : demo
--     Password : AppleReview@2026
--
-- هذا الحساب admin معزول تماماً: يشوف بيانات تجريبية فقط، لا يصل للبيانات
-- الحقيقية، وأي شيء ينشئه لا يظهر للموظفين الحقيقيين.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── 1. أنشئ/حدّث الحساب في auth.users + accounts ─────────────────────────
do $$
declare
    v_username   text := 'demo';
    v_password   text := 'AppleReview@2026';
    v_email      text := 'demo@alfarwania.app';
    v_auth_id    uuid;
    v_account_id bigint;
    v_app_meta   jsonb;
begin
    -- auth.users
    select id into v_auth_id from auth.users where email = v_email;

    if v_auth_id is null then
        v_auth_id := gen_random_uuid();
        insert into auth.users (
            instance_id, id, aud, role, email,
            encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data,
            created_at, updated_at,
            confirmation_token, email_change, email_change_token_new, recovery_token
        ) values (
            '00000000-0000-0000-0000-000000000000',
            v_auth_id, 'authenticated', 'authenticated', v_email,
            crypt(v_password, gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            now(), now(),
            '', '', '', ''
        );

        insert into auth.identities (
            id, user_id, provider_id, identity_data, provider,
            last_sign_in_at, created_at, updated_at
        ) values (
            gen_random_uuid(), v_auth_id, v_auth_id::text,
            jsonb_build_object('sub', v_auth_id::text, 'email', v_email, 'email_verified', true),
            'email', now(), now(), now()
        );
    else
        update auth.users
           set encrypted_password = crypt(v_password, gen_salt('bf')),
               email_confirmed_at = coalesce(email_confirmed_at, now()),
               updated_at         = now()
         where id = v_auth_id;
    end if;

    -- public.accounts (نُعطّل trigger الديمو مؤقتاً لأن صف الحساب نفسه يجب
    -- أن يكون is_demo=true بصرف النظر عن المستخدم المنفّذ)
    alter table public.accounts disable trigger trg_set_is_demo_accounts;

    select id into v_account_id from public.accounts where username = v_username;

    if v_account_id is null then
        insert into public.accounts (username, role, person_id, auth_user_id, is_demo)
        values (v_username, 'admin', null, v_auth_id, true)
        returning id into v_account_id;
    else
        update public.accounts
           set role         = 'admin',
               auth_user_id = v_auth_id,
               is_demo      = true
         where id = v_account_id;
    end if;

    alter table public.accounts enable trigger trg_set_is_demo_accounts;

    -- app_metadata يحوي is_demo=true → JWT يحمل العلامة → RLS يعزل البيانات
    v_app_meta := jsonb_build_object(
        'provider'  , 'email',
        'providers' , jsonb_build_array('email'),
        'role'      , 'admin',
        'account_id', v_account_id,
        'person_id' , null,
        'username'  , v_username,
        'is_demo'   , true
    );
    update auth.users
       set raw_app_meta_data = v_app_meta,
           updated_at = now()
     where id = v_auth_id;

    raise notice 'Demo account ready. account_id=%, auth_user_id=%', v_account_id, v_auth_id;
end $$;

-- ─── 2. علّم البيانات اللي أُدخلت سابقاً كـ ديمو ──────────────────────────
update public.employees     set is_demo = true where number in ('EMP-1001','EMP-1002','EMP-1003','EMP-1004');
update public.officers      set is_demo = true where military_number in ('MIL-2001','MIL-2002','MIL-2003');
update public.leaves        set is_demo = true where person_name in ('أحمد محمد العتيبي','سالم فهد الرشيدي','ملازم / خالد سعد');
update public.notifications set is_demo = true where title in ('مرحباً بمراجع تطبيق App Store','تذكير');

-- ─── 3. بيانات تجريبية إضافية (idempotent) ────────────────────────────────
-- نُعطّل trigger مؤقتاً لأن السكربت يعمل بصلاحية owner وليس JWT للديمو،
-- ونضبط is_demo=true يدوياً.

alter table public.employees     disable trigger trg_set_is_demo_employees;
alter table public.officers      disable trigger trg_set_is_demo_officers;
alter table public.leaves        disable trigger trg_set_is_demo_leaves;
alter table public.notifications disable trigger trg_set_is_demo_notifications;

insert into public.employees (name, number, department, shift, position, hire_date, phone, status, is_demo)
select v.*, true from (values
    ('أحمد محمد العتيبي'   , 'EMP-1001', 'الفحص الفني', 'صباحي', 'فاحص'      , '2022-03-15', '99000001', 'نشط'),
    ('سالم فهد الرشيدي'    , 'EMP-1002', 'الإدارة'    , 'مسائي', 'موظف إداري', '2021-06-01', '99000002', 'نشط'),
    ('عبدالله جاسم الكندري', 'EMP-1003', 'الفحص الفني', 'صباحي', 'فاحص أول' , '2020-01-20', '99000003', 'نشط'),
    ('يوسف ناصر المطيري'   , 'EMP-1004', 'الأرشيف'    , 'صباحي', 'موظف أرشيف', '2023-09-10', '99000004', 'نشط')
) as v(name, number, department, shift, position, hire_date, phone, status)
where not exists (select 1 from public.employees e where e.number = v.number);

insert into public.officers (name, rank, position, military_number, civil_number, phone, hire_date, status, is_demo)
select v.*, true from (values
    ('ملازم / خالد سعد'  , 'ملازم'  , 'ضابط فحص'      , 'MIL-2001', '290010100001', '99100001', '2019-04-01', 'نشط'),
    ('نقيب / فهد عبدالله', 'نقيب'   , 'رئيس قسم الفحص', 'MIL-2002', '285020200002', '99100002', '2015-08-15', 'نشط'),
    ('رائد / محمد العنزي', 'رائد'   , 'مدير المناوبة' , 'MIL-2003', '280030300003', '99100003', '2012-02-10', 'نشط')
) as v(name, rank, position, military_number, civil_number, phone, hire_date, status)
where not exists (select 1 from public.officers o where o.military_number = v.military_number);

insert into public.leaves (person_id, person_type, type, person_name, leave_type, start_date, end_date, return_date, days, status, notes, is_demo)
select v.*, true from (values
    (1::bigint, 'employee', 'leave', 'أحمد محمد العتيبي', 'سنوية', '2026-05-15', '2026-05-20', '2026-05-21', 6, 'approved', 'إجازة سنوية معتمدة'),
    (2::bigint, 'employee', 'leave', 'سالم فهد الرشيدي' , 'مرضية', '2026-05-08', '2026-05-10', '2026-05-11', 3, 'approved', 'تقرير طبي مرفق'),
    (1::bigint, 'officer' , 'leave', 'ملازم / خالد سعد' , 'عرضية', '2026-05-25', '2026-05-25', '2026-05-26', 1, 'pending' , 'بانتظار موافقة الإدارة')
) as v(person_id, person_type, type, person_name, leave_type, start_date, end_date, return_date, days, status, notes)
where not exists (
    select 1 from public.leaves l
    where l.person_name = v.person_name and l.start_date = v.start_date and l.is_demo = true
);

insert into public.notifications (person_id, title, message, type, status, is_demo)
select v.*, true from (values
    ('all', 'مرحباً بمراجع تطبيق App Store', 'هذا حساب تجريبي معزول لمراجعة كل ميزات التطبيق.', 'message', 'info'),
    ('all', 'تذكير', 'يرجى مراجعة طلبات الإجازات المعلّقة في شاشة الإجازات.', 'message', 'warning')
) as v(person_id, title, message, type, status)
where not exists (select 1 from public.notifications n where n.title = v.title and n.is_demo = true);

alter table public.employees     enable trigger trg_set_is_demo_employees;
alter table public.officers      enable trigger trg_set_is_demo_officers;
alter table public.leaves        enable trigger trg_set_is_demo_leaves;
alter table public.notifications enable trigger trg_set_is_demo_notifications;

-- ─── 4. تحقق نهائي ────────────────────────────────────────────────────────
select a.id as account_id, a.username, a.role, a.is_demo,
       u.email, (u.email_confirmed_at is not null) as email_confirmed,
       u.raw_app_meta_data ->> 'role' as jwt_role,
       (u.raw_app_meta_data ->> 'is_demo')::boolean as jwt_is_demo
  from public.accounts a
  join auth.users u on u.id = a.auth_user_id
 where a.username = 'demo';

select 'employees'     as t, count(*) as demo_rows from public.employees     where is_demo = true
union all
select 'officers'      , count(*) from public.officers      where is_demo = true
union all
select 'leaves'        , count(*) from public.leaves        where is_demo = true
union all
select 'notifications' , count(*) from public.notifications where is_demo = true;
