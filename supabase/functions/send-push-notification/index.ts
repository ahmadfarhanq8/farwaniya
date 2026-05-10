import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadServiceAccount } from "../_shared/firebase-secret.ts";

const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ─── FCM v1 HTTP API: توليد Access Token عبر Service Account JWT ────────────
async function getAccessToken(): Promise<string> {
  const SERVICE_ACCOUNT = await loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss  : SERVICE_ACCOUNT.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud  : "https://oauth2.googleapis.com/token",
    exp  : now + 3600,
    iat  : now,
  };

  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const pemContents = SERVICE_ACCOUNT.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method : "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body   : `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`FCM token exchange failed: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

// ─── إرسال رسالة FCM v1 لـ token واحد ──────────────────────────────────────
async function sendToToken(
  accessToken: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
  badge: number = 1,
): Promise<{ token: string; success: boolean; error?: string }> {
  const fcmPayload = {
    message: {
      token,
      notification: { title, body },
      apns: {
        headers: { "apns-priority": "10", "apns-push-type": "alert" },
        payload: { aps: { sound: "default", badge, "mutable-content": 1 } },
      },
      android: { priority: "high" },
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization : `Bearer ${accessToken}`,
      },
      body: JSON.stringify(fcmPayload),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    return { token, success: false, error: JSON.stringify(data) };
  }
  return { token, success: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  try {
    const { title, body, role, person_id } = await req.json();

    if (!title || !body || (!role && !person_id)) {
      return new Response(JSON.stringify({ error: "Missing fields: title, body, and role or person_id" }), {
        status : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // جلب FCM tokens من Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let query = supabase.from("fcm_tokens").select("token, person_id");
    if (person_id) {
      query = query.eq("person_id", String(person_id));
    } else {
      query = query.eq("role", role);
    }
    const { data: tokenRows, error } = await query;

    if (error || !tokenRows || tokenRows.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: "no_tokens" }), {
        status : 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken();
    const projectId   = (await loadServiceAccount()).project_id;

    // حساب عدد الإشعارات غير المقروءة (badge count)
    async function getBadgeCountForPerson(pid: string): Promise<number> {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("person_id", String(pid))
        .not("read_by", "cs", `["${pid}"]`);
      return Math.max(count ?? 0, 1);
    }

    async function getBadgeCountForAdmin(): Promise<number> {
      const month = new Date().toISOString().slice(0, 7);
      const { data } = await supabase
        .from("admin_notifications_store")
        .select("data")
        .eq("month", month)
        .maybeSingle();
      const arr = (data && data.data) || [];
      const unread = arr.filter((n: { read?: boolean }) => !n.read).length;
      return Math.max(unread, 1);
    }

    // إرسال لكل token بشكل متوازٍ مع badge صحيح
    const results = await Promise.all(
      tokenRows.map(async (r: { token: string; person_id: string | null }) => {
        const badge = r.person_id
          ? await getBadgeCountForPerson(r.person_id)
          : await getBadgeCountForAdmin();
        return sendToToken(accessToken, projectId, r.token, title, body, badge);
      }),
    );

    const succeeded = results.filter((r) => r.success).length;
    const failed    = results.filter((r) => !r.success);

    return new Response(
      JSON.stringify({ sent: succeeded, failed: failed.length, details: failed }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status : 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
