process.env.NODE_ENV = "test";
// Auth token only: signatures can be checked, but sending stays simulated (no account SID).
process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
process.env.PUBLIC_API_URL = "http://api.test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { all, one, run } = await import("../src/db.js");
const { createBooking } = await import("../src/lib/bookings.js");
const { runReminders } = await import("../src/lib/reminders.js");
const { handleInboundSms } = await import("../src/lib/smsInbound.js");
const { normalizePhone, sendSms } = await import("../src/lib/sms.js");
const { findSlots } = await import("../src/lib/availability.js");

const CUSTOMER = "+15557770001";
const ADMIN = "+15550102020";
let business: any;
let server: Server;
let base = "";
const settle = () => new Promise((r) => setTimeout(r, 30)); // notify() sends texts without blocking the request
const texts = (to: string) => all("SELECT * FROM sms_messages WHERE to_phone = ? AND direction = 'outbound' ORDER BY created_at, rowid", to);

function bookAt(daysAhead: number, phone = CUSTOMER, optIn = true) {
  const svc = one("SELECT * FROM services WHERE business_id = ? AND name LIKE 'Guitar%'", business.id)!;
  let day = DateTime.now().setZone(business.timezone).plus({ days: daysAhead });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  const [slot] = findSlots({ businessId: business.id, serviceId: svc.id, from: day.toISODate()!, to: day.toISODate()! })
    .filter((s) => !one("SELECT 1 FROM bookings WHERE starts_at = ? AND status != 'cancelled'", s.start));
  return createBooking({
    businessId: business.id, serviceId: svc.id, staffId: slot.staffId, start: slot.start,
    customer: { name: "Pat Lee", email: "pat@example.com", phone }, source: "admin", smsOptIn: optIn,
  }, { label: "admin:owner@demo.test" });
}

before(async () => {
  await seed();
  business = one("SELECT * FROM businesses WHERE slug = 'riverside-music'");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

test("phone numbers normalise to E.164", () => {
  assert.equal(normalizePhone("(555) 777-0001"), CUSTOMER);
  assert.equal(normalizePhone("1-555-777-0001"), CUSTOMER);
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("12"), null);
});

test("new booking texts the opted-in customer; admin isn't alerted about their own booking", async () => {
  const before = texts(ADMIN).length;
  const b = bookAt(5);
  await settle();
  assert.equal(b.customer_phone, CUSTOMER);
  const sent = texts(CUSTOMER).at(-1)!;
  assert.equal(sent.kind, "booking_confirmed");
  assert.equal(sent.status, "simulated");
  assert.match(sent.body, /You're booked for Guitar lesson/);
  assert.equal(texts(ADMIN).length, before);

  const noConsent = bookAt(6, "+15557770002", false);
  await settle();
  assert.equal(noConsent.sms_opt_in, 0);
  assert.equal(texts("+15557770002").length, 0);
});

test("reminders: one per threshold, closest only, never duplicated", async () => {
  const b = bookAt(5);
  run("UPDATE bookings SET created_at = datetime('now','-10 days') WHERE id = ?", b.id);
  const start = DateTime.fromISO(b.starts_at);
  const kinds = () => texts(CUSTOMER).filter((m) => m.booking_id === b.id && m.kind.startsWith("reminder")).map((m) => m.kind);

  await runReminders(start.minus({ hours: 30 }));
  assert.deepEqual(kinds(), []);
  await runReminders(start.minus({ hours: 20 }));
  await runReminders(start.minus({ hours: 19 }));
  assert.deepEqual(kinds(), ["reminder_24h"]);
  await runReminders(start.minus({ minutes: 90 }));
  assert.deepEqual(kinds(), ["reminder_24h", "reminder_2h"]);
  // Staff reminder (60 min) goes to the instructor's phone.
  await runReminders(start.minus({ minutes: 50 }));
  const staffPhone = one("SELECT phone FROM staff WHERE id = ?", b.staff_id)!.phone;
  assert.ok(texts(staffPhone).some((m) => m.kind === "staff_reminder" && m.booking_id === b.id));
  run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", b.id);
});

test("reply C confirms and alerts the admin", async () => {
  const b = bookAt(7);
  await settle();
  const [reply] = await handleInboundSms("555-777-0001", "c");
  assert.match(reply.body, /you're confirmed/);
  await settle();
  assert.ok(one("SELECT customer_confirmed_at FROM bookings WHERE id = ?", b.id)!.customer_confirmed_at);
  assert.match(texts(ADMIN).at(-1)!.body, /^\[Confirmed by text\] Pat Lee/);
});

test("reply R offers three times; replying 2 moves the booking", async () => {
  const b = bookAt(8);
  await settle();
  const [offer] = await handleInboundSms(CUSTOMER, "R");
  assert.match(offer.body, /Reply 1, 2 or 3/);
  const convo = JSON.parse(one("SELECT state FROM sms_conversations WHERE phone = ?", CUSTOMER)!.state);
  assert.equal(convo.options.length, 3);
  const [moved] = await handleInboundSms(CUSTOMER, "2");
  assert.match(moved.body, /is now/);
  const updated = one("SELECT * FROM bookings WHERE id = ?", b.id)!;
  assert.equal(DateTime.fromISO(updated.starts_at).toMillis(), DateTime.fromISO(convo.options[1].start).toMillis());
  await settle();
  assert.match(texts(ADMIN).at(-1)!.body, /^\[Rescheduled\]/);
});

test("reply X cancels; unknown text gets the menu (no AI key here)", async () => {
  const b = bookAt(10); // well outside the 24h cancellation window, and now the booking we last texted about
  await settle();
  const [menu] = await handleInboundSms(CUSTOMER, "what time is it again?");
  assert.match(menu.body, /Reply C to confirm, R to reschedule, or X to cancel/);
  const [cancelled] = await handleInboundSms(CUSTOMER, "X");
  assert.match(cancelled.body, /is cancelled/);
  assert.equal(cancelled.booking_id, b.id);
  assert.equal(one("SELECT status FROM bookings WHERE id = ?", b.id)!.status, "cancelled");
});

test("STOP opts out of all texts; START opts back in", async () => {
  await handleInboundSms(CUSTOMER, "STOP");
  const msg = await sendSms({ business, to: CUSTOMER, body: "hi", kind: "test", audience: "customer" });
  assert.equal(msg.status, "skipped");
  await handleInboundSms(CUSTOMER, "start");
  assert.equal((await sendSms({ business, to: CUSTOMER, body: "hi", kind: "test", audience: "customer" })).status, "simulated");
});

test("admin texts TODAY for the agenda; morning agenda is sent once", async () => {
  const [agenda] = await handleInboundSms(ADMIN, "today");
  assert.match(agenda.body, /^Today at Riverside Music/);
  const agendas = () => texts(ADMIN).filter((m) => m.kind === "agenda").length;
  const before = agendas();
  const morning = DateTime.now().setZone(business.timezone).plus({ days: 20 }).set({ hour: 7, minute: 5 });
  await runReminders(morning.toUTC());
  await runReminders(morning.plus({ minutes: 30 }).toUTC());
  assert.equal(agendas() - before, 1);
});

test("plan allowance stops sending once used up", async () => {
  run("UPDATE businesses SET plan = 'free' WHERE id = ?", business.id); // 50/month
  const fresh = one("SELECT * FROM businesses WHERE id = ?", business.id);
  for (let i = 0; i < 50; i++) await sendSms({ business: fresh, to: "+15558880000", body: "x", kind: "test", audience: "customer" });
  const over = await sendSms({ business: fresh, to: "+15558880000", body: "x", kind: "test", audience: "customer" });
  assert.equal(over.status, "skipped");
  assert.match(over.error, /allowance/);
  run("UPDATE businesses SET plan = 'pro' WHERE id = ?", business.id);
});

test("Twilio webhook requires a valid signature", async () => {
  const params = { From: "+15559990000", Body: "hello" };
  const post = (sig: string) => fetch(`${base}/api/webhooks/twilio/sms`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig }, body: new URLSearchParams(params),
  });
  assert.equal((await post("bogus")).status, 403);
  const data = "http://api.test/api/webhooks/twilio/sms" + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("");
  const good = await post(createHmac("sha1", "test-twilio-token").update(data).digest("base64"));
  assert.equal(good.status, 200);
  assert.match(await good.text(), /<Response>/);
});
