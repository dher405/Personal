process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { all, one, run, newId } = await import("../src/db.js");
const { meter } = await import("../src/lib/usage.js");
const { runSeriesReminders } = await import("../src/lib/series.js");

let server: Server, base = "", owner = "", bid = "", svc = "", alex = "";
const ZONE = "America/New_York";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const emailsTo = (to: string) => all("SELECT * FROM email_messages WHERE to_email = ? ORDER BY rowid", to);
let dayOffset = 3;
async function slot() {
  let d = DateTime.now().setZone(ZONE).plus({ days: dayOffset });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  dayOffset += 1;
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${d.toISODate()}&staffId=${alex}`, undefined, "")).body;
  return slots[2];
}
const bookWeekly = async (email: string, s?: any) => {
  s ??= await slot();
  return api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: svc, staffId: alex, start: s.start, name: "Weekly Wendy", email, repeat: { intervalWeeks: 1 } }, "");
};

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
  svc = one("SELECT id FROM services WHERE business_id = ? AND name LIKE 'Piano lesson (30%'", bid)!.id;
  alex = one("SELECT id FROM staff WHERE business_id = ? AND name = 'Alex Kim'", bid)!.id;
  await api("PATCH", `/api/admin/${bid}`, { require_payment: false });
});
after(() => server.close());

test("customers can only book weekly when the business allows it", async () => {
  assert.equal((await bookWeekly("nope@example.com")).status, 400);
  const page = (await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body;
  assert.equal(page.recurring, null);
  await api("PATCH", `/api/admin/${bid}`, { allow_recurring: true });
  assert.deepEqual((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body.recurring, { weeks: 26 });
});

let token = "", seriesId = "";

test("a weekly booking makes 26 lessons at the same local time, skips taken weeks, and sends one summary", async () => {
  const s = await slot();
  const first = DateTime.fromISO(s.start).setZone(ZONE);
  // Week 3 is blocked as time off.
  const w3 = first.plus({ weeks: 2 });
  run("INSERT INTO time_off (id, staff_id, starts_at, ends_at, reason) VALUES (?,?,?,?,?)", newId("off"), alex, w3.minus({ hours: 1 }).toUTC().toISO(), w3.plus({ hours: 2 }).toUTC().toISO(), "holiday");
  const usedBefore = meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used;

  const res = await bookWeekly("wendy@example.com", s);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.seriesResult.created, 25);
  assert.equal(res.body.seriesResult.skipped.length, 1);
  assert.equal(DateTime.fromISO(res.body.seriesResult.skipped[0].start).toMillis(), w3.toMillis());
  token = res.body.booking.manageToken;
  seriesId = res.body.booking.series.id;

  const lessons = all("SELECT starts_at FROM bookings WHERE series_id = ? ORDER BY starts_at", seriesId);
  assert.equal(lessons.length, 25);
  // Same wall-clock time every week, through daylight-saving changes.
  assert.ok(lessons.every((l) => DateTime.fromISO(l.starts_at).setZone(ZONE).toFormat("ccc HH:mm") === first.toFormat("ccc HH:mm")));
  const span = DateTime.fromISO(lessons.at(-1)!.starts_at).diff(first, "weeks").weeks;
  assert.equal(Math.round(span), 25, "26 weeks from the first lesson");

  // Only this month's lessons count toward this month's allowance.
  const thisMonth = lessons.filter((l) => DateTime.fromISO(l.starts_at).toUTC().hasSame(DateTime.utc(), "month")).length;
  assert.equal(meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used, usedBefore + thisMonth);

  await settle();
  const mails = emailsTo("wendy@example.com");
  assert.equal(mails.length, 1, "one summary, not 25 confirmations");
  assert.match(mails[0].subject, /You're booked: Piano lesson \(30 min\) every week/);
  assert.match(mails[0].body, /These weeks weren't free/);
  assert.equal((mails[0].body.match(/^- /gm) ?? []).length, 26);
});

test("each lesson can be moved on its own, months ahead", async () => {
  const later = one("SELECT * FROM bookings WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1", seriesId)!;
  const moved = DateTime.fromISO(later.starts_at).plus({ hours: 1 }).toUTC().toISO();
  const res = await api("PATCH", `/api/admin/${bid}/bookings/${later.id}`, { start: moved });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(DateTime.fromISO(one("SELECT starts_at FROM bookings WHERE id = ?", later.id)!.starts_at).toMillis(), DateTime.fromISO(moved!).toMillis());
});

test("two weeks before the end, the customer gets a renewal link and renewing adds the next 26 weeks", async () => {
  assert.equal((await api("POST", `/api/public/manage/${token}/series/renew`, {}, "")).status, 400, "too early to renew");
  // Pretend the series ends in 10 days.
  // Keep the lesson closest to 10 days out as the last one, and drop the ones after it.
  const target = DateTime.utc().plus({ days: 10 }).toMillis();
  const lessons = all("SELECT id, starts_at FROM bookings WHERE series_id = ? ORDER BY starts_at", seriesId);
  const last = lessons.reduce((a, b) => Math.abs(DateTime.fromISO(b.starts_at).toMillis() - target) < Math.abs(DateTime.fromISO(a.starts_at).toMillis() - target) ? b : a);
  run("DELETE FROM bookings WHERE series_id = ? AND starts_at > ?", seriesId, last.starts_at);
  run("UPDATE booking_series SET last_start = ? WHERE id = ?", last.starts_at, seriesId);
  assert.equal(await runSeriesReminders(), 1);
  assert.equal(await runSeriesReminders(), 0, "reminded once");
  await settle();
  const reminder = emailsTo("wendy@example.com").at(-1)!;
  assert.match(reminder.subject, /Keep your Piano lesson/);
  assert.match(reminder.body, /\?renew=1/);

  const before = all("SELECT 1 FROM bookings WHERE series_id = ?", seriesId).length;
  const renewed = await api("POST", `/api/public/manage/${token}/series/renew`, {}, "");
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.ok(renewed.body.added >= 24);
  assert.equal(all("SELECT 1 FROM bookings WHERE series_id = ?", seriesId).length, before + renewed.body.added);
  assert.equal(one("SELECT reminder_sent_at FROM booking_series WHERE id = ?", seriesId)!.reminder_sent_at, null, "it'll remind again before the new end");
});

test("cancelling the series cancels the remaining lessons with one email", async () => {
  const before = emailsTo("wendy@example.com").length;
  const res = await api("POST", `/api/admin/${bid}/series/${seriesId}/cancel`);
  assert.ok(res.body.cancelled > 20);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE series_id = ? AND status = 'confirmed' AND starts_at > ?", seriesId, DateTime.utc().toISO())!.n, 0);
  await settle();
  const after = emailsTo("wendy@example.com");
  assert.equal(after.length, before + 1);
  assert.match(after.at(-1)!.subject, /repeating Piano lesson .* is cancelled/);
});

test("the owner can make a fortnightly series from + New booking, even outside the booking window", async () => {
  const s = await slot();
  const res = await api("POST", `/api/admin/${bid}/bookings`, { serviceId: svc, staffId: alex, start: s.start, name: "Fortnightly Fred", email: "fred@example.com", repeat: { intervalWeeks: 2, weeks: 26 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.seriesResult.created + res.body.seriesResult.skipped.length, 13);
});

test("the owner sees active series, soonest-ending first, and the legal page details are public", async () => {
  const list = (await api("GET", `/api/admin/${bid}/series`)).body;
  assert.ok(list.length >= 1);
  assert.equal(list[0].service_name, "Piano lesson (30 min)");
  assert.ok(list.every((s: any, i: number) => i === 0 || s.last_start >= list[i - 1].last_start));
  const legal = (await api("GET", "/api/public/legal", undefined, "")).body;
  assert.deepEqual(Object.keys(legal).sort(), ["address", "companyName", "contactEmail", "effectiveDate", "governingLaw"]);
});
