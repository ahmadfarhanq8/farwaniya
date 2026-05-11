-- Allow service_role to invoke helpers used by bulk-provision-accounts EF.
grant execute on function public.fn_hash_password(text)                 to service_role;
grant execute on function public.rpc_link_auth_user(bigint, uuid)       to service_role;
