import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { addDays, endOfDay, format, isSameDay, startOfDay, startOfWeek } from "date-fns";
import { supabase } from "./lib/supabase";
import type { Appointment, ClinicSettings, Provider } from "./lib/types";
import Login from "./components/Login";
import TimeGrid from "./components/TimeGrid";
import AppointmentModal, { type ModalSeed } from "./components/AppointmentModal";
import SettingsModal from "./components/SettingsModal";

type View = "day" | "week";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!authReady) return null;
  if (!session) return <Login />;
  return <Scheduler />;
}

function Scheduler() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settings, setSettings] = useState<ClinicSettings | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [view, setView] = useState<View>(() => (window.innerWidth < 768 ? "day" : "week"));
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ appt?: Appointment; seed?: ModalSeed } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const rangeStart = useMemo(
    () => (view === "week" ? startOfWeek(currentDate, { weekStartsOn: 1 }) : startOfDay(currentDate)),
    [view, currentDate],
  );
  const rangeEnd = useMemo(
    () => (view === "week" ? endOfDay(addDays(rangeStart, 6)) : endOfDay(currentDate)),
    [view, rangeStart, currentDate],
  );

  const loadStatic = useCallback(async () => {
    const [prov, sett] = await Promise.all([
      supabase.from("providers").select("*").eq("active", true).order("sort_order").order("created_at"),
      supabase.from("clinic_settings").select("*").eq("id", 1).single(),
    ]);
    if (prov.data) setProviders(prov.data);
    if (sett.data) setSettings(sett.data);
  }, []);

  const loadAppointments = useCallback(async () => {
    const { data } = await supabase
      .from("appointments")
      .select("*")
      .lt("starts_at", rangeEnd.toISOString())
      .gt("ends_at", rangeStart.toISOString())
      .order("starts_at");
    if (data) setAppointments(data);
  }, [rangeStart, rangeEnd]);

  useEffect(() => {
    loadStatic();
  }, [loadStatic]);

  useEffect(() => {
    loadAppointments();
  }, [loadAppointments]);

  // Keep multiple front-desk screens in sync.
  useEffect(() => {
    const channel = supabase
      .channel("schedule-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => loadAppointments())
      .on("postgres_changes", { event: "*", schema: "public", table: "providers" }, () => loadStatic())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadAppointments, loadStatic]);

  const visibleProviders = providers.filter((p) => !hiddenProviders.has(p.id));
  const visibleAppointments = appointments.filter(
    (a) => !hiddenProviders.has(a.provider_id) && a.status !== "cancelled",
  );

  const navigate = (dir: -1 | 1) => setCurrentDate((d) => addDays(d, dir * (view === "week" ? 7 : 1)));

  const title =
    view === "week"
      ? `${format(rangeStart, "MMM d")} – ${format(addDays(rangeStart, 6), "MMM d, yyyy")}`
      : format(currentDate, "EEEE, MMMM d, yyyy");

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 shadow-sm">
        <h1 className="mr-2 text-lg font-semibold text-slate-800">
          {settings?.clinic_name ?? "Office Scheduler"}
        </h1>
        <div className="flex items-center gap-1">
          <button onClick={() => navigate(-1)} className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100" aria-label="Previous">
            ←
          </button>
          <button
            onClick={() => setCurrentDate(new Date())}
            className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
          >
            Today
          </button>
          <button onClick={() => navigate(1)} className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100" aria-label="Next">
            →
          </button>
        </div>
        <span className="text-sm font-medium text-slate-700">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-slate-300 text-sm">
            {(["day", "week"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 capitalize ${view === v ? "bg-blue-600 text-white" : "bg-white hover:bg-slate-100"}`}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            onClick={() => setModal({ seed: { date: currentDate } })}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            + New
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm hover:bg-slate-100"
            title="Settings"
          >
            ⚙
          </button>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            Sign out
          </button>
        </div>
        {providers.length > 1 && (
          <div className="flex w-full flex-wrap gap-1.5 pt-1">
            {providers.map((p) => {
              const hidden = hiddenProviders.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() =>
                    setHiddenProviders((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                    hidden ? "border-slate-200 text-slate-400" : "border-slate-300 text-slate-700"
                  }`}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: hidden ? "#cbd5e1" : p.color }}
                  />
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {providers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-500">
            <p>No providers yet. Add the doctors or rooms you schedule for.</p>
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Add providers
            </button>
          </div>
        ) : (
          <TimeGrid
            columns={
              view === "week"
                ? Array.from({ length: 7 }, (_, i) => {
                    const day = addDays(rangeStart, i);
                    return {
                      key: day.toISOString(),
                      label: format(day, "EEE d"),
                      highlight: isSameDay(day, new Date()),
                      date: day,
                      appointments: visibleAppointments.filter((a) => isSameDay(new Date(a.starts_at), day)),
                    };
                  })
                : visibleProviders.map((p) => ({
                    key: p.id,
                    label: p.name,
                    highlight: false,
                    date: currentDate,
                    providerId: p.id,
                    appointments: visibleAppointments.filter(
                      (a) => a.provider_id === p.id && isSameDay(new Date(a.starts_at), currentDate),
                    ),
                  }))
            }
            providers={providers}
            onSlotClick={(date, providerId) => setModal({ seed: { date, providerId } })}
            onAppointmentClick={(appt) => setModal({ appt })}
          />
        )}
      </main>

      {modal && settings && (
        <AppointmentModal
          appointment={modal.appt}
          seed={modal.seed}
          providers={providers}
          settings={settings}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            loadAppointments();
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          providers={providers}
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            loadStatic();
          }}
        />
      )}
    </div>
  );
}
