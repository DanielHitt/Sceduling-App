import { useMemo, useState } from "react";
import { addMinutes, addWeeks, format } from "date-fns";
import { supabase } from "../lib/supabase";
import type { Appointment, AppointmentStatus, ClinicSettings, Provider } from "../lib/types";
import { STATUS_LABELS } from "../lib/types";
import {
  appointmentMessage,
  mailtoLink,
  sendEmail,
  smsLink,
  type MessageKind,
} from "../lib/messaging";

export interface ModalSeed {
  date: Date;
  providerId?: string;
  patientName?: string;
  patientPhone?: string;
  patientEmail?: string;
  durationMinutes?: number;
  notes?: string;
  repeat?: "none" | "weekly" | "biweekly";
  repeatCount?: number;
}

/** Pre-applied changes when opening an existing appointment (e.g. from a voice command). */
export interface ModalOverrides {
  date?: string;
  time?: string;
  durationMinutes?: number;
  status?: AppointmentStatus;
}

interface Props {
  appointment?: Appointment;
  seed?: ModalSeed;
  overrides?: ModalOverrides;
  providers: Provider[];
  settings: ClinicSettings;
  onClose: () => void;
  onSaved: () => void;
}

type Scope = "this" | "future" | "all";
type Repeat = "none" | "weekly" | "biweekly";

const DURATIONS = [15, 30, 45, 60, 90, 120];

export default function AppointmentModal({ appointment, seed, overrides, providers, settings, onClose, onSaved }: Props) {
  const isEdit = !!appointment;
  const initialStart = appointment ? new Date(appointment.starts_at) : (seed?.date ?? new Date());
  const initialDuration = appointment
    ? Math.round((new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()) / 60000)
    : (seed?.durationMinutes ?? 30);

  const [name, setName] = useState(appointment?.patient_name ?? seed?.patientName ?? "");
  const [phone, setPhone] = useState(appointment?.patient_phone ?? seed?.patientPhone ?? "");
  const [email, setEmail] = useState(appointment?.patient_email ?? seed?.patientEmail ?? "");
  const [providerId, setProviderId] = useState(
    appointment?.provider_id ?? seed?.providerId ?? providers[0]?.id ?? "",
  );
  const [date, setDate] = useState(overrides?.date ?? format(initialStart, "yyyy-MM-dd"));
  const [time, setTime] = useState(overrides?.time ?? format(initialStart, "HH:mm"));
  const [duration, setDuration] = useState(overrides?.durationMinutes ?? initialDuration);
  const [notes, setNotes] = useState(appointment?.notes ?? seed?.notes ?? "");
  const [status, setStatus] = useState<AppointmentStatus>(
    overrides?.status ?? appointment?.status ?? "scheduled",
  );
  const [repeat, setRepeat] = useState<Repeat>(seed?.repeat ?? "none");
  const [repeatCount, setRepeatCount] = useState(seed?.repeatCount ?? 4);
  const [scope, setScope] = useState<Scope>("this");
  const [emailOnSave, setEmailOnSave] = useState(false);
  const [msgKind, setMsgKind] = useState<MessageKind>(isEdit ? "update" : "confirmation");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const provider = providers.find((p) => p.id === providerId);
  const startsAt = useMemo(() => new Date(`${date}T${time}`), [date, time]);
  const endsAt = useMemo(() => addMinutes(startsAt, duration), [startsAt, duration]);

  const currentDraft = (): Appointment => ({
    id: appointment?.id ?? "",
    provider_id: providerId,
    series_id: appointment?.series_id ?? null,
    patient_name: name,
    patient_phone: phone || null,
    patient_email: email || null,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    notes: notes || null,
    status,
    reminder_sent_at: appointment?.reminder_sent_at ?? null,
  });

  const trySendEmail = async (kind: MessageKind, apptId: string | null) => {
    const { subject, body } = appointmentMessage(
      kind, currentDraft(), provider, settings.clinic_name, settings.clinic_phone,
    );
    await sendEmail(apptId, email, subject, body, kind);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerId) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!isEdit) {
        const rows = [];
        const count = repeat === "none" ? 1 : repeatCount;
        const intervalWeeks = repeat === "biweekly" ? 2 : 1;
        const seriesId = repeat === "none" ? null : crypto.randomUUID();
        for (let i = 0; i < count; i++) {
          const s = addWeeks(startsAt, i * intervalWeeks);
          rows.push({
            provider_id: providerId,
            series_id: seriesId,
            patient_name: name,
            patient_phone: phone || null,
            patient_email: email || null,
            starts_at: s.toISOString(),
            ends_at: addMinutes(s, duration).toISOString(),
            notes: notes || null,
          });
        }
        const { data, error } = await supabase.from("appointments").insert(rows).select("id").limit(1);
        if (error) throw error;
        if (emailOnSave && email) await trySendEmail("confirmation", data?.[0]?.id ?? null);
      } else {
        const fields = {
          provider_id: providerId,
          patient_name: name,
          patient_phone: phone || null,
          patient_email: email || null,
          notes: notes || null,
          status,
        };
        if (!appointment.series_id || scope === "this") {
          const { error } = await supabase
            .from("appointments")
            .update({ ...fields, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() })
            .eq("id", appointment.id);
          if (error) throw error;
        } else {
          // Apply the new time-of-day, duration, and details to every
          // occurrence in scope while keeping each occurrence on its own date.
          let q = supabase.from("appointments").select("id, starts_at").eq("series_id", appointment.series_id);
          if (scope === "future") q = q.gte("starts_at", appointment.starts_at);
          const { data: series, error } = await q;
          if (error) throw error;
          const [h, m] = time.split(":").map(Number);
          await Promise.all(
            (series ?? []).map((row) => {
              const s = new Date(row.starts_at);
              s.setHours(h, m, 0, 0);
              return supabase
                .from("appointments")
                .update({ ...fields, starts_at: s.toISOString(), ends_at: addMinutes(s, duration).toISOString() })
                .eq("id", row.id);
            }),
          );
        }
        if (emailOnSave && email) {
          await trySendEmail(status === "cancelled" ? "cancellation" : "update", appointment.id);
        }
      }
      onSaved();
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : "Something went wrong" });
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!appointment) return;
    if (!confirm("Delete this appointment? This cannot be undone.")) return;
    setBusy(true);
    try {
      let q = supabase.from("appointments").delete();
      if (!appointment.series_id || scope === "this") {
        q = q.eq("id", appointment.id);
      } else {
        q = q.eq("series_id", appointment.series_id);
        if (scope === "future") q = q.gte("starts_at", appointment.starts_at);
      }
      const { error } = await q;
      if (error) throw error;
      onSaved();
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : "Something went wrong" });
      setBusy(false);
    }
  };

  const sendNow = async () => {
    if (!email) return;
    setBusy(true);
    setNotice(null);
    try {
      await trySendEmail(msgKind, appointment?.id ?? null);
      setNotice({ kind: "ok", text: `Email sent to ${email}` });
    } catch (err) {
      setNotice({
        kind: "err",
        text: `Couldn't send: ${err instanceof Error ? err.message : "unknown error"}. Try the "Open email app" button instead.`,
      });
    }
    setBusy(false);
  };

  const draftMsg = appointmentMessage(
    msgKind, currentDraft(), provider, settings.clinic_name, settings.clinic_phone,
  );
  const inputCls =
    "w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none";
  const labelCls = "mb-0.5 block text-xs font-medium text-slate-600";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">
            {isEdit ? "Edit appointment" : "New appointment"}
          </h2>
          <button onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>

        <form onSubmit={save} className="space-y-3">
          <div>
            <label className={labelCls}>Patient name *</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Phone</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="(555) 555-5555" />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="patient@example.com" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Provider</label>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputCls}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Date</label>
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Time</label>
              <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Duration</label>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={inputCls}>
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>{d >= 60 ? `${d / 60} hr${d > 60 ? ` ${d % 60 ? `${d % 60} min` : ""}` : ""}` : `${d} min`}</option>
                ))}
              </select>
            </div>
            {isEdit ? (
              <div>
                <label className={labelCls}>Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value as AppointmentStatus)} className={inputCls}>
                  {Object.entries(STATUS_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className={labelCls}>Repeats</label>
                <div className="flex gap-2">
                  <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} className={inputCls}>
                    <option value="none">Does not repeat</option>
                    <option value="weekly">Every week</option>
                    <option value="biweekly">Every 2 weeks</option>
                  </select>
                  {repeat !== "none" && (
                    <select value={repeatCount} onChange={(e) => setRepeatCount(Number(e.target.value))} className={inputCls + " w-24"}>
                      {Array.from({ length: 25 }, (_, i) => i + 2).map((n) => (
                        <option key={n} value={n}>{n}×</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
          </div>

          {isEdit && appointment?.series_id && (
            <fieldset className="rounded border border-slate-200 p-2.5">
              <legend className="px-1 text-xs font-medium text-slate-600">This is a repeating appointment — apply changes to</legend>
              <div className="flex gap-4 text-sm">
                {([["this", "Only this one"], ["future", "This + following"], ["all", "All"]] as [Scope, string][]).map(([v, l]) => (
                  <label key={v} className="flex items-center gap-1.5">
                    <input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} />
                    {l}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={emailOnSave}
              disabled={!email}
              onChange={(e) => setEmailOnSave(e.target.checked)}
            />
            Email the patient about this {isEdit ? "change" : "booking"} when I save
            {!email && <span className="text-xs text-slate-400">(add an email above)</span>}
          </label>

          {notice && (
            <p className={`text-sm ${notice.kind === "ok" ? "text-green-600" : "text-red-600"}`}>{notice.text}</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={onClose} className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100">
              Cancel
            </button>
            {isEdit && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="ml-auto rounded px-3 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                Delete{appointment?.series_id ? ` (${scope === "this" ? "this one" : scope === "future" ? "this + following" : "all"})` : ""}
              </button>
            )}
          </div>
        </form>

        {/* Messaging — only for saved appointments, so composing a message can
            never be mistaken for booking one. New bookings use the checkbox above. */}
        {!isEdit ? (
          <div className="mt-5 border-t border-slate-200 pt-4">
            <p className="text-xs text-slate-400">
              Messaging buttons appear here once the appointment is saved. To notify the patient
              right away, tick the checkbox above before clicking Save.
            </p>
          </div>
        ) : (
        <div className="mt-5 border-t border-slate-200 pt-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Message the patient</h3>
          {!email && !phone ? (
            <p className="text-sm text-slate-400">Add a phone number or email to enable messaging.</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <select value={msgKind} onChange={(e) => setMsgKind(e.target.value as MessageKind)} className={inputCls + " w-auto"}>
                  <option value="confirmation">Confirmation</option>
                  <option value="update">Change notice</option>
                  <option value="cancellation">Cancellation</option>
                  <option value="reminder">Reminder</option>
                </select>
                <button
                  type="button"
                  onClick={sendNow}
                  disabled={!email || busy}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                  title={email ? `Send email to ${email}` : "No email on file"}
                >
                  Send email now
                </button>
                {email && (
                  <a
                    href={mailtoLink(email, draftMsg.subject, draftMsg.body)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                  >
                    Open email app
                  </a>
                )}
                {phone && (
                  <a
                    href={smsLink(phone, draftMsg.body)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                  >
                    Open texting app
                  </a>
                )}
              </div>
              <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-500">{draftMsg.body}</p>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
