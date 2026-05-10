-- ─────────────────────────────────────────────────────────────
-- adjust notifications: allow any authenticated to update
-- (mark-as-read sets the read_by array — must work for all roles)
-- ─────────────────────────────────────────────────────────────
drop policy if exists pol_notifications_admin_write on public.notifications;

create policy pol_notifications_update on public.notifications
    for update to authenticated using (true) with check (true);

create policy pol_notifications_admin_modify on public.notifications
    for insert to authenticated
    with check (public.app_role() = 'admin');

create policy pol_notifications_admin_delete on public.notifications
    for delete to authenticated
    using (public.app_role() = 'admin');
