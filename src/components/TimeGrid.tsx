import { format, setHours, setMinutes } from "date-fns";
import type { Appointment, Provider } from "../lib/types";

export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 19;
const HOUR_PX = 64;

export interface GridColumn {
  key: string;
  label: string;
  highlight: boolean;
  date: Date;
  providerId?: string;
  appointments: Appointment[];
}

interface Props {
  columns: GridColumn[];
  providers: Provider[];
  onSlotClick: (date: Date, providerId?: string) => void;
  onAppointmentClick: (appt: Appointment) => void;
}

interface Positioned {
  appt: Appointment;
  lane: number;
  laneCount: number;
}

/** Assign overlapping appointments to side-by-side lanes within a column. */
function layoutColumn(appts: Appointment[]): Positioned[] {
  const sorted = [...appts].sort(
    (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  );
  const result: Positioned[] = [];
  let cluster: Positioned[] = [];
  let clusterEnd = 0;
  let laneEnds: number[] = [];

  const flush = () => {
    for (const p of cluster) p.laneCount = laneEnds.length;
    result.push(...cluster);
    cluster = [];
    laneEnds = [];
  };

  for (const appt of sorted) {
    const start = new Date(appt.starts_at).getTime();
    const end = new Date(appt.ends_at).getTime();
    if (cluster.length > 0 && start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    cluster.push({ appt, lane, laneCount: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return result;
}

function minutesFromDayStart(d: Date): number {
  return (d.getHours() - DAY_START_HOUR) * 60 + d.getMinutes();
}

export default function TimeGrid({ columns, providers, onSlotClick, onAppointmentClick }: Props) {
  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);
  const gridHeight = hours.length * HOUR_PX;
  const providerById = new Map(providers.map((p) => [p.id, p]));

  const handleBackgroundClick = (e: React.MouseEvent<HTMLDivElement>, col: GridColumn) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = ((e.clientY - rect.top) / HOUR_PX) * 60;
    const snapped = Math.floor(minutes / 30) * 30;
    const date = setMinutes(setHours(col.date, DAY_START_HOUR + Math.floor(snapped / 60)), snapped % 60);
    onSlotClick(date, col.providerId);
  };

  return (
    <div className="flex min-w-fit">
      {/* time gutter */}
      <div className="sticky left-0 z-10 w-14 shrink-0 bg-slate-50 pt-8 text-right text-xs text-slate-400">
        {hours.map((h) => (
          <div key={h} style={{ height: HOUR_PX }} className="pr-2 -translate-y-2">
            {format(setHours(new Date(), h), "h a")}
          </div>
        ))}
      </div>

      {columns.map((col) => (
        <div key={col.key} className="min-w-36 flex-1 border-l border-slate-200">
          <div
            className={`sticky top-0 z-10 h-8 border-b border-slate-200 bg-white px-2 py-1.5 text-center text-sm font-medium ${
              col.highlight ? "text-blue-600" : "text-slate-700"
            }`}
          >
            {col.label}
          </div>
          <div
            className="relative cursor-pointer"
            style={{ height: gridHeight }}
            onClick={(e) => handleBackgroundClick(e, col)}
          >
            {hours.map((h) => (
              <div key={h} style={{ height: HOUR_PX }} className="border-b border-slate-100">
                <div className="h-1/2 border-b border-dashed border-slate-100" />
              </div>
            ))}
            {layoutColumn(col.appointments).map(({ appt, lane, laneCount }) => {
              const start = new Date(appt.starts_at);
              const end = new Date(appt.ends_at);
              const top = Math.max(0, (minutesFromDayStart(start) / 60) * HOUR_PX);
              const height = Math.max(
                20,
                ((end.getTime() - start.getTime()) / 60000 / 60) * HOUR_PX,
              );
              const provider = providerById.get(appt.provider_id);
              const width = 100 / laneCount;
              return (
                <button
                  key={appt.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAppointmentClick(appt);
                  }}
                  className="absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs text-white shadow-sm hover:brightness-110"
                  style={{
                    top,
                    height,
                    left: `${lane * width}%`,
                    width: `calc(${width}% - 2px)`,
                    backgroundColor: provider?.color ?? "#64748b",
                    opacity: appt.status === "completed" ? 0.55 : 1,
                  }}
                  title={`${appt.patient_name} · ${format(start, "h:mm a")}–${format(end, "h:mm a")}`}
                >
                  <span className="font-semibold">{format(start, "h:mm")}</span>{" "}
                  <span className={appt.status === "no_show" ? "line-through" : ""}>
                    {appt.patient_name}
                  </span>
                  {appt.series_id && <span title="Recurring"> ↻</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
