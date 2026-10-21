process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");

let server: Server, base = "", owner = "", boss = "", bid = "", svc = "";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

let dayOffset = 3;
/** A booking paid online (test-mode payments), a few weekdays out. */
async function paidBooking(email: string) {
  let d = DateTime.now().setZone("America/New_York").plus({ days: dayOffset++ });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const [slot] = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${d.toISODate()}`, undefined, "")).body;
  const res = await api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: svc, staffId: slot.staffId, start: slot.start, name: "Paying Customer", email }, "");
  await fetch(res.body.paymentUrl.replace(/^https?:\/\/[^/]+/, base), { redirect: "manual" });
  const booking = one("SELECT * FROM bookings WHERE manage_token = ?", res.body.booking.manageToken)!;
  assert.equal(one("SELECT status FROM payments WHERE booking_id = ?", booking.id)!.status, "paid");
  return booking;
}
const paymentOf = (bookingId: string) => one("SELECT * FROM payments WHERE booking_id = ?", bookingId)!;

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  boss = (await api("POST", "/api/auth/login", { email: "super@slotwise.test", password: "super1234" }, "")).body.token;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
  svc = one("SELECT id FROM services WHERE business_id = ? AND name LIKE 'Piano lesson (30%'", bid)!.id;
});
after(() => server.close());

test("moving a paid booking keeps the payment; the business cancelling it refunds in full and tells the customer", async () => {
  const b = await paidBooking("move-then-cancel@example.com");
  const later = DateTime.fromISO(b.starts_at).plus({ days: 7 }).toUTC().toISO();
  assert.equal((await api("PATCH", `/api/admin/${bid}/bookings/${b.id}`, { start: later, force: true })).status, 200);
  assert.equal(paymentOf(b.id).status, "paid", "rescheduling never refunds");

  const res = await api("PATCH", `/api/admin/${bid}/bookings/${b.id}`, { status: "cancelled" });
  assert.equal(res.status, 200);
  assert.equal(paymentOf(b.id).status, "refunded");
  assert.equal(paymentOf(b.id).refunded_cents, paymentOf(b.id).amount_cents);
  await settle();
  const email = one("SELECT body FROM email_messages WHERE booking_id = ? AND kind = 'booking_cancelled'", b.id)!;
  assert.match(email.body, /has been refunded to the card you paid with/);
});

test("if the refund fails, the booking is still cancelled and the business is shown what to do", async () => {
  const b = await paidBooking("refund-fails@example.com");
  run("UPDATE payments SET provider = 'stripe' WHERE booking_id = ?", b.id); // no Stripe keys saved, so the refund fails
  const res = await api("PATCH", `/api/admin/${bid}/bookings/${b.id}`, { status: "cancelled" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "cancelled");
  assert.match(res.body.refundError, /Stripe keys/);
  assert.equal(paymentOf(b.id).status, "paid");
  assert.ok(one("SELECT 1 FROM audit_log WHERE action = 'payment.refund_failed'"));
});

test("closing a business cancels and refunds its upcoming bookings; it can't be reactivated; then it can be deleted", async () => {
  const a = await paidBooking("close-a@example.com"), c = await paidBooking("close-b@example.com");
  assert.equal((await api("DELETE", `/api/super/businesses/${bid}`, undefined, boss)).status, 400, "close first");
  assert.equal((await api("POST", `/api/super/businesses/${bid}/close`, {}, owner)).status, 403, "super admin only");

  const closed = await api("POST", `/api/super/businesses/${bid}/close`, {}, boss);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.ok(closed.body.bookingsCancelled >= 2);
  for (const b of [a, c]) {
    assert.equal(one("SELECT status FROM bookings WHERE id = ?", b.id)!.status, "cancelled");
    assert.equal(paymentOf(b.id).status, "refunded");
  }
  const biz = one("SELECT * FROM businesses WHERE id = ?", bid)!;
  assert.equal(biz.suspended, 1);
  assert.ok(biz.closed_at);
  assert.equal((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).status, 404);
  assert.equal((await api("PATCH", `/api/super/businesses/${bid}`, { suspended: false }, boss)).status, 400);

  assert.equal((await api("DELETE", `/api/super/businesses/${bid}`, undefined, boss)).status, 200);
  assert.equal(one("SELECT 1 FROM businesses WHERE id = ?", bid), undefined);
  assert.equal(one("SELECT 1 FROM bookings WHERE business_id = ?", bid), undefined);
  assert.ok(one("SELECT 1 FROM audit_log WHERE action = 'business.deleted'"));
});
