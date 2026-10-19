import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, newId, one, run, Row } from "../db.js";
import { checkAlerts, hasCapacity } from "./usage.js";

/**
 * Outbound texting. Uses Twilio when TWILIO_* is configured; otherwise messages
 * are recorded as "simulated" so the whole flow can be tried locally from the
 * admin message log.
 */

export type Audience = "customer" | "admin" | "staff";

export const smsLive = () => !!(config.twilio.accountSid && config.twilio.authToken && (config.twilio.messagingServiceSid || config.twilio.fromNumber));
export const platformFromNumber = () => config.twilio.fromNumber || config.twilio.messagingServiceSid || "+15550000000";

/** Best-effort E.164 normalisation: "(555) 010-2020" → "+15550102020". Returns null when it can't be a phone number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && config.twilio.defaultCountryCode === "1") return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && config.twilio.defaultCountryCode === "1") return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${config.twilio.defaultCountryCode}${digits}`;
  return null;
}

export const isOptedOut = (phone: string) => !!one("SELECT 1 FROM sms_opt_outs WHERE phone = ?", phone);

export function smsUsedThisMonth(businessId: string) {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sms_messages WHERE business_id = ? AND direction = 'outbound'
       AND status NOT IN ('failed','skipped') AND created_at >= datetime('now','start of month')`,
    businessId,
  )!.n;
}

async function twilioSend(to: string, body: string) {
  const { accountSid, authToken, messagingServiceSid, fromNumber } = config.twilio;
  const form = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
  else form.set("From", fromNumber);
  form.set("StatusCallback", `${config.apiUrl}/api/webhooks/twilio/status`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
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
      platformFromNumber(), opts.body, status, extra.sid ?? null, extra.error ?? null,
    );
    return one("SELECT * FROM sms_messages WHERE id = ?", id)!;
  };

  if (!to) return record("skipped", { error: "Invalid phone number" });
  if (!opts.force && !opts.business.sms_enabled) return record("skipped", { error: "SMS disabled for this business" });
  if (isOptedOut(to)) return record("skipped", { error: "Recipient replied STOP" });
  if (!hasCapacity(opts.business, "sms")) {
    return record("skipped", { error: "Monthly text allowance is used up (buy more or upgrade under Plan & billing)" });
  }
  let sent: Row;
  if (!smsLive()) {
    if (process.env.NODE_ENV !== "test") console.log(`[sms:simulated] → ${to}: ${opts.body}`);
    sent = record("simulated");
  } else {
    try {
      sent = record("sent", { sid: await twilioSend(to, opts.body) });
    } catch (err) {
      return record("failed", { error: (err as Error).message });
    }
  }
  checkAlerts(opts.business, "sms").catch((err) => console.error("usage alert failed", err));
  return sent;
}

// ---------- Message templates ----------

const when = (b: Row, zone: string) => DateTime.fromISO(b.starts_at).setZone(zone).toFormat("ccc LLL d 'at' h:mm a");
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
    return `${business.name}: You're booked for ${service.name} with ${staff.name} on ${at}. Code ${b.code}. Reply R to reschedule, X to cancel. ${manageLink(b)} Reply STOP to opt out.`;
  },
  reminder: (b: Row) => {
    const { business, service, staff, at } = bookingContext(b);
    const ask = b.customer_confirmed_at ? "Reply R to reschedule or X to cancel." : "Reply C to confirm, R to reschedule, X to cancel.";
    return `Reminder from ${business.name}: ${service.name} with ${staff.name} on ${at}. ${ask}`;
  },
  rescheduled: (b: Row) => {
    const { business, service, at } = bookingContext(b);
    return `${business.name}: Your ${service.name} is now ${at}. Reply C to confirm or R to change it again.`;
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
      WHERE b.business_id = ? AND b.status IN ('confirmed','pending_payment') AND b.starts_at >= ? AND b.starts_at <= ? ORDER BY b.starts_at`,
    business.id, from, to,
  );
  const label = day.hasSame(DateTime.now().setZone(business.timezone), "day") ? "Today" : day.toFormat("ccc LLL d");
  if (!rows.length) return `${label} at ${business.name}: no appointments.`;
  const lines = rows.slice(0, 12).map((b) => {
    const t = DateTime.fromISO(b.starts_at).setZone(business.timezone).toFormat("h:mm");
    return `${t} ${b.customer_name} (${b.service_name}, ${b.staff_name})${b.customer_confirmed_at ? " ✓" : ""}`;
  });
  return `${label} at ${business.name} — ${rows.length} appt${rows.length > 1 ? "s" : ""}:\n${lines.join("\n")}${rows.length > 12 ? `\n+${rows.length - 12} more` : ""}`;
}
