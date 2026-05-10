// Provision Supabase Auth user from legacy account
// Verifies legacy credentials via rpc_login, then creates/updates auth.users
// with email = `${username}@alfarwania.app` and the same password,
// finally links accounts.auth_user_id.
//
// Called from the web app right after a successful legacy login when the
// JS client wants to obtain a real Supabase Auth JWT for that user.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_DOMAIN  = "alfarwania.app";

const cors = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });

function emailFor(username: string): string {
  // اسم المستخدم قد يحتوي رموزاً غير صالحة في الإيميل → ننظّفه
  const safe = username.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return `${safe}@${EMAIL_DOMAIN}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")     return json({ error: "method not allowed" }, 405);

  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return json({ error: "username and password required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) تحقق من بيانات الدخول القديمة عبر rpc_login
  const { data: loginRows, error: loginErr } = await admin.rpc("rpc_login", {
    p_username: username,
    p_password: password,
  });
  if (loginErr)                    return json({ error: "login check failed", details: loginErr.message }, 500);
  if (!loginRows || loginRows.length === 0) return json({ error: "invalid credentials" }, 401);

  const account = loginRows[0] as {
    id: number; username: string; role: string; person_id: number | null;
  };

  const email = emailFor(account.username);
  const appMeta = {
    role: account.role,
    account_id: account.id,
    person_id: account.person_id,
    username: account.username,
  };

  // 2) هل المستخدم موجود فعلاً في auth.users؟ نبحث بالإيميل
  let authUserId: string | null = null;
  {
    // listUsers ما عنده فلتر بالإيميل مباشر — نستخدم admin.getUserById بعد البحث في accounts
    const { data: existingAccount } = await admin
      .from("accounts")
      .select("auth_user_id")
      .eq("id", account.id)
      .single();
    if (existingAccount?.auth_user_id) authUserId = existingAccount.auth_user_id as string;
  }

  if (authUserId) {
    // موجود — حدّث كلمة المرور والميتاداتا فقط (يضمن تطابق كلمة السر بعد تغييرها من التطبيق)
    const { error: updErr } = await admin.auth.admin.updateUserById(authUserId, {
      password,
      app_metadata: appMeta,
      email_confirm: true,
    });
    if (updErr) return json({ error: "update auth user failed", details: updErr.message }, 500);
  } else {
    // غير موجود — أنشئه. قد يكون الإيميل موجود من محاولة سابقة لحساب آخر؛ نتعامل مع ذلك.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: appMeta,
    });
    if (createErr) {
      // إذا الإيميل مأخوذ، نحاول إيجاد المستخدم ونحدّثه
      const msg = createErr.message || "";
      if (/already (registered|been registered|exists)/i.test(msg)) {
        // نبحث في قائمة المستخدمين (الأولى عادةً كافية للمشاريع الصغيرة)
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const match = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (!match) return json({ error: "email taken but user not found" }, 500);
        const { error: updErr } = await admin.auth.admin.updateUserById(match.id, {
          password, app_metadata: appMeta, email_confirm: true,
        });
        if (updErr) return json({ error: "update existing user failed", details: updErr.message }, 500);
        authUserId = match.id;
      } else {
        return json({ error: "create auth user failed", details: msg }, 500);
      }
    } else {
      authUserId = created.user!.id;
    }

    // اربط الحساب
    const { error: linkErr } = await admin.rpc("rpc_link_auth_user", {
      p_account_id  : account.id,
      p_auth_user_id: authUserId,
    });
    if (linkErr) return json({ error: "link failed", details: linkErr.message }, 500);
  }

  return json({ ok: true, email, account_id: account.id, role: account.role });
});
