import { DateTime } from "luxon";
import { config } from "../config.js";
import { one, Row } from "../db.js";

/**
 * iCalendar (RFC 5545) for bookings: one-off files customers add to their own
 * calendar, email invitations that update in place, and subscribable feeds.
 */

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (iso: string | DateTime) => (typeof iso === "string" ? DateTime.fromISO(iso) : iso).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");

/** Lines longer than 75 bytes are folded with CRLF + space, as the spec requires. */
function fold(line: string) {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = " " + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

const calendar = (lines: string[], extra: string[] = []) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Slotwise//Bookings//EN", "CALSCALE:GREGORIAN", ...extra, ...lines, "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";

export interface BookingContext { booking: Row; business: Row; service: Row; staff: Row }

export function bookingContext(booking: Row): BookingContext {
  return {
    booking,
    business: one("SELECT * FROM businesses WHERE id = ?", booking.business_id)!,
    service: one("SELECT * FROM services WHERE id = ?", booking.service_id)!,
    staff: one("SELECT * FROM staff WHERE id = ?", booking.staff_id)!,
  };
}

export const manageUrl = (b: Row) => `${config.webUrl}/manage/${b.manage_token}`;
export const eventUid = (b: Row) => `${b.id}@slotwise`;

/** How the event reads in the customer's calendar. */
export function customerEventText({ booking, business, service, staff }: BookingContext) {
  return {
    title: `${service.name} with ${business.name}`,
    description: [
      `${service.name} with ${staff.name}`,
      `Booking code: ${booking.code}`,
      `Reschedule or cancel: ${manageUrl(booking)}`,
      business.phone ? `Questions: ${business.phone}` : "",
    ].filter(Boolean).join("\n"),
    location: business.address ?? business.name,
  };
}

function vevent(ctx: BookingContext, opts: { title: string; description: string; location: string; cancelled?: boolean; attendee?: boolean; alarmMinutes?: number }) {
  const { booking, business } = ctx;
  const from = config.email.from.match(/<([^>]+)>/)?.[1] ?? config.email.from;
  return [
    "BEGIN:VEVENT",
    `UID:${eventUid(booking)}`,
    `SEQUENCE:${booking.ics_sequence ?? 0}`,
    `DTSTAMP:${stamp(DateTime.utc())}`,
    `DTSTART:${stamp(booking.starts_at)}`,
    `DTEND:${stamp(booking.ends_at)}`,
    `SUMMARY:${esc(opts.title)}`,
    `DESCRIPTION:${esc(opts.description)}`,
    `LOCATION:${esc(opts.location)}`,
    `URL:${manageUrl(booking)}`,
    `STATUS:${opts.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    ...(opts.attendee
      ? [`ORGANIZER;CN=${esc(business.name)}:mailto:${from}`,
         `ATTENDEE;CN=${esc(booking.customer_name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${booking.customer_email}`]
      : []),
    ...(opts.alarmMinutes && !opts.cancelled
      ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(opts.title)}`, `TRIGGER:-PT${opts.alarmMinutes}M`, "END:VALARM"]
      : []),
    "END:VEVENT",
  ];
}

/** A download for "Add to Apple Calendar / Outlook": opens straight in the calendar app. */
export function customerIcs(booking: Row) {
  const ctx = bookingContext(booking);
  return calendar(vevent(ctx, { ...customerEventText(ctx), cancelled: booking.status === "cancelled", alarmMinutes: 60 }), ["METHOD:PUBLISH"]);
}

/**
 * Attached to booking emails. METHOD:REQUEST with a stable UID + rising SEQUENCE is what
 * makes Gmail, Outlook and Apple Mail update (or remove, with CANCEL) the same calendar entry.
 */
export function inviteIcs(booking: Row, method: "REQUEST" | "CANCEL") {
  const ctx = bookingContext(booking);
  return calendar(vevent(ctx, { ...customerEventText(ctx), cancelled: method === "CANCEL", attendee: true, alarmMinutes: 60 }), [`METHOD:${method}`]);
}

/** One-click links for calendars that don't open .ics files from a link. */
export function addToCalendarLinks(booking: Row) {
  const ctx = bookingContext(booking);
  const t = customerEventText(ctx);
  const s = DateTime.fromISO(booking.starts_at).toUTC(), e = DateTime.fromISO(booking.ends_at).toUTC();
  const google = new URLSearchParams({
    action: "TEMPLATE", text: t.title, details: t.description, location: t.location,
    dates: `${s.toFormat("yyyyLLdd'T'HHmmss'Z'")}/${e.toFormat("yyyyLLdd'T'HHmmss'Z'")}`,
  });
  const outlook = (host: string) => `https://${host}/calendar/0/deeplink/compose?` + new URLSearchParams({
    path: "/calendar/action/compose", rru: "addevent", subject: t.title, body: t.description, location: t.location,
    startdt: s.toISO()!, enddt: e.toISO()!,
  });
  return {
    google: `https://calendar.google.com/calendar/render?${google}`,
    outlook: outlook("outlook.live.com"),
    office365: outlook("outlook.office.com"),
    ics: `${config.apiUrl}/api/public/manage/${booking.manage_token}/calendar.ics`,
  };
}

/** Subscribable feed of a business's (or one staff member's) bookings, for owners' calendars. */
export function feedIcs(business: Row, bookings: Row[], name: string) {
  const events = bookings.flatMap((b) => {
    const ctx = bookingContext(b);
    return vevent(ctx, {
      title: `${ctx.service.name}: ${b.customer_name}`,
      description: [
        `With ${ctx.staff.name}`,
        b.customer_phone ? `Phone: ${b.customer_phone}` : "",
        `Email: ${b.customer_email}`,
        b.notes ? `Notes: ${b.notes}` : "",
        b.customer_confirmed_at ? "Customer confirmed they're coming" : "",
        `Code ${b.code} · ${config.webUrl}/admin/${business.id}/bookings`,
      ].filter(Boolean).join("\n"),
      location: business.address ?? business.name,
      alarmMinutes: 30,
    });
  });
  return calendar(events, [
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    `X-WR-TIMEZONE:${business.timezone}`,
    // Hints only: Google refreshes subscribed calendars every several hours whatever we say.
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ]);
}
