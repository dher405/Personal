import { Router, type Request } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import { all, audit, newId, one, run, tx } from "../db.js";
import { actorOf, assertBusinessAccess } from "../lib/auth.js";
import { createBooking, getBooking, cancelBooking, refundPayment, rescheduleBooking, serializeBooking } from "../lib/bookings.js";
import { findSlotsLive } from "../lib/availability.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { getPlan, getPlans } from "../lib/plans.js";
import { createStripeOnboarding } from "../payments/stripe.js";
import { startPlanCheckout, openBillingPortal } from "../lib/platformBilling.js";
import { chat } from "../ai/chat.js";
import { aiChatEnabled } from "./public.js";
import { config } from "../config.js";
import { normalizePhone, sendSms, smsLive, templates } from "../lib/sms.js";
import { handleInboundSms } from "../lib/smsInbound.js";
import { parseReminderHours } from "../lib/reminders.js";
import { buyPacks, currentPeriod, meter, usageFor } from "../lib/usage.js";
import { getPacks } from "../lib/plans.js";

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
  const { payment_config, ...rest } = b;
  const cfg = decryptJson<Record<string, any>>(payment_config);
  return {
    ...rest,
    payment_summary: {
      stripeConnected: !!cfg.stripeAccountId,
      squareConfigured: !!cfg.accessToken && !!cfg.locationId,
      squareLocationId: cfg.locationId,
      paypalMerchantId: cfg.merchantId,
    },
    plan_details: getPlan(b.plan),
    ai_chat_active: aiChatEnabled(b),
    sms_usage: { used: meter(b, "sms").used, allowance: meter(b, "sms").limit, live: smsLive() },
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
    require_payment: z.boolean(), ai_enabled: z.boolean(), ai_instructions: z.string().max(4000),
    sms_enabled: z.boolean(), sms_reminder_hours: z.string().max(40), sms_admin_phone: z.string().nullable(),
    sms_admin_alerts: z.boolean(), sms_agenda_hour: z.number().int().min(0).max(23).nullable(),
    sms_staff_reminder_min: z.number().int().min(5).max(24 * 60).nullable(),
  }).partial(), req.body);
  if (body.timezone && !DateTime.local().setZone(body.timezone).isValid) throw badRequest("Unknown timezone");
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
      "INSERT INTO services (id, business_id, name, description, category, duration_min, buffer_min, price_cents, deposit_cents, active) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, bid(req), body.name, body.description, body.category, body.duration_min, body.buffer_min, body.price_cents, body.deposit_cents, Number(body.active),
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
    smsOptIn: z.boolean().optional(),
  }), req.body);
  const booking = createBooking({
    businessId: bid(req), serviceId: body.serviceId, staffId: body.staffId, start: body.start,
    customer: { name: body.name, email: body.email, phone: body.phone }, notes: body.notes,
    source: "admin", force: body.force, priceCentsOverride: body.priceCents, smsOptIn: body.smsOptIn,
  }, actor(req));
  return serializeBooking(booking, { includeToken: true });
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
      "SELECT COALESCE(SUM(amount_cents - refunded_cents - platform_fee_cents), 0) AS n FROM payments WHERE business_id = ? AND status IN ('paid','partially_refunded') AND created_at >= ?",
      b.id, DateTime.fromISO(monthStart!).toFormat("yyyy-MM-dd HH:mm:ss"),
    )!.n,
    currency: b.currency,
  };
}));

adminRouter.get("/audit", h((req) => all("SELECT * FROM audit_log WHERE business_id = ? ORDER BY created_at DESC LIMIT 200", bid(req))));

// ---------- Payment provider setup ----------

adminRouter.put("/payment-provider", h(async (req) => {
  const body = parse(z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("none") }),
    z.object({ provider: z.literal("mock") }),
    z.object({ provider: z.literal("stripe") }),
    z.object({ provider: z.literal("square"), accessToken: z.string().min(10), locationId: z.string().min(3) }),
    z.object({ provider: z.literal("paypal"), merchantId: z.string().min(5) }),
  ]), req.body);
  const b = business(req);
  const cfg = decryptJson<Record<string, any>>(b.payment_config);
  if (body.provider === "mock" && config.isProduction && !config.demoMode) throw badRequest("Mock payments are disabled in production");
  let onboardingUrl: string | undefined;
  if (body.provider === "stripe") {
    const result = await createStripeOnboarding(cfg.stripeAccountId, req.user!.email, `${config.webUrl}/admin/${b.id}/payments`);
    cfg.stripeAccountId = result.accountId;
    onboardingUrl = result.url;
  }
  if (body.provider === "square") Object.assign(cfg, { accessToken: body.accessToken, locationId: body.locationId });
  if (body.provider === "paypal") cfg.merchantId = body.merchantId;
  run("UPDATE businesses SET payment_provider = ?, payment_config = ? WHERE id = ?", body.provider, encryptJson(cfg), b.id);
  audit(actor(req), b.id, "payments.provider_changed", { provider: body.provider });
  return { settings: publicSettings(business(req)), onboardingUrl };
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
    // Auto top-up bills the card on the platform subscription; free plans have none until they buy something.
    canAutoTopUp: !config.stripe.secretKey || !!b.platform_customer_id,
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
  if (enabled && config.stripe.secretKey && !b.platform_customer_id) throw badRequest("Add a card first: subscribe to a plan or buy a pack once, then turn on auto top-up.");
  run("UPDATE businesses SET auto_topup = ? WHERE id = ?", Number(enabled), b.id);
  audit(actor(req), b.id, "usage.auto_topup", { enabled });
  return { ok: true };
}));

adminRouter.post("/billing/checkout", h(async (req) => {
  const body = parse(z.object({ planId: z.string() }), req.body);
  return startPlanCheckout(business(req), body.planId, req.user!, actor(req));
}));

adminRouter.post("/billing/portal", h(async (req) => ({ url: await openBillingPortal(business(req)) })));

// ---------- Admin AI assistant ----------

adminRouter.post("/assistant", h(async (req) => {
  const body = parse(z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(4000) }), req.body);
  const b = business(req);
  if (!getPlan(b.plan).aiChat && req.user!.role !== "superadmin") throw forbidden("The AI assistant is available on paid plans");
  return chat({ kind: "admin", business: b, sessionId: body.sessionId, message: body.message, admin: req.user });
}));

// ---------- Text messages ----------

adminRouter.get("/sms", h((req) => ({
  usage: { used: meter(business(req), "sms").used, allowance: meter(business(req), "sms").limit, live: smsLive() },
  messages: all("SELECT * FROM sms_messages WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200", bid(req)),
})));

adminRouter.post("/sms/test", h(async (req) => {
  const body = parse(z.object({ to: z.string().optional() }), req.body ?? {});
  const b = business(req);
  const to = body.to ?? b.sms_admin_phone;
  if (!to) throw badRequest("Enter a phone number or set the admin alert phone first");
  return sendSms({ business: b, to, body: `${b.name}: test message from Slotwise. Texting is set up.`, kind: "test", audience: "admin", force: true });
}));

/** "Send reminder now" from the bookings screen. Only to customers who agreed to texts. */
adminRouter.post("/bookings/:id/sms-reminder", h(async (req) => {
  const b = ownedBy(getBooking(req.params.id as string), bid(req), "Booking");
  if (!b.sms_opt_in || !b.customer_phone) throw badRequest("This customer hasn't agreed to text messages");
  const msg = await sendSms({ business: business(req), to: b.customer_phone, body: templates.reminder(b), kind: "reminder_manual", audience: "customer", bookingId: b.id });
  if (msg.status === "skipped" || msg.status === "failed") throw badRequest(msg.error ?? "Text not sent");
  return msg;
}));

/** Pretend a phone texted us — lets admins try two-way texting before Twilio is connected. */
adminRouter.post("/sms/simulate", h(async (req) => {
  if (config.isProduction && smsLive()) throw forbidden("The simulator is only available before Twilio is connected");
  const body = parse(z.object({ from: z.string().min(5), body: z.string().min(1).max(1600) }), req.body);
  const replies = await handleInboundSms(body.from, body.body);
  return { replies };
}));
