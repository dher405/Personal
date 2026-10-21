process.env.NODE_ENV = "test";
process.env.PUBLIC_API_URL = "http://api.test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { all, one, run } = await import("../src/db.js");
const { meter, hasCapacity, recordUse } = await import("../src/lib/usage.js");

let server: Server, base = "", owner = "", superToken = "", bid = "", svc = "";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null, headers: res.headers };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
let slotCursor = 0;
async function nextSlot() {
  let d = DateTime.now().setZone("America/New_York").plus({ days: 3 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${d.toISODate()}&to=${d.plus({ days: 6 }).toISODate()}`, undefined, "")).body;
  return slots[slotCursor++ * 3];
}
const bookOnline = async (email: string) => {
  const s = await nextSlot();
  return api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: svc, staffId: s.staffId, start: s.start, name: "Usage Tester", email }, "");
};
async function setProAllowance(fields: Record<string, number>) {
  const plans = (await api("GET", "/api/super/plans", undefined, superToken)).body;
  Object.assign(plans.find((p: any) => p.id === "pro"), fields);
  assert.equal((await api("PUT", "/api/super/plans", plans, superToken)).status, 200);
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  superToken = (await api("POST", "/api/auth/login", { email: "super@slotwise.test", password: "super1234" }, "")).body.token;
  bid = (await api("GET", "/api/auth/me")).body.businesses[0].id;
  svc = one("SELECT id FROM services WHERE name = 'Free trial lesson'")!.id; // free: no payment step
});
after(() => server.close());

test("every booking counts; warnings at 80% and 90% before the limit; bookings pause at 100%", async () => {
  await setProAllowance({ bookingsPerMonth: 10 });
  const alerts = () => all("SELECT threshold FROM usage_alerts WHERE business_id = ? AND metric = 'bookings' ORDER BY threshold", bid).map((r) => r.threshold);
  const adminBook = async (email: string) => {
    const s = await nextSlot();
    return api("POST", `/api/admin/${bid}/bookings`, { serviceId: svc, staffId: s.staffId, start: s.start, name: "Walk In", email });
  };
  for (let i = 0; i < 4; i++) assert.equal((await bookOnline(`u${i}@example.com`)).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await adminBook(`w${i}@example.com`)).status, 200);
  await settle();
  const bookings = (await api("GET", `/api/admin/${bid}/usage`)).body.meters.find((m: any) => m.metric === "bookings");
  assert.equal(bookings.used, 8, "bookings the business enters count too");
  assert.equal(bookings.label, "bookings");
  assert.deepEqual(alerts(), [80], "first warning at 8 of 10");

  assert.equal((await bookOnline("u4@example.com")).status, 200);
  await settle();
  assert.deepEqual(alerts(), [80, 90], "second warning before the limit");
  assert.equal((await adminBook("w4@example.com")).status, 200);
  await settle();
  assert.deepEqual(alerts(), [80, 90, 100]);

  const blocked = await bookOnline("u5@example.com");
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /isn't taking online bookings right now\. Please call \(555\) 010-2020/);
  const adminBlocked = await adminBook("w5@example.com");
  assert.equal(adminBlocked.status, 403);
  assert.match(adminBlocked.body.error, /used all the bookings in your plan this month/);
  assert.equal((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body.onlineBookingPaused, true);
});

test("buying a pack adds room for the rest of the month", async () => {
  const usage = (await api("GET", `/api/admin/${bid}/usage`)).body;
  const pack = usage.packs.find((p: any) => p.metric === "bookings");
  const bought = await api("POST", `/api/admin/${bid}/usage/packs`, { packId: pack.id, packs: 2 });
  assert.equal(bought.body.applied, true); // no Stripe in tests: applied straight away
  const after = (await api("GET", `/api/admin/${bid}/usage`)).body;
  const m = after.meters.find((x: any) => x.metric === "bookings");
  assert.equal(m.extra, pack.quantity * 2);
  assert.equal(m.limit, 10 + pack.quantity * 2);
  assert.equal(after.purchases[0].source, "purchase");
  assert.equal((await bookOnline("after-pack@example.com")).status, 200);
  assert.equal((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body.onlineBookingPaused, false);
});

test("auto top-up adds the smallest pack when a meter runs out", async () => {
  const b = one("SELECT * FROM businesses WHERE id = ?", bid)!;
  await setProAllowance({ aiMessagesPerMonth: 1 });
  recordUse(b, "ai", "chat-1:2");
  assert.equal(hasCapacity(b, "ai"), false);
  assert.equal((await api("PUT", `/api/admin/${bid}/usage/auto-topup`, { enabled: true })).status, 200);
  const fresh = one("SELECT * FROM businesses WHERE id = ?", bid)!;
  assert.equal(hasCapacity(fresh, "ai"), true);
  const credit = one("SELECT * FROM usage_credits WHERE business_id = ? AND metric = 'ai'", bid)!;
  assert.equal(credit.source, "auto");
  assert.equal(credit.quantity, 250);
  assert.equal(meter(fresh, "ai").limit, 251);
  await api("PUT", `/api/admin/${bid}/usage/auto-topup`, { enabled: false });
});

test("a paid booking counts only once payment completes", async () => {
  run("UPDATE businesses SET require_payment = 1 WHERE id = ?", bid);
  const paidSvc = one("SELECT id FROM services WHERE name LIKE 'Guitar%'")!.id;
  const before = meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used;
  let d = DateTime.now().setZone("America/New_York").plus({ days: 10 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const [slot] = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${paidSvc}&from=${d.toISODate()}`, undefined, "")).body;
  const res = await api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: paidSvc, staffId: slot.staffId, start: slot.start, name: "Payer", email: "payer@example.com" }, "");
  assert.equal(meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used, before, "pending payment not counted");
  await fetch(res.body.paymentUrl.replace("http://api.test", base), { redirect: "manual" });
  assert.equal(meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used, before + 1);
  run("UPDATE businesses SET require_payment = 0 WHERE id = ?", bid);
});

test("super admin: edit packs, grant credits, see each business's usage", async () => {
  const packs = (await api("GET", "/api/super/packs", undefined, superToken)).body;
  packs.find((p: any) => p.metric === "ai").priceCents = 700;
  assert.equal((await api("PUT", "/api/super/packs", packs, superToken)).body.find((p: any) => p.metric === "ai").priceCents, 700);
  const extraBefore = meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "ai").extra;
  const granted = await api("POST", `/api/super/businesses/${bid}/credits`, { metric: "ai", quantity: 40 }, superToken);
  assert.equal(granted.body.find((m: any) => m.metric === "ai").extra, extraBefore + 40);
  const list = (await api("GET", "/api/super/businesses", undefined, superToken)).body;
  const row = list.find((b: any) => b.id === bid);
  assert.deepEqual(row.usage.map((m: any) => m.metric), ["bookings", "ai"]);
  assert.equal((await api("POST", `/api/super/businesses/${bid}/credits`, { metric: "ai", quantity: 5 }, owner)).status, 403);
});

test("moving to Starter keeps the paid plan until the paid period ends", async () => {
  const { handleSubscriptionEvent } = await import("../src/lib/platformBilling.js");
  run("UPDATE businesses SET plan = 'pro', platform_subscription_id = 'sub_test', plan_ends_at = NULL WHERE id = ?", bid);
  const periodEnd = Math.floor(Date.now() / 1000) + 20 * 86400;
  const sub = (extra: Record<string, unknown>) => ({
    id: "sub_test", status: "active", metadata: { businessId: bid, planId: "pro" },
    cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: periodEnd }] }, ...extra,
  });
  const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, data: { object: sub(extra) } }) as any;

  // Cancelled from the billing portal (or by choosing Starter): still Pro, with an end date.
  handleSubscriptionEvent(event("customer.subscription.updated", { cancel_at_period_end: true, cancel_at: periodEnd }));
  let b = (await api("GET", `/api/admin/${bid}`)).body;
  assert.equal(b.plan, "pro");
  assert.equal(b.plan_ends_at, new Date(periodEnd * 1000).toISOString());

  // Changing their mind clears it.
  assert.equal((await api("POST", `/api/admin/${bid}/billing/keep`)).status, 200);
  assert.equal((await api("GET", `/api/admin/${bid}`)).body.plan_ends_at, null);

  // The period ends: Stripe deletes the subscription and they move to Starter.
  handleSubscriptionEvent(event("customer.subscription.updated", { cancel_at_period_end: true, cancel_at: periodEnd }));
  handleSubscriptionEvent(event("customer.subscription.deleted", { status: "canceled" }));
  b = (await api("GET", `/api/admin/${bid}`)).body;
  assert.equal(b.plan, "free");
  assert.equal(b.plan_ends_at, null);
  assert.equal(b.platform_subscription_id, null);
  run("UPDATE businesses SET plan = 'pro' WHERE id = ?", bid);
});

test("hidden plans stay off the home page and the Billing page, and only the super admin can give them", async () => {
  const plans = (await api("GET", "/api/super/plans", undefined, superToken)).body;
  const saved = [...plans, { id: "tester", name: "Tester", monthlyPriceCents: 0, maxStaff: 1, aiChat: true, bookingsPerMonth: 2000, aiMessagesPerMonth: 5000, visible: false }];
  assert.equal((await api("PUT", "/api/super/plans", saved, superToken)).status, 200);
  assert.equal((await api("PUT", "/api/super/plans", saved.map((p: any) => (p.id === "free" ? { ...p, visible: false } : p)), superToken)).status, 400, "Starter stays visible");

  const ids = (body: any[]) => body.map((p) => p.id);
  assert.ok(!ids((await api("GET", "/api/public/plans", undefined, "")).body).includes("tester"));
  assert.ok(!ids((await api("GET", `/api/admin/${bid}/plans`)).body).includes("tester"));
  assert.ok(ids((await api("GET", "/api/super/plans", undefined, superToken)).body).includes("tester"));
  const choose = await api("POST", `/api/admin/${bid}/billing/checkout`, { planId: "tester" });
  assert.equal(choose.status, 400);
  assert.match(choose.body.error, /isn't available/);

  // Given by the super admin, the business sees it as its current plan.
  const before = one("SELECT plan FROM businesses WHERE id = ?", bid)!.plan;
  run("UPDATE businesses SET plan = 'tester' WHERE id = ?", bid);
  assert.ok(ids((await api("GET", `/api/admin/${bid}/plans`)).body).includes("tester"));
  run("UPDATE businesses SET plan = ? WHERE id = ?", before, bid);
});
