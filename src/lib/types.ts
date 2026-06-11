export interface Provider {
  id: string;
  name: string;
  color: string;
  active: boolean;
  sort_order: number;
}

export type AppointmentStatus = "scheduled" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: string;
  provider_id: string;
  series_id: string | null;
  patient_name: string;
  patient_phone: string | null;
  patient_email: string | null;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  status: AppointmentStatus;
  reminder_sent_at: string | null;
}

export interface ClinicSettings {
  id: number;
  clinic_name: string;
  clinic_phone: string | null;
  reminder_hours: number;
  timezone: string;
}

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const PROVIDER_COLORS = [
  "#2563eb", // blue
  "#16a34a", // green
  "#9333ea", // purple
  "#ea580c", // orange
  "#0d9488", // teal
  "#db2777", // pink
  "#ca8a04", // yellow
  "#dc2626", // red
];
