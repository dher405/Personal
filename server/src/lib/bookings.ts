import { DateTime } from "luxon";
import { all, audit, newId, one, run, tx, Row } from "../db.js";
import { providerFor } from "../payments/index.js";
import { config } from "../config.js";
import { findSlots, isSlotAvailable } from "./availability.js";
import { randomCode, randomToken } from "./crypto.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { changedBy, notify } from "./notify.js";
import { normalizePhone } from "./sms.js";
import { smsReady } from "./channels.js";
import { addToCalendarLinks } from "./ics.js";
import { hasCapacity, recordUse } from "./usage.js";
import { HttpError } from "./errors.js";

type Actor = { id?: string | null; label: string };

export interface NewBooking {
  businessId: string;
  serviceId: string;
  staffId?: string;
  start: string;
  customer: { name: string; email: string; phone?: string };
  customerId?: string;
  notes?: string;
  source: "web" | "mobile" | "ai" | "admin";
  /** Customer agreed to booking texts (required before we send any). */
  smsOptIn?: boolean;
  /** Admins may book outside published hours (e.g. a squeeze-in). */
  force?: boolean;
  priceCentsOverride?: number;
  /** Customer asks to pay in person instead of online; the business accepts or declines the request. */
  payInPerson?: boolean;
}

export function serializeBooking(b: Row, opts: { includeToken?: boolean } = {}) {
  const service = one("SELECT name, duration_min FROM services WHERE id = ?", b.service_id);
  const staff = one("SELECT name FROM staff WHERE id = ?", b.staff_id);
  const payments = all(
    "SELECT id, provider, amount_cents, refunded_cents, status, checkout_url, created_at FROM payments WHERE booking_id = ? ORDER BY created_at",
    b.id,
  );
  return {
    id: b.id,
    code: b.code,
    businessId: b.business_id,
    serviceId: b.service_id,
    serviceName: service?.name,
    staffId: b.staff_id,
    staffName: staff?.name,
    customerName: b.customer_name,
    customerEmail: b.customer_email,
    customerPhone: b.customer_phone,
    start: b.starts_at,
    end: b.ends_at,
    status: b.status,
    payInPerson: !!b.pay_in_person,
    declineReason: b.decline_reason ?? null,
    smsOptIn: !!b.sms_opt_in,
    customerConfirmedAt: b.customer_confirmed_at,
    priceCents: b.price_cents,
    currency: b.currency,
    notes: b.notes,
    source: b.source,
    createdAt: b.created_at,
    payments,
    ...(opts.includeToken
      ? { manageToken: b.manage_token, manageUrl: `${config.webUrl}/manage/${b.manage_token}`, calendarLinks: addToCalendarLinks(b) }
      : {}),
  };
}

export function getBooking(id: string) {
  const b = one("SELECT * FROM bookings WHERE id = ?", id);
  if (!b) throw notFound("Booking not found");
  return b;
}

export function createBooking(input: NewBooking, actor: Actor) {
  const business = one("SELECT * FROM businesses WHERE id = ?", input.businessId);
  if (!business || business.suspended) throw notFound("Business not available");
  const service = one("SELECT * FROM services WHERE id = ? AND business_id = ? AND active = 1", input.serviceId, input.businessId);
  if (!service) throw badRequest("Unknown service");

  const start = DateTime.fromISO(input.start, { zone: "utc" });
  if (!start.isValid) throw badRequest("Invalid start time");
  // Usage-based plans: every booking counts toward the month's allowance; when it's used up, new ones pause.
  if (!hasCapacity(business, "bookings")) {
    throw new HttpError(403, input.source === "admin"
      ? "You've used all the bookings in your plan this month. Add more or upgrade under Plan & billing to keep booking."
      : `${business.name} isn't taking online bookings right now.${business.phone ? ` Please call ${business.phone}.` : " Please contact them directly."}`);
  }

  return tx(() => {
    let staffId = input.staffId;
    if (!input.force) {
      if (staffId) {
        if (!isSlotAvailable(business.id, service.id, staffId, start.toISO()!)) throw conflict("That time is no longer available");
      } else {
        const day = start.setZone(business.timezone).toISODate()!;
        const match = findSlots({ businessId: business.id, serviceId: service.id, from: day, to: day })
          .find((s) => DateTime.fromISO(s.start).toMillis() === start.toMillis());
        if (!match) throw conflict("That time is no longer available");
        staffId = match.staffId;
      }
    } else if (!staffId) {
      throw badRequest("staffId is required when forcing a booking");
    }

    const price = input.priceCentsOverride ?? service.price_cents;
    const needsPayment = business.require_payment && business.payment_provider !== "none" && price > 0 && input.source !== "admin";
    // Paying in person instead of online makes it a request: the slot is held until the business accepts or declines.
    const requested = needsPayment && !!input.payInPerson;
    if (requested && !business.cash_requests) throw badRequest(`${business.name} takes payment online when you book.`);
    const status = requested ? "requested" : needsPayment ? "pending_payment" : "confirmed";
    const id = newId("bk");
    run(
      `INSERT INTO bookings (id, code, manage_token, business_id, service_id, staff_id, customer_id, customer_name, customer_email,
         customer_phone, starts_at, ends_at, status, price_cents, currency, notes, source, sms_opt_in, pay_in_person)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, randomCode(), randomToken(), business.id, service.id, staffId, input.customerId ?? null,
      input.customer.name, input.customer.email.toLowerCase(),
      input.customer.phone ? normalizePhone(input.customer.phone) ?? input.customer.phone : null,
      start.toISO(), start.plus({ minutes: service.duration_min }).toISO(),
      status, price, business.currency, input.notes ?? "", input.source,
      // Consent to texts only counts if the business actually offers texting.
      Number(!!input.smsOptIn && !!input.customer.phone && smsReady(business)),
      Number(requested),
    );
    audit(actor, business.id, "booking.created", { bookingId: id, start: start.toISO(), source: input.source });
    const booking = getBooking(id);
    // A request counts toward the plan only once the business accepts it.
    if (requested) notify("booking_requested", booking, "customer");
    if (!needsPayment) notify("booking_confirmed", booking, input.source === "admin" ? "staff" : "customer");
    if (!needsPayment) recordUse(business, "bookings", id);
    return booking;
  });
}

/** Creates a hosted checkout for the booking's price (or deposit) through the business's provider. */
export async function startPayment(bookingId: string) {
  const booking = getBooking(bookingId);
  const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id)!;
  const service = one("SELECT * FROM services WHERE id = ?", booking.service_id)!;
  const amount = service.deposit_cents > 0 ? Math.min(service.deposit_cents, booking.price_cents) : booking.price_cents;
  if (amount <= 0) throw badRequest("Nothing to pay");

  const existing = one("SELECT * FROM payments WHERE booking_id = ? AND status = 'pending' AND checkout_url IS NOT NULL", booking.id);
  if (existing) return existing.checkout_url as string;

  const provider = providerFor(business.payment_provider);
  const paymentId = newId("pay");
  run(
    "INSERT INTO payments (id, booking_id, business_id, provider, amount_cents, currency) VALUES (?,?,?,?,?,?)",
    paymentId, booking.id, business.id, provider.name, amount, business.currency,
  );
  const payment = one("SELECT * FROM payments WHERE id = ?", paymentId)!;
  try {
    const result = await provider.createCheckout({
      payment,
      business,
      description: `${service.name} with ${business.name}`,
      amountCents: amount,
      currency: business.currency,
      customerEmail: booking.customer_email,
      successUrl: `${config.webUrl}/manage/${booking.manage_token}?paid=1`,
      cancelUrl: `${config.webUrl}/manage/${booking.manage_token}?paid=0`,
    });
    run("UPDATE payments SET provider_ref = ?, checkout_url = ? WHERE id = ?", result.providerRef, result.checkoutUrl, paymentId);
    return result.checkoutUrl;
  } catch (err) {
    run("UPDATE payments SET status = 'failed' WHERE id = ?", paymentId);
    throw err;
  }
}

/** Verifies a payment with its provider and confirms the booking. Idempotent; used by return URLs and webhooks. */
export async function confirmPayment(paymentId: string, params: Record<string, string> = {}) {
  const payment = one("SELECT * FROM payments WHERE id = ?", paymentId);
  if (!payment) throw notFound("Payment not found");
  if (payment.status !== "pending") return payment;
  const business = one("SELECT * FROM businesses WHERE id = ?", payment.business_id)!;
  const result = await providerFor(payment.provider).confirm(payment, business, params);
  if (result.paid) markPaid(paymentId, result.providerPaymentId);
  return one("SELECT * FROM payments WHERE id = ?", paymentId)!;
}

export function markPaid(paymentId: string, providerPaymentId?: string) {
  tx(() => {
    const payment = one("SELECT * FROM payments WHERE id = ?", paymentId);
    if (!payment || payment.status !== "pending") return;
    run("UPDATE payments SET status = 'paid', provider_payment_id = COALESCE(?, provider_payment_id) WHERE id = ?", providerPaymentId ?? null, paymentId);
    if (payment.booking_id) {
      run("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'pending_payment'", payment.booking_id);
      recordUse(one("SELECT * FROM businesses WHERE id = ?", payment.business_id)!, "bookings", payment.booking_id);
      audit({ label: `provider:${payment.provider}` }, payment.business_id, "payment.paid", { paymentId, bookingId: payment.booking_id });
      notify("booking_confirmed", getBooking(payment.booking_id), "customer");
    }
  });
}

export async function refundPayment(paymentId: string, amountCents: number | undefined, actor: Actor, reason = "") {
  const payment = one("SELECT * FROM payments WHERE id = ?", paymentId);
  if (!payment) throw notFound("Payment not found");
  if (!["paid", "partially_refunded"].includes(payment.status)) throw badRequest("Only paid payments can be refunded");
  const refundable = payment.amount_cents - payment.refunded_cents;
  const amount = amountCents ?? refundable;
  if (amount <= 0 || amount > refundable) throw badRequest(`Refund must be between 1 and ${refundable} cents`);

  const business = one("SELECT * FROM businesses WHERE id = ?", payment.business_id)!;
  await providerFor(payment.provider).refund(payment, business, amount);
  const refunded = payment.refunded_cents + amount;
  run(
    "UPDATE payments SET refunded_cents = ?, status = ? WHERE id = ?",
    refunded, refunded >= payment.amount_cents ? "refunded" : "partially_refunded", paymentId,
  );
  audit(actor, payment.business_id, "payment.refunded", { paymentId, amountCents: amount, reason });
  return one("SELECT * FROM payments WHERE id = ?", paymentId)!;
}

export function rescheduleBooking(bookingId: string, newStart: string, opts: { staffId?: string; force?: boolean }, actor: Actor) {
  return tx(() => {
    const booking = getBooking(bookingId);
    if (["cancelled", "completed", "no_show"].includes(booking.status)) throw badRequest(`Cannot move a ${booking.status} booking`);
    const service = one("SELECT * FROM services WHERE id = ?", booking.service_id)!;
    const start = DateTime.fromISO(newStart, { zone: "utc" });
    if (!start.isValid) throw badRequest("Invalid start time");
    const staffId = opts.staffId ?? booking.staff_id;
    if (!opts.force && !isSlotAvailable(booking.business_id, booking.service_id, staffId, start.toISO()!, booking.id)) {
      throw conflict("That time is not available");
    }
    run(
      "UPDATE bookings SET starts_at = ?, ends_at = ?, staff_id = ?, ics_sequence = ics_sequence + 1 WHERE id = ?",
      start.toISO(), start.plus({ minutes: service.duration_min }).toISO(), staffId, booking.id,
    );
    audit(actor, booking.business_id, "booking.rescheduled", { bookingId, from: booking.starts_at, to: start.toISO(), staffId });
    const updated = getBooking(bookingId);
    // Moving the booking means the customer's earlier confirmation and reminders no longer apply.
    run("UPDATE bookings SET customer_confirmed_at = NULL, last_reminder_h = NULL, staff_reminded = 0 WHERE id = ?", booking.id);
    notify("booking_rescheduled", updated, changedBy(actor));
    return updated;
  });
}

/**
 * Customers must cancel inside the business's cancellation window; doing so
 * refunds anything they paid. Admin cancellations never auto-refund — the admin
 * decides separately from the bookings screen.
 */
export async function cancelBooking(bookingId: string, opts: { byCustomer: boolean; reason?: string }, actor: Actor) {
  const booking = getBooking(bookingId);
  if (booking.status === "cancelled") return booking;
  const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id)!;
  if (opts.byCustomer && booking.status !== "requested") {
    const hoursUntil = DateTime.fromISO(booking.starts_at).diffNow("hours").hours;
    if (hoursUntil < business.cancellation_hours) {
      throw forbidden(`Online cancellation closes ${business.cancellation_hours}h before the appointment. Please contact ${business.name}.`);
    }
  }
  run("UPDATE bookings SET status = 'cancelled', ics_sequence = ics_sequence + 1 WHERE id = ?", booking.id);
  audit(actor, booking.business_id, "booking.cancelled", { bookingId, reason: opts.reason ?? "", byCustomer: opts.byCustomer });
  if (opts.byCustomer) {
    for (const p of all("SELECT id FROM payments WHERE booking_id = ? AND status IN ('paid','partially_refunded')", booking.id)) {
      await refundPayment(p.id, undefined, actor, "Customer cancelled within policy");
    }
  }
  const updated = getBooking(bookingId);
  notify("booking_cancelled", updated, changedBy(actor));
  return updated;
}

/** The business accepts a pay-in-person request: it becomes a normal confirmed booking, paid in person. */
export function acceptRequest(bookingId: string, actor: Actor) {
  return tx(() => {
    const booking = getBooking(bookingId);
    if (booking.status !== "requested") throw badRequest(`This booking is ${booking.status}, not a request`);
    const business = one("SELECT * FROM businesses WHERE id = ?", booking.business_id)!;
    if (!hasCapacity(business, "bookings")) throw new HttpError(403, "You've used all the bookings in your plan this month. Add more or upgrade under Plan & billing, then accept.");
    run("UPDATE bookings SET status = 'confirmed' WHERE id = ?", booking.id);
    audit(actor, booking.business_id, "booking.request_accepted", { bookingId });
    recordUse(business, "bookings", booking.id);
    const updated = getBooking(bookingId);
    notify("booking_confirmed", updated, "staff");
    return updated;
  });
}

/** The business declines a request (or nobody answered before the time came): the slot is released. */
export function declineRequest(bookingId: string, reason: string | undefined, actor: Actor) {
  const booking = getBooking(bookingId);
  if (booking.status !== "requested") throw badRequest(`This booking is ${booking.status}, not a request`);
  // An empty reason still marks it as declined (NULL means it wasn't), so the manage page can say so.
  run("UPDATE bookings SET status = 'cancelled', decline_reason = ? WHERE id = ?", reason?.trim() ?? "", booking.id);
  audit(actor, booking.business_id, "booking.request_declined", { bookingId, reason: reason ?? "" });
  const updated = getBooking(bookingId);
  notify("booking_declined", updated, "staff");
  return updated;
}

/** Customer said "yes, I'll be there" (by text reply or the manage page). */
export function confirmAttendance(bookingId: string, actor: Actor) {
  const booking = getBooking(bookingId);
  if (!["confirmed", "pending_payment"].includes(booking.status)) throw badRequest(`This booking is ${booking.status}`);
  if (!booking.customer_confirmed_at) {
    run("UPDATE bookings SET customer_confirmed_at = datetime('now') WHERE id = ?", bookingId);
    audit(actor, booking.business_id, "booking.customer_confirmed", { bookingId });
    notify("customer_confirmed", getBooking(bookingId), "customer");
  }
  return getBooking(bookingId);
}

/** Releases slots held by checkouts that were abandoned. */
export function expireUnpaidBookings(olderThanMinutes = 30) {
  const cutoff = DateTime.utc().minus({ minutes: olderThanMinutes }).toFormat("yyyy-MM-dd HH:mm:ss");
  const stale = all("SELECT id, business_id FROM bookings WHERE status = 'pending_payment' AND created_at < ?", cutoff);
  for (const b of stale) {
    run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", b.id);
    run("UPDATE payments SET status = 'failed' WHERE booking_id = ? AND status = 'pending'", b.id);
    audit({ label: "system" }, b.business_id, "booking.expired", { bookingId: b.id });
  }
  // Requests nobody accepted before their start time are released, and the customer is told.
  const unanswered = all("SELECT id FROM bookings WHERE status = 'requested' AND starts_at < ?", DateTime.utc().toISO());
  for (const b of unanswered) declineRequest(b.id, "It wasn't confirmed before the appointment time.", { label: "system" });
  return stale.length + unanswered.length;
}
