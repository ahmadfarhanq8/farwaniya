-- ═══════════════════════════════════════════════════════════════════════════
-- Demo Data Isolation
-- ─────────────────────────────────────────────────────────────────────────
-- يمنع حساب الـ demo (المخصص لمراجعة App Store) من رؤية البيانات الحقيقية،
-- ويمنع المستخدمين الحقيقيين من رؤية البيانات التجريبية.
--
-- الآلية:
--   • عمود is_demo boolean على كل الجداول الحساسة (افتراضي false).
--   • helper:  public.is_demo_user()  يقرأ JWT.app_metadata.is_demo
--   • RESTRICTIVE RLS policy على كل جدول:
--       is_demo = is_demo_user()
--     → السياسات الموجودة مسبقاً تبقى كما هي، وتُضاف إليها هذه طبقة عزل.
--   • BEFORE INSERT trigger يضبط is_demo تلقائياً حسب المستخدم.
--   • rpc_list_accounts يفلتر حسب is_demo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. helper: هل المستخدم الحالي حساب ديمو؟ ─────────────────────────────
create or replace function public.is_demo_user()
returns boolean
language sql
stable
as $$
    select coalesce(
        (auth.jwt() -> 'app_metadata' ->> 'is_demo')::boolean,
        false
    );
$$;

grant execute on function public.is_demo_user() to anon, authenticated;

-- ─── 2. أضِف is_demo + restrictive policy + insert trigger لكل جدول ─────────
do $$
declare
    t    text;
    tbls text[] := array[
        'employees','officers','leaves','notes','statistics',
        'employee_files','officer_files','leave_permissions',
        'custom_archive_types','notifications',
        'other_requests','admin_notifications_store','accounts'
    ];
    fn_name  text;
    trg_name text;
    pol_name text;
    idx_name text;
begin
    foreach t in array tbls loop
        if to_regclass('public.' || t) is null then continue; end if;

        -- 2a) عمود is_demo
        execute format(
            'alter table public.%I add column if not exists is_demo boolean not null default false',
            t
        );

        idx_name := 'idx_' || t || '_is_demo';
        execute format(
            'create index if not exists %I on public.%I(is_demo)',
            idx_name, t
        );

        -- 2b) restrictive policy للعزل
        pol_name := 'pol_' || t || '_demo_isolation';
        execute format('drop policy if exists %I on public.%I', pol_name, t);
        execute format(
            'create policy %I on public.%I as restrictive for all to authenticated '
            || 'using (is_demo = public.is_demo_user()) '
            || 'with check (is_demo = public.is_demo_user())',
            pol_name, t
        );

        -- 2c) trigger يضبط is_demo تلقائياً عند الإدخال
        fn_name  := 'fn_set_is_demo_' || t;
        trg_name := 'trg_set_is_demo_' || t;

        execute format($f$
            create or replace function public.%I()
            returns trigger
            language plpgsql
            security definer
            set search_path = public
            as $body$
            begin
                new.is_demo := coalesce(public.is_demo_user(), false);
                return new;
            end;
            $body$
        $f$, fn_name);

        execute format('drop trigger if exists %I on public.%I', trg_name, t);
        execute format(
            'create trigger %I before insert on public.%I '
            || 'for each row execute function public.%I()',
            trg_name, t, fn_name
        );
    end loop;
end $$;

-- ─── 3. حدّث rpc_list_accounts ليفلتر حسب is_demo ─────────────────────────
create or replace function public.rpc_list_accounts()
returns table(id bigint, username text, role text, person_id bigint, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
    select a.id, a.username, a.role, a.person_id, a.created_at
      from public.accounts a
     where a.is_demo = public.is_demo_user()
     order by a.id;
$$;

grant execute on function public.rpc_list_accounts() to anon, authenticated;

-- ─── 4. حدّث rpc_me ليُرجع فقط الحساب المطابق للمستخدم الحالي ──────────────
-- (بدون تغيير سلوك، فقط للتأكد أن الجوين على auth.uid() يبقى يعمل)
-- لا حاجة لتعديل — rpc_me يستخدم auth.uid() المباشرة، والـ trigger
-- ضمن أن حساب الديمو نفسه له is_demo=true.

-- ─── 5. تأكد أن service_role يتجاوز كل الـ RLS (سلوك افتراضي لكن للتوثيق) ──
-- service_role يتجاوز الـ policies تلقائياً، لذا Edge Functions تعمل بدون
-- مشاكل سواء على بيانات حقيقية أو ديمو.
