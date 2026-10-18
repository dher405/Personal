import { one, type Row } from "../db.js";
import { sendSms, templates } from "./sms.js";

export type NotificationKind = "booking_confirmed" | "booking_rescheduled" | "booking_cancelled" | "customer_confirmed";

/** Who caused the event. Admins aren't texted about changes they made themselves. */
export type ChangedBy = "customer" | "sms" | "staff" | "system";

export function changedBy(actor: { label: string }): ChangedBy {
  if (/^(admin|superadmin):|^ai-assistant\(/.test(actor.label)) return "staff";
  if (actor.label.startsWith("sms:")) return "sms";
  if (/^(provider|system|stripe)/.test(actor.label)) return "system";
  return "customer";
}

const customerText: Partial<Record<NotificationKind, (b: Row) => string>> = {
  booking_confirmed: templates.confirmed,
  booking_rescheduled: templates.rescheduled,
  booking_cancelled: templates.cancelled,
};

const adminLabel: Record<NotificationKind, string> = {
  booking_confirmed: "New booking",
  booking_rescheduled: "Rescheduled",
  booking_cancelled: "Cancelled",
  customer_confirmed: "Confirmed by text",
};

/**
 * Fan-out for booking events: text the customer (if they opted in) and alert the
 * business. Email is a logging stub — plug a provider (Postmark, SendGrid) in here.
 * Fire-and-forget so a slow SMS provider never blocks a booking request.
 */
export function notify(kind: NotificationKind, booking: Row, by: ChangedBy = "customer") {
  if (process.env.NODE_ENV !== "test") console.log(`[email] ${kind} → ${booking.customer_email} (booking ${booking.code})`);
  dispatchSms(kind, booking, by).catch((err) => console.error("sms dispatch failed", err));
}

export async function dispatchSms(kind: NotificationKind, booking: Row, by: ChangedBy) {
  const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id);
  if (!business?.sms_enabled) return;

  const text = customerText[kind];
  // Changes made by text already get a direct reply from the SMS handler, so skip the duplicate.
  if (text && booking.sms_opt_in && booking.customer_phone && by !== "sms") {
    await sendSms({ business, to: booking.customer_phone, body: text(booking), kind, audience: "customer", bookingId: booking.id });
  }
  if (business.sms_admin_alerts && business.sms_admin_phone && by !== "staff") {
    await sendSms({ business, to: business.sms_admin_phone, body: templates.adminAlert(adminLabel[kind], booking), kind: `admin_${kind}`, audience: "admin", bookingId: booking.id });
  }
}
