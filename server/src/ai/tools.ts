import { z } from "zod";
import { DateTime } from "luxon";
import { all, audit, newId, one, run, Row } from "../db.js";
import { findSlotsLive, freeInConnectedCalendars } from "../lib/availability.js";
import { cancelBooking, createBooking, getBooking, rescheduleBooking, serializeBooking, startPayment } from "../lib/bookings.js";
import type { AuthUser } from "../lib/auth.js";

export interface ToolContext {
  business: Row;
  /** Present for the admin assistant; absent for public customer chat. */
  admin?: AuthUser;
  /** Side effects the UI may want to surface (new booking, payment link). */
  events: Array<{ type: string; [key: string]: unknown }>;
}

export interface AiTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

const tool = <S extends z.ZodObject>(t: AiTool<S>) => t as unknown as AiTool;

const local = (iso: string, zone: string) =>
  DateTime.fromISO(iso).setZone(zone).toLocaleString(DateTime.DATETIME_MED_WITH_WEEKDAY);

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

function describeBooking(b: Row, zone: string) {
  const s = serializeBooking(b);
  return {
    booking_id: s.id,
    booking_code: s.code,
    service: s.serviceName,
    with: s.staffName,
    start_utc: s.start,
    start_local: local(s.start, zone),
    status: s.status,
    price: money(s.priceCents, s.currency),
    customer: { name: s.customerName, email: s.customerEmail, phone: s.customerPhone },
    paid: s.payments.some((p: Row) => ["paid", "partially_refunded"].includes(p.status)),
  };
}

/** Customer-facing tools act only on bookings the customer proves ownership of (code + email). */
function bookingByCodeAndEmail(ctx: ToolContext, code: string, email: string) {
  const b = one(
    "SELECT * FROM bookings WHERE business_id = ? AND code = ? AND customer_email = ? COLLATE NOCASE",
    ctx.business.id, code.trim().toUpperCase(), email.trim(),
  );
  if (!b) throw new Error("No booking matches that code and email. Ask the customer to double-check both.");
  return b;
}

function adminBooking(ctx: ToolContext, id: string) {
  const b = getBooking(id);
  if (b.business_id !== ctx.business.id) throw new Error("Booking belongs to another business");
  return b;
}

const actorFor = (ctx: ToolContext) =>
  ctx.admin ? { id: ctx.admin.id, label: `ai-assistant(${ctx.admin.email})` } : { label: "ai-customer-chat" };

const listServices = tool({
  name: "list_services",
  description: "List the services/lessons this business offers with ids, durations, prices and which staff provide them.",
  schema: z.object({}),
  run: (_input, ctx) =>
    all("SELECT * FROM services WHERE business_id = ? AND active = 1 ORDER BY category, name", ctx.business.id).map((s) => ({
      service_id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      duration_minutes: s.duration_min,
      price: money(s.price_cents, ctx.business.currency),
      deposit: s.deposit_cents ? money(s.deposit_cents, ctx.business.currency) : null,
      staff: all("SELECT st.id, st.name FROM staff st JOIN staff_services ss ON ss.staff_id = st.id WHERE ss.service_id = ? AND st.active = 1", s.id),
    })),
});

const findTimes = tool({
  name: "find_available_times",
  description:
    "Find open appointment times for a service. Dates are YYYY-MM-DD in the business's timezone. " +
    "Returns at most 40 slots; narrow the range or pass staff_id to see more specific options.",
  schema: z.object({
    service_id: z.string(),
    date_from: z.string().describe("YYYY-MM-DD"),
    date_to: z.string().optional().describe("YYYY-MM-DD, inclusive; defaults to date_from"),
    staff_id: z.string().optional(),
  }),
  run: async (input, ctx) => {
    const slots = await findSlotsLive({
      businessId: ctx.business.id,
      serviceId: input.service_id,
      from: input.date_from,
      to: input.date_to ?? input.date_from,
      staffId: input.staff_id,
    });
    return {
      total_found: slots.length,
      slots: slots.slice(0, 40).map((s) => ({ start_utc: s.start, start_local: local(s.start, ctx.business.timezone), staff_id: s.staffId, staff_name: s.staffName })),
    };
  },
});

const customerTools: AiTool[] = [
  listServices,
  findTimes,
  tool({
    name: "book_appointment",
    description:
      "Book an appointment. Only call after the customer has explicitly confirmed the service, time, and their name and email. " +
      "start_utc and staff_id must come from find_available_times.",
    schema: z.object({
      service_id: z.string(),
      staff_id: z.string(),
      start_utc: z.string(),
      customer_name: z.string().min(1),
      customer_email: z.email(),
      customer_phone: z.string().optional(),
      sms_opt_in: z.boolean().optional().describe("True only if the customer explicitly agreed to text reminders/updates at customer_phone"),
      notes: z.string().optional(),
    }),
    run: async (input, ctx) => {
      if (!(await freeInConnectedCalendars(ctx.business.id, input.staff_id, input.start_utc, input.service_id))) {
        throw new Error("That time was just taken. Check find_available_times again and offer another.");
      }
      const booking = createBooking({
        businessId: ctx.business.id,
        serviceId: input.service_id,
        staffId: input.staff_id,
        start: input.start_utc,
        customer: { name: input.customer_name, email: input.customer_email, phone: input.customer_phone },
        notes: input.notes,
        source: "ai",
        smsOptIn: input.sms_opt_in,
      }, actorFor(ctx));
      const serialized = serializeBooking(booking, { includeToken: true });
      let paymentUrl: string | undefined;
      if (booking.status === "pending_payment") paymentUrl = await startPayment(booking.id);
      ctx.events.push({ type: "booking_created", booking: serialized, paymentUrl });
      return {
        ...describeBooking(booking, ctx.business.timezone),
        manage_url: serialized.manageUrl,
        payment_required: !!paymentUrl,
        payment_url: paymentUrl,
        note: paymentUrl ? "The time is held for 30 minutes until payment is completed at payment_url." : undefined,
      };
    },
  }),
  tool({
    name: "find_my_booking",
    description: "Look up a customer's existing booking by its 6-character booking code and the email used to book.",
    schema: z.object({ booking_code: z.string(), email: z.string() }),
    run: (input, ctx) => describeBooking(bookingByCodeAndEmail(ctx, input.booking_code, input.email), ctx.business.timezone),
  }),
  tool({
    name: "reschedule_booking",
    description: "Move a customer's booking to a new available time (from find_available_times). Confirm the new time with the customer first.",
    schema: z.object({ booking_code: z.string(), email: z.string(), new_start_utc: z.string(), staff_id: z.string().optional() }),
    run: async (input, ctx) => {
      const b = bookingByCodeAndEmail(ctx, input.booking_code, input.email);
      if (!(await freeInConnectedCalendars(ctx.business.id, input.staff_id ?? b.staff_id, input.new_start_utc, b.service_id))) {
        throw new Error("That time isn't available. Check find_available_times again.");
      }
      const updated = rescheduleBooking(b.id, input.new_start_utc, { staffId: input.staff_id }, actorFor(ctx));
      ctx.events.push({ type: "booking_updated", bookingId: b.id });
      return describeBooking(updated, ctx.business.timezone);
    },
  }),
  tool({
    name: "cancel_booking",
    description: "Cancel a customer's booking (refunds automatically when inside the cancellation policy). Confirm with the customer first.",
    schema: z.object({ booking_code: z.string(), email: z.string(), reason: z.string().optional() }),
    run: async (input, ctx) => {
      const b = bookingByCodeAndEmail(ctx, input.booking_code, input.email);
      const updated = await cancelBooking(b.id, { byCustomer: true, reason: input.reason }, actorFor(ctx));
      ctx.events.push({ type: "booking_updated", bookingId: b.id });
      return describeBooking(updated, ctx.business.timezone);
    },
  }),
];

/**
 * Admin assistant tools. Refunds are intentionally not exposed to the AI —
 * moving money stays a human action in the admin screen.
 */
const adminTools: AiTool[] = [
  listServices,
  findTimes,
  tool({
    name: "list_staff",
    description: "List staff/instructors with ids and weekly hours.",
    schema: z.object({}),
    run: (_input, ctx) =>
      all("SELECT * FROM staff WHERE business_id = ?", ctx.business.id).map((s) => ({
        staff_id: s.id,
        name: s.name,
        active: !!s.active,
        hours: all("SELECT weekday, start_time, end_time FROM availability_rules WHERE staff_id = ? ORDER BY weekday, start_time", s.id),
      })),
  }),
  tool({
    name: "list_bookings",
    description: "List bookings between two dates (YYYY-MM-DD, business timezone, inclusive).",
    schema: z.object({ date_from: z.string(), date_to: z.string(), status: z.enum(["pending_payment", "confirmed", "cancelled", "completed", "no_show"]).optional() }),
    run: (input, ctx) => {
      const zone = ctx.business.timezone;
      const from = DateTime.fromISO(input.date_from, { zone }).startOf("day").toUTC().toISO();
      const to = DateTime.fromISO(input.date_to, { zone }).endOf("day").toUTC().toISO();
      return all(
        `SELECT * FROM bookings WHERE business_id = ? AND starts_at >= ? AND starts_at <= ? ${input.status ? "AND status = ?" : ""} ORDER BY starts_at LIMIT 100`,
        ...[ctx.business.id, from, to, ...(input.status ? [input.status] : [])],
      ).map((b) => describeBooking(b, zone));
    },
  }),
  tool({
    name: "create_booking",
    description: "Create a booking on behalf of a customer. Set force=true only when the admin explicitly wants to book outside open hours.",
    schema: z.object({
      service_id: z.string(), staff_id: z.string(), start_utc: z.string(),
      customer_name: z.string(), customer_email: z.email(), customer_phone: z.string().optional(),
      price_cents: z.number().int().nonnegative().optional().describe("Override the service price for this booking"),
      force: z.boolean().optional(),
    }),
    run: (input, ctx) => {
      const booking = createBooking({
        businessId: ctx.business.id, serviceId: input.service_id, staffId: input.staff_id, start: input.start_utc,
        customer: { name: input.customer_name, email: input.customer_email, phone: input.customer_phone },
        source: "admin", force: input.force, priceCentsOverride: input.price_cents,
      }, actorFor(ctx));
      ctx.events.push({ type: "booking_created", bookingId: booking.id });
      return describeBooking(booking, ctx.business.timezone);
    },
  }),
  tool({
    name: "reschedule_booking",
    description: "Move a booking to a new time and/or staff member. force=true skips the availability check (admin override).",
    schema: z.object({ booking_id: z.string(), new_start_utc: z.string(), staff_id: z.string().optional(), force: z.boolean().optional() }),
    run: (input, ctx) => {
      adminBooking(ctx, input.booking_id);
      const updated = rescheduleBooking(input.booking_id, input.new_start_utc, { staffId: input.staff_id, force: input.force }, actorFor(ctx));
      ctx.events.push({ type: "booking_updated", bookingId: input.booking_id });
      return describeBooking(updated, ctx.business.timezone);
    },
  }),
  tool({
    name: "cancel_booking",
    description: "Cancel a booking. Does not refund; tell the admin to issue any refund from the Bookings screen.",
    schema: z.object({ booking_id: z.string(), reason: z.string().optional() }),
    run: async (input, ctx) => {
      adminBooking(ctx, input.booking_id);
      const updated = await cancelBooking(input.booking_id, { byCustomer: false, reason: input.reason }, actorFor(ctx));
      ctx.events.push({ type: "booking_updated", bookingId: input.booking_id });
      return describeBooking(updated, ctx.business.timezone);
    },
  }),
  tool({
    name: "update_service",
    description: "Change a service's price (in cents), duration, or availability. Confirm price changes with the admin first.",
    schema: z.object({
      service_id: z.string(),
      price_cents: z.number().int().nonnegative().optional(),
      duration_min: z.number().int().positive().optional(),
      active: z.boolean().optional(),
    }),
    run: (input, ctx) => {
      const s = one("SELECT * FROM services WHERE id = ? AND business_id = ?", input.service_id, ctx.business.id);
      if (!s) throw new Error("Unknown service");
      run(
        "UPDATE services SET price_cents = ?, duration_min = ?, active = ? WHERE id = ?",
        input.price_cents ?? s.price_cents, input.duration_min ?? s.duration_min,
        input.active === undefined ? s.active : Number(input.active), s.id,
      );
      audit(actorFor(ctx), ctx.business.id, "service.updated", { serviceId: s.id, ...input });
      ctx.events.push({ type: "service_updated", serviceId: s.id });
      return one("SELECT * FROM services WHERE id = ?", s.id);
    },
  }),
  tool({
    name: "add_time_off",
    description: "Block time on a staff member's calendar (vacation, lunch, etc). Times are ISO 8601 UTC.",
    schema: z.object({ staff_id: z.string(), start_utc: z.string(), end_utc: z.string(), reason: z.string().optional() }),
    run: (input, ctx) => {
      const staff = one("SELECT id FROM staff WHERE id = ? AND business_id = ?", input.staff_id, ctx.business.id);
      if (!staff) throw new Error("Unknown staff member");
      const id = newId("off");
      run("INSERT INTO time_off (id, staff_id, starts_at, ends_at, reason) VALUES (?,?,?,?,?)", id, staff.id, input.start_utc, input.end_utc, input.reason ?? "");
      audit(actorFor(ctx), ctx.business.id, "time_off.created", { id, ...input });
      return { time_off_id: id };
    },
  }),
];

export const toolsFor = (kind: "customer" | "admin") => (kind === "admin" ? adminTools : customerTools);
