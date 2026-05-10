-- ═══════════════════════════════════════════════════════════
-- Auth Bridge (Phase 2): link legacy accounts to auth.users
-- ═══════════════════════════════════════════════════════════
-- يضيف عمود auth_user_id لربط حساب التطبيق بمستخدم في auth.users
-- ويُضيف RPCs مساعدة للجسر بين النظامين.

-- ─── الربط بين accounts و auth.users ───
alter table public.accounts
    add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists accounts_auth_user_id_idx on public.accounts(auth_user_id);

-- ─── إرجاع الحساب المرتبط بـ auth.uid() الحالي ───
create or replace function public.rpc_me()
returns table(id bigint, username text, role text, person_id bigint, auth_user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
        select a.id, a.username, a.role, a.person_id, a.auth_user_id
        from public.accounts a
        where a.auth_user_id = auth.uid();
end;
$$;

-- ─── ربط حساب بـ auth_user_id (يُستدعى من Edge Function بصلاحية service_role) ───
create or replace function public.rpc_link_auth_user(p_account_id bigint, p_auth_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.accounts
       set auth_user_id = p_auth_user_id
     where id = p_account_id;
end;
$$;

-- ─── إيجاد حساب بالـ username (يُستدعى من Edge Function) ───
create or replace function public.rpc_find_by_username(p_username text)
returns table(id bigint, username text, role text, person_id bigint, auth_user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
        select a.id, a.username, a.role, a.person_id, a.auth_user_id
        from public.accounts a
        where a.username = p_username
        limit 1;
end;
$$;

-- صلاحيات التنفيذ
grant execute on function public.rpc_me() to anon, authenticated;
grant execute on function public.rpc_link_auth_user(bigint, uuid) to service_role;
grant execute on function public.rpc_find_by_username(text) to service_role;
revoke execute on function public.rpc_link_auth_user(bigint, uuid) from anon, authenticated;
revoke execute on function public.rpc_find_by_username(text) from anon, authenticated;
