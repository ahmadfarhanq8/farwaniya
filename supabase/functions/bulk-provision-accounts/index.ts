// One-shot admin tool: bulk-provision every account that still has no auth_user_id.
// Generates a random 12-char password for each, creates the auth.users record,
// updates accounts.password (bcrypt via fn_hash_password) so legacy rpc_login
// keeps working, and links accounts.auth_user_id.
//
// Requires the caller to be authenticated AND app_metadata.role = 'admin'.
//
// Returns: { provisioned: [{username, role, email, temp_password}], skipped: [...] }

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
function randomPassword(): string {
  // 12-char: upper + lower + digits + symbol (no ambiguous chars)
  const sets = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghjkmnpqrstuvwxyz",
    "23456789",
    "!@#$%^&*",
  ];
  const all = sets.join("");
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // ensure at least one of each set
  const pwd: string[] = sets.map((s, i) => s[bytes[i] % s.length]);
  for (let i = 4; i < 12; i++) pwd.push(all[bytes[i] % all.length]);
  // shuffle
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1);
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")     return json({ error: "method not allowed" }, 405);

  // ───────── verify caller is admin via their JWT ─────────
  const authz = req.headers.get("authorization") || "";
  const callerJwt = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!callerJwt) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
    auth  : { persistSession: false, autoRefreshToken: false },
  });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: "invalid jwt", details: uerr?.message }, 401);
  const role = (ures.user.app_metadata as any)?.role;
  if (role !== "admin") return json({ error: "admin only" }, 403);

  // ───────── work as service_role ─────────
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error: listErr } = await admin
    .from("accounts")
    .select("id, username, role, person_id, auth_user_id")
    .is("auth_user_id", null);
  if (listErr) return json({ error: "list failed", details: listErr.message }, 500);

  const provisioned: Array<{ id: number; username: string; role: string; email: string; temp_password: string }> = [];
  const skipped:     Array<{ username: string; reason: string }> = [];

  for (const acc of rows ?? []) {
    const username = acc.username as string;
    const email    = emailFor(username);
    const tempPwd  = randomPassword();
    const appMeta  = {
      role      : acc.role,
      account_id: acc.id,
      person_id : acc.person_id,
      username  : username,
    };

    // 1) check whether an auth.users with that email already exists
    let authId: string | null = null;
    try {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const match = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (match) authId = match.id;
    } catch { /* ignore */ }

    if (authId) {
      const { error: updErr } = await admin.auth.admin.updateUserById(authId, {
        password: tempPwd, email_confirm: true, app_metadata: appMeta,
      });
      if (updErr) { skipped.push({ username, reason: "update_user: " + updErr.message }); continue; }
    } else {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password: tempPwd, email_confirm: true, app_metadata: appMeta,
      });
      if (cErr || !created?.user) { skipped.push({ username, reason: "create_user: " + (cErr?.message || "no user") }); continue; }
      authId = created.user.id;
    }

    // 2) hash the temp password (bcrypt) and update legacy accounts.password
    //    so old code paths keep working until rpc_login is dropped.
    const { data: hashed, error: hashErr } = await admin.rpc("fn_hash_password", { p_password: tempPwd });
    if (hashErr || typeof hashed !== "string") {
      skipped.push({ username, reason: "hash: " + (hashErr?.message || "no hash") }); continue;
    }
    const { error: updErr2 } = await admin.from("accounts").update({ password: hashed }).eq("id", acc.id);
    if (updErr2) { skipped.push({ username, reason: "update password: " + updErr2.message }); continue; }

    // 3) link auth_user_id
    const { error: linkErr } = await admin.rpc("rpc_link_auth_user", {
      p_account_id: acc.id, p_auth_user_id: authId,
    });
    if (linkErr) { skipped.push({ username, reason: "link: " + linkErr.message }); continue; }

    provisioned.push({
      id: acc.id, username, role: acc.role as string, email, temp_password: tempPwd,
    });
  }

  return json({ provisioned_count: provisioned.length, skipped_count: skipped.length, provisioned, skipped });
});
