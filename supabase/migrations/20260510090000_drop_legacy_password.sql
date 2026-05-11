-- ═══════════════════════════════════════════════════════════
-- Phase 5-B: تقاعد المسار القديم لكلمة المرور
-- ═══════════════════════════════════════════════════════════
-- نُلغي:
--   • public.accounts.password
--   • rpc_login / rpc_change_password / fn_hash_password
-- ونعيد كتابة rpc_add_account / rpc_update_account بدون p_password
-- (إدارة كلمة المرور تتم الآن حصراً عبر Edge Function admin-account-auth
--  التي تستخدم Supabase Auth Admin API).
-- ═══════════════════════════════════════════════════════════

-- 1) تحقُّق احتياطي: لا يوجد حساب بدون auth_user_id
do $$
declare missing int;
begin
    select count(*) into missing from public.accounts where auth_user_id is null;
    if missing > 0 then
        raise exception
          'Refusing to drop password column: % accounts still have auth_user_id NULL', missing;
    end if;
end$$;

-- 2) أعد كتابة rpc_add_account بإسقاط p_password
drop function if exists public.rpc_add_account(text, text, text, bigint);

create or replace function public.rpc_add_account(
    p_username  text,
    p_role      text,
    p_person_id bigint default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare new_id bigint;
begin
    if p_username is null or length(btrim(p_username)) = 0 then
        raise exception 'username required';
    end if;
    if exists (select 1 from public.accounts where username = p_username) then
        raise exception 'username exists';
    end if;
    insert into public.accounts(username, role, person_id)
    values (p_username, p_role, p_person_id)
    returning id into new_id;

    perform public.fn_audit_from_jwt(
        'add_account', 'account', new_id,
        jsonb_build_object('username', p_username, 'role', p_role, 'person_id', p_person_id)
    );
    return new_id;
end;
$$;
grant execute on function public.rpc_add_account(text, text, bigint) to authenticated;

-- 3) أعد كتابة rpc_update_account بإسقاط p_password
drop function if exists public.rpc_update_account(bigint, text, text, text);

create or replace function public.rpc_update_account(
    p_id       bigint,
    p_username text,
    p_role     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare before_row record;
begin
    select id, username, role into before_row from public.accounts where id = p_id;
    if before_row.id is null then raise exception 'account not found'; end if;

    if exists (select 1 from public.accounts where username = p_username and id <> p_id) then
        raise exception 'username exists';
    end if;

    update public.accounts
       set username = p_username,
           role     = p_role
     where id = p_id;

    perform public.fn_audit_from_jwt(
        'update_account', 'account', p_id,
        jsonb_build_object(
            'before', jsonb_build_object('username', before_row.username, 'role', before_row.role),
            'after',  jsonb_build_object('username', p_username,         'role', p_role)
        )
    );
end;
$$;
grant execute on function public.rpc_update_account(bigint, text, text) to authenticated;

-- 4) أسقط الدوال القديمة
drop function if exists public.rpc_login(text, text);
drop function if exists public.rpc_change_password(text, text, text);
drop function if exists public.fn_hash_password(text);

-- 5) أخيراً، أسقط عمود password
alter table public.accounts drop column if exists password;
