import { format } from "date-fns";
import { supabase } from "./supabase";
import type { Appointment, Provider } from "./types";

export type MessageKind = "confirmation" | "update" | "cancellation" | "reminder" | "custom";

export function appointmentMessage(
  kind: MessageKind,
  appt: Appointment,
  provider: Provider | undefined,
  clinicName: string,
  customBody?: string,
): { subject: string; body: string } {
  const when = `${format(new Date(appt.starts_at), "EEEE, MMMM d")} at ${format(new Date(appt.starts_at), "h:mm a")}`;
  const withWho = provider ? ` with ${provider.name}` : "";
  const firstName = appt.patient_name.split(" ")[0];

  switch (kind) {
    case "confirmation":
      return {
        subject: `Appointment confirmed — ${when}`,
        body: `Hi ${firstName},\n\nYour appointment${withWho} is confirmed for ${when}.\n\nIf you need to reschedule, please call or reply to this message.\n\n— ${clinicName}`,
      };
    case "update":
      return {
        subject: `Appointment updated — ${when}`,
        body: `Hi ${firstName},\n\nYour appointment${withWho} has been changed. It is now scheduled for ${when}.\n\nIf this doesn't work for you, please call or reply to this message.\n\n— ${clinicName}`,
      };
    case "cancellation":
      return {
        subject: `Appointment cancelled`,
        body: `Hi ${firstName},\n\nYour appointment${withWho} on ${when} has been cancelled.\n\nPlease call or reply to this message to rebook.\n\n— ${clinicName}`,
      };
    case "reminder":
      return {
        subject: `Reminder: appointment ${when}`,
        body: `Hi ${firstName},\n\nThis is a friendly reminder of your appointment${withWho} on ${when}.\n\n— ${clinicName}`,
      };
    case "custom":
      return {
        subject: `Message from ${clinicName}`,
        body: customBody ?? "",
      };
  }
}

export function mailtoLink(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function smsLink(phone: string, body: string): string {
  return `sms:${encodeURIComponent(phone)}?&body=${encodeURIComponent(body)}`;
}

/**
 * Sends an email through the send-message edge function (Resend).
 * Throws with a friendly message if the email service isn't configured yet.
 */
export async function sendEmail(
  appointmentId: string | null,
  to: string,
  subject: string,
  body: string,
  kind: MessageKind,
): Promise<void> {
  const { data, error } = await supabase.functions.invoke("send-message", {
    body: { appointment_id: appointmentId, to, subject, body, kind },
  });
  if (error) {
    let detail = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) {
        const json = await ctx.json();
        if (json?.error) detail = json.error;
      }
    } catch {
      // keep the generic message
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
}
