// ═══════════════════════════════════════════════════════════
// leave-end-reminder
// تشغّل يومياً (cron) — ترسل تنبيهاً قبل يوم من تاريخ المباشرة
// (return_date إن وُجد، وإلا اليوم التالي بعد end_date).
// ═══════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadServiceAccount } from "../_shared/firebase-secret.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    "pkcs8", binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey,
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
  return tokenData.access_token;
}

// YYYY-MM-DD + n days
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // تاريخ "غداً" بتوقيت الكويت (UTC+3)
    const now = new Date();
    const kuwaitNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const today    = kuwaitNow.toISOString().split("T")[0];
    const tomorrow = addDays(today, 1);

    // الإجازات المعتمدة التي تنتهي اليوم (return_date = tomorrow)
    // أو إذا لم يكن return_date، نحسبها = end_date + 1
    const { data: leaves, error } = await supabase
      .from("leaves")
      .select("id, person_id, person_type, person_name, leave_type, start_date, end_date, return_date, status")
      .eq("status", "approved");

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    // فلترة: من سيباشر غداً
    const targets = (leaves || []).filter((l: any) => {
      const ret = l.return_date && l.return_date !== ""
        ? l.return_date
        : (l.end_date ? addDays(l.end_date, 1) : null);
      return ret === tomorrow;
    });

    if (targets.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0, reason: "no leaves ending tomorrow" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken();
    const projectId   = (await loadServiceAccount()).project_id;

    let sent = 0, failed = 0, persisted = 0;

    for (const lv of targets) {
      const title = "🔔 تذكير: مباشرة العمل غداً";
      const body  = `إجازتك (${lv.leave_type || "إجازة"}) تنتهي اليوم. يرجى المباشرة غداً ${tomorrow}.`;

      // 1) أنشئ إشعاراً داخل التطبيق
      try {
        await supabase.from("notifications").insert([{
          person_id: lv.person_id,
          title, message: body,
          type: "leave",
          status: "reminder",
          read: false,
        }]);
        persisted++;
      } catch (_) {}

      // 2) ابحث عن FCM token
      const { data: tokens } = await supabase
        .from("fcm_tokens")
        .select("token")
        .eq("person_id", lv.person_id);

      if (!tokens || tokens.length === 0) continue;

      for (const t of tokens) {
        try {
          const fcmPayload = {
            message: {
              token: t.token,
              notification: { title, body },
              apns: { payload: { aps: { sound: "default" } } },
              android: { priority: "high" },
            },
          };
          const res = await fetch(
            `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
              body: JSON.stringify(fcmPayload),
            },
          );
          if (res.ok) sent++; else failed++;
        } catch (_) { failed++; }
      }

      // 3) audit log
      try {
        await supabase.from("audit_log").insert([{
          actor: "system",
          actor_role: "cron",
          action: "leave_end_reminder",
          entity_type: "leave",
          entity_id: lv.id,
          person_id: lv.person_id,
          person_type: lv.person_type,
          details: { return_date: tomorrow, leave_type: lv.leave_type },
        }]);
      } catch (_) {}
    }

    return new Response(JSON.stringify({ success: true, candidates: targets.length, sent, failed, persisted }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
