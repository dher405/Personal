import { DateTime } from "luxon";
import { all, audit, newId, one, run, tx, Row } from "../db.js";
import { providerFor } from "../payments/index.js";
import { config } from "../config.js";
import { findSlots, isSlotAvailable } from "./availability.js";
import { randomCode, randomToken } from "./crypto.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { platformFeeFor } from "./plans.js";
import { notify } from "./notify.js";

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
  /** Admins may book outside published hours (e.g. a squeeze-in). */
  force?: boolean;
  priceCentsOverride?: number;
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
    priceCents: b.price_cents,
    currency: b.currency,
    notes: b.notes,
    source: b.source,
    createdAt: b.created_at,
    payments,
    ...(opts.includeToken ? { manageToken: b.manage_token, manageUrl: `${config.webUrl}/manage/${b.manage_token}` } : {}),
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
    const id = newId("bk");
    run(
      `INSERT INTO bookings (id, code, manage_token, business_id, service_id, staff_id, customer_id, customer_name, customer_email,
         customer_phone, starts_at, ends_at, status, price_cents, currency, notes, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, randomCode(), randomToken(), business.id, service.id, staffId, input.customerId ?? null,
      input.customer.name, input.customer.email.toLowerCase(), input.customer.phone ?? null,
      start.toISO(), start.plus({ minutes: service.duration_min }).toISO(),
      needsPayment ? "pending_payment" : "confirmed", price, business.currency, input.notes ?? "", input.source,
    );
    audit(actor, business.id, "booking.created", { bookingId: id, start: start.toISO(), source: input.source });
    const booking = getBooking(id);
    if (!needsPayment) notify("booking_confirmed", booking);
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
  const fee = platformFeeFor(business.plan, amount);
  const paymentId = newId("pay");
  run(
    "INSERT INTO payments (id, booking_id, business_id, provider, amount_cents, platform_fee_cents, currency) VALUES (?,?,?,?,?,?,?)",
    paymentId, booking.id, business.id, provider.name, amount, fee, business.currency,
  );
  const payment = one("SELECT * FROM payments WHERE id = ?", paymentId)!;
  try {
    const result = await provider.createCheckout({
      payment,
      business,
      description: `${service.name} with ${business.name}`,
      amountCents: amount,
      platformFeeCents: fee,
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
      audit({ label: `provider:${payment.provider}` }, payment.business_id, "payment.paid", { paymentId, bookingId: payment.booking_id });
      notify("booking_confirmed", getBooking(payment.booking_id));
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
      "UPDATE bookings SET starts_at = ?, ends_at = ?, staff_id = ? WHERE id = ?",
      start.toISO(), start.plus({ minutes: service.duration_min }).toISO(), staffId, booking.id,
    );
    audit(actor, booking.business_id, "booking.rescheduled", { bookingId, from: booking.starts_at, to: start.toISO(), staffId });
    const updated = getBooking(bookingId);
    notify("booking_rescheduled", updated);
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
  if (opts.byCustomer) {
    const hoursUntil = DateTime.fromISO(booking.starts_at).diffNow("hours").hours;
    if (hoursUntil < business.cancellation_hours) {
      throw forbidden(`Online cancellation closes ${business.cancellation_hours}h before the appointment. Please contact ${business.name}.`);
    }
  }
  run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", booking.id);
  audit(actor, booking.business_id, "booking.cancelled", { bookingId, reason: opts.reason ?? "", byCustomer: opts.byCustomer });
  if (opts.byCustomer) {
    for (const p of all("SELECT id FROM payments WHERE booking_id = ? AND status IN ('paid','partially_refunded')", booking.id)) {
      await refundPayment(p.id, undefined, actor, "Customer cancelled within policy");
    }
  }
  const updated = getBooking(bookingId);
  notify("booking_cancelled", updated);
  return updated;
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
  return stale.length;
}
