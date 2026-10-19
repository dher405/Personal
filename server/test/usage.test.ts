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

test("only online bookings count; alerts at 80% and 100%; booking pauses when used up", async () => {
  await setProAllowance({ bookingsPerMonth: 5 });
  for (let i = 0; i < 4; i++) assert.equal((await bookOnline(`u${i}@example.com`)).status, 200);
  await settle();
  const alerts = () => all("SELECT threshold FROM usage_alerts WHERE business_id = ? AND metric = 'bookings' ORDER BY threshold", bid).map((r) => r.threshold);
  assert.deepEqual(alerts(), [80], "80% alert at 4 of 5");

  // An admin-entered booking is neither counted nor blocked.
  const s = await nextSlot();
  const admin = await api("POST", `/api/admin/${bid}/bookings`, { serviceId: svc, staffId: s.staffId, start: s.start, name: "Walk In", email: "walkin@example.com" });
  assert.equal(admin.status, 200);
  const usage = (await api("GET", `/api/admin/${bid}/usage`)).body;
  const bookings = usage.meters.find((m: any) => m.metric === "bookings");
  assert.equal(bookings.used, 4);
  assert.equal(bookings.percent, 80);

  assert.equal((await bookOnline("u4@example.com")).status, 200);
  await settle();
  assert.deepEqual(alerts(), [80, 100]);
  const blocked = await bookOnline("u5@example.com");
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /isn't taking online bookings right now\. Please call \(555\) 010-2020/);
  assert.equal((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body.onlineBookingPaused, true);
  // Still free for admins
  const s2 = await nextSlot();
  assert.equal((await api("POST", `/api/admin/${bid}/bookings`, { serviceId: svc, staffId: s2.staffId, start: s2.start, name: "Phone", email: "phone@example.com" })).status, 200);
});

test("buying a pack adds room for the rest of the month", async () => {
  const usage = (await api("GET", `/api/admin/${bid}/usage`)).body;
  const pack = usage.packs.find((p: any) => p.metric === "bookings");
  const bought = await api("POST", `/api/admin/${bid}/usage/packs`, { packId: pack.id, packs: 2 });
  assert.equal(bought.body.applied, true); // no Stripe in tests: applied straight away
  const after = (await api("GET", `/api/admin/${bid}/usage`)).body;
  const m = after.meters.find((x: any) => x.metric === "bookings");
  assert.equal(m.extra, pack.quantity * 2);
  assert.equal(m.limit, 5 + pack.quantity * 2);
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
  packs.find((p: any) => p.metric === "sms").priceCents = 700;
  assert.equal((await api("PUT", "/api/super/packs", packs, superToken)).body.find((p: any) => p.metric === "sms").priceCents, 700);
  const granted = await api("POST", `/api/super/businesses/${bid}/credits`, { metric: "sms", quantity: 40 }, superToken);
  assert.equal(granted.body.find((m: any) => m.metric === "sms").extra, 40);
  const list = (await api("GET", "/api/super/businesses", undefined, superToken)).body;
  const row = list.find((b: any) => b.id === bid);
  assert.deepEqual(row.usage.map((m: any) => m.metric), ["bookings", "sms", "ai"]);
  assert.equal((await api("POST", `/api/super/businesses/${bid}/credits`, { metric: "sms", quantity: 5 }, owner)).status, 403);
});
