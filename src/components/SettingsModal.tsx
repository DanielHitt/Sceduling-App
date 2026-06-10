import { useState } from "react";
import { supabase } from "../lib/supabase";
import type { ClinicSettings, Provider } from "../lib/types";
import { PROVIDER_COLORS } from "../lib/types";

interface Props {
  providers: Provider[];
  settings: ClinicSettings | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function SettingsModal({ providers, settings, onClose, onSaved }: Props) {
  const [clinicName, setClinicName] = useState(settings?.clinic_name ?? "Our Office");
  const [reminderHours, setReminderHours] = useState(settings?.reminder_hours ?? 24);
  const [newProvider, setNewProvider] = useState("");
  const [localProviders, setLocalProviders] = useState(providers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addProvider = async () => {
    const name = newProvider.trim();
    if (!name) return;
    const color = PROVIDER_COLORS[localProviders.length % PROVIDER_COLORS.length];
    const { data, error } = await supabase
      .from("providers")
      .insert({ name, color, sort_order: localProviders.length })
      .select()
      .single();
    if (error) setError(error.message);
    else if (data) {
      setLocalProviders([...localProviders, data]);
      setNewProvider("");
    }
  };

  const renameProvider = async (id: string, name: string) => {
    setLocalProviders((ps) => ps.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const recolorProvider = async (id: string, color: string) => {
    setLocalProviders((ps) => ps.map((p) => (p.id === id ? { ...p, color } : p)));
    await supabase.from("providers").update({ color }).eq("id", id);
  };

  const removeProvider = async (id: string) => {
    if (!confirm("Remove this provider? Their appointments will also be deleted.")) return;
    const { error } = await supabase.from("providers").delete().eq("id", id);
    if (error) setError(error.message);
    else setLocalProviders((ps) => ps.filter((p) => p.id !== id));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: e1 } = await supabase
        .from("clinic_settings")
        .update({ clinic_name: clinicName, reminder_hours: reminderHours })
        .eq("id", 1);
      if (e1) throw e1;
      await Promise.all(
        localProviders.map((p) =>
          supabase.from("providers").update({ name: p.name }).eq("id", p.id),
        ),
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Settings</h2>
          <button onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-700">×</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-0.5 block text-xs font-medium text-slate-600">Office name (appears in messages)</label>
            <input value={clinicName} onChange={(e) => setClinicName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="mb-0.5 block text-xs font-medium text-slate-600">
              Send automatic reminders this many hours before the appointment
            </label>
            <select value={reminderHours} onChange={(e) => setReminderHours(Number(e.target.value))} className={inputCls}>
              {[4, 12, 24, 48, 72].map((h) => (
                <option key={h} value={h}>{h} hours</option>
              ))}
            </select>
          </div>

          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-slate-700">Providers / rooms</h3>
            <ul className="space-y-1.5">
              {localProviders.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <input
                    type="color"
                    value={p.color}
                    onChange={(e) => recolorProvider(p.id, e.target.value)}
                    className="h-7 w-8 cursor-pointer rounded border border-slate-300"
                    title="Color"
                  />
                  <input
                    value={p.name}
                    onChange={(e) => renameProvider(p.id, e.target.value)}
                    className={inputCls}
                  />
                  <button
                    onClick={() => removeProvider(p.id)}
                    className="shrink-0 rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                    title="Remove provider"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <input
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addProvider())}
                placeholder="e.g. Dr. Patel or Exam Room 2"
                className={inputCls}
              />
              <button
                onClick={addProvider}
                className="shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Add
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button onClick={onClose} className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
