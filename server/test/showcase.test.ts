process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one } = await import("../src/db.js");
const { meter } = await import("../src/lib/usage.js");
const { clearShowcaseBookings } = await import("../src/lib/showcase.js");

let server: Server, base = "", owner = "", boss = "", bid = "";
async function api(method: string, path: string, body?: unknown, token = "") {
  const res = await fetch(base + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" })).body.token;
  boss = (await api("POST", "/api/auth/login", { email: "super@slotwise.test", password: "super1234" })).body.token;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
});
after(() => server.close());

test("the super admin picks the home page demo; the booking page says it's a demo", async () => {
  assert.equal((await api("GET", "/api/public/showcase")).body, null);
  assert.equal((await api("PATCH", `/api/super/businesses/${bid}`, { showcase: true }, boss)).status, 200);
  assert.deepEqual((await api("GET", "/api/public/showcase")).body, { id: bid, name: "Riverside Music", slug: "riverside-music" });
  assert.deepEqual((await api("GET", "/api/public/businesses/riverside-music")).body.demo, { clearedAfterHours: 3 });
  assert.equal(one("SELECT payment_provider FROM businesses WHERE id = ?", bid)!.payment_provider, "mock", "test payments");
});

test("only the super admin can change the demo business", async () => {
  assert.equal((await api("GET", `/api/admin/${bid}/services`, undefined, owner)).status, 200);
  const edit = await api("PATCH", `/api/admin/${bid}`, { name: "Something else" }, owner);
  assert.equal(edit.status, 403);
  assert.match(edit.body.error, /showcase demo/);
  assert.equal((await api("PATCH", `/api/admin/${bid}`, { description: "Lessons for all ages." }, boss)).status, 200);
});

test("visitors book and pay with a test payment; nothing is sent or counted; their bookings are cleared later", async () => {
  const usedBefore = meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used;
  const svc = one("SELECT id FROM services WHERE business_id = ? AND name LIKE 'Piano lesson (30%'", bid)!.id;
  let d = DateTime.now().setZone("America/New_York").plus({ days: 3 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const [slot] = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${d.toISODate()}`)).body;
  const res = await api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: svc, staffId: slot.staffId, start: slot.start, name: "Curious Visitor", email: "visitor@example.com", phone: "5551234567", smsOptIn: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await fetch(res.body.paymentUrl.replace(/^https?:\/\/[^/]+/, base), { redirect: "manual" });
  const booking = one("SELECT * FROM bookings WHERE manage_token = ?", res.body.booking.manageToken)!;
  assert.equal(booking.status, "confirmed");
  assert.equal(one("SELECT status FROM payments WHERE booking_id = ?", booking.id)!.status, "paid");

  await new Promise((r) => setTimeout(r, 80));
  const email = one("SELECT status, error FROM email_messages WHERE booking_id = ?", booking.id)!;
  assert.equal(email.status, "not_sent");
  assert.match(email.error, /Demo business/);
  assert.equal(one("SELECT 1 FROM sms_messages WHERE booking_id = ? AND status = 'sent'", booking.id), undefined, "no texts");
  assert.equal(meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used, usedBefore, "doesn't use up the allowance");
  assert.equal((await api("GET", `/api/public/manage/${booking.manage_token}`)).body.business.is_demo, 1);

  assert.equal(clearShowcaseBookings(), 0, "kept for a few hours");
  assert.ok(clearShowcaseBookings(DateTime.utc().plus({ hours: 4 })) >= 1);
  assert.equal(one("SELECT 1 FROM bookings WHERE id = ?", booking.id), undefined);
  assert.equal(one("SELECT 1 FROM payments WHERE booking_id = ?", booking.id), undefined);
});

test("turning it off removes it from the home page and switches off test payments", async () => {
  assert.equal((await api("PATCH", `/api/super/businesses/${bid}`, { showcase: false }, boss)).status, 200);
  assert.equal((await api("GET", "/api/public/showcase")).body, null);
  assert.equal(one("SELECT payment_provider FROM businesses WHERE id = ?", bid)!.payment_provider, "none");
  const created = await api("POST", "/api/super/showcase/create", {}, boss);
  assert.equal(created.status, 200);
  assert.equal(created.body.slug, "riverside-music-2");
  assert.equal(one("SELECT COUNT(*) AS n FROM services WHERE business_id = ?", created.body.id)!.n, 5);
});
