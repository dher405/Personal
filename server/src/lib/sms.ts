import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, newId, one, run, Row } from "../db.js";
import { channelsFor, smsConfigured, smsFrom, twilioWebhookUrls, type SmsChannel } from "./channels.js";

/**
 * Outbound texting, always through the business's own Twilio account (Admin → Text messages).
 * A business in test mode has its texts recorded as "simulated" so the whole flow can be tried
 * from the admin message log without sending anything.
 */

export type Audience = "customer" | "admin" | "staff";

/** Best-effort E.164 normalisation: "(555) 010-2020" → "+15550102020". Returns null when it can't be a phone number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && config.smsDefaultCountryCode === "1") return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && config.smsDefaultCountryCode === "1") return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${config.smsDefaultCountryCode}${digits}`;
  return null;
}

/** STOP applies to the business whose number they replied to. */
export const isOptedOut = (businessId: string, phone: string) =>
  !!one("SELECT 1 FROM business_sms_opt_outs WHERE business_id = ? AND phone = ?", businessId, phone);

export const twilioAuth = (c: SmsChannel) => `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}`;

async function twilioSend(businessId: string, c: SmsChannel, to: string, body: string) {
  const { accountSid, messagingServiceSid, fromNumber } = c;
  const form = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
  else form.set("From", fromNumber!);
  form.set("StatusCallback", twilioWebhookUrls(businessId).status);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: twilioAuth(c),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Twilio error ${res.status}`);
  return json.sid as string;
}

export interface SendOptions {
  business: Row;
  to: string | null | undefined;
  body: string;
  kind: string;
  audience: Audience;
  bookingId?: string | null;
  /** Bypasses the business's "SMS enabled" switch (used for the admin's test message). */
  force?: boolean;
}

/** Sends one text and records it. Never throws: failures are logged on the message row. */
export async function sendSms(opts: SendOptions): Promise<Row> {
  const to = normalizePhone(opts.to);
  const id = newId("sms");
  const record = (status: string, extra: { sid?: string; error?: string } = {}) => {
    run(
      `INSERT INTO sms_messages (id, business_id, booking_id, direction, audience, kind, to_phone, from_phone, body, status, provider_sid, error)
       VALUES (?,?,?,'outbound',?,?,?,?,?,?,?,?)`,
      id, opts.business.id, opts.bookingId ?? null, opts.audience, opts.kind, to ?? String(opts.to ?? ""),
      smsFrom(opts.business), opts.body, status, extra.sid ?? null, extra.error ?? null,
    );
    return one("SELECT * FROM sms_messages WHERE id = ?", id)!;
  };

  if (!to) return record("skipped", { error: "Invalid phone number" });
  if (opts.business.is_demo) return record("skipped", { error: "Demo business: texts aren't sent" });
  if (!smsConfigured(opts.business)) return record("skipped", { error: "Texting isn't set up (connect your Twilio account under Text messages)" });
  if (!opts.force && !opts.business.sms_enabled) return record("skipped", { error: "Text messages are switched off" });
  if (isOptedOut(opts.business.id, to)) return record("skipped", { error: "Recipient replied STOP" });
  const channel = channelsFor(opts.business).sms;
  if (channel.provider === "test") {
    if (process.env.NODE_ENV !== "test") console.log(`[sms:simulated] → ${to}: ${opts.body}`);
    return record("simulated");
  }
  try {
    return record("sent", { sid: await twilioSend(opts.business.id, channel, to, opts.body) });
  } catch (err) {
    return record("failed", { error: (err as Error).message });
  }
}

// ---------- Message templates ----------

const when = (b: Row, zone: string) => DateTime.fromISO(b.starts_at).setZone(zone).toFormat("ccc LLL d 'at' h:mm a");
/** " Join online: <link>" for online appointments, so texts carry the meeting link too. */
const online = (b: Row) => (b.meeting_mode === "online" && b.meeting_url ? ` Join online: ${b.meeting_url}` : "");
const manageLink = (b: Row) => `${config.webUrl}/manage/${b.manage_token}`;

function bookingContext(b: Row) {
  const business = one("SELECT * FROM businesses WHERE id = ?", b.business_id)!;
  const service = one("SELECT name FROM services WHERE id = ?", b.service_id)!;
  const staff = one("SELECT name, phone FROM staff WHERE id = ?", b.staff_id)!;
  return { business, service, staff, at: when(b, business.timezone) };
}

export const templates = {
  confirmed: (b: Row) => {
    const { business, service, staff, at } = bookingContext(b);
    return `${business.name}: You're booked for ${service.name} with ${staff.name} on ${at}.${online(b)} Code ${b.code}. Reply R to reschedule, X to cancel. ${manageLink(b)} Reply STOP to opt out.`;
  },
  reminder: (b: Row) => {
    const { business, service, staff, at } = bookingContext(b);
    const ask = b.customer_confirmed_at ? "Reply R to reschedule or X to cancel." : "Reply C to confirm, R to reschedule, X to cancel.";
    return `Reminder from ${business.name}: ${service.name} with ${staff.name} on ${at}.${online(b)} ${ask}`;
  },
  rescheduled: (b: Row) => {
    const { business, service, at } = bookingContext(b);
    return `${business.name}: Your ${service.name} is now ${at}.${online(b)} Reply C to confirm or R to change it again.`;
  },
  requested: (b: Row) => {
    const { business, service, staff, at } = bookingContext(b);
    return `${business.name}: We've got your request for ${service.name} with ${staff.name} on ${at}, paying in person. The time is held for you; we'll text you when it's confirmed. ${manageLink(b)}`;
  },
  declined: (b: Row) => {
    const { business, service, at } = bookingContext(b);
    return `${business.name}: Sorry, we couldn't accept your request for ${service.name} on ${at}.${b.decline_reason ? ` ${b.decline_reason}` : ""} Book again: ${config.webUrl}/b/${business.slug}`;
  },
  cancelled: (b: Row) => {
    const { business, service, at } = bookingContext(b);
    return `${business.name}: Your ${service.name} on ${at} is cancelled. Book again any time: ${config.webUrl}/b/${business.slug}`;
  },
  adminAlert: (event: string, b: Row) => {
    const { service, staff, at } = bookingContext(b);
    return `[${event}] ${b.customer_name} — ${service.name} with ${staff.name}, ${at}${b.customer_phone ? ` (${b.customer_phone})` : ""}. Code ${b.code}.`;
  },
  staffReminder: (b: Row) => {
    const { service, at } = bookingContext(b);
    return `Up next: ${b.customer_name}, ${service.name} ${at}${b.notes ? `. Notes: ${b.notes.slice(0, 80)}` : ""}`;
  },
};

/** "Today at Riverside Music: 9:00 Pat Lee (Guitar)…" for the admin's morning text. */
export function agendaText(business: Row, day: DateTime) {
  const from = day.startOf("day").toUTC().toISO(), to = day.endOf("day").toUTC().toISO();
  const rows = all(
    `SELECT b.*, s.name AS service_name, st.name AS staff_name FROM bookings b
       JOIN services s ON s.id = b.service_id JOIN staff st ON st.id = b.staff_id
      WHERE b.business_id = ? AND b.status IN ('confirmed','pending_payment','requested') AND b.starts_at >= ? AND b.starts_at <= ? ORDER BY b.starts_at`,
    business.id, from, to,
  );
  const label = day.hasSame(DateTime.now().setZone(business.timezone), "day") ? "Today" : day.toFormat("ccc LLL d");
  if (!rows.length) return `${label} at ${business.name}: no appointments.`;
  const lines = rows.slice(0, 12).map((b) => {
    const t = DateTime.fromISO(b.starts_at).setZone(business.timezone).toFormat("h:mm");
    return `${t} ${b.customer_name} (${b.service_name}, ${b.staff_name})${b.status === "requested" ? " [request, not accepted yet]" : b.customer_confirmed_at ? " ✓" : ""}`;
  });
  return `${label} at ${business.name} — ${rows.length} appt${rows.length > 1 ? "s" : ""}:\n${lines.join("\n")}${rows.length > 12 ? `\n+${rows.length - 12} more` : ""}`;
}
