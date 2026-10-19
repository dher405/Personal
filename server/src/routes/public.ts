import { Router } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import { all, one } from "../db.js";
import { findSlotsLive, freeInConnectedCalendars } from "../lib/availability.js";
import { cancelBooking, confirmAttendance, createBooking, rescheduleBooking, serializeBooking, startPayment } from "../lib/bookings.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { getPlan } from "../lib/plans.js";
import { aiAvailable, chat } from "../ai/chat.js";
import { customerIcs } from "../lib/ics.js";
import { rateLimit } from "../lib/rateLimit.js";

export const publicRouter = Router();

function businessBySlug(slug: string) {
  const b = one("SELECT * FROM businesses WHERE slug = ? AND suspended = 0", slug);
  if (!b) throw notFound("Business not found");
  return b;
}

export const aiChatEnabled = (b: Record<string, any>) => !!b.ai_enabled && getPlan(b.plan).aiChat && aiAvailable();

publicRouter.get("/businesses", h((req) => {
  const q = `%${String(req.query.q ?? "").trim()}%`;
  return all("SELECT name, slug, category, description, address FROM businesses WHERE suspended = 0 AND (name LIKE ? OR category LIKE ?) ORDER BY name LIMIT 50", q, q);
}));

publicRouter.get("/businesses/:slug", h((req) => {
  const b = businessBySlug(req.params.slug as string);
  return {
    id: b.id, name: b.name, slug: b.slug, description: b.description, category: b.category,
    timezone: b.timezone, currency: b.currency, phone: b.phone, address: b.address,
    cancellationHours: b.cancellation_hours, requirePayment: !!b.require_payment && b.payment_provider !== "none",
    aiChat: aiChatEnabled(b),
    smsEnabled: !!b.sms_enabled,
    services: all("SELECT id, name, description, category, duration_min, price_cents, deposit_cents FROM services WHERE business_id = ? AND active = 1 ORDER BY category, name", b.id),
    staff: all(
      `SELECT s.id, s.name, s.bio, GROUP_CONCAT(ss.service_id) AS service_ids FROM staff s
         LEFT JOIN staff_services ss ON ss.staff_id = s.id WHERE s.business_id = ? AND s.active = 1 GROUP BY s.id ORDER BY s.name`, b.id,
    ).map((s) => ({ ...s, service_ids: s.service_ids ? String(s.service_ids).split(",") : [] })),
  };
}));

publicRouter.get("/businesses/:slug/slots", h((req) => {
  const b = businessBySlug(req.params.slug as string);
  const q = parse(z.object({ serviceId: z.string(), from: z.string(), to: z.string().optional(), staffId: z.string().optional() }), req.query);
  return findSlotsLive({ businessId: b.id, serviceId: q.serviceId, from: q.from, to: q.to ?? q.from, staffId: q.staffId });
}));

publicRouter.post("/businesses/:slug/bookings", rateLimit({ windowMs: 60_000, max: 10 }), h(async (req) => {
  const b = businessBySlug(req.params.slug as string);
  const body = parse(z.object({
    serviceId: z.string(),
    staffId: z.string().optional(),
    start: z.string(),
    name: z.string().min(1),
    email: z.email(),
    phone: z.string().optional(),
    notes: z.string().max(1000).optional(),
    source: z.enum(["web", "mobile"]).default("web"),
    smsOptIn: z.boolean().optional(),
  }), req.body);
  if (body.staffId && !(await freeInConnectedCalendars(b.id, body.staffId, body.start, body.serviceId))) throw conflict("That time is no longer available");
  const booking = createBooking({
    businessId: b.id, serviceId: body.serviceId, staffId: body.staffId, start: body.start,
    customer: { name: body.name, email: body.email, phone: body.phone },
    customerId: req.user?.id, notes: body.notes, source: body.source, smsOptIn: body.smsOptIn,
  }, req.user ? { id: req.user.id, label: req.user.email } : { label: `guest:${body.email}` });
  const paymentUrl = booking.status === "pending_payment" ? await startPayment(booking.id) : undefined;
  return { booking: serializeBooking(booking, { includeToken: true }), paymentUrl };
}));

publicRouter.post("/businesses/:slug/chat", rateLimit({ windowMs: 60_000, max: 15 }), h(async (req) => {
  const b = businessBySlug(req.params.slug as string);
  if (!aiChatEnabled(b)) throw notFound("Chat is not enabled for this business");
  const body = parse(z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(4000) }), req.body);
  return chat({ kind: "customer", business: b, sessionId: body.sessionId, message: body.message });
}));

// --- Self-service via the private manage link sent to the customer ---

function bookingByToken(token: string) {
  const b = one("SELECT * FROM bookings WHERE manage_token = ?", token);
  if (!b) throw notFound("Booking not found");
  return b;
}

publicRouter.get("/manage/:token", h((req) => {
  const b = bookingByToken(req.params.token as string);
  const biz = one("SELECT name, slug, timezone, cancellation_hours, phone FROM businesses WHERE id = ?", b.business_id)!;
  return { booking: serializeBooking(b, { includeToken: true }), business: biz };
}));

publicRouter.post("/manage/:token/reschedule", h(async (req) => {
  const b = bookingByToken(req.params.token as string);
  const body = parse(z.object({ start: z.string(), staffId: z.string().optional() }), req.body);
  const biz = one("SELECT cancellation_hours FROM businesses WHERE id = ?", b.business_id)!;
  if (DateTime.fromISO(b.starts_at).diffNow("hours").hours < biz.cancellation_hours) {
    throw forbidden(`Online changes close ${biz.cancellation_hours}h before the appointment`);
  }
  if (!(await freeInConnectedCalendars(b.business_id, body.staffId ?? b.staff_id, body.start, b.service_id))) throw conflict("That time is not available");
  return serializeBooking(rescheduleBooking(b.id, body.start, { staffId: body.staffId }, { label: `customer:${b.customer_email}` }), { includeToken: true });
}));

publicRouter.post("/manage/:token/cancel", h(async (req) => {
  const b = bookingByToken(req.params.token as string);
  const updated = await cancelBooking(b.id, { byCustomer: true, reason: req.body?.reason }, { label: `customer:${b.customer_email}` });
  return serializeBooking(updated, { includeToken: true });
}));

publicRouter.post("/manage/:token/confirm", h((req) => {
  const b = bookingByToken(req.params.token as string);
  return serializeBooking(confirmAttendance(b.id, { label: `customer:${b.customer_email}` }), { includeToken: true });
}));

/** "Add to Apple Calendar / Outlook": an .ics file the calendar app opens directly. */
publicRouter.get("/manage/:token/calendar.ics", h((req, res) => {
  const b = bookingByToken(req.params.token as string);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="booking-${b.code}.ics"`);
  res.send(customerIcs(b));
}));

publicRouter.post("/manage/:token/pay", h(async (req) => {
  const b = bookingByToken(req.params.token as string);
  return { paymentUrl: await startPayment(b.id) };
}));
