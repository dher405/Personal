process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");

let server: Server;
let base = "";

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null, headers: res.headers };
}

// Payment URLs are built from PUBLIC_API_URL; point them at the test server.
const local = (url: string) => url.replace(/^https?:\/\/[^/]+/, base);

const login = async (email: string, password: string) => (await api("POST", "/api/auth/login", { email, password })).body.token as string;

// Next weekday at least 3 days out, so min-notice and cancellation windows don't interfere.
function nextWeekday() {
  let d = DateTime.now().setZone("America/New_York").plus({ days: 3 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  return d.toISODate()!;
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

test("public business page lists services and staff", async () => {
  const res = await api("GET", "/api/public/businesses/riverside-music");
  assert.equal(res.status, 200);
  assert.equal(res.body.services.length, 5);
  assert.equal(res.body.staff.length, 2);
});

test("slots respect hours, duration and staff assignment", async () => {
  const biz = (await api("GET", "/api/public/businesses/riverside-music")).body;
  const piano60 = biz.services.find((s: any) => s.name.includes("60"));
  const day = nextWeekday();
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${piano60.id}&from=${day}`)).body;
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s: any) => s.staffName === "Alex Kim"));
  const first = DateTime.fromISO(slots[0].start).setZone("America/New_York");
  const last = DateTime.fromISO(slots.at(-1).end).setZone("America/New_York");
  assert.equal(first.toFormat("HH:mm"), "09:00");
  assert.ok(last.toFormat("HH:mm") <= "17:00");
});

test("booking with payment: hold, mock checkout, confirm, no double booking", async () => {
  const biz = (await api("GET", "/api/public/businesses/riverside-music")).body;
  const svc = biz.services.find((s: any) => s.name.includes("30 min"));
  const day = nextWeekday();
  const [slot] = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc.id}&from=${day}`)).body;

  const res = await api("POST", "/api/public/businesses/riverside-music/bookings", {
    serviceId: svc.id, staffId: slot.staffId, start: slot.start, name: "Pat Lee", email: "pat@example.com",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.booking.status, "pending_payment");
  assert.ok(res.body.paymentUrl);

  const dup = await api("POST", "/api/public/businesses/riverside-music/bookings", {
    serviceId: svc.id, staffId: slot.staffId, start: slot.start, name: "Other", email: "o@example.com",
  });
  assert.equal(dup.status, 409);

  const checkout = await fetch(local(res.body.paymentUrl), { redirect: "manual" });
  assert.equal(checkout.status, 302);
  const managed = await api("GET", `/api/public/manage/${res.body.booking.manageToken}`);
  assert.equal(managed.body.booking.status, "confirmed");
  assert.equal(managed.body.booking.payments[0].status, "paid");

  // Customer cancels (outside the 24h window) → automatic full refund.
  const cancelled = await api("POST", `/api/public/manage/${res.body.booking.manageToken}/cancel`, {});
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.payments[0].status, "refunded");
});

test("admin can reschedule, change price, and partially refund", async () => {
  const token = await login("owner@demo.test", "demo1234");
  const me = (await api("GET", "/api/auth/me", undefined, token)).body;
  const bid = me.businesses[0].id;
  const services = (await api("GET", `/api/admin/${bid}/services`, undefined, token)).body;
  const svc = services.find((s: any) => s.name.includes("Guitar"));
  const day = nextWeekday();
  const slots = (await api("GET", `/api/admin/${bid}/slots?serviceId=${svc.id}&from=${day}`, undefined, token)).body;

  const pub = await api("POST", "/api/public/businesses/riverside-music/bookings", {
    serviceId: svc.id, staffId: slots[0].staffId, start: slots[0].start, name: "Jo", email: "jo@example.com",
  });
  await fetch(local(pub.body.paymentUrl), { redirect: "manual" });
  const bookingId = pub.body.booking.id;

  const moved = await api("PATCH", `/api/admin/${bid}/bookings/${bookingId}`, { start: slots[8].start, priceCents: 5000 }, token);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.start, slots[8].start);
  assert.equal(moved.body.priceCents, 5000);

  const paymentId = moved.body.payments[0].id;
  const refund = await api("POST", `/api/admin/${bid}/payments/${paymentId}/refund`, { amountCents: 1000, reason: "Started late" }, token);
  assert.equal(refund.body.status, "partially_refunded");
  assert.equal(refund.body.refunded_cents, 1000);
  const tooMuch = await api("POST", `/api/admin/${bid}/payments/${paymentId}/refund`, { amountCents: 999999 }, token);
  assert.equal(tooMuch.status, 400);

  const svcUpdate = await api("PATCH", `/api/admin/${bid}/services/${svc.id}`, { price_cents: 6000 }, token);
  assert.equal(svcUpdate.body.price_cents, 6000);
});

test("admins cannot touch other businesses; super admin can", async () => {
  const reg = await api("POST", "/api/auth/register", { email: "other@example.com", password: "password1", name: "Other", businessName: "Other Studio" });
  assert.equal(reg.status, 200);
  const ownerToken = await login("owner@demo.test", "demo1234");
  const otherBid = reg.body.businesses[0].id;
  assert.equal((await api("GET", `/api/admin/${otherBid}`, undefined, ownerToken)).status, 403);
  assert.equal((await api("GET", "/api/super/overview", undefined, ownerToken)).status, 403);

  const superToken = await login("super@slotwise.test", "super1234");
  assert.equal((await api("GET", `/api/admin/${otherBid}`, undefined, superToken)).status, 200);
  const plans = (await api("GET", "/api/super/plans", undefined, superToken)).body;
  plans.find((p: any) => p.id === "pro").monthlyPriceCents = 3900;
  const saved = await api("PUT", "/api/super/plans", plans, superToken);
  assert.equal(saved.body.find((p: any) => p.id === "pro").monthlyPriceCents, 3900);
  const suspended = await api("PATCH", `/api/super/businesses/${otherBid}`, { suspended: true }, superToken);
  assert.equal(suspended.body.suspended, 1);
});

test("free plan staff limit and customer cancellation window", async () => {
  const reg = await api("POST", "/api/auth/register", { email: "tutor@example.com", password: "password1", name: "T", businessName: "Tutor Co" });
  const { token } = reg.body;
  const bid = reg.body.businesses[0].id;
  assert.equal((await api("POST", `/api/admin/${bid}/staff`, { name: "One" }, token)).status, 200);
  assert.equal((await api("POST", `/api/admin/${bid}/staff`, { name: "Two" }, token)).status, 403);

  // A booking 2 hours away can't be cancelled online under a 24h policy.
  const b = one("SELECT * FROM bookings WHERE status != 'cancelled' LIMIT 1")!;
  run("UPDATE bookings SET starts_at = ? WHERE id = ?", DateTime.utc().plus({ hours: 2 }).toISO(), b.id);
  const res = await api("POST", `/api/public/manage/${b.manage_token}/cancel`, {});
  assert.equal(res.status, 403);
});
