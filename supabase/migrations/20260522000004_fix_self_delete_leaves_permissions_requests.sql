-- Fix: employee/stats/officer cannot DELETE their own records
-- No DELETE policy existed for non-admin roles on these three tables

do $$
declare
    t text;
    tbls text[] := array['leaves','leave_permissions','other_requests'];
begin
    foreach t in array tbls loop
        if to_regclass('public.' || t) is null then continue; end if;

        execute format('drop policy if exists %I on public.%I',
            'pol_' || t || '_self_delete', t);

        execute format($f$
            create policy %I on public.%I
            for delete to authenticated
            using (
                (public.app_role() in ('employee','stats') and person_type = 'employee'
                 and person_id = public.app_person_id())
             or (public.app_role() = 'officer' and person_type = 'officer'
                 and person_id = public.app_person_id())
            )
        $f$, 'pol_' || t || '_self_delete', t);

    end loop;
end $$;
