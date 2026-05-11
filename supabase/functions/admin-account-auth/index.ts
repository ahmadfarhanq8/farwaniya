// Admin-only EF: manage Supabase Auth side of an account.
// Actions:
//   set_password  → create/update auth.users for the given account_id and password,
//                   then link via rpc_link_auth_user. Used right after rpc_add_account,
//                   and also for admin password resets.
//   delete        → delete the auth.users row associated with account_id.
//
// Body: { action: 'set_password', account_id: number, password: string }
//       { action: 'delete',       account_id: number }
//
// Caller must be authenticated and have app_metadata.role === 'admin'.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const EMAIL_DOMAIN = "alfarwania.app";

const cors = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors } });

function emailFor(u: string) {
  return `${u.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_")}@${EMAIL_DOMAIN}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")     return json({ error: "method not allowed" }, 405);

  // verify admin caller
  const authz = req.headers.get("authorization") || "";
  const callerJwt = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!callerJwt) return json({ error: "unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
    auth  : { persistSession: false, autoRefreshToken: false },
  });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: "invalid jwt" }, 401);
  if ((ures.user.app_metadata as any)?.role !== "admin") return json({ error: "admin only" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(body?.action || "");
  const accountId = Number(body?.account_id);
  if (!Number.isFinite(accountId) || accountId <= 0) return json({ error: "account_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: acc, error: accErr } = await admin
    .from("accounts")
    .select("id, username, role, person_id, auth_user_id")
    .eq("id", accountId)
    .maybeSingle();
  if (accErr) return json({ error: "lookup failed", details: accErr.message }, 500);
  if (!acc)   return json({ error: "account not found" }, 404);

  const email = emailFor(acc.username);
  const appMeta = {
    role      : acc.role,
    account_id: acc.id,
    person_id : acc.person_id,
    username  : acc.username,
  };

  if (action === "set_password") {
    const password = String(body?.password || "");
    if (password.length < 6) return json({ error: "password too short" }, 400);

    let authId: string | null = acc.auth_user_id ?? null;

    if (!authId) {
      // maybe exists by email
      try {
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const match = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (match) authId = match.id;
      } catch { /* ignore */ }
    }

    if (authId) {
      const { error: upErr } = await admin.auth.admin.updateUserById(authId, {
        password, email_confirm: true, app_metadata: appMeta,
      });
      if (upErr) return json({ error: "update auth user", details: upErr.message }, 500);
    } else {
      const { data: c, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, app_metadata: appMeta,
      });
      if (cErr || !c?.user) return json({ error: "create auth user", details: cErr?.message }, 500);
      authId = c.user.id;
    }

    if (acc.auth_user_id !== authId) {
      const { error: linkErr } = await admin.rpc("rpc_link_auth_user", {
        p_account_id: acc.id, p_auth_user_id: authId,
      });
      if (linkErr) return json({ error: "link failed", details: linkErr.message }, 500);
    }
    return json({ ok: true, auth_user_id: authId });
  }

  if (action === "delete") {
    if (acc.auth_user_id) {
      const { error: dErr } = await admin.auth.admin.deleteUser(acc.auth_user_id);
      if (dErr) return json({ error: "delete auth user", details: dErr.message }, 500);
    }
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
