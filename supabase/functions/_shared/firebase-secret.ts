// shared helper: load Firebase service account JSON
// 1) Vault (preferred): public.fn_get_secret('firebase_service_account')
// 2) Env fallback: FIREBASE_SERVICE_ACCOUNT
//
// نتيجة الاستدعاء مُخبَّأة لطول عمر العملية.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let _cached: any = null;

export async function loadServiceAccount(): Promise<any> {
    if (_cached) return _cached;

    // 1) حاول من Vault
    try {
        const url = Deno.env.get("SUPABASE_URL");
        const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (url && key) {
            const sb = createClient(url, key, {
                auth: { autoRefreshToken: false, persistSession: false },
            });
            const { data, error } = await sb.rpc("fn_get_secret", { p_name: "firebase_service_account" });
            if (!error && typeof data === "string" && data.length > 0) {
                _cached = JSON.parse(data);
                return _cached;
            }
        }
    } catch (_) { /* fall through to env */ }

    // 2) Fallback لقيمة env التقليدية
    const env = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
    if (!env) throw new Error("Firebase service account not configured (vault + env both missing)");
    _cached = JSON.parse(env);
    return _cached;
}
