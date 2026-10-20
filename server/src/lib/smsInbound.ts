import { DateTime } from "luxon";
import { config } from "../config.js";
import { newId, one, run, Row } from "../db.js";
import { aiChatEnabled } from "../routes/public.js";
import { chat } from "../ai/chat.js";
import { findSlotsLive } from "./availability.js";
import { cancelBooking, confirmAttendance, rescheduleBooking } from "./bookings.js";
import { getPlan } from "./plans.js";
import { agendaText, normalizePhone, sendSms, templates } from "./sms.js";
import { smsFrom } from "./channels.js";
import type { AuthUser } from "./auth.js";

/*
 * Two-way texting. Carrier/Twilio opt-out keywords (STOP, CANCEL, END, QUIT,
 * UNSUBSCRIBE, STOPALL) and HELP are reserved, which is why "cancel appointment"
 * is the letter X rather than the word CANCEL.
 */
const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const OPT_IN = new Set(["START", "UNSTOP"]);
const CONFIRM = new Set(["C", "CONFIRM", "CONFIRMED", "Y", "YES", "YEP", "OK"]);
const RESCHEDULE = new Set(["R", "RESCHEDULE", "CHANGE", "MOVE"]);
const CANCEL_APPT = new Set(["X"]);

interface Conversation { phone: string; business_id: string | null; booking_id: string | null; state: any; chat_session_id: string | null }

/** Conversations are per business: the same customer can text two businesses' numbers. */
function conversation(key: string): Conversation {
  const row = one("SELECT * FROM sms_conversations WHERE phone = ?", key);
  return row ? { ...row, state: JSON.parse(row.state) } as Conversation : { phone: key, business_id: null, booking_id: null, state: {}, chat_session_id: null };
}

function saveConversation(c: Conversation) {
  run(
    `INSERT INTO sms_conversations (phone, business_id, booking_id, state, chat_session_id, updated_at) VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET business_id = excluded.business_id, booking_id = excluded.booking_id, state = excluded.state,
       chat_session_id = excluded.chat_session_id, updated_at = excluded.updated_at`,
    c.phone, c.business_id, c.booking_id, JSON.stringify(c.state), c.chat_session_id,
  );
}

function logInbound(business: Row, from: string, body: string, bookingId: string | null, audience: "customer" | "admin") {
  run(
    `INSERT INTO sms_messages (id, business_id, booking_id, direction, audience, kind, to_phone, from_phone, body, status)
     VALUES (?,?,?,'inbound',?,'reply',?,?,?,'received')`,
    newId("sms"), business.id, bookingId, audience, smsFrom(business), from, body,
  );
}

const activeStatuses = "('confirmed','pending_payment')";

/**
 * The booking a customer's text is about: the one in the latest text we sent them
 * (that's what they're replying to), else the conversation's booking, else their next one.
 */
function bookingForPhone(businessId: string, phone: string, convo: Conversation): Row | undefined {
  const now = DateTime.utc().toISO();
  const lastTexted = one(
    `SELECT b.* FROM sms_messages m JOIN bookings b ON b.id = m.booking_id
      WHERE m.business_id = ? AND m.to_phone = ? AND m.direction = 'outbound' AND m.audience = 'customer' AND m.status NOT IN ('skipped','failed')
        AND b.status IN ${activeStatuses} AND b.starts_at > ?
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
    businessId, phone, now,
  );
  if (lastTexted) return lastTexted;
  if (convo.booking_id) {
    const b = one(`SELECT * FROM bookings WHERE id = ? AND business_id = ? AND status IN ${activeStatuses} AND starts_at > ?`, convo.booking_id, businessId, now);
    if (b) return b;
  }
  return one(
    `SELECT * FROM bookings WHERE business_id = ? AND customer_phone = ? AND status IN ${activeStatuses} AND starts_at > ? ORDER BY starts_at LIMIT 1`,
    businessId, phone, now,
  );
}

/** Up to three new times for the same service and staff, spread across different days where possible. */
async function rescheduleOptions(b: Row, business: Row) {
  const today = DateTime.now().setZone(business.timezone);
  const slots = (await findSlotsLive({
    businessId: b.business_id, serviceId: b.service_id, staffId: b.staff_id,
    from: today.toISODate()!, to: today.plus({ days: 14 }).toISODate()!, excludeBookingId: b.id,
  })).filter((s) => s.start !== DateTime.fromISO(b.starts_at).toUTC().toISO());
  const picked: typeof slots = [];
  const days = new Set<string>();
  for (const s of slots) {
    const day = DateTime.fromISO(s.start).setZone(business.timezone).toISODate()!;
    if (!days.has(day)) { days.add(day); picked.push(s); }
    if (picked.length === 3) break;
  }
  for (const s of slots) if (picked.length < 3 && !picked.includes(s)) picked.push(s);
  return picked.slice(0, 3);
}

const fmt = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat("ccc LLL d, h:mm a");

/** Handles one text to a business's number and sends the reply. Returns the messages sent (for the simulator and tests). */
export async function handleInboundSms(business: Row, fromRaw: string, bodyRaw: string): Promise<Row[]> {
  const from = normalizePhone(fromRaw) ?? fromRaw;
  const body = bodyRaw.trim();
  const word = body.toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim();

  if (OPT_OUT.has(word)) {
    run("INSERT OR IGNORE INTO business_sms_opt_outs (business_id, phone) VALUES (?,?)", business.id, from);
    logInbound(business, from, body, null, "customer");
    return []; // Twilio sends the carrier-required opt-out confirmation itself.
  }
  if (OPT_IN.has(word)) {
    run("DELETE FROM business_sms_opt_outs WHERE business_id = ? AND phone = ?", business.id, from);
    logInbound(business, from, body, null, "customer");
    return [];
  }
  if (business.suspended) return [];

  if (business.sms_admin_phone === from) return handleAdminText(business, from, body, word);
  return handleCustomerText(business, from, body, word);
}

async function handleCustomerText(business: Row, from: string, body: string, word: string): Promise<Row[]> {
  const convo = conversation(`${business.id}:${from}`);
  const booking = bookingForPhone(business.id, from, convo);
  if (!booking) {
    logInbound(business, from, body, null, "customer");
    return [await sendSms({
      business, to: from, kind: "reply", audience: "customer",
      body: `We couldn't find an upcoming appointment for this number. Book online: ${config.webUrl}/b/${business.slug}`,
    })];
  }

  logInbound(business, from, body, booking.id, "customer");
  convo.business_id = business.id;
  convo.booking_id = booking.id;
  const actor = { label: `sms:${from}` };
  const reply = async (text: string, kind = "reply") => {
    saveConversation(convo);
    return [await sendSms({ business, to: from, body: text, kind, audience: "customer", bookingId: booking.id })];
  };
  const hoursUntil = DateTime.fromISO(booking.starts_at).diffNow("hours").hours;
  const tooLate = hoursUntil < business.cancellation_hours;
  const callUs = business.phone ? ` Please call ${business.phone}.` : "";

  // Picking one of the numbered times we offered.
  if (convo.state.awaiting === "choice" && convo.state.bookingId !== booking.id) convo.state = {};
  if (convo.state.awaiting === "choice" && /^[1-3]$/.test(word)) {
    const choice = convo.state.options?.[Number(word) - 1];
    convo.state = {};
    if (!choice) return reply("That option has expired. Reply R for new times.");
    try {
      const moved = rescheduleBooking(booking.id, choice.start, { staffId: choice.staffId }, actor);
      return reply(templates.rescheduled(moved), "rescheduled");
    } catch {
      return reply("Sorry, that time was just taken. Reply R for fresh options.");
    }
  }

  if (CONFIRM.has(word)) {
    convo.state = {};
    const b = confirmAttendance(booking.id, actor);
    return reply(`Thanks ${b.customer_name.split(" ")[0]}, you're confirmed for ${fmt(b.starts_at, business.timezone)}. See you then!`, "confirmed_reply");
  }

  if (CANCEL_APPT.has(word)) {
    convo.state = {};
    if (tooLate) return reply(`Online cancellation closes ${business.cancellation_hours}h before your appointment.${callUs}`);
    const b = await cancelBooking(booking.id, { byCustomer: true, reason: "Cancelled by text" }, actor);
    return reply(templates.cancelled(b), "cancelled_reply");
  }

  if (RESCHEDULE.has(word)) {
    if (tooLate) return reply(`Changes by text close ${business.cancellation_hours}h before your appointment.${callUs}`);
    const options = await rescheduleOptions(booking, business);
    if (!options.length) return reply(`No other times are open in the next 2 weeks. Reply X to cancel, or see ${config.webUrl}/manage/${booking.manage_token}`);
    convo.state = { awaiting: "choice", bookingId: booking.id, options: options.map((o) => ({ start: o.start, staffId: o.staffId })) };
    const lines = options.map((o, i) => `${i + 1}) ${fmt(o.start, business.timezone)}`).join("\n");
    const more = aiChatEnabled(business) ? "\nOr tell us a day/time that suits you." : `\nMore times: ${config.webUrl}/manage/${booking.manage_token}`;
    return reply(`Reply 1, 2 or 3 to move your appointment:\n${lines}${more}`, "reschedule_options");
  }

  // Free text ("can I come Thursday at 4 instead?") → the AI booking assistant, when the business has it.
  if (aiChatEnabled(business)) {
    convo.state = {};
    try {
      const result = await chat({
        kind: "customer", business, sessionId: convo.chat_session_id ?? undefined, message: body, channel: "sms",
        context: `Customer texting from ${from} about booking code ${booking.code} (booked with email ${booking.customer_email}). ` +
          `Their phone number is verified, so you may act on this booking without asking for the code or email.`,
      });
      convo.chat_session_id = result.sessionId;
      return reply(result.reply.slice(0, 640), "ai_reply");
    } catch (err) {
      console.error("sms AI reply failed", err);
    }
  }
  return reply(`${business.name}: Reply C to confirm, R to reschedule, or X to cancel your ${fmt(booking.starts_at, business.timezone)} appointment.${callUs}`, "menu");
}

async function handleAdminText(business: Row, from: string, body: string, word: string): Promise<Row[]> {
  const convo = conversation(`admin:${business.id}:${from}`);
  logInbound(business, from, body, null, "admin");
  convo.business_id = business.id;
  const reply = async (text: string, kind = "admin_reply") => {
    saveConversation(convo);
    return [await sendSms({ business, to: from, body: text, kind, audience: "admin" })];
  };
  const today = DateTime.now().setZone(business.timezone);

  if (["TODAY", "AGENDA", "SCHEDULE"].includes(word)) return reply(agendaText(business, today), "agenda_reply");
  if (word === "TOMORROW") return reply(agendaText(business, today.plus({ days: 1 })), "agenda_reply");

  const owner = one<AuthUser>(
    `SELECT u.id, u.email, u.name, u.role FROM business_members m JOIN users u ON u.id = m.user_id
      WHERE m.business_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1`, business.id,
  );
  if (owner && getPlan(business.plan).aiChat && config.ai.apiKey) {
    try {
      const result = await chat({
        kind: "admin", business, sessionId: convo.chat_session_id ?? undefined, message: body, channel: "sms", admin: owner,
        context: `The business admin is texting from ${from}.`,
      });
      convo.chat_session_id = result.sessionId;
      return reply(result.reply.slice(0, 640));
    } catch (err) {
      console.error("admin sms AI failed", err);
    }
  }
  return reply(`Reply TODAY or TOMORROW for your schedule. Manage bookings: ${config.webUrl}/admin/${business.id}/bookings`, "menu");
}

