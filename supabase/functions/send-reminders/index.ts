// Sends automatic email reminders for upcoming appointments. Invoked on a
// schedule by pg_cron (see supabase/migrations). Idempotent: each appointment
// gets at most one reminder, tracked via appointments.reminder_sent_at.
// Config: RESEND_API_KEY and FROM_EMAIL, read from function secrets or, as a
// fallback, from Supabase Vault via get_app_secret.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

async function getSecret(admin: SupabaseClient, name: string): Promise<string | null> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data } = await admin.rpc("get_app_secret", { secret_name: name });
  return (data as string | null) ?? null;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const resendKey = await getSecret(admin, "RESEND_API_KEY");
  const fromEmail = await getSecret(admin, "FROM_EMAIL");
  if (!resendKey || !fromEmail) {
    return json(200, { skipped: "RESEND_API_KEY / FROM_EMAIL not configured" });
  }

  const { data: settings } = await admin.from("clinic_settings").select("*").eq("id", 1).single();
  const reminderHours = settings?.reminder_hours ?? 24;
  const clinicName = settings?.clinic_name ?? "Our Office";
  const timezone = settings?.timezone ?? "America/New_York";

  const now = new Date();
  const cutoff = new Date(now.getTime() + reminderHours * 3600_000);

  const { data: due, error } = await admin
    .from("appointments")
    .select("*, providers(name)")
    .eq("status", "scheduled")
    .is("reminder_sent_at", null)
    .not("patient_email", "is", null)
    .gt("starts_at", now.toISOString())
    .lte("starts_at", cutoff.toISOString())
    .limit(50);
  if (error) return json(500, { error: error.message });

  let sent = 0;
  const failures: string[] = [];

  for (const appt of due ?? []) {
    const start = new Date(appt.starts_at);
    const when = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(start);
    const providerName = (appt.providers as { name?: string } | null)?.name;
    const firstName = (appt.patient_name as string).split(" ")[0];
    const subject = `Reminder: appointment on ${when}`;
    const body = `Hi ${firstName},\n\nThis is a friendly reminder of your appointment${
      providerName ? ` with ${providerName}` : ""
    } on ${when}.\n\nIf you need to reschedule, please call the office.\n\n— ${clinicName}`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromEmail, to: [appt.patient_email], subject, text: body }),
    });
    const ok = resp.ok;
    const detail = ok ? null : await resp.text();

    if (ok) {
      sent++;
      await admin
        .from("appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", appt.id);
    } else {
      failures.push(`${appt.id}: ${detail}`);
    }
    await admin.from("message_log").insert({
      appointment_id: appt.id,
      recipient: appt.patient_email,
      kind: "reminder",
      subject,
      body,
      status: ok ? "sent" : "failed",
      error: detail,
    });
  }

  return json(200, { sent, failed: failures.length, failures });
});
