-- ═══════════════════════════════════════════════════════════
-- Phase 5-F: upgrade password hashing to bcrypt
-- ═══════════════════════════════════════════════════════════
-- pgcrypto.crypt() with gen_salt('bf', 12) → bcrypt cost 12.
-- formats:
--   bc1$<bcrypt-hash>     ← new bcrypt
--   v1$<salt>$<sha256>    ← legacy sha256 (verified, then upgraded on login)
--   <plain>               ← very old (verified, then upgraded)
--
-- نُبقي fn_hash_password بنفس الاسم لتسهيل التوافق، لكن نُغيّر الناتج.

create or replace function public.fn_hash_password(p_password text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    return 'bc1$' || crypt(p_password, gen_salt('bf', 12));
end;
$$;

-- ═══════════════════════════════════════════════════════════
-- Phase 5-E: helper for audit logging from RPCs
-- ═══════════════════════════════════════════════════════════
create or replace function public.fn_audit_from_jwt(
    p_action      text,
    p_entity_type text,
    p_entity_id   bigint,
    p_details     jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    actor_un text := coalesce(auth.jwt() -> 'app_metadata' ->> 'username', '');
    actor_rl text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
begin
    insert into public.audit_log (actor, actor_role, action, entity_type, entity_id, details)
    values (actor_un, actor_rl, p_action, p_entity_type, p_entity_id, p_details);
end;
$$;
grant execute on function public.fn_audit_from_jwt(text, text, bigint, jsonb) to authenticated;

-- ═══════════════════════════════════════════════════════════
-- rpc_login: يدعم bcrypt + sha256 + plain (مع ترقية تلقائية)
-- ═══════════════════════════════════════════════════════════
create or replace function public.rpc_login(p_username text, p_password text)
returns table(id bigint, username text, role text, person_id bigint)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
    rec        record;
    parts      text[];
    salt       text;
    expected   text;
    actual_h   text;
    bc_hash    text;
    la         public.login_attempts%rowtype;
    now_ts     timestamptz := now();
    win        interval := interval '1 minute';
    lock_dur   interval := interval '5 minutes';
    max_try    int := 5;
    valid      boolean := false;
    needs_up   boolean := false;
begin
    select * into la from public.login_attempts where username = p_username;
    if found and la.locked_until is not null and la.locked_until > now_ts then
        return;
    end if;

    select a.id, a.username, a.role, a.person_id, a.password
      into rec
      from public.accounts a
     where a.username = p_username
     limit 1;

    if rec.id is not null then
        if rec.password like 'bc1$%' then
            bc_hash := substr(rec.password, 5);
            valid   := (crypt(p_password, bc_hash) = bc_hash);
        elsif rec.password like 'v1$%' then
            parts    := string_to_array(rec.password, '$');
            salt     := parts[2];
            expected := parts[3];
            actual_h := encode(digest(salt || ':' || p_password, 'sha256'), 'hex');
            valid    := (actual_h = expected);
            if valid then needs_up := true; end if;
        else
            valid := (rec.password = p_password);
            if valid then needs_up := true; end if;
        end if;

        if valid and needs_up then
            update public.accounts
               set password = public.fn_hash_password(p_password)
             where id = rec.id;
        end if;
    end if;

    if valid then
        delete from public.login_attempts where username = p_username;
        return query select rec.id, rec.username, rec.role, rec.person_id;
        return;
    end if;

    insert into public.login_attempts(username, attempts, window_started)
         values (p_username, 1, now_ts)
    on conflict (username) do update
        set attempts = case
                when public.login_attempts.window_started < now_ts - win then 1
                else public.login_attempts.attempts + 1
            end,
            window_started = case
                when public.login_attempts.window_started < now_ts - win then now_ts
                else public.login_attempts.window_started
            end,
            locked_until = case
                when (case when public.login_attempts.window_started < now_ts - win then 1
                           else public.login_attempts.attempts + 1 end) >= max_try
                then now_ts + lock_dur
                else null
            end;
    return;
end;
$$;
grant execute on function public.rpc_login(text, text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- rpc_change_password: bcrypt + يدعم legacy verify
-- ═══════════════════════════════════════════════════════════
create or replace function public.rpc_change_password(
    p_username     text,
    p_old_password text,
    p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
    rec     record;
    parts   text[];
    salt    text;
    expected text;
    actual_h text;
    bc_hash text;
    valid   boolean := false;
begin
    select id, password into rec from public.accounts where username = p_username limit 1;
    if rec.id is null then return false; end if;

    if rec.password like 'bc1$%' then
        bc_hash := substr(rec.password, 5);
        valid   := (crypt(p_old_password, bc_hash) = bc_hash);
    elsif rec.password like 'v1$%' then
        parts    := string_to_array(rec.password, '$');
        salt     := parts[2];
        expected := parts[3];
        actual_h := encode(digest(salt || ':' || p_old_password, 'sha256'), 'hex');
        valid    := (actual_h = expected);
    else
        valid := (rec.password = p_old_password);
    end if;

    if not valid then return false; end if;
    if length(p_new_password) < 6 then return false; end if;

    update public.accounts set password = public.fn_hash_password(p_new_password) where id = rec.id;
    perform public.fn_audit_from_jwt('change_password', 'account', rec.id, '{}'::jsonb);
    return true;
end;
$$;
grant execute on function public.rpc_change_password(text, text, text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- Phase 5-E: audit_log داخل rpc_add/update/delete_account
-- ═══════════════════════════════════════════════════════════
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
    if exists (select 1 from public.accounts where username = p_username) then
        raise exception 'username exists';
    end if;
    insert into public.accounts(username, password, role, person_id)
    values (p_username, public.fn_hash_password(p_password), p_role, p_person_id)
    returning id into new_id;

    perform public.fn_audit_from_jwt(
        'add_account', 'account', new_id,
        jsonb_build_object('username', p_username, 'role', p_role, 'person_id', p_person_id)
    );
    return new_id;
end;
$$;
grant execute on function public.rpc_add_account(text, text, text, bigint) to authenticated;

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
declare
    before_row record;
    pwd_changed boolean := false;
begin
    select id, username, role into before_row from public.accounts where id = p_id;
    if before_row.id is null then raise exception 'account not found'; end if;

    if exists (select 1 from public.accounts where username = p_username and id <> p_id) then
        raise exception 'username exists';
    end if;

    if p_password is not null and length(p_password) > 0 then
        update public.accounts
           set username = p_username,
               role     = p_role,
               password = public.fn_hash_password(p_password)
         where id = p_id;
        pwd_changed := true;
    else
        update public.accounts
           set username = p_username,
               role     = p_role
         where id = p_id;
    end if;

    perform public.fn_audit_from_jwt(
        'update_account', 'account', p_id,
        jsonb_build_object(
            'before',         jsonb_build_object('username', before_row.username, 'role', before_row.role),
            'after',          jsonb_build_object('username', p_username, 'role', p_role),
            'password_reset', pwd_changed
        )
    );
end;
$$;
grant execute on function public.rpc_update_account(bigint, text, text, text) to authenticated;

create or replace function public.rpc_delete_account(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare before_row record;
begin
    select id, username, role into before_row from public.accounts where id = p_id;
    if before_row.id is null then raise exception 'account not found'; end if;

    delete from public.accounts where id = p_id;
    perform public.fn_audit_from_jwt(
        'delete_account', 'account', p_id,
        jsonb_build_object('username', before_row.username, 'role', before_row.role)
    );
end;
$$;
grant execute on function public.rpc_delete_account(bigint) to authenticated;
