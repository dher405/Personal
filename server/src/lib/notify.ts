import { DateTime } from "luxon";
import { config } from "../config.js";
import { one, type Row } from "../db.js";
import { sendEmail } from "./email.js";
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
 * Fan-out for booking events: email the customer, text them (if they opted in) and alert the business.
 * Fire-and-forget so a slow SMS provider never blocks a booking request.
 */
export function notify(kind: NotificationKind, booking: Row, by: ChangedBy = "customer") {
  dispatchEmail(kind, booking).catch((err) => console.error("email dispatch failed", err));
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

const emailSubjects: Partial<Record<NotificationKind, string>> = {
  booking_confirmed: "Your booking is confirmed",
  booking_rescheduled: "Your booking has moved",
  booking_cancelled: "Your booking is cancelled",
};

/** Customer emails for confirmed / moved / cancelled bookings (sent through Resend or Postmark; logged otherwise). */
export async function dispatchEmail(kind: NotificationKind, booking: Row) {
  const subject = emailSubjects[kind];
  if (!subject) return;
  const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id)!;
  const service = one("SELECT name FROM services WHERE id = ?", booking.service_id)!;
  const staff = one("SELECT name FROM staff WHERE id = ?", booking.staff_id)!;
  const when = DateTime.fromISO(booking.starts_at).setZone(business.timezone).toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
  const manage = `${config.webUrl}/manage/${booking.manage_token}`;
  const first = String(booking.customer_name).split(" ")[0];
  const lines = kind === "booking_cancelled"
    ? [`Hi ${first},`, `Your ${service.name} with ${business.name} on ${when} has been cancelled.`, `Book again any time: ${config.webUrl}/b/${business.slug}`]
    : [
        `Hi ${first},`,
        `${kind === "booking_rescheduled" ? "Your booking has moved. It's now:" : "You're booked:"}`,
        `${service.name} with ${staff.name}\n${when}\n${business.name}${business.address ? `, ${business.address}` : ""}`,
        `Booking code: ${booking.code}`,
        `Need to reschedule or cancel? ${manage}` + (business.cancellation_hours ? ` (online changes close ${business.cancellation_hours} hours before)` : ""),
      ];
  if (business.phone) lines.push(`Questions? Call ${business.name} at ${business.phone}.`);
  await sendEmail({
    to: booking.customer_email,
    subject: `${subject}: ${service.name} with ${business.name}`,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l).replace(/\n/g, "<br>").replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join(""),
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
