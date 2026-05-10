-- ─────────────────────────────────────────────────────────────
-- fix #2: still ambiguous due to RETURNS TABLE(username) clash
-- with login_attempts.username. Use #variable_conflict.
-- ─────────────────────────────────────────────────────────────
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
    la         public.login_attempts%rowtype;
    now_ts     timestamptz := now();
    win        interval := interval '1 minute';
    lock_dur   interval := interval '5 minutes';
    max_try    int := 5;
    valid      boolean := false;
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
        if rec.password like 'v1$%' then
            parts    := string_to_array(rec.password, '$');
            salt     := parts[2];
            expected := parts[3];
            actual_h := encode(digest(salt || ':' || p_password, 'sha256'), 'hex');
            valid    := (actual_h = expected);
        else
            valid := (rec.password = p_password);
            if valid then
                update public.accounts set password = public.fn_hash_password(p_password) where id = rec.id;
            end if;
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
