-- Fix: SECURITY DEFINER functions can't see pgcrypto.digest because
-- pgcrypto extension lives in the `extensions` schema in Supabase,
-- not in `public`. Add `extensions` to search_path.

create or replace function public.fn_hash_password(p_password text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare s text;
begin
    s := encode(gen_random_bytes(16), 'hex');
    return 'v1$' || s || '$' || encode(digest(s || ':' || p_password, 'sha256'), 'hex');
end;
$$;

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
        if rec.password <> p_password then return; end if;
        update accounts set password = fn_hash_password(p_password) where id = rec.id;
    end if;

    return query select rec.id, rec.username, rec.role, rec.person_id;
end;
$$;
