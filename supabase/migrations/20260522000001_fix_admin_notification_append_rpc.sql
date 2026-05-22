-- Fix: non-admin users (employee/stats/officer) cannot UPSERT admin_notifications_store
-- because UPSERT needs UPDATE permission which is admin-only.
-- Solution: SECURITY DEFINER function that any authenticated user can call to safely
-- prepend a single notification to the current month's array.

create or replace function public.rpc_append_admin_notification(p_notif jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_month text := to_char(now(), 'YYYY-MM');
begin
    insert into public.admin_notifications_store (month, data)
    values (v_month, jsonb_build_array(p_notif))
    on conflict (month) do update
        set data = jsonb_build_array(p_notif) || admin_notifications_store.data;
end;
$$;

grant execute on function public.rpc_append_admin_notification(jsonb) to authenticated;
