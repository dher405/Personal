import { DateTime } from "luxon";
import { all, audit, newId, one, run, type Row } from "../db.js";
import { encryptJson } from "./crypto.js";
import { saveChannels } from "./channels.js";

/**
 * The showcase: one business, picked by the super admin, that anyone can book on the home page to see what their
 * customers would see. It's a sandbox: payments are test payments (nothing is charged), no emails or texts go out,
 * its bookings don't count toward any allowance, and visitors' bookings are deleted a few hours later. Only the
 * super admin can change its settings.
 */

/** Visitors' demo bookings are cleared this long after they're made (or once their time has passed). */
export const SHOWCASE_KEEP_HOURS = 3;

export const isShowcase = (business: Row | undefined) => !!business?.is_demo;

export function showcaseBusiness() {
  return one("SELECT id, name, slug FROM businesses WHERE is_demo = 1 AND suspended = 0 LIMIT 1");
}

/** Makes this business the showcase (or stops it being one). Only one at a time. */
export function setShowcase(businessId: string, on: boolean, actor: { id?: string | null; label: string }) {
  if (on) {
    run("UPDATE businesses SET is_demo = 0 WHERE is_demo = 1 AND id != ?", businessId);
    // Test payments so visitors can try paying; texts and customer emails stay off.
    run("UPDATE businesses SET is_demo = 1, payment_provider = 'mock' WHERE id = ?", businessId);
  } else {
    run("UPDATE businesses SET is_demo = 0, payment_provider = CASE payment_provider WHEN 'mock' THEN 'none' ELSE payment_provider END WHERE id = ?", businessId);
  }
  audit(actor, businessId, on ? "showcase.on" : "showcase.off");
}

/** Deletes visitors' demo bookings (with their payments and message logs) once they're a few hours old or in the past. */
export function clearShowcaseBookings(now = DateTime.utc()) {
  const old = all(
    `SELECT b.id FROM bookings b JOIN businesses z ON z.id = b.business_id
      WHERE z.is_demo = 1 AND (b.created_at < ? OR b.starts_at < ?)`,
    now.minus({ hours: SHOWCASE_KEEP_HOURS }).toFormat("yyyy-LL-dd HH:mm:ss"), now.toISO(),
  );
  for (const b of old) {
    run("DELETE FROM payments WHERE booking_id = ?", b.id);
    run("DELETE FROM email_messages WHERE booking_id = ?", b.id);
    run("DELETE FROM sms_messages WHERE booking_id = ?", b.id);
    run("DELETE FROM bookings WHERE id = ?", b.id);
  }
  run("DELETE FROM booking_series WHERE business_id IN (SELECT id FROM businesses WHERE is_demo = 1) AND id NOT IN (SELECT series_id FROM bookings WHERE series_id IS NOT NULL)");
  return old.length;
}

/**
 * Creates a sample music school for the showcase, owned by the super admin (so there's no shared demo login).
 * Used when the platform has no Riverside Music yet (e.g. it was launched without DEMO_MODE).
 */
export function createShowcaseBusiness(ownerId: string) {
  const id = newId("biz");
  let slug = "riverside-music";
  for (let i = 2; one("SELECT 1 FROM businesses WHERE slug = ?", slug); i++) slug = `riverside-music-${i}`;
  run(
    `INSERT INTO businesses (id, name, slug, timezone, category, description, address, phone, plan, payment_provider, require_payment, payment_config, allow_recurring, is_demo)
     VALUES (?, 'Riverside Music', ?, 'America/New_York', 'Music lessons', ?, '12 River St, Hudson, NY', '(555) 010-2020', 'pro', 'mock', 1, ?, 1, 0)`,
    id, slug, "Private piano, guitar and voice lessons for all ages.", encryptJson({}),
  );
  run("INSERT INTO business_members (business_id, user_id, role) VALUES (?,?, 'owner')", id, ownerId);
  saveChannels(id, { email: { provider: "none" }, sms: { provider: "none" } });
  const staff = [
    { id: newId("stf"), name: "Alex Kim", bio: "Piano & music theory, 12 years teaching." },
    { id: newId("stf"), name: "Sam Ortiz", bio: "Guitar and voice. Rock, folk and jazz." },
  ];
  for (const s of staff) {
    run("INSERT INTO staff (id, business_id, name, bio) VALUES (?,?,?,?)", s.id, id, s.name, s.bio);
    for (const weekday of [1, 2, 3, 4, 5]) run("INSERT INTO availability_rules (id, staff_id, weekday, start_time, end_time) VALUES (?,?,?,?,?)", newId("avl"), s.id, weekday, "09:00", "17:00");
    run("INSERT INTO availability_rules (id, staff_id, weekday, start_time, end_time) VALUES (?,?,?,?,?)", newId("avl"), s.id, 6, "10:00", "14:00");
  }
  const services = [
    { name: "Piano lesson (30 min)", category: "Piano", duration: 30, price: 4000, staff: [0] },
    { name: "Piano lesson (60 min)", category: "Piano", duration: 60, price: 7500, staff: [0] },
    { name: "Guitar lesson (45 min)", category: "Guitar", duration: 45, price: 5500, staff: [1] },
    { name: "Voice lesson (45 min)", category: "Voice", duration: 45, price: 5500, staff: [1] },
    { name: "Free trial lesson", category: "Intro", duration: 20, price: 0, staff: [0, 1] },
  ];
  for (const s of services) {
    const sid = newId("svc");
    run("INSERT INTO services (id, business_id, name, category, duration_min, buffer_min, price_cents) VALUES (?,?,?,?,?,?,?)", sid, id, s.name, s.category, s.duration, 10, s.price);
    for (const i of s.staff) run("INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)", staff[i].id, sid);
  }
  return one("SELECT * FROM businesses WHERE id = ?", id)!;
}
