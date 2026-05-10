import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function getAccessToken(): Promise<string> {
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
  return tokenData.access_token;
}

serve(async (_req) => {
  try {
    const accessToken = await getAccessToken();
    const projectId   = SERVICE_ACCOUNT.project_id;
    const supabase    = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const now    = new Date();
    const hour   = now.getUTCHours();
    const minute = now.getUTCMinutes();

    // تاريخ اليوم بتوقيت الكويت (UTC+3)
    const kuwaitNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const todayStr  = kuwaitNow.toISOString().split("T")[0]; // YYYY-MM-DD

    // الكويت UTC+3 → 9:45 = 6:45 UTC, 10:15 = 7:15 UTC
    const is945  = hour === 6 && minute >= 43 && minute <= 47;
    const is1015 = hour === 7 && minute >= 13 && minute <= 17;

    let body = "";
    if (is945) {
      body = "⏰ تذكير الساعة 9:45 — يرجى تسجيل بصمة التواجد الصباحية";
    } else if (is1015) {
      body = "⏰ تذكير الساعة 10:15 — آخر فرصة لتسجيل بصمة التواجد";
    } else {
      body = "⏰ تذكير — يرجى تسجيل بصمة التواجد";
    }

    // جلب الموظفين والضباط اللي عندهم إجازة معتمدة اليوم
    const { data: onLeave } = await supabase
      .from("leaves")
      .select("person_id")
      .eq("status", "approved")
      .lte("start_date", todayStr)
      .gte("end_date", todayStr);

    const onLeaveIds = new Set((onLeave || []).map((l: any) => String(l.person_id)));

    // جلب كل FCM tokens
    const { data: tokens } = await supabase
      .from("fcm_tokens")
      .select("token, person_id, role");

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0, reason: "no tokens" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // إرسال لكل شخص ما عنده إجازة اليوم
    let sent = 0;
    let skipped = 0;
    for (const row of tokens) {
      // admin دائماً يستلم
      if (row.role !== "admin" && row.person_id && onLeaveIds.has(String(row.person_id))) {
        skipped++;
        continue;
      }

      const fcmPayload = {
        message: {
          token       : row.token,
          notification: { title: "تذكير بصمة التواجد", body },
          apns        : { payload: { aps: { sound: "default" } } },
          android     : { priority: "high" },
        },
      };

      await fetch(
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
      sent++;
    }

    return new Response(JSON.stringify({ success: true, sent, skipped }), {
      status : 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
