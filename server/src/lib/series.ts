import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, audit, newId, one, run, Row } from "../db.js";
import { cancelBooking, createBooking, type NewBooking } from "./bookings.js";
import { freeInConnectedCalendars } from "./availability.js";
import { sendBusinessEmail, sendEmail } from "./email.js";
import { badRequest, notFound } from "./errors.js";
import { seriesInviteIcs } from "./ics.js";
import { dispatchAdminEmail, dispatchSms } from "./notify.js";

/**
 * Repeating bookings: the same lesson every week (or every two weeks), made a block at a time
 * (the business's recurring_weeks, 26 by default). Each lesson is an ordinary booking that can be moved or
 * cancelled on its own. Weeks where the time isn't free are skipped and listed. Two weeks before the last
 * lesson, the customer is sent a link to continue for another block, and the business is reminded.
 */

type Actor = { id?: string | null; label: string };
export interface SeriesResult { series: Row; created: Row[]; skipped: { start: string; reason: string }[] }

const RENEWAL_NOTICE_DAYS = 14;
const fmt = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat("ccc d LLL yyyy, h:mm a");

/** Makes `count` lessons starting at `first` (local wall-clock time kept across daylight-saving changes). */
async function makeLessons(series: Row, base: NewBooking, first: DateTime, count: number, actor: Actor, opts: { force?: boolean; firstIsLater: boolean }) {
  const business = one("SELECT * FROM businesses WHERE id = ?", series.business_id)!;
  const local = first.setZone(business.timezone);
  const created: Row[] = [];
  const skipped: { start: string; reason: string }[] = [];
  for (let k = 0; k < count; k++) {
    const start = local.plus({ weeks: k * series.interval_weeks }).toUTC().toISO()!;
    try {
      if (!opts.force && !(await freeInConnectedCalendars(business.id, series.staff_id, start, series.service_id))) {
        throw new Error("busy in the staff member's calendar");
      }
      created.push(createBooking({ ...base, start, staffId: series.staff_id, force: opts.force, series: { id: series.id, later: k > 0 || opts.firstIsLater } }, actor));
    } catch (err) {
      // The first lesson of a brand-new series must work; later weeks are skipped and reported.
      if (k === 0 && !opts.firstIsLater) throw err;
      skipped.push({ start, reason: /available/i.test((err as Error).message) ? "that time isn't free" : (err as Error).message });
    }
  }
  if (created.length) run("UPDATE booking_series SET last_start = ? WHERE id = ? AND last_start < ?", created.at(-1)!.starts_at, series.id, created.at(-1)!.starts_at);
  return { created, skipped };
}

export async function createSeries(base: NewBooking, intervalWeeks: 1 | 2, actor: Actor, opts: { weeks?: number; force?: boolean } = {}): Promise<SeriesResult> {
  const business = one("SELECT * FROM businesses WHERE id = ?", base.businessId);
  if (!business) throw notFound("Business not available");
  if (!base.staffId) throw badRequest("Choose who the repeating lessons are with");
  const weeks = Math.min(52, Math.max(2, opts.weeks ?? business.recurring_weeks ?? 26));
  const id = newId("ser");
  run(
    `INSERT INTO booking_series (id, business_id, service_id, staff_id, customer_name, customer_email, customer_phone, interval_weeks, weeks, last_start, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, business.id, base.serviceId, base.staffId, base.customer.name, base.customer.email.toLowerCase(), base.customer.phone ?? null,
    intervalWeeks, weeks, base.start, base.source,
  );
  const series = one("SELECT * FROM booking_series WHERE id = ?", id)!;
  let result;
  try {
    result = await makeLessons(series, base, DateTime.fromISO(base.start, { zone: "utc" }), Math.ceil(weeks / intervalWeeks), actor, { force: opts.force, firstIsLater: false });
  } catch (err) {
    run("DELETE FROM booking_series WHERE id = ?", id);
    throw err;
  }
  audit(actor, business.id, "series.created", { seriesId: id, lessons: result.created.length, skipped: result.skipped.length, intervalWeeks, weeks });
  const fresh = one("SELECT * FROM booking_series WHERE id = ?", id)!;
  await summaryEmail(fresh, result.created, result.skipped, "created");
  // The owner hears about it once (when the customer made it), and an opted-in customer gets one text.
  const first = result.created[0];
  if (!/^(admin|superadmin|ai-assistant)/.test(actor.label)) dispatchAdminEmail("booking_confirmed", first).catch(() => {});
  dispatchSms("booking_confirmed", first, /^(admin|superadmin)/.test(actor.label) ? "staff" : "customer").catch(() => {});
  return { series: fresh, ...result };
}

/** Adds the next block of lessons after the last one (the "continue for another 26 weeks" link, or the owner's Renew). */
export async function renewSeries(seriesId: string, actor: Actor): Promise<SeriesResult> {
  const series = one("SELECT * FROM booking_series WHERE id = ?", seriesId);
  if (!series) throw notFound("Series not found");
  if (series.status === "cancelled") throw badRequest("This series was cancelled");
  const template = one("SELECT * FROM bookings WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1", seriesId)!;
  const base: NewBooking = {
    businessId: series.business_id, serviceId: series.service_id, staffId: series.staff_id, start: series.last_start,
    customer: { name: series.customer_name, email: series.customer_email, phone: series.customer_phone ?? undefined },
    source: series.source, smsOptIn: !!template.sms_opt_in, meetingMode: template.meeting_mode, priceCentsOverride: template.price_cents,
  };
  const next = DateTime.fromISO(series.last_start, { zone: "utc" }).setZone(one("SELECT timezone FROM businesses WHERE id = ?", series.business_id)!.timezone)
    .plus({ weeks: series.interval_weeks });
  const result = await makeLessons(series, base, next, Math.ceil(series.weeks / series.interval_weeks), actor, { firstIsLater: true });
  run("UPDATE booking_series SET status = 'active', reminder_sent_at = NULL WHERE id = ?", seriesId);
  audit(actor, series.business_id, "series.renewed", { seriesId, lessons: result.created.length, skipped: result.skipped.length });
  const fresh = one("SELECT * FROM booking_series WHERE id = ?", seriesId)!;
  await summaryEmail(fresh, result.created, result.skipped, "renewed");
  return { series: fresh, ...result };
}

/** Cancels every lesson still to come. Customers can't cancel ones inside the business's cancellation cutoff. */
export async function cancelSeries(seriesId: string, actor: Actor, byCustomer: boolean) {
  const series = one("SELECT * FROM booking_series WHERE id = ?", seriesId);
  if (!series) throw notFound("Series not found");
  const business = one("SELECT * FROM businesses WHERE id = ?", series.business_id)!;
  const upcoming = all("SELECT * FROM bookings WHERE series_id = ? AND status = 'confirmed' AND starts_at > ? ORDER BY starts_at", seriesId, DateTime.utc().toISO());
  const cancelled: Row[] = [];
  const kept: Row[] = [];
  for (const b of upcoming) {
    try {
      cancelled.push(await cancelBooking(b.id, { byCustomer, reason: "Repeating lessons cancelled", quiet: true }, actor));
    } catch {
      kept.push(b); // inside the cancellation cutoff
    }
  }
  run("UPDATE booking_series SET status = 'cancelled' WHERE id = ?", seriesId);
  audit(actor, business.id, "series.cancelled", { seriesId, cancelled: cancelled.length, kept: kept.length });
  if (cancelled.length) {
    const service = one("SELECT name FROM services WHERE id = ?", series.service_id)!;
    await sendBusinessEmail(business, {
      kind: "series_cancelled", bookingId: cancelled[0].id, to: series.customer_email,
      subject: `Your repeating ${service.name} with ${business.name} is cancelled`,
      text: [
        `Hi ${series.customer_name.split(" ")[0]},`,
        `${cancelled.length} upcoming ${service.name} lesson${cancelled.length === 1 ? " has" : "s have"} been cancelled:`,
        cancelled.map((b) => `- ${fmt(b.starts_at, business.timezone)}`).join("\n"),
        kept.length ? `These are too close to cancel online and are still booked:\n${kept.map((b) => `- ${fmt(b.starts_at, business.timezone)}`).join("\n")}\nPlease contact ${business.name}${business.phone ? ` at ${business.phone}` : ""} about them.` : "",
        `Book again any time: ${config.webUrl}/b/${business.slug}`,
      ].filter(Boolean).join("\n\n"),
      attachments: [{ filename: "cancel.ics", content: seriesInviteIcs(cancelled, "CANCEL"), contentType: "text/calendar; charset=utf-8; method=CANCEL" }],
    });
  }
  return { cancelled: cancelled.length, kept: kept.map((b) => b.starts_at) };
}

/** One email for the whole block: every date, the weeks that were skipped, and one invitation with all the lessons. */
async function summaryEmail(series: Row, created: Row[], skipped: { start: string; reason: string }[], what: "created" | "renewed") {
  if (!created.length) return;
  const business = one("SELECT * FROM businesses WHERE id = ?", series.business_id)!;
  const service = one("SELECT name FROM services WHERE id = ?", series.service_id)!;
  const staff = one("SELECT name FROM staff WHERE id = ?", series.staff_id)!;
  const every = series.interval_weeks === 1 ? "every week" : "every two weeks";
  const first = DateTime.fromISO(created[0].starts_at).setZone(business.timezone);
  const online = created[0].meeting_mode === "online";
  await sendBusinessEmail(business, {
    kind: what === "created" ? "series_created" : "series_renewed", bookingId: created[0].id, to: series.customer_email,
    subject: `${what === "created" ? "You're booked" : "Renewed"}: ${service.name} ${every} with ${business.name}`,
    text: [
      `Hi ${series.customer_name.split(" ")[0]},`,
      `${what === "created" ? "You're booked for" : "We've added"} ${created.length} ${service.name} lessons with ${staff.name}, ${every} on ${first.toFormat("cccc 'at' h:mm a")}${online ? " (online; each lesson's join link is in its calendar entry)" : business.address ? ` at ${business.address}` : ""}:`,
      created.map((b) => `- ${fmt(b.starts_at, business.timezone)}`).join("\n"),
      skipped.length ? `These weeks weren't free, so they aren't booked:\n${skipped.map((s) => `- ${fmt(s.start, business.timezone)}`).join("\n")}` : "",
      `The attached invitation adds every lesson to your calendar. To move or cancel one lesson, or all of them, use: ${config.webUrl}/manage/${created[0].manage_token}`,
      `About two weeks before the last lesson we'll send you a link to continue for another ${series.weeks} weeks.`,
    ].filter(Boolean).join("\n\n"),
    attachments: [{ filename: "lessons.ics", content: seriesInviteIcs(created, "REQUEST"), contentType: "text/calendar; charset=utf-8; method=REQUEST" }],
  });
}

/**
 * Runs with the reminders. Two weeks before a series' last lesson: the customer gets a one-click link to
 * continue, and the business's admins are told. Series whose last lesson has passed are marked ended.
 */
export async function runSeriesReminders(now = DateTime.utc()) {
  run("UPDATE booking_series SET status = 'ended' WHERE status = 'active' AND last_start < ?", now.toISO());
  const due = all(
    "SELECT * FROM booking_series WHERE status = 'active' AND reminder_sent_at IS NULL AND last_start <= ? AND last_start > ?",
    now.plus({ days: RENEWAL_NOTICE_DAYS }).toISO(), now.toISO(),
  );
  for (const series of due) {
    run("UPDATE booking_series SET reminder_sent_at = datetime('now') WHERE id = ?", series.id);
    const business = one("SELECT * FROM businesses WHERE id = ?", series.business_id)!;
    const service = one("SELECT name FROM services WHERE id = ?", series.service_id)!;
    const next = one("SELECT manage_token FROM bookings WHERE series_id = ? AND status = 'confirmed' AND starts_at > ? ORDER BY starts_at LIMIT 1", series.id, now.toISO());
    const last = fmt(series.last_start, business.timezone);
    if (next) {
      await sendBusinessEmail(business, {
        kind: "series_renewal", to: series.customer_email,
        subject: `Keep your ${service.name} with ${business.name}? Your lessons end ${DateTime.fromISO(series.last_start).setZone(business.timezone).toFormat("LLL d")}`,
        text: [
          `Hi ${series.customer_name.split(" ")[0]},`,
          `Your repeating ${service.name} lessons with ${business.name} end on ${last}.`,
          `To keep the same time for another ${series.weeks} weeks, click here: ${config.webUrl}/manage/${next.manage_token}?renew=1`,
          `If you don't want to continue, there's nothing to do; your booked lessons stay as they are.`,
        ].join("\n\n"),
      });
    }
    const admins = all("SELECT u.email FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = ?", business.id);
    for (const a of admins) {
      await sendEmail({
        to: a.email, subject: `Repeating lessons ending: ${series.customer_name}, ${service.name}`,
        text: `${series.customer_name}'s repeating ${service.name} ends on ${last}. They've been sent a link to continue. You can also renew it yourself in Bookings: ${config.webUrl}/admin/${business.id}/bookings?series=${series.id}`,
      }).catch(() => {});
    }
  }
  return due.length;
}

export function seriesDetail(seriesId: string, businessId: string) {
  const series = one("SELECT * FROM booking_series WHERE id = ? AND business_id = ?", seriesId, businessId);
  if (!series) throw notFound("Series not found");
  const lessons = all("SELECT id, code, starts_at, status FROM bookings WHERE series_id = ? ORDER BY starts_at", seriesId);
  const endsSoon = series.status === "active" && DateTime.fromISO(series.last_start) <= DateTime.utc().plus({ days: RENEWAL_NOTICE_DAYS + 7 });
  return { ...series, lessons, endsSoon };
}
