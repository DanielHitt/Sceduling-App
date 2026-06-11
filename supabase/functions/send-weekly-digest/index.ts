// Weekly appointment digest: one email per patient, Monday at 8 AM clinic time,
// listing all of their appointments in the coming week. pg_cron invokes this
// hourly on Mondays; it no-ops except at 8 AM local. Appointments covered by a
// digest are marked reminder_sent_at so the daily reminder doesn't also fire —
// patients get ONE reminder per week (anything booked after Monday still gets
// the regular 24h reminder).
// Config: RESEND_API_KEY, FROM_EMAIL (secrets or Vault). Optional: REPLY_TO_EMAIL.
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
  const replyTo = await getSecret(admin, "REPLY_TO_EMAIL");
  if (!resendKey || !fromEmail) {
    return json(200, { skipped: "RESEND_API_KEY / FROM_EMAIL not configured" });
  }

  const { data: settings } = await admin.from("clinic_settings").select("*").eq("id", 1).single();
  const clinicName = settings?.clinic_name ?? "Our Office";
  const timezone = settings?.timezone ?? "America/New_York";
  const callUs = settings?.clinic_phone
    ? `please call us at ${settings.clinic_phone}`
    : "please call the office";

  const now = new Date();
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false })
      .format(now),
  );
  const localDay = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
    .format(now);
  if (localDay !== "Mon" || localHour !== 8) {
    return json(200, { skipped: `not Monday 8 AM in ${timezone} (now ${localDay} ${localHour}:00)` });
  }

  // This week's remaining appointments (Monday morning through Sunday night).
  const weekEnd = new Date(now.getTime() + 6.75 * 24 * 3600_000);
  const { data: appts, error } = await admin
    .from("appointments")
    .select("*, providers(name)")
    .eq("status", "scheduled")
    .not("patient_email", "is", null)
    .gt("starts_at", now.toISOString())
    .lte("starts_at", weekEnd.toISOString())
    .order("starts_at")
    .limit(500);
  if (error) return json(500, { error: error.message });

  // Group by patient email.
  const byPatient = new Map<string, typeof appts>();
  for (const a of appts ?? []) {
    const key = (a.patient_email as string).toLowerCase();
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key)!.push(a);
  }

  let sent = 0;
  const failures: string[] = [];

  for (const [email, list] of byPatient) {
    // Idempotency: one digest per recipient per Monday, even though cron retries hourly.
    const { data: already } = await admin
      .from("message_log")
      .select("id")
      .eq("recipient", email)
      .eq("kind", "weekly_digest")
      .gt("sent_at", new Date(now.getTime() - 20 * 3600_000).toISOString())
      .limit(1);
    if (already && already.length > 0) continue;

    const firstName = (list[0].patient_name as string).split(" ")[0];
    const lines = list.map((a) => {
      const when = new Intl.DateTimeFormat("en-US", {
        weekday: "long", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZone: timezone,
      }).format(new Date(a.starts_at));
      const providerName = (a.providers as { name?: string } | null)?.name;
      return `- ${when}${providerName ? ` with ${providerName}` : ""}`;
    });
    const subject = `Your appointments this week at ${clinicName}`;
    const body = `Hi ${firstName},\n\nYou have the following appointment${
      list.length > 1 ? "s" : ""
    } this week at ${clinicName}:\n\n${lines.join("\n")}\n\nIf you have any issues, ${callUs}.\n\n— ${clinicName}`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject,
        text: body,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    const ok = resp.ok;
    const detail = ok ? null : await resp.text();

    if (ok) {
      sent++;
      // Covered by the digest — suppress the per-appointment reminder.
      await admin
        .from("appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .in("id", list.map((a) => a.id));
    } else {
      failures.push(`${email}: ${detail}`);
    }
    await admin.from("message_log").insert({
      appointment_id: list[0].id,
      recipient: email,
      kind: "weekly_digest",
      subject,
      body,
      status: ok ? "sent" : "failed",
      error: detail,
    });
  }

  return json(200, { sent, failed: failures.length, failures });
});
