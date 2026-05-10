-- ═══════════════════════════════════════════════════════════
-- Phase 5-C: Firebase service account moved to Supabase Vault
-- ═══════════════════════════════════════════════════════════
-- بعد تطبيق هذه الـ migration، نفّذ من Dashboard → SQL Editor:
--
--   select vault.create_secret(
--     '<paste FIREBASE_SERVICE_ACCOUNT JSON here>',
--     'firebase_service_account',
--     'Firebase Cloud Messaging service account JSON'
--   );
--
-- بعدها يمكن حذف FIREBASE_SERVICE_ACCOUNT من Edge Function secrets.

-- helper: قراءة سر من vault — مقيّدة لـ service_role فقط
create or replace function public.fn_get_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare s text;
begin
    select decrypted_secret into s
      from vault.decrypted_secrets
     where name = p_name
     limit 1;
    return s;
end;
$$;

revoke all on function public.fn_get_secret(text) from anon, authenticated, public;
grant execute on function public.fn_get_secret(text) to service_role;
