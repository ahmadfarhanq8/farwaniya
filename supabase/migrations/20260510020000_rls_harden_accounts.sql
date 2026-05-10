-- ═══════════════════════════════════════════════════════════
-- RLS Hardening (Phase 1): protect accounts table
-- ═══════════════════════════════════════════════════════════
-- المشكلة: anon key يقدر يقرأ كل صفوف accounts بما فيها password
-- (حتى لو مُشفّرة، فإن كشفها يسمح بهجمات brute-force / rainbow).
--
-- الحل: SECURITY DEFINER RPC functions تتعامل مع الجدول بدلاً
-- من الوصول المباشر، ثم سحب الصلاحيات عن anon.

create extension if not exists pgcrypto;

-- ─── helper: تشفير كلمة المرور بصيغة v1$salt$sha256(salt:password) ───
create or replace function public.fn_hash_password(p_password text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare s text;
begin
    s := encode(gen_random_bytes(16), 'hex');
    return 'v1$' || s || '$' || encode(digest(s || ':' || p_password, 'sha256'), 'hex');
end;
$$;

-- ─── rpc_login: تحقّق من كلمة المرور وأرجع بيانات الحساب (بدون الـ password) ───
create or replace function public.rpc_login(p_username text, p_password text)
returns table(id bigint, username text, role text, person_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
    rec        record;
    parts      text[];
    salt       text;
    expected   text;
    actual_h   text;
begin
    select a.id, a.username, a.role, a.person_id, a.password
      into rec
      from accounts a
     where a.username = p_username
     limit 1;

    if not found then return; end if;

    if rec.password like 'v1$%' then
        parts    := string_to_array(rec.password, '$');
        salt     := parts[2];
        expected := parts[3];
        actual_h := encode(digest(salt || ':' || p_password, 'sha256'), 'hex');
        if actual_h <> expected then return; end if;
    else
        -- توافق رجعي مع كلمات سر قديمة (plain-text)
        if rec.password <> p_password then return; end if;
        -- ترقية تلقائية لصيغة v1
        update accounts set password = fn_hash_password(p_password) where id = rec.id;
    end if;

    return query select rec.id, rec.username, rec.role, rec.person_id;
end;
$$;

-- ─── rpc_list_accounts: قائمة الحسابات بدون password ───
create or replace function public.rpc_list_accounts()
returns table(id bigint, username text, role text, person_id bigint, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
    select id, username, role, person_id, created_at from accounts order by id;
$$;

-- ─── rpc_add_account ───
create or replace function public.rpc_add_account(
    p_username  text,
    p_password  text,
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
    if p_password is null or length(p_password) < 1 then
        raise exception 'password required';
    end if;
    if exists (select 1 from accounts where username = p_username) then
        raise exception 'username exists';
    end if;
    insert into accounts(username, password, role, person_id)
    values (p_username, fn_hash_password(p_password), p_role, p_person_id)
    returning id into new_id;
    return new_id;
end;
$$;

-- ─── rpc_update_account ───
create or replace function public.rpc_update_account(
    p_id       bigint,
    p_username text,
    p_role     text,
    p_password text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if exists (select 1 from accounts where username = p_username and id <> p_id) then
        raise exception 'username exists';
    end if;
    if p_password is not null and length(p_password) > 0 then
        update accounts set username = p_username, role = p_role, password = fn_hash_password(p_password) where id = p_id;
    else
        update accounts set username = p_username, role = p_role where id = p_id;
    end if;
end;
$$;

-- ─── rpc_delete_account ───
create or replace function public.rpc_delete_account(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    delete from accounts where id = p_id;
end;
$$;

-- ─── rpc_change_password (بدون admin) ───
create or replace function public.rpc_change_password(
    p_username     text,
    p_old_password text,
    p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare rec record;
begin
    if exists (select 1 from rpc_login(p_username, p_old_password)) then
        select id into rec from accounts where username = p_username limit 1;
        update accounts set password = fn_hash_password(p_new_password) where id = rec.id;
        return true;
    end if;
    return false;
end;
$$;

-- ═══════════════════════════════════════════════════════════
-- صلاحيات
-- ═══════════════════════════════════════════════════════════
revoke all on function public.fn_hash_password(text)                          from public;

grant execute on function public.rpc_login(text, text)                                    to anon, authenticated;
grant execute on function public.rpc_list_accounts()                                       to anon, authenticated;
grant execute on function public.rpc_add_account(text, text, text, bigint)                 to anon, authenticated;
grant execute on function public.rpc_update_account(bigint, text, text, text)              to anon, authenticated;
grant execute on function public.rpc_delete_account(bigint)                                to anon, authenticated;
grant execute on function public.rpc_change_password(text, text, text)                     to anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- إقفال جدول accounts عن الوصول المباشر
-- ═══════════════════════════════════════════════════════════
-- نُبقي RLS مفعّلاً لكن نلغي صلاحيات الجدول للـ anon/authenticated
-- بحيث لا يمكن قراءة/كتابة accounts إلا عبر RPCs أعلاه.
revoke select, insert, update, delete on public.accounts from anon, authenticated;

-- service_role يبقى كامل الصلاحيات (للـ edge functions / admin tools)
grant select, insert, update, delete on public.accounts to service_role;
