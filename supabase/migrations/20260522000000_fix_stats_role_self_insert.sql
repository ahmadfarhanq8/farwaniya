-- Fix: allow stats role to insert/update their own leave/permission/request records.
-- stats users are linked to an employee via person_id and share the employee dashboard,
-- so they must be able to submit requests just like employee role.

do $$
declare
    t text;
    tbls text[] := array['leaves','leave_permissions','other_requests'];
begin
    foreach t in array tbls loop
        if to_regclass('public.' || t) is null then continue; end if;

        -- self insert: add 'stats' alongside 'employee'
        execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_self_insert', t);
        execute format($f$
            create policy %I on public.%I
            for insert to authenticated
            with check (
                (public.app_role() in ('employee','stats') and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer' and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
        $f$, 'pol_' || t || '_self_insert', t);

        -- self update: add 'stats' alongside 'employee'
        execute format('drop policy if exists %I on public.%I', 'pol_' || t || '_self_update', t);
        execute format($f$
            create policy %I on public.%I
            for update to authenticated
            using (
                (public.app_role() in ('employee','stats') and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer' and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
            with check (
                (public.app_role() in ('employee','stats') and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer' and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
        $f$, 'pol_' || t || '_self_update', t);
    end loop;
end $$;
