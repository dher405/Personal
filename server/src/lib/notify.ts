import type { Row } from "../db.js";

export type NotificationKind = "booking_confirmed" | "booking_rescheduled" | "booking_cancelled";

/**
 * Hook point for email/SMS (e.g. Postmark, SendGrid, Twilio). Logs for now so
 * flows are visible in development; swap the body for a real sender.
 */
export function notify(kind: NotificationKind, booking: Row) {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[notify] ${kind} → ${booking.customer_email} (booking ${booking.code} at ${booking.starts_at})`);
}
