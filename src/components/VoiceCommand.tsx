import { useEffect, useRef, useState } from "react";
import { endOfDay, startOfDay } from "date-fns";
import { format } from "date-fns";
import { supabase } from "../lib/supabase";
import type { Appointment, Provider } from "../lib/types";
import type { ModalOverrides, ModalSeed } from "./AppointmentModal";

interface ParsedCommand {
  action: "create" | "reschedule" | "cancel" | "unknown";
  patient_name: string | null;
  patient_phone: string | null;
  patient_email: string | null;
  provider_name: string | null;
  date: string | null;
  time: string | null;
  duration_minutes: number | null;
  notes: string | null;
  new_date: string | null;
  new_time: string | null;
  repeat: "none" | "weekly" | "biweekly" | "course12" | null;
  repeat_count: number | null;
  clarification: string | null;
}

interface Props {
  providers: Provider[];
  onCreate: (seed: ModalSeed) => void;
  onEdit: (appt: Appointment, overrides: ModalOverrides) => void;
  onClose: () => void;
}

// Minimal typings for the browser SpeechRecognition API (vendor-prefixed in Chrome).
type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionInstance)
    | null;
}

export default function VoiceCommand({ providers, onCreate, onEdit, onClose }: Props) {
  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ appts: Appointment[]; cmd: ParsedCommand } | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const speechSupported = getSpeechRecognition() !== null;

  const startListening = () => {
    const SR = getSpeechRecognition();
    if (!SR) return;
    setError(null);
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setTranscript(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed") setError("Microphone access was blocked. Allow it in your browser, or type the command below.");
      else if (e.error !== "aborted") setError(`Speech recognition error (${e.error}). You can type the command instead.`);
    };
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  useEffect(() => {
    if (speechSupported) startListening();
    return () => recognitionRef.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveProvider = (name: string | null): Provider | undefined => {
    if (!name) return undefined;
    const lower = name.toLowerCase();
    return (
      providers.find((p) => p.name.toLowerCase() === lower) ??
      providers.find((p) => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()))
    );
  };

  const openEdit = (appt: Appointment, cmd: ParsedCommand) => {
    const overrides: ModalOverrides =
      cmd.action === "cancel"
        ? { status: "cancelled" }
        : {
            date: cmd.new_date ?? undefined,
            time: cmd.new_time ?? undefined,
            durationMinutes: cmd.duration_minutes ?? undefined,
          };
    onEdit(appt, overrides);
  };

  const run = async () => {
    if (!transcript.trim()) return;
    stopListening();
    setBusy(true);
    setError(null);
    setMatches(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("parse-command", {
        body: { transcript: transcript.trim() },
      });
      if (fnError) {
        let detail = fnError.message;
        try {
          const ctx = (fnError as { context?: Response }).context;
          if (ctx) {
            const j = await ctx.json();
            if (j?.error) detail = j.error;
          }
        } catch { /* keep generic message */ }
        throw new Error(detail);
      }
      const cmd = data.command as ParsedCommand;

      if (cmd.action === "unknown") {
        setError(cmd.clarification ?? "I couldn't work out what to do with that. Try rephrasing.");
        return;
      }

      if (cmd.action === "create") {
        const when = new Date(`${cmd.date ?? format(new Date(), "yyyy-MM-dd")}T${cmd.time ?? "09:00"}`);
        onCreate({
          date: when,
          providerId: resolveProvider(cmd.provider_name)?.id,
          patientName: cmd.patient_name ?? "",
          patientPhone: cmd.patient_phone ?? undefined,
          patientEmail: cmd.patient_email ?? undefined,
          durationMinutes: cmd.duration_minutes ?? undefined,
          notes: cmd.notes ?? undefined,
          repeat: cmd.repeat && cmd.repeat !== "none" ? cmd.repeat : undefined,
          repeatCount: cmd.repeat_count ?? undefined,
        });
        return;
      }

      // reschedule / cancel: find the existing appointment by patient name (+ date if given)
      if (!cmd.patient_name) {
        setError("I didn't catch whose appointment that is. Try again with the patient's name.");
        return;
      }
      let q = supabase
        .from("appointments")
        .select("*")
        .ilike("patient_name", `%${cmd.patient_name}%`)
        .eq("status", "scheduled")
        .order("starts_at")
        .limit(10);
      if (cmd.date) {
        const day = new Date(`${cmd.date}T00:00`);
        q = q.gte("starts_at", startOfDay(day).toISOString()).lte("starts_at", endOfDay(day).toISOString());
      } else {
        q = q.gte("ends_at", new Date().toISOString());
      }
      const provider = resolveProvider(cmd.provider_name);
      if (provider) q = q.eq("provider_id", provider.id);

      const { data: appts, error: qError } = await q;
      if (qError) throw qError;
      if (!appts || appts.length === 0) {
        setError(
          `No upcoming appointment found for "${cmd.patient_name}"${cmd.date ? ` on ${cmd.date}` : ""}.`,
        );
        return;
      }
      if (appts.length === 1) {
        openEdit(appts[0], cmd);
        return;
      }
      setMatches({ appts, cmd });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Voice command</h2>
          <button onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-700">×</button>
        </div>

        <div className="mb-3 flex flex-col items-center gap-2">
          {speechSupported ? (
            <button
              onClick={listening ? stopListening : startListening}
              className={`flex h-16 w-16 items-center justify-center rounded-full text-3xl text-white shadow transition ${
                listening ? "animate-pulse bg-red-500 hover:bg-red-600" : "bg-blue-600 hover:bg-blue-700"
              }`}
              title={listening ? "Stop listening" : "Start listening"}
            >
              🎤
            </button>
          ) : (
            <p className="text-sm text-slate-500">
              This browser doesn't support speech input — type the command instead.
            </p>
          )}
          {listening && <p className="text-xs text-slate-400">Listening… tap the mic when you're done.</p>}
        </div>

        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={2}
          placeholder={'e.g. "Book Maria Lopez with Dr. Patel next Tuesday at 2pm for 30 minutes"'}
          className="mb-2 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <p className="mb-3 text-xs text-slate-400">
          Try: "Cancel John Smith's appointment on Friday" · "Move Bob's Tuesday appointment to 3pm"
        </p>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        {matches && (
          <div className="mb-3 rounded border border-slate-200 p-2">
            <p className="mb-1.5 text-sm font-medium text-slate-700">Which appointment did you mean?</p>
            <ul className="space-y-1">
              {matches.appts.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => openEdit(a, matches.cmd)}
                    className="w-full rounded px-2 py-1 text-left text-sm hover:bg-blue-50"
                  >
                    {a.patient_name} — {format(new Date(a.starts_at), "EEE MMM d, h:mm a")}
                    <span className="text-slate-400"> · {providerName(a.provider_id)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={run}
            disabled={busy || !transcript.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Thinking…" : "Go"}
          </button>
          <button onClick={onClose} className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100">
            Cancel
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Nothing changes until you review the pre-filled form and press Save.
        </p>
      </div>
    </div>
  );
}
