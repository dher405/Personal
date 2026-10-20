import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, one, type Row } from "../db.js";
import { sendBusinessEmail, sendEmail } from "./email.js";
import { smsReady } from "./channels.js";
import { addToCalendarLinks, inviteIcs } from "./ics.js";
import { syncBookingToCalendars } from "./calendarSync.js";
import { sendSms, templates } from "./sms.js";

export type NotificationKind = "booking_confirmed" | "booking_rescheduled" | "booking_cancelled" | "customer_confirmed" | "booking_requested" | "booking_declined";

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
  booking_requested: templates.requested,
  booking_declined: templates.declined,
};

const adminLabel: Record<NotificationKind, string> = {
  booking_confirmed: "New booking",
  booking_rescheduled: "Rescheduled",
  booking_cancelled: "Cancelled",
  customer_confirmed: "Confirmed by text",
  booking_requested: "Pay-in-person request, accept or decline",
  booking_declined: "Request declined",
};

/**
 * Fan-out for booking events: email the customer, text them (if they opted in) and alert the business.
 * Fire-and-forget so a slow SMS provider never blocks a booking request.
 */
export function notify(kind: NotificationKind, booking: Row, by: ChangedBy = "customer") {
  dispatchEmail(kind, booking).catch((err) => console.error("email dispatch failed", err));
  if (by !== "staff") dispatchAdminEmail(kind, booking).catch((err) => console.error("admin email failed", err));
  // Owners' and staff's connected Google/Outlook calendars follow every change, whoever made it.
  if (kind !== "customer_confirmed") syncBookingToCalendars(booking.id).catch((err) => console.error("calendar sync failed", err));
  dispatchSms(kind, booking, by).catch((err) => console.error("sms dispatch failed", err));
}

export async function dispatchSms(kind: NotificationKind, booking: Row, by: ChangedBy) {
  const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id);
  if (!business || !smsReady(business)) return;

  const text = customerText[kind];
  // Changes made by text already get a direct reply from the SMS handler, so skip the duplicate.
  if (text && booking.sms_opt_in && booking.customer_phone && by !== "sms") {
    await sendSms({ business, to: booking.customer_phone, body: text(booking), kind, audience: "customer", bookingId: booking.id });
  }
  // A request needs the owner to act, so they're texted about it even with change alerts switched off.
  if ((business.sms_admin_alerts || kind === "booking_requested") && business.sms_admin_phone && by !== "staff") {
    await sendSms({ business, to: business.sms_admin_phone, body: templates.adminAlert(adminLabel[kind], booking), kind: `admin_${kind}`, audience: "admin", bookingId: booking.id });
  }
}

const emailSubjects: Partial<Record<NotificationKind, string>> = {
  booking_confirmed: "Your booking is confirmed",
  booking_rescheduled: "Your booking has moved",
  booking_cancelled: "Your booking is cancelled",
  booking_requested: "We've received your booking request",
  booking_declined: "Your booking request wasn't accepted",
};

/** Customer emails for confirmed / moved / cancelled bookings, sent from the business's own email account (Admin → Email). */
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
    : kind === "booking_requested"
    ? [
        `Hi ${first},`,
        `Thanks! ${business.name} has your request to pay in person for:`,
        `${service.name} with ${staff.name}\n${when}`,
        `The time is held for you while ${business.name} reviews it. You'll get another email as soon as they accept it, and that one adds it to your calendar.`,
        `Booking code: ${booking.code}. Change your mind? You can cancel the request here: ${manage}`,
      ]
    : kind === "booking_declined"
    ? [
        `Hi ${first},`,
        `Sorry, ${business.name} couldn't accept your request for ${service.name} on ${when}.`,
        ...(booking.decline_reason ? [`Their note: ${booking.decline_reason}`] : []),
        `Nothing has been charged. You can book another time, or pay online to confirm straight away: ${config.webUrl}/b/${business.slug}`,
      ]
    : [
        `Hi ${first},`,
        `${kind === "booking_rescheduled" ? "Your booking has moved. It's now:" : "You're booked:"}`,
        `${service.name} with ${staff.name}\n${when}\n${business.name}${business.address ? `, ${business.address}` : ""}`,
        `Booking code: ${booking.code}`,
        ...(booking.pay_in_person && booking.price_cents ? [`You're paying in person at your appointment: ${formatMoney(booking.price_cents, booking.currency)}.`] : []),
        `Need to reschedule or cancel? ${manage}` + (business.cancellation_hours ? ` (online changes close ${business.cancellation_hours} hours before)` : ""),
      ];
  // Calendar invites only go with a booking that's actually happening (not a request that may be declined).
  // A pay-in-person request that was never accepted never had an invite, so its cancellation sends none either.
  const neverInvited = !!booking.pay_in_person && !one("SELECT 1 FROM audit_log WHERE action = 'booking.request_accepted' AND details LIKE ?", `%"${booking.id}"%`);
  const invite = kind === "booking_confirmed" || (kind === "booking_rescheduled" && booking.status !== "requested") ? "REQUEST"
    : kind === "booking_cancelled" && !neverInvited ? "CANCEL" : null;
  if (invite === "REQUEST") {
    const links = addToCalendarLinks(booking);
    lines.push(`Add it to your calendar: the attached invite works in Gmail, Outlook and Apple Mail, or use Google Calendar ${links.google} or Outlook ${links.outlook}`);
  }
  if (business.phone) lines.push(`Questions? Call ${business.name} at ${business.phone}.`);
  await sendBusinessEmail(business, {
    kind, bookingId: booking.id,
    to: booking.customer_email,
    subject: `${subject}: ${service.name} with ${business.name}`,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l).replace(/\n/g, "<br>").replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join(""),
    // Same UID every time with a rising SEQUENCE: mail apps update or remove the one calendar entry.
    attachments: invite ? [{
      filename: invite === "CANCEL" ? "cancel.ics" : "invite.ics",
      content: inviteIcs(booking, invite),
      contentType: `text/calendar; charset=utf-8; method=${invite}`,
    }] : [],
  });
}

const adminSubjects: Record<NotificationKind, string> = {
  booking_confirmed: "New booking",
  booking_rescheduled: "Booking moved",
  booking_cancelled: "Booking cancelled",
  customer_confirmed: "Customer confirmed",
  booking_requested: "Pay-in-person request to accept or decline",
  booking_declined: "Request declined",
};

/** Emails the business's admins when a customer books, moves, confirms or cancels (switch in Calendar sync). */
export async function dispatchAdminEmail(kind: NotificationKind, booking: Row) {
  const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id)!;
  if (!business.email_admin_alerts && kind !== "booking_requested") return;
  const service = one("SELECT name FROM services WHERE id = ?", booking.service_id)!;
  const staff = one("SELECT name FROM staff WHERE id = ?", booking.staff_id)!;
  const when = DateTime.fromISO(booking.starts_at).setZone(business.timezone).toFormat("ccc LLL d 'at' h:mm a");
  const admins = all("SELECT u.email FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = ?", business.id);
  const text = [
    `${adminSubjects[kind]}: ${booking.customer_name}, ${service.name} with ${staff.name}, ${when}.`,
    `Email: ${booking.customer_email}${booking.customer_phone ? ` · Phone: ${booking.customer_phone}` : ""}`,
    booking.notes ? `Notes: ${booking.notes}` : "",
    kind === "booking_requested"
      ? `They'd like to pay in person instead of online. The time is held until you accept or decline: ${config.webUrl}/admin/${business.id}/bookings?status=requested`
      : `Booking code ${booking.code}: ${config.webUrl}/admin/${business.id}/bookings`,
  ].filter(Boolean).join("\n\n");
  for (const a of admins) {
    await sendEmail({ to: a.email, subject: `${adminSubjects[kind]}: ${booking.customer_name}, ${when}`, text });
  }
}

const formatMoney = (cents: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
