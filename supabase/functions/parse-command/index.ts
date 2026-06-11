// Parses a spoken/typed scheduling command into a structured action using Claude.
// Config: ANTHROPIC_API_KEY, read from function secrets or Supabase Vault via get_app_secret.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

async function getSecret(admin: SupabaseClient, name: string): Promise<string | null> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data } = await admin.rpc("get_app_secret", { secret_name: name });
  return (data as string | null) ?? null;
}

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

// What the model must produce. Kept flat and nullable so the UI can decide
// what's missing and let staff fill the gaps in the pre-filled form.
const COMMAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action", "patient_name", "patient_phone", "patient_email", "provider_name",
    "date", "time", "duration_minutes", "notes", "new_date", "new_time",
    "repeat", "repeat_count", "clarification",
  ],
  properties: {
    action: { type: "string", enum: ["create", "reschedule", "cancel", "unknown"] },
    patient_name: { type: ["string", "null"] },
    patient_phone: { type: ["string", "null"] },
    patient_email: { type: ["string", "null"] },
    provider_name: { type: ["string", "null"], description: "Must exactly match one provider from the list, or null" },
    date: { type: ["string", "null"], description: "YYYY-MM-DD. For create: the appointment date. For reschedule/cancel: the date of the EXISTING appointment, if mentioned." },
    time: { type: ["string", "null"], description: "HH:MM 24-hour. Same semantics as date." },
    duration_minutes: { type: ["integer", "null"] },
    notes: { type: ["string", "null"] },
    new_date: { type: ["string", "null"], description: "Reschedule target date, YYYY-MM-DD" },
    new_time: { type: ["string", "null"], description: "Reschedule target time, HH:MM 24-hour" },
    repeat: { anyOf: [{ type: "string", enum: ["none", "weekly", "biweekly"] }, { type: "null" }] },
    repeat_count: { type: ["integer", "null"] },
    clarification: { type: ["string", "null"], description: "When action is unknown: a short note on what was unclear or missing" },
  },
} as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Only allowlisted staff may use voice commands.
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json(401, { error: "Not signed in" });
  const { data: staffRow } = await admin
    .from("staff").select("user_id").eq("user_id", userData.user.id).maybeSingle();
  if (!staffRow) return json(403, { error: "This account is not on the staff list" });

  const anthropicKey = await getSecret(admin, "ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return json(503, {
      error: "Voice commands not configured. Add an ANTHROPIC_API_KEY secret (see README).",
    });
  }

  let transcript: string;
  try {
    const body = await req.json();
    transcript = String(body.transcript ?? "").trim();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!transcript) return json(400, { error: "Empty transcript" });
  if (transcript.length > 1000) return json(400, { error: "Transcript too long" });

  const [{ data: providers }, { data: settings }] = await Promise.all([
    admin.from("providers").select("name").eq("active", true),
    admin.from("clinic_settings").select("timezone").eq("id", 1).single(),
  ]);
  const timezone = settings?.timezone ?? "America/New_York";
  const providerNames = (providers ?? []).map((p) => p.name);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" })
    .format(new Date());

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const response = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: COMMAND_SCHEMA },
    },
    system: [
      "You convert a spoken scheduling command from medical front-desk staff into a structured action.",
      `Today is ${weekday}, ${today} (timezone ${timezone}).`,
      `Providers at this office: ${providerNames.join(", ") || "(none configured)"}.`,
      "Rules:",
      "- Resolve relative dates ('tomorrow', 'next Tuesday', 'the 15th') to YYYY-MM-DD using today's date. 'Next <weekday>' means the soonest upcoming one.",
      "- Convert times to 24-hour HH:MM. Assume daytime office hours when ambiguous (e.g. 'at 2' means 14:00).",
      "- provider_name must exactly match one name from the provider list (match loosely on what was said, e.g. a last name), or be null if no provider was mentioned.",
      "- 'cancel' means action=cancel. Moving/changing an existing appointment means action=reschedule, with the new slot in new_date/new_time.",
      "- When an existing appointment is referenced by weekday ('Bob's Tuesday appointment'), assume the soonest UPCOMING occurrence — appointments in the past can't be changed.",
      "- Use action=unknown only when the request is not a scheduling command or the patient cannot be identified; explain in clarification.",
      "- Never invent contact details, durations, or notes that were not said.",
    ].join("\n"),
    messages: [{ role: "user", content: transcript }],
  });

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return json(502, { error: "The model returned no parse result. Try again." });
  return json(200, { command: JSON.parse(text), transcript });
  } catch (err) {
    console.error("parse-command error:", err);
    return json(500, { error: err instanceof Error ? err.message : "Unexpected error" });
  }
});
