// Sends a one-off email to a patient on behalf of signed-in staff, via Resend.
// Required function secrets: RESEND_API_KEY, FROM_EMAIL (e.g. "Front Desk <office@yourdomain.com>").
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Only signed-in staff may send messages (the anon key alone is not enough).
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json(401, { error: "Not signed in" });

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL");
  if (!resendKey || !fromEmail) {
    return json(503, {
      error:
        "Email service not configured. Set the RESEND_API_KEY and FROM_EMAIL secrets on the Supabase project (see README).",
    });
  }

  let payload: { appointment_id?: string; to?: string; subject?: string; body?: string; kind?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const { appointment_id, to, subject, body, kind } = payload;
  if (!to || !subject || !body) return json(400, { error: "Missing to/subject/body" });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, text: body }),
  });
  const ok = resp.ok;
  const detail = ok ? null : await resp.text();

  const admin = createClient(supabaseUrl, serviceKey);
  await admin.from("message_log").insert({
    appointment_id: appointment_id ?? null,
    recipient: to,
    kind: kind ?? "custom",
    subject,
    body,
    status: ok ? "sent" : "failed",
    error: detail,
  });

  if (!ok) return json(502, { error: `Email provider error: ${detail}` });
  return json(200, { sent: true });
});
