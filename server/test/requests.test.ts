process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { all, one, run } = await import("../src/db.js");
const { meter } = await import("../src/lib/usage.js");
const { expireUnpaidBookings } = await import("../src/lib/bookings.js");

let server: Server, base = "", owner = "", bid = "", paid = "";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
let cursor = 0;
async function slot() {
  let d = DateTime.now().setZone("America/New_York").plus({ days: 3 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${paid}&from=${d.toISODate()}&to=${d.plus({ days: 6 }).toISODate()}`, undefined, "")).body;
  return slots[cursor++ * 4];
}
const request = async (email: string, s?: any) => {
  s ??= await slot();
  return { s, res: await api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: paid, staffId: s.staffId, start: s.start, name: "Cash Customer", email, payInPerson: true }, "") };
};
const emailsTo = (to: string) => all("SELECT subject, body, kind FROM email_messages WHERE to_email = ? ORDER BY rowid", to);
const used = () => meter(one("SELECT * FROM businesses WHERE id = ?", bid)!, "bookings").used;

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
  paid = one("SELECT id FROM services WHERE business_id = ? AND price_cents > 0 ORDER BY price_cents LIMIT 1", bid)!.id;
});
after(() => server.close());

test("pay-in-person requests are refused unless the business allows them", async () => {
  const page = (await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body;
  assert.equal(page.cashRequests, false);
  const { res } = await request("nope@example.com");
  assert.equal(res.status, 400);
  assert.equal((await api("PATCH", `/api/admin/${bid}`, { cash_requests: true })).status, 200);
  assert.equal((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body.cashRequests, true);
});

test("a request holds the slot, asks for no payment, tells the customer and doesn't count yet", async () => {
  const before = used();
  const { s, res } = await request("cash1@example.com");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.booking.status, "requested");
  assert.equal(res.body.booking.payInPerson, true);
  assert.equal(res.body.paymentUrl, undefined, "no checkout");
  assert.equal(all("SELECT 1 FROM payments WHERE booking_id = ?", res.body.booking.id).length, 0);

  const day = DateTime.fromISO(s.start).setZone("America/New_York").toISODate();
  const open = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${paid}&from=${day}&staffId=${s.staffId}`, undefined, "")).body;
  assert.ok(!open.some((o: any) => o.start === s.start), "slot is held");
  assert.equal((await request("cash-dupe@example.com", s)).res.status, 409, "nobody else can take it");

  await settle();
  const [mail] = emailsTo("cash1@example.com");
  assert.match(mail.subject, /received your booking request/);
  assert.match(mail.body, /held for you/);
  assert.equal(used(), before, "requests don't use the allowance");
  assert.equal((await api("GET", `/api/admin/${bid}`)).body.requests_waiting, 1);
  // Can't be paid online, and the manage page can still cancel it
  assert.equal((await api("POST", `/api/public/manage/${res.body.booking.manageToken}/pay`, {}, "")).status, 400);
});

test("accepting confirms it, counts it and sends the confirmation with the calendar invite", async () => {
  const { res } = await request("cash2@example.com");
  const before = used();
  const accepted = await api("POST", `/api/admin/${bid}/bookings/${res.body.booking.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, "confirmed");
  assert.equal(used(), before + 1);
  await settle();
  const mails = emailsTo("cash2@example.com");
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /Your booking is confirmed/);
  assert.match(mails[1].body, /You're paying in person at your appointment: \$\d+\.\d\d\./);
  assert.equal((await api("POST", `/api/admin/${bid}/bookings/${res.body.booking.id}/accept`)).status, 400, "only requests can be accepted");
});

test("declining releases the slot and tells the customer why", async () => {
  const { s, res } = await request("cash3@example.com");
  const declined = await api("POST", `/api/admin/${bid}/bookings/${res.body.booking.id}/decline`, { reason: "We only take card for new students." });
  assert.equal(declined.body.status, "cancelled");
  await settle();
  const last = emailsTo("cash3@example.com").at(-1)!;
  assert.match(last.subject, /wasn't accepted/);
  assert.match(last.body, /We only take card for new students\./);
  assert.equal((await request("cash3b@example.com", s)).res.status, 200, "the slot is free again");
});

test("customers can cancel their own request any time; unanswered requests are released at their start time", async () => {
  const { res } = await request("cash4@example.com");
  assert.equal((await api("POST", `/api/public/manage/${res.body.booking.manageToken}/cancel`, {}, "")).body.status, "cancelled");

  const { res: late } = await request("cash5@example.com");
  run("UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = ?", DateTime.utc().minus({ hours: 1 }).toISO(), DateTime.utc().toISO(), late.body.booking.id);
  expireUnpaidBookings();
  assert.equal(one("SELECT status FROM bookings WHERE id = ?", late.body.booking.id)!.status, "cancelled");
  await settle();
  assert.match(emailsTo("cash5@example.com").at(-1)!.body, /wasn't confirmed before the appointment time/);
});
