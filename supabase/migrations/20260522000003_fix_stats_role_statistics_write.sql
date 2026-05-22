-- Fix: stats role cannot INSERT/UPDATE statistics table
-- pol_statistics_admin_write only allowed app_role() = 'admin', blocking stats role

drop policy if exists pol_statistics_admin_write on public.statistics;

create policy pol_statistics_admin_write
on public.statistics
for all
to authenticated
using   (public.app_role() in ('admin', 'stats'))
with check (public.app_role() in ('admin', 'stats'));
