import { DateTime } from "luxon";
import { all, run } from "../db.js";
import { agendaText, sendSms, templates } from "./sms.js";

/** "24,2" → [2, 24]. Ignores junk so a bad setting can't break the scheduler. */
export function parseReminderHours(value: string): number[] {
  return [...new Set(value.split(",").map((v) => Number(v.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 24 * 14))].sort((a, b) => a - b);
}

/**
 * Runs every minute. For each booking it sends at most one reminder per
 * threshold, and only the closest due one (so after downtime a customer gets
 * one text, not a burst). A threshold is skipped if the booking was made after
 * it had already passed (booked 3h ahead → no "24h" reminder).
 */
export async function runReminders(now = DateTime.utc()) {
  let sent = 0;
  for (const business of all("SELECT * FROM businesses WHERE sms_enabled = 1 AND suspended = 0")) {
    const hours = parseReminderHours(business.sms_reminder_hours);
    const maxH = hours.at(-1) ?? 0;

    if (maxH) {
      const due = all(
        `SELECT * FROM bookings WHERE business_id = ? AND status = 'confirmed' AND sms_opt_in = 1 AND customer_phone IS NOT NULL
           AND starts_at > ? AND starts_at <= ?`,
        business.id, now.toISO(), now.plus({ hours: maxH }).toISO(),
      );
      for (const b of due) {
        const start = DateTime.fromISO(b.starts_at);
        const created = DateTime.fromSQL(b.created_at, { zone: "utc" });
        const hoursUntil = start.diff(now, "hours").hours;
        const threshold = hours.find((h) => hoursUntil <= h && created < start.minus({ hours: h }));
        if (threshold === undefined || (b.last_reminder_h !== null && b.last_reminder_h <= threshold)) continue;
        run("UPDATE bookings SET last_reminder_h = ? WHERE id = ?", threshold, b.id);
        await sendSms({ business, to: b.customer_phone, body: templates.reminder(b), kind: `reminder_${threshold}h`, audience: "customer", bookingId: b.id });
        sent++;
      }
    }

    if (business.sms_staff_reminder_min) {
      const due = all(
        `SELECT b.*, st.phone AS staff_phone FROM bookings b JOIN staff st ON st.id = b.staff_id
          WHERE b.business_id = ? AND b.status = 'confirmed' AND b.staff_reminded = 0 AND st.phone IS NOT NULL AND st.phone != ''
            AND b.starts_at > ? AND b.starts_at <= ?`,
        business.id, now.toISO(), now.plus({ minutes: business.sms_staff_reminder_min }).toISO(),
      );
      for (const b of due) {
        run("UPDATE bookings SET staff_reminded = 1 WHERE id = ?", b.id);
        await sendSms({ business, to: b.staff_phone, body: templates.staffReminder(b), kind: "staff_reminder", audience: "staff", bookingId: b.id });
        sent++;
      }
    }

    // Morning agenda for the admin, once per local day, within 3h of the chosen hour.
    const local = now.setZone(business.timezone);
    if (business.sms_admin_phone && business.sms_agenda_hour !== null && business.sms_last_agenda_date !== local.toISODate()
        && local.hour >= business.sms_agenda_hour && local.hour < business.sms_agenda_hour + 3) {
      run("UPDATE businesses SET sms_last_agenda_date = ? WHERE id = ?", local.toISODate(), business.id);
      await sendSms({ business, to: business.sms_admin_phone, body: agendaText(business, local), kind: "agenda", audience: "admin" });
      sent++;
    }
  }
  return sent;
}
