import { Router, type Request } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import { all, audit, newId, one, run, tx } from "../db.js";
import { actorOf, assertBusinessAccess } from "../lib/auth.js";
import { acceptRequest, createBooking, declineRequest, getBooking, cancelBooking, refundPayment, rescheduleBooking, serializeBooking } from "../lib/bookings.js";
import { findSlotsLive } from "../lib/availability.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { getPlan, getPlans } from "../lib/plans.js";
import { stripeFor } from "../payments/stripe.js";
import { squareFetch } from "../payments/square.js";
import { credsFor as paypalCredsFor, paypalAccessToken } from "../payments/paypal.js";
import { keepPlan, startPlanCheckout, openBillingPortal } from "../lib/platformBilling.js";
import { chat } from "../ai/chat.js";
import { aiChatEnabled } from "./public.js";
import { config } from "../config.js";
import { normalizePhone, sendSms, templates, twilioAuth } from "../lib/sms.js";
import { sendBusinessEmail } from "../lib/email.js";
import { MEETING_LABEL, meetingsReady, prepareMeeting, testMeetings } from "../lib/meetings.js";
import { notify } from "../lib/notify.js";
import { channelsFor, emailReady, saveChannels, smsConfigured, smsLive, smsReady, testModeAllowed, twilioWebhookUrls, type Channels } from "../lib/channels.js";
import { handleInboundSms } from "../lib/smsInbound.js";
import { parseReminderHours } from "../lib/reminders.js";
import { buyPacks, currentPeriod, meter, usageFor } from "../lib/usage.js";
import { getPacks } from "../lib/plans.js";
import { addReply, CATEGORIES, createCase, getCase, serializeCase, type Category } from "../lib/support.js";

export const adminRouter = Router({ mergeParams: true });

/** Every route below is scoped to :bid and requires membership (or super admin). */
adminRouter.use((req, _res, next) => {
  try {
    assertBusinessAccess(req.user, req.params.bid as string);
    next();
  } catch (err) {
    next(err);
  }
});

const bid = (req: Request) => req.params.bid as string;
const business = (req: Request) => one("SELECT * FROM businesses WHERE id = ?", bid(req))!;
const actor = (req: Request) => actorOf(req.user);

function ownedBy<T extends Record<string, any>>(row: T | undefined, businessId: string, what: string): T {
  if (!row || row.business_id !== businessId) throw notFound(`${what} not found`);
  return row;
}

// ---------- Business settings ----------

function publicSettings(b: Record<string, any>) {
  const { payment_config, comms_config, ...rest } = b;
  const cfg = decryptJson<Record<string, any>>(payment_config);
  return {
    ...rest,
    payment_summary: paymentSummary(b, cfg),
    plan_details: getPlan(b.plan),
    ai_chat_active: aiChatEnabled(b),
    // Customer communications go only through the business's own accounts (Email and Text messages tabs).
    email_ready: emailReady(b),
    sms_configured: smsConfigured(b),
    sms_ready: smsReady(b),
    meeting_ready: meetingsReady(b),
    meeting_label: MEETING_LABEL[channelsFor(b).meetings.provider],
    requests_waiting: one("SELECT COUNT(*) AS n FROM bookings WHERE business_id = ? AND status = 'requested'", b.id)!.n,
    // Cases support has answered that the business hasn't replied to yet.
    support_waiting: one("SELECT COUNT(*) AS n FROM support_cases WHERE business_id = ? AND status = 'waiting'", b.id)!.n,
    usage: usageFor(b),
  };
}

adminRouter.get("/", h((req) => publicSettings(business(req))));

adminRouter.patch("/", h((req) => {
  const body = parse(z.object({
    name: z.string().min(2), description: z.string(), category: z.string(), timezone: z.string(),
    currency: z.string().length(3), phone: z.string().nullable(), address: z.string().nullable(),
    slot_interval_min: z.number().int().min(5).max(240), min_notice_min: z.number().int().min(0),
    max_advance_days: z.number().int().min(1).max(730), cancellation_hours: z.number().int().min(0),
    require_payment: z.boolean(), cash_requests: z.boolean(), ai_enabled: z.boolean(), ai_instructions: z.string().max(4000),
    sms_enabled: z.boolean(), sms_reminder_hours: z.string().max(40), sms_admin_phone: z.string().nullable(),
    sms_admin_alerts: z.boolean(), sms_agenda_hour: z.number().int().min(0).max(23).nullable(),
    sms_staff_reminder_min: z.number().int().min(5).max(24 * 60).nullable(),
  }).partial(), req.body);
  if (body.timezone && !DateTime.local().setZone(body.timezone).isValid) throw badRequest("Unknown timezone");
  if (body.sms_enabled && !smsConfigured(business(req))) throw badRequest("Connect your Twilio account first, then switch text messages on");
  if (body.sms_reminder_hours !== undefined) body.sms_reminder_hours = parseReminderHours(body.sms_reminder_hours).join(",");
  if (body.sms_admin_phone) {
    const phone = normalizePhone(body.sms_admin_phone);
    if (!phone) throw badRequest("Admin phone number isn't valid");
    body.sms_admin_phone = phone;
  }
  const entries = Object.entries(body).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v] as const);
  if (entries.length) {
    run(`UPDATE businesses SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, v]) => v), bid(req));
    audit(actor(req), bid(req), "business.updated", body);
  }
  return publicSettings(business(req));
}));

// ---------- Services & prices ----------

const serviceSchema = z.object({
  name: z.string().min(1), description: z.string().default(""), category: z.string().default(""),
  duration_min: z.number().int().min(5).max(24 * 60), buffer_min: z.number().int().min(0).default(0),
  price_cents: z.number().int().min(0), deposit_cents: z.number().int().min(0).default(0),
  active: z.boolean().default(true), staff_ids: z.array(z.string()).optional(),
  location_mode: z.enum(["in_person", "online", "choice"]).default("in_person"),
});

function setServiceStaff(businessId: string, serviceId: string, staffIds?: string[]) {
  if (!staffIds) return;
  run("DELETE FROM staff_services WHERE service_id = ?", serviceId);
  for (const sid of staffIds) {
    ownedBy(one("SELECT * FROM staff WHERE id = ?", sid), businessId, "Staff");
    run("INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)", sid, serviceId);
  }
}

const withStaff = (s: Record<string, any>) => ({ ...s, staff_ids: all("SELECT staff_id FROM staff_services WHERE service_id = ?", s.id).map((r) => r.staff_id) });

adminRouter.get("/services", h((req) => all("SELECT * FROM services WHERE business_id = ? ORDER BY category, name", bid(req)).map(withStaff)));

adminRouter.post("/services", h((req) => {
  const body = parse(serviceSchema, req.body);
  const id = newId("svc");
  tx(() => {
    run(
      "INSERT INTO services (id, business_id, name, description, category, duration_min, buffer_min, price_cents, deposit_cents, active, location_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, bid(req), body.name, body.description, body.category, body.duration_min, body.buffer_min, body.price_cents, body.deposit_cents, Number(body.active), body.location_mode,
    );
    // Default to every staff member so a new service is immediately bookable.
    setServiceStaff(bid(req), id, body.staff_ids ?? all("SELECT id FROM staff WHERE business_id = ?", bid(req)).map((s) => s.id));
  });
  audit(actor(req), bid(req), "service.created", { id, ...body });
  return withStaff(one("SELECT * FROM services WHERE id = ?", id)!);
}));

adminRouter.patch("/services/:id", h((req) => {
  const s = ownedBy(one("SELECT * FROM services WHERE id = ?", req.params.id), bid(req), "Service");
  const body = parse(serviceSchema.partial(), req.body);
  const { staff_ids, ...fields } = body;
  const entries = Object.entries(fields).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v] as const);
  tx(() => {
    if (entries.length) run(`UPDATE services SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, v]) => v), s.id);
    setServiceStaff(bid(req), s.id, staff_ids);
  });
  audit(actor(req), bid(req), "service.updated", { id: s.id, before: { price_cents: s.price_cents }, ...body });
  return withStaff(one("SELECT * FROM services WHERE id = ?", s.id)!);
}));

adminRouter.delete("/services/:id", h((req) => {
  const s = ownedBy(one("SELECT * FROM services WHERE id = ?", req.params.id), bid(req), "Service");
  // Soft-delete: past bookings still reference the service.
  run("UPDATE services SET active = 0 WHERE id = ?", s.id);
  audit(actor(req), bid(req), "service.archived", { id: s.id });
  return { ok: true };
}));

// ---------- Staff, weekly hours, time off ----------

adminRouter.get("/staff", h((req) => all("SELECT * FROM staff WHERE business_id = ? ORDER BY name", bid(req)).map((s) => ({
  ...s,
  hours: all("SELECT id, weekday, start_time, end_time FROM availability_rules WHERE staff_id = ? ORDER BY weekday, start_time", s.id),
  time_off: all("SELECT * FROM time_off WHERE staff_id = ? AND ends_at > ? ORDER BY starts_at", s.id, DateTime.utc().toISO()),
}))));

adminRouter.post("/staff", h((req) => {
  const body = parse(z.object({ name: z.string().min(1), email: z.email().optional(), phone: z.string().optional(), bio: z.string().default("") }), req.body);
  const b = business(req);
  const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM staff WHERE business_id = ? AND active = 1", b.id)!.n;
  if (count >= getPlan(b.plan).maxStaff && req.user!.role !== "superadmin") {
    throw forbidden(`Your ${getPlan(b.plan).name} plan allows ${getPlan(b.plan).maxStaff} staff. Upgrade to add more.`);
  }
  const id = newId("stf");
  run("INSERT INTO staff (id, business_id, name, email, phone, bio) VALUES (?,?,?,?,?,?)", id, b.id, body.name, body.email ?? null, normalizePhone(body.phone) ?? null, body.bio);
  audit(actor(req), b.id, "staff.created", { id, name: body.name });
  return one("SELECT * FROM staff WHERE id = ?", id);
}));

adminRouter.patch("/staff/:id", h((req) => {
  const s = ownedBy(one("SELECT * FROM staff WHERE id = ?", req.params.id), bid(req), "Staff");
  const body = parse(z.object({ name: z.string().min(1), email: z.email().nullable(), phone: z.string().nullable(), bio: z.string(), active: z.boolean() }).partial(), req.body);
  if (body.phone) {
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest("Phone number isn't valid");
    body.phone = phone;
  }
  const entries = Object.entries(body).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v] as const);
  if (entries.length) run(`UPDATE staff SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, v]) => v), s.id);
  audit(actor(req), bid(req), "staff.updated", { id: s.id, ...body });
  return one("SELECT * FROM staff WHERE id = ?", s.id);
}));

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Replaces a staff member's weekly schedule. weekday: 1 = Monday … 7 = Sunday. */
adminRouter.put("/staff/:id/hours", h((req) => {
  const s = ownedBy(one("SELECT * FROM staff WHERE id = ?", req.params.id), bid(req), "Staff");
  const body = parse(z.array(z.object({ weekday: z.number().int().min(1).max(7), start_time: hhmm, end_time: hhmm })), req.body);
  for (const r of body) if (r.end_time <= r.start_time) throw badRequest("Each block must end after it starts");
  tx(() => {
    run("DELETE FROM availability_rules WHERE staff_id = ?", s.id);
    for (const r of body) run("INSERT INTO availability_rules (id, staff_id, weekday, start_time, end_time) VALUES (?,?,?,?,?)", newId("avl"), s.id, r.weekday, r.start_time, r.end_time);
  });
  audit(actor(req), bid(req), "staff.hours_updated", { id: s.id, hours: body });
  return all("SELECT id, weekday, start_time, end_time FROM availability_rules WHERE staff_id = ? ORDER BY weekday, start_time", s.id);
}));

adminRouter.post("/staff/:id/time-off", h((req) => {
  const s = ownedBy(one("SELECT * FROM staff WHERE id = ?", req.params.id), bid(req), "Staff");
  const body = parse(z.object({ starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), reason: z.string().default("") }), req.body);
  const start = DateTime.fromISO(body.starts_at).toUTC(), end = DateTime.fromISO(body.ends_at).toUTC();
  if (end <= start) throw badRequest("Time off must end after it starts");
  const id = newId("off");
  run("INSERT INTO time_off (id, staff_id, starts_at, ends_at, reason) VALUES (?,?,?,?,?)", id, s.id, start.toISO(), end.toISO(), body.reason);
  audit(actor(req), bid(req), "time_off.created", { id, staffId: s.id });
  return one("SELECT * FROM time_off WHERE id = ?", id);
}));

adminRouter.delete("/time-off/:id", h((req) => {
  const t = one("SELECT t.*, s.business_id FROM time_off t JOIN staff s ON s.id = t.staff_id WHERE t.id = ?", req.params.id);
  ownedBy(t, bid(req), "Time off");
  run("DELETE FROM time_off WHERE id = ?", req.params.id);
  return { ok: true };
}));

// ---------- Bookings ----------

adminRouter.get("/bookings", h((req) => {
  const q = parse(z.object({ from: z.string().optional(), to: z.string().optional(), status: z.string().optional(), q: z.string().optional() }), req.query);
  const zone = business(req).timezone;
  const from = DateTime.fromISO(q.from ?? DateTime.now().setZone(zone).toISODate()!, { zone }).startOf("day").toUTC().toISO();
  const to = DateTime.fromISO(q.to ?? DateTime.now().setZone(zone).plus({ days: 30 }).toISODate()!, { zone }).endOf("day").toUTC().toISO();
  const params: unknown[] = [bid(req), from, to];
  let sql = "SELECT * FROM bookings WHERE business_id = ? AND starts_at >= ? AND starts_at <= ?";
  if (q.status) { sql += " AND status = ?"; params.push(q.status); }
  if (q.q) { sql += " AND (customer_name LIKE ? OR customer_email LIKE ? OR code = ?)"; params.push(`%${q.q}%`, `%${q.q}%`, q.q.toUpperCase()); }
  return all(sql + " ORDER BY starts_at LIMIT 500", ...params).map((b) => serializeBooking(b));
}));

adminRouter.get("/slots", h(async (req) => {
  const q = parse(z.object({ serviceId: z.string(), from: z.string(), to: z.string().optional(), staffId: z.string().optional(), excludeBookingId: z.string().optional() }), req.query);
  return findSlotsLive({ businessId: bid(req), serviceId: q.serviceId, from: q.from, to: q.to ?? q.from, staffId: q.staffId, excludeBookingId: q.excludeBookingId });
}));

adminRouter.post("/bookings", h((req) => {
  const body = parse(z.object({
    serviceId: z.string(), staffId: z.string(), start: z.string(), name: z.string().min(1), email: z.email(),
    phone: z.string().optional(), notes: z.string().optional(), priceCents: z.number().int().min(0).optional(), force: z.boolean().optional(),
    smsOptIn: z.boolean().optional(), meetingMode: z.enum(["in_person", "online"]).optional(),
  }), req.body);
  const booking = createBooking({
    businessId: bid(req), serviceId: body.serviceId, staffId: body.staffId, start: body.start,
    customer: { name: body.name, email: body.email, phone: body.phone }, notes: body.notes,
    source: "admin", force: body.force, priceCentsOverride: body.priceCents, smsOptIn: body.smsOptIn, meetingMode: body.meetingMode,
  }, actor(req));
  return serializeBooking(booking, { includeToken: true });
}));

/**
 * An online booking's meeting link: "retry" makes it again with the business's meeting tool; a pasted link
 * replaces it (marked manual, so it's never overwritten). Either way the customer is sent the link.
 */
adminRouter.post("/bookings/:id/meeting", h(async (req) => {
  const b = ownedBy(getBooking(req.params.id as string), bid(req), "Booking");
  if (b.meeting_mode !== "online") throw badRequest("This is an in-person booking");
  const body = parse(z.object({ url: z.url().optional() }), req.body ?? {});
  if (body.url) {
    run("UPDATE bookings SET meeting_provider = 'manual', meeting_url = ?, meeting_external_id = NULL, meeting_error = NULL WHERE id = ?", body.url, b.id);
  } else {
    run("UPDATE bookings SET meeting_url = NULL, meeting_provider = NULL, meeting_error = NULL WHERE id = ? AND meeting_provider != 'manual'", b.id);
    await prepareMeeting(b.id, "confirmed");
  }
  const updated = getBooking(b.id);
  if (!updated.meeting_url) throw badRequest(updated.meeting_error ?? "No meeting link was created");
  audit(actor(req), bid(req), "booking.meeting_link", { bookingId: b.id, provider: updated.meeting_provider });
  // Send the customer the link: the confirmation again, with an updated calendar invite.
  if (updated.status === "confirmed") {
    run("UPDATE bookings SET ics_sequence = ics_sequence + 1 WHERE id = ?", b.id);
    notify("booking_confirmed", getBooking(b.id), "staff");
  }
  return serializeBooking(updated);
}));

/** Pay-in-person requests: accepting makes it a confirmed booking; declining releases the time and tells the customer. */
adminRouter.post("/bookings/:id/accept", h((req) => {
  const b = ownedBy(getBooking(req.params.id as string), bid(req), "Booking");
  return serializeBooking(acceptRequest(b.id, actor(req)));
}));

adminRouter.post("/bookings/:id/decline", h((req) => {
  const b = ownedBy(getBooking(req.params.id as string), bid(req), "Booking");
  const { reason } = parse(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});
  return serializeBooking(declineRequest(b.id, reason, actor(req)));
}));

adminRouter.patch("/bookings/:id", h(async (req) => {
  const b = ownedBy(getBooking(req.params.id as string), bid(req), "Booking");
  const body = parse(z.object({
    start: z.string().optional(), staffId: z.string().optional(), force: z.boolean().optional(),
    status: z.enum(["confirmed", "cancelled", "completed", "no_show"]).optional(),
    priceCents: z.number().int().min(0).optional(), notes: z.string().optional(),
  }), req.body);
  if (body.start || body.staffId) rescheduleBooking(b.id, body.start ?? b.starts_at, { staffId: body.staffId, force: body.force }, actor(req));
  if (body.priceCents !== undefined && body.priceCents !== b.price_cents) {
    run("UPDATE bookings SET price_cents = ? WHERE id = ?", body.priceCents, b.id);
    audit(actor(req), bid(req), "booking.price_changed", { bookingId: b.id, from: b.price_cents, to: body.priceCents });
  }
  if (body.notes !== undefined) run("UPDATE bookings SET notes = ? WHERE id = ?", body.notes, b.id);
  if (body.status === "cancelled") await cancelBooking(b.id, { byCustomer: false }, actor(req));
  else if (body.status && body.status !== b.status) {
    run("UPDATE bookings SET status = ? WHERE id = ?", body.status, b.id);
    audit(actor(req), bid(req), "booking.status_changed", { bookingId: b.id, from: b.status, to: body.status });
  }
  return serializeBooking(getBooking(b.id), { includeToken: true });
}));

adminRouter.post("/payments/:id/refund", h(async (req) => {
  ownedBy(one("SELECT * FROM payments WHERE id = ?", req.params.id), bid(req), "Payment");
  const body = parse(z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().default("") }), req.body ?? {});
  return refundPayment(req.params.id as string, body.amountCents, actor(req), body.reason);
}));

adminRouter.get("/payments", h((req) => all(
  `SELECT p.*, b.code AS booking_code, b.customer_name FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id
    WHERE p.business_id = ? ORDER BY p.created_at DESC LIMIT 500`, bid(req),
)));

adminRouter.get("/stats", h((req) => {
  const b = business(req);
  const monthStart = DateTime.now().setZone(b.timezone).startOf("month").toUTC().toISO();
  return {
    upcoming: one("SELECT COUNT(*) AS n FROM bookings WHERE business_id = ? AND status = 'confirmed' AND starts_at > ?", b.id, DateTime.utc().toISO())!.n,
    bookingsThisMonth: one("SELECT COUNT(*) AS n FROM bookings WHERE business_id = ? AND starts_at >= ? AND status != 'cancelled'", b.id, monthStart)!.n,
    revenueThisMonthCents: one(
      "SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS n FROM payments WHERE business_id = ? AND status IN ('paid','partially_refunded') AND created_at >= ?",
      b.id, DateTime.fromISO(monthStart!).toFormat("yyyy-MM-dd HH:mm:ss"),
    )!.n,
    currency: b.currency,
  };
}));

adminRouter.get("/audit", h((req) => all("SELECT * FROM audit_log WHERE business_id = ? ORDER BY created_at DESC LIMIT 200", bid(req))));

// ---------- Payment provider setup ----------

const mask = (v?: string) => (v ? `••••${v.slice(-4)}` : "");

/** What the Payments tab shows: masked keys and the webhook addresses to paste into each provider. */
function paymentSummary(b: Record<string, any>, cfg: Record<string, any>) {
  return {
    stripeKey: mask(cfg.stripeSecretKey),
    stripeWebhookSecret: mask(cfg.stripeWebhookSecret),
    squareConfigured: !!cfg.accessToken && !!cfg.locationId,
    squareToken: mask(cfg.accessToken),
    squareLocationId: cfg.locationId ?? "",
    squareEnv: cfg.squareEnv || "production",
    squareWebhookKey: mask(cfg.squareWebhookKey),
    paypalClientId: cfg.paypalClientId ?? "",
    paypalClientSecret: mask(cfg.paypalClientSecret),
    paypalEnv: cfg.paypalEnv || "live",
    paypalWebhookId: cfg.paypalWebhookId ?? "",
    webhooks: {
      stripe: `${config.apiUrl}/api/webhooks/stripe/${b.id}`,
      square: `${config.apiUrl}/api/webhooks/square/${b.id}`,
      paypal: `${config.apiUrl}/api/webhooks/paypal/${b.id}`,
    },
  };
}

// Secret fields left blank keep what's already saved, so admins never have to retype them.
const keep = (next: string | undefined, prev: string | undefined) => (next && next.trim() ? next.trim() : prev);

/** Businesses take payments with their own Stripe, Square or PayPal account; Slotwise takes no cut. */
adminRouter.put("/payment-provider", h(async (req) => {
  const body = parse(z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("none") }),
    z.object({ provider: z.literal("mock") }),
    z.object({ provider: z.literal("stripe"), secretKey: z.string().optional(), webhookSecret: z.string().optional() }),
    z.object({
      provider: z.literal("square"), accessToken: z.string().optional(), locationId: z.string().min(3),
      squareEnv: z.enum(["sandbox", "production"]).optional(), webhookKey: z.string().optional(),
    }),
    z.object({
      provider: z.literal("paypal"), clientId: z.string().optional(), clientSecret: z.string().optional(),
      paypalEnv: z.enum(["sandbox", "live"]).optional(), webhookId: z.string().optional(),
    }),
  ]), req.body);
  const b = business(req);
  const cfg = decryptJson<Record<string, any>>(b.payment_config);
  if (body.provider === "mock" && config.isProduction && !config.demoMode) throw badRequest("Test mode payments are turned off on this platform");

  if (body.provider === "stripe") {
    cfg.stripeSecretKey = keep(body.secretKey, cfg.stripeSecretKey);
    cfg.stripeWebhookSecret = keep(body.webhookSecret, cfg.stripeWebhookSecret);
    if (!cfg.stripeSecretKey?.startsWith("sk_") && !cfg.stripeSecretKey?.startsWith("rk_")) throw badRequest("Enter your Stripe secret key (starts with sk_live_ or sk_test_)");
  }
  if (body.provider === "square") {
    cfg.accessToken = keep(body.accessToken, cfg.accessToken);
    cfg.locationId = body.locationId.trim();
    cfg.squareEnv = body.squareEnv ?? cfg.squareEnv;
    cfg.squareWebhookKey = keep(body.webhookKey, cfg.squareWebhookKey);
    if (!cfg.accessToken) throw badRequest("Enter your Square access token");
  }
  if (body.provider === "paypal") {
    cfg.paypalClientId = keep(body.clientId, cfg.paypalClientId);
    cfg.paypalClientSecret = keep(body.clientSecret, cfg.paypalClientSecret);
    cfg.paypalEnv = body.paypalEnv ?? cfg.paypalEnv ?? "live";
    cfg.paypalWebhookId = keep(body.webhookId, cfg.paypalWebhookId);
    if (!cfg.paypalClientId || !cfg.paypalClientSecret) throw badRequest("Enter your PayPal client ID and secret");
  }
  run("UPDATE businesses SET payment_provider = ?, payment_config = ? WHERE id = ?", body.provider, encryptJson(cfg), b.id);
  audit(actor(req), b.id, "payments.provider_changed", { provider: body.provider });
  return { settings: publicSettings(business(req)) };
}));

/** "Test connection" on the Payments tab: one harmless call with the saved keys. */
adminRouter.post("/payment-provider/test", h(async (req) => {
  const b = business(req);
  try {
    if (b.payment_provider === "stripe") {
      const acct = await stripeFor(b).accounts.retrieveCurrent();
      return { ok: true, message: `Connected to your Stripe account ${acct.settings?.dashboard?.display_name ?? acct.email ?? acct.id}${acct.charges_enabled ? "" : " (not activated for payments yet; finish setup in Stripe)"}` };
    }
    if (b.payment_provider === "square") {
      const cfg = decryptJson<any>(b.payment_config);
      const { json } = await squareFetch(b, `/v2/locations/${encodeURIComponent(cfg.locationId)}`);
      return { ok: true, message: `Connected to Square location "${json.location?.name}" (${cfg.squareEnv || "production"})` };
    }
    if (b.payment_provider === "paypal") {
      const creds = paypalCredsFor(b);
      await paypalAccessToken(creds);
      return { ok: true, message: `Your PayPal app is working (${creds.env})` };
    }
    if (b.payment_provider === "mock") return { ok: true, message: "Test mode: bookings 'pay' instantly with no real money" };
    return { ok: false, message: "No online payment provider chosen" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}));

// ---------- Platform plan (what the business pays us) ----------

adminRouter.get("/plans", h(() => getPlans()));

// ---------- Usage (usage-based pricing) ----------

adminRouter.get("/usage", h((req) => {
  const b = business(req);
  return {
    period: currentPeriod(),
    resetsOn: DateTime.utc().plus({ months: 1 }).startOf("month").toISODate(),
    meters: usageFor(b),
    packs: getPacks(),
    autoTopUp: !!b.auto_topup,
    // Auto top-ups are added to the next plan invoice, so they need a paid plan subscription to land on.
    canAutoTopUp: !config.stripe.secretKey || !!b.platform_subscription_id,
    purchases: all("SELECT metric, quantity, source, price_cents, charge_status, created_at FROM usage_credits WHERE business_id = ? ORDER BY created_at DESC LIMIT 50", b.id),
  };
}));

adminRouter.post("/usage/packs", h(async (req) => {
  const body = parse(z.object({ packId: z.string(), packs: z.number().int().min(1).max(20) }), req.body);
  return buyPacks(business(req), body.packId, body.packs, req.user!);
}));

adminRouter.put("/usage/auto-topup", h((req) => {
  const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
  const b = business(req);
  if (enabled && config.stripe.secretKey && !b.platform_subscription_id) throw badRequest("Auto top-up is added to your monthly plan invoice, so it needs a paid plan. Upgrade first, or buy packs as you need them.");
  run("UPDATE businesses SET auto_topup = ? WHERE id = ?", Number(enabled), b.id);
  audit(actor(req), b.id, "usage.auto_topup", { enabled });
  return { ok: true };
}));

adminRouter.post("/billing/checkout", h(async (req) => {
  const body = parse(z.object({ planId: z.string() }), req.body);
  return startPlanCheckout(business(req), body.planId, req.user!, actor(req));
}));

adminRouter.post("/billing/keep", h(async (req) => {
  await keepPlan(business(req), actor(req));
  return { ok: true };
}));

adminRouter.post("/billing/portal", h(async (req) => ({ url: await openBillingPortal(business(req)) })));

// ---------- Support cases (this business ↔ the platform) ----------

adminRouter.get("/support", h((req) => ({
  categories: CATEGORIES,
  cases: all("SELECT * FROM support_cases WHERE business_id = ? ORDER BY updated_at DESC", bid(req)).map((c) => serializeCase(c)),
})));

adminRouter.post("/support", h((req) => {
  const body = parse(z.object({
    subject: z.string().trim().min(3).max(150), body: z.string().trim().min(5).max(10_000),
    replyEmail: z.email(), category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]).default("other"),
  }), req.body);
  return serializeCase(createCase(business(req), req.user!, body), true);
}));

const caseOf = (req: Request) => ownedBy(getCase(req.params.cid as string), bid(req), "Case");

adminRouter.get("/support/:cid", h((req) => serializeCase(caseOf(req), true)));

adminRouter.post("/support/:cid/messages", h((req) => {
  const c = caseOf(req);
  const body = parse(z.object({ body: z.string().max(10_000).default(""), resolved: z.boolean().optional() }), req.body);
  // The business can reply (reopening the case) or say it's sorted.
  return serializeCase(addReply(c.id, req.user!, "business", body.body, body.resolved ? "resolved" : undefined), true);
}));

// ---------- Admin AI assistant ----------

adminRouter.post("/assistant", h(async (req) => {
  const body = parse(z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(4000) }), req.body);
  const b = business(req);
  if (!getPlan(b.plan).aiChat && req.user!.role !== "superadmin") throw forbidden("The AI assistant is available on paid plans");
  return chat({ kind: "admin", business: b, sessionId: body.sessionId, message: body.message, admin: req.user });
}));

// ---------- Customer communications: the business's own email and Twilio accounts ----------

function commsSummary(b: Record<string, any>) {
  const { email: e, sms: t } = channelsFor(b);
  return {
    testModeAllowed: testModeAllowed(),
    email: {
      provider: e.provider, ready: emailReady(b), fromName: e.fromName ?? "", fromEmail: e.fromEmail ?? "", replyTo: e.replyTo ?? "",
      smtpHost: e.smtpHost ?? "", smtpPort: e.smtpPort ?? null, smtpSecurity: e.smtpSecurity ?? "", smtpUser: e.smtpUser ?? "",
      smtpPass: mask(e.smtpPass), resendApiKey: mask(e.resendApiKey),
    },
    sms: {
      provider: t.provider, configured: smsConfigured(b), live: smsLive(b),
      accountSid: t.accountSid ?? "", authToken: mask(t.authToken), messagingServiceSid: t.messagingServiceSid ?? "", fromNumber: t.fromNumber ?? "",
      webhooks: twilioWebhookUrls(b.id),
    },
  };
}

adminRouter.get("/communications", h((req) => ({
  ...commsSummary(business(req)),
  emails: all("SELECT * FROM email_messages WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100", bid(req)),
})));

adminRouter.put("/communications/email", h((req) => {
  const body = parse(z.object({
    provider: z.enum(["none", "smtp", "resend"]),
    fromName: z.string().max(100).optional(), fromEmail: z.string().email().or(z.literal("")).optional(), replyTo: z.string().email().or(z.literal("")).optional(),
    smtpHost: z.string().max(200).optional(), smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    smtpSecurity: z.enum(["ssl", "starttls"]).or(z.literal("")).optional(), smtpUser: z.string().max(200).optional(), smtpPass: z.string().max(500).optional(),
    resendApiKey: z.string().max(200).optional(),
  }), req.body);
  const b = business(req);
  const channels: Channels = channelsFor(b);
  const saved = channels.email;
  if (body.provider !== "none" && !body.fromEmail) throw badRequest("Enter the email address customers should get emails from");
  channels.email = {
    provider: body.provider, fromName: body.fromName?.trim() || undefined, fromEmail: body.fromEmail || undefined, replyTo: body.replyTo || undefined,
    smtpHost: body.smtpHost?.trim() || undefined, smtpPort: body.smtpPort ?? undefined, smtpSecurity: body.smtpSecurity || undefined,
    smtpUser: body.smtpUser?.trim() || undefined, smtpPass: keep(body.smtpPass, saved.smtpPass), resendApiKey: keep(body.resendApiKey, saved.resendApiKey),
  };
  saveChannels(b.id, channels);
  audit(actor(req), b.id, "communications.email_updated", { provider: body.provider, fromEmail: body.fromEmail });
  return commsSummary(business(req));
}));

adminRouter.put("/communications/sms", h((req) => {
  const body = parse(z.object({
    provider: z.enum(["none", "twilio", "test"]),
    accountSid: z.string().max(64).optional(), authToken: z.string().max(128).optional(),
    messagingServiceSid: z.string().max(64).optional(), fromNumber: z.string().max(32).optional(),
  }), req.body);
  if (body.provider === "test" && !testModeAllowed()) throw badRequest("Test mode isn't available on this platform");
  const b = business(req);
  const channels: Channels = channelsFor(b);
  const fromNumber = body.fromNumber?.trim() ? normalizePhone(body.fromNumber) : undefined;
  if (body.fromNumber?.trim() && !fromNumber) throw badRequest("The Twilio phone number isn't valid");
  channels.sms = {
    provider: body.provider, accountSid: body.accountSid?.trim() || undefined, authToken: keep(body.authToken, channels.sms.authToken),
    messagingServiceSid: body.messagingServiceSid?.trim() || undefined, fromNumber: fromNumber ?? undefined,
  };
  saveChannels(b.id, channels);
  // Without a working channel, texting is switched off so customers aren't offered it.
  if (!smsConfigured(business(req))) run("UPDATE businesses SET sms_enabled = 0 WHERE id = ?", b.id);
  audit(actor(req), b.id, "communications.sms_updated", { provider: body.provider, accountSid: body.accountSid, fromNumber });
  return commsSummary(business(req));
}));

/** Sends a real email through the business's own account to whoever is signed in, so they can see it arrive. */
adminRouter.post("/communications/email/test", h(async (req) => {
  const b = business(req);
  const to = parse(z.object({ to: z.string().email().optional() }), req.body ?? {}).to ?? req.user!.email;
  if (!emailReady(b)) throw badRequest("Save your email settings first");
  const msg = await sendBusinessEmail(b, {
    kind: "test", to, subject: `Test email from ${b.name}`,
    text: `This is a test from your Slotwise booking system.\n\nIf you can read this, customer emails for ${b.name} are set up: booking confirmations, changes and cancellations will be sent from ${channelsFor(b).email.fromEmail}.`,
  });
  if (msg.status !== "sent") throw badRequest(`The email wasn't sent: ${msg.error}`);
  return { ok: true, message: `Sent to ${to}. Check that inbox (and its spam folder).` };
}));

/** Checks the Twilio credentials and that the number or Messaging Service belongs to the account. */
adminRouter.post("/communications/sms/check", h(async (req) => {
  const t = channelsFor(business(req)).sms;
  if (t.provider === "test") return { ok: true, message: "Test mode: texts are recorded in the message log and never sent." };
  if (t.provider !== "twilio" || !t.accountSid || !t.authToken) throw badRequest("Save your Twilio Account SID and Auth token first");
  const get = async (path: string) => {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}${path}`, { headers: { Authorization: twilioAuth(t) } });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) as any };
  };
  const account = await get(".json");
  if (!account.ok) throw badRequest(account.status === 401 ? "Twilio didn't accept that Account SID and Auth token" : account.json.message ?? `Twilio said ${account.status}`);
  let sender = "";
  if (t.messagingServiceSid) {
    const res = await fetch(`https://messaging.twilio.com/v1/Services/${t.messagingServiceSid}`, { headers: { Authorization: twilioAuth(t) } });
    if (!res.ok) throw badRequest(`Connected to "${account.json.friendly_name}", but Messaging Service ${t.messagingServiceSid} wasn't found in that account`);
    sender = ` using Messaging Service "${(await res.json() as any).friendly_name}"`;
  } else if (t.fromNumber) {
    const nums = await get(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(t.fromNumber)}`);
    if (!nums.json.incoming_phone_numbers?.length) throw badRequest(`Connected to "${account.json.friendly_name}", but ${t.fromNumber} isn't a number in that account`);
    sender = ` sending from ${t.fromNumber}`;
  }
  return { ok: true, message: `Connected to Twilio account "${account.json.friendly_name}"${sender}.` };
}));

// ---------- Online meetings: the business's own meeting tool ----------

function meetingSummary(b: Record<string, any>) {
  const m = channelsFor(b).meetings;
  return {
    provider: m.provider, ready: meetingsReady(b), label: MEETING_LABEL[m.provider],
    zoomAccountId: m.zoomAccountId ?? "", zoomClientId: m.zoomClientId ?? "", zoomClientSecret: mask(m.zoomClientSecret),
    rcClientId: m.rcClientId ?? "", rcClientSecret: mask(m.rcClientSecret), rcJwt: mask(m.rcJwt),
    customUrl: m.customUrl ?? "",
    // Google Meet / Teams links are made in each staff member's connected calendar.
    staff: all(
      `SELECT s.id, s.name, (SELECT GROUP_CONCAT(provider) FROM calendar_connections c WHERE c.staff_id = s.id) AS calendars
         FROM staff s WHERE s.business_id = ? AND s.active = 1 ORDER BY s.name`, b.id,
    ).map((s) => ({ id: s.id, name: s.name, calendars: s.calendars ? String(s.calendars).split(",") : [] })),
    onlineServices: all("SELECT id, name, location_mode FROM services WHERE business_id = ? AND location_mode != 'in_person' AND active = 1", b.id),
  };
}

adminRouter.get("/meetings", h((req) => meetingSummary(business(req))));

adminRouter.put("/meetings", h((req) => {
  const body = parse(z.object({
    provider: z.enum(["none", "google_meet", "teams", "zoom", "ringcentral", "custom"]),
    zoomAccountId: z.string().max(100).optional(), zoomClientId: z.string().max(100).optional(), zoomClientSecret: z.string().max(200).optional(),
    rcClientId: z.string().max(100).optional(), rcClientSecret: z.string().max(200).optional(), rcJwt: z.string().max(4000).optional(),
    customUrl: z.url().or(z.literal("")).optional(),
  }), req.body);
  const b = business(req);
  const channels = channelsFor(b);
  const saved = channels.meetings;
  channels.meetings = {
    provider: body.provider,
    zoomAccountId: body.zoomAccountId?.trim() || undefined, zoomClientId: body.zoomClientId?.trim() || undefined,
    zoomClientSecret: keep(body.zoomClientSecret, saved.zoomClientSecret),
    rcClientId: body.rcClientId?.trim() || undefined, rcClientSecret: keep(body.rcClientSecret, saved.rcClientSecret), rcJwt: keep(body.rcJwt, saved.rcJwt),
    customUrl: body.customUrl || undefined,
  };
  saveChannels(b.id, channels);
  audit(actor(req), b.id, "meetings.updated", { provider: body.provider });
  return meetingSummary(business(req));
}));

adminRouter.post("/meetings/test", h(async (req) => {
  try {
    return { ok: true, message: await testMeetings(business(req)) };
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}));

// ---------- Text messages ----------

adminRouter.get("/sms", h((req) => ({
  configured: smsConfigured(business(req)),
  live: smsLive(business(req)),
  messages: all("SELECT * FROM sms_messages WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200", bid(req)),
})));

adminRouter.post("/sms/test", h(async (req) => {
  const body = parse(z.object({ to: z.string().optional() }), req.body ?? {});
  const b = business(req);
  const to = body.to ?? b.sms_admin_phone;
  if (!to) throw badRequest("Enter a phone number or set the admin alert phone first");
  const msg = await sendSms({ business: b, to, body: `${b.name}: test message from Slotwise. Texting is set up.`, kind: "test", audience: "admin", force: true });
  if (msg.status === "skipped" || msg.status === "failed") throw badRequest(msg.error ?? "Text not sent");
  return msg;
}));

/** "Send reminder now" from the bookings screen. Only to customers who agreed to texts. */
adminRouter.post("/bookings/:id/sms-reminder", h(async (req) => {
  const b = ownedBy(getBooking(req.params.id as string), bid(req), "Booking");
  if (!b.sms_opt_in || !b.customer_phone) throw badRequest("This customer hasn't agreed to text messages");
  const msg = await sendSms({ business: business(req), to: b.customer_phone, body: templates.reminder(b), kind: "reminder_manual", audience: "customer", bookingId: b.id });
  if (msg.status === "skipped" || msg.status === "failed") throw badRequest(msg.error ?? "Text not sent");
  return msg;
}));

/** Pretend a phone texted the business — lets admins try two-way texting in test mode. */
adminRouter.post("/sms/simulate", h(async (req) => {
  const b = business(req);
  if (channelsFor(b).sms.provider !== "test" || !testModeAllowed()) throw forbidden("The reply simulator only works in test mode");
  const body = parse(z.object({ from: z.string().min(5), body: z.string().min(1).max(1600) }), req.body);
  const replies = await handleInboundSms(b, body.from, body.body);
  return { replies };
}));
