import { DateTime, Interval } from "luxon";
import { all, one, Row } from "../db.js";

export interface Slot { start: string; end: string; staffId: string; staffName: string }

interface SlotQuery {
  businessId: string;
  serviceId: string;
  /** ISO date (YYYY-MM-DD) in the business timezone, inclusive. */
  from: string;
  to: string;
  staffId?: string;
  /** Ignore this booking when checking conflicts (used when rescheduling). */
  excludeBookingId?: string;
  now?: DateTime;
}

export function eligibleStaff(businessId: string, serviceId: string, staffId?: string) {
  return all(
    `SELECT s.id, s.name FROM staff s
       JOIN staff_services ss ON ss.staff_id = s.id
      WHERE s.business_id = ? AND ss.service_id = ? AND s.active = 1 ${staffId ? "AND s.id = ?" : ""}
      ORDER BY s.name`,
    ...(staffId ? [businessId, serviceId, staffId] : [businessId, serviceId]),
  );
}

/** Busy intervals for a staff member: existing bookings (padded by their service buffer) and time off. */
function busyIntervals(staffId: string, from: DateTime, to: DateTime, excludeBookingId?: string): Interval[] {
  const bookings = all(
    `SELECT b.starts_at, b.ends_at, sv.buffer_min FROM bookings b JOIN services sv ON sv.id = b.service_id
      WHERE b.staff_id = ? AND b.status IN ('confirmed','pending_payment','completed')
        AND b.ends_at > ? AND b.starts_at < ? AND b.id IS NOT ?`,
    staffId, from.toUTC().toISO(), to.toUTC().toISO(), excludeBookingId ?? null,
  );
  const timeOff = all(
    "SELECT starts_at, ends_at FROM time_off WHERE staff_id = ? AND ends_at > ? AND starts_at < ?",
    staffId, from.toUTC().toISO(), to.toUTC().toISO(),
  );
  return [
    ...bookings.map((b) =>
      Interval.fromDateTimes(DateTime.fromISO(b.starts_at), DateTime.fromISO(b.ends_at).plus({ minutes: b.buffer_min })),
    ),
    ...timeOff.map((t) => Interval.fromDateTimes(DateTime.fromISO(t.starts_at), DateTime.fromISO(t.ends_at))),
  ];
}

export function findSlots(q: SlotQuery): Slot[] {
  const business = one("SELECT * FROM businesses WHERE id = ?", q.businessId);
  const service = one("SELECT * FROM services WHERE id = ? AND business_id = ? AND active = 1", q.serviceId, q.businessId);
  if (!business || !service) return [];

  const zone = business.timezone;
  const now = (q.now ?? DateTime.utc()).setZone(zone);
  const earliest = now.plus({ minutes: business.min_notice_min });
  const latest = now.plus({ days: business.max_advance_days }).endOf("day");

  let day = DateTime.fromISO(q.from, { zone }).startOf("day");
  const lastDay = DateTime.min(DateTime.fromISO(q.to, { zone }).endOf("day"), latest);
  if (!day.isValid || !lastDay.isValid) return [];
  // Cap range so a single request can't make us scan a year of calendar.
  const maxDay = day.plus({ days: 31 });

  const slots: Slot[] = [];
  const step = business.slot_interval_min;
  const blockMinutes = service.duration_min + service.buffer_min;

  for (const staff of eligibleStaff(q.businessId, q.serviceId, q.staffId)) {
    const rules = all("SELECT weekday, start_time, end_time FROM availability_rules WHERE staff_id = ?", staff.id);
    const busy = busyIntervals(staff.id, day, lastDay, q.excludeBookingId);

    for (let d = day; d <= lastDay && d < maxDay; d = d.plus({ days: 1 })) {
      for (const rule of rules.filter((r: Row) => r.weekday === d.weekday)) {
        const [sh, sm] = rule.start_time.split(":").map(Number);
        const [eh, em] = rule.end_time.split(":").map(Number);
        const windowEnd = d.set({ hour: eh, minute: em });
        for (let t = d.set({ hour: sh, minute: sm }); t.plus({ minutes: service.duration_min }) <= windowEnd; t = t.plus({ minutes: step })) {
          if (t < earliest) continue;
          const block = Interval.fromDateTimes(t, t.plus({ minutes: blockMinutes }));
          if (busy.some((b) => b.overlaps(block))) continue;
          slots.push({
            start: t.toUTC().toISO()!,
            end: t.plus({ minutes: service.duration_min }).toUTC().toISO()!,
            staffId: staff.id,
            staffName: staff.name,
          });
        }
      }
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start) || a.staffName.localeCompare(b.staffName));
}

/** True when `start` is a currently-offered slot for this service/staff. */
export function isSlotAvailable(businessId: string, serviceId: string, staffId: string, start: string, excludeBookingId?: string) {
  const business = one("SELECT timezone FROM businesses WHERE id = ?", businessId);
  if (!business) return false;
  const startDt = DateTime.fromISO(start, { zone: "utc" });
  if (!startDt.isValid) return false;
  const day = startDt.setZone(business.timezone).toISODate()!;
  return findSlots({ businessId, serviceId, staffId, from: day, to: day, excludeBookingId }).some(
    (s) => DateTime.fromISO(s.start).toMillis() === startDt.toMillis(),
  );
}
