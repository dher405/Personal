process.env.NODE_ENV = "test";
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
const { createBusiness } = await import("../src/routes/auth.js");
const { runReminders } = await import("../src/lib/reminders.js");
const { handleInboundSms } = await import("../src/lib/smsInbound.js");
const { normalizePhone, sendSms } = await import("../src/lib/sms.js");
const { findSlots } = await import("../src/lib/availability.js");
const { channelsFor, saveChannels, smsReady } = await import("../src/lib/channels.js");

const CUSTOMER = "+15557770001";
const ADMIN = "+15550102020";
let business: any;
let server: Server;
let base = "";
const settle = () => new Promise((r) => setTimeout(r, 30)); // notify() sends texts without blocking the request
const texts = (to: string) => all("SELECT * FROM sms_messages WHERE to_phone = ? AND direction = 'outbound' ORDER BY created_at, rowid", to);

function bookingInput(daysAhead: number, phone = CUSTOMER, optIn = true) {
  const svc = one("SELECT * FROM services WHERE business_id = ? AND name LIKE 'Guitar%'", business.id)!;
  let day = DateTime.now().setZone(business.timezone).plus({ days: daysAhead });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  const [slot] = findSlots({ businessId: business.id, serviceId: svc.id, from: day.toISODate()!, to: day.toISODate()! })
    .filter((s) => !one("SELECT 1 FROM bookings WHERE starts_at = ? AND status != 'cancelled'", s.start));
  return {
    businessId: business.id, serviceId: svc.id, staffId: slot.staffId, start: slot.start,
    customer: { name: "Pat Lee", email: "pat@example.com", phone }, source: "admin" as const, smsOptIn: optIn,
  };
}
const bookAt = (daysAhead: number, phone = CUSTOMER, optIn = true) =>
  createBooking(bookingInput(daysAhead, phone, optIn), { label: "admin:owner@demo.test" });

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
  const [reply] = await handleInboundSms(business, "555-777-0001", "c");
  assert.match(reply.body, /you're confirmed/);
  await settle();
  assert.ok(one("SELECT customer_confirmed_at FROM bookings WHERE id = ?", b.id)!.customer_confirmed_at);
  assert.match(texts(ADMIN).at(-1)!.body, /^\[Confirmed by text\] Pat Lee/);
});

test("reply R offers three times; replying 2 moves the booking", async () => {
  const b = bookAt(8);
  await settle();
  const [offer] = await handleInboundSms(business, CUSTOMER, "R");
  assert.match(offer.body, /Reply 1, 2 or 3/);
  const convo = JSON.parse(one("SELECT state FROM sms_conversations WHERE phone = ?", `${business.id}:${CUSTOMER}`)!.state);
  assert.equal(convo.options.length, 3);
  const [moved] = await handleInboundSms(business, CUSTOMER, "2");
  assert.match(moved.body, /is now/);
  const updated = one("SELECT * FROM bookings WHERE id = ?", b.id)!;
  assert.equal(DateTime.fromISO(updated.starts_at).toMillis(), DateTime.fromISO(convo.options[1].start).toMillis());
  await settle();
  assert.match(texts(ADMIN).at(-1)!.body, /^\[Rescheduled\]/);
});

test("reply X cancels; unknown text gets the menu (no AI key here)", async () => {
  const b = bookAt(10); // well outside the 24h cancellation window, and now the booking we last texted about
  await settle();
  const [menu] = await handleInboundSms(business, CUSTOMER, "what time is it again?");
  assert.match(menu.body, /Reply C to confirm, R to reschedule, or X to cancel/);
  const [cancelled] = await handleInboundSms(business, CUSTOMER, "X");
  assert.match(cancelled.body, /is cancelled/);
  assert.equal(cancelled.booking_id, b.id);
  assert.equal(one("SELECT status FROM bookings WHERE id = ?", b.id)!.status, "cancelled");
});

test("STOP opts out of all texts; START opts back in", async () => {
  await handleInboundSms(business, CUSTOMER, "STOP");
  const msg = await sendSms({ business, to: CUSTOMER, body: "hi", kind: "test", audience: "customer" });
  assert.equal(msg.status, "skipped");
  await handleInboundSms(business, CUSTOMER, "start");
  assert.equal((await sendSms({ business, to: CUSTOMER, body: "hi", kind: "test", audience: "customer" })).status, "simulated");
});

test("admin texts TODAY for the agenda; morning agenda is sent once", async () => {
  const [agenda] = await handleInboundSms(business, ADMIN, "today");
  assert.match(agenda.body, /^Today at Riverside Music/);
  const agendas = () => texts(ADMIN).filter((m) => m.kind === "agenda").length;
  const before = agendas();
  const morning = DateTime.now().setZone(business.timezone).plus({ days: 20 }).set({ hour: 7, minute: 5 });
  await runReminders(morning.toUTC());
  await runReminders(morning.plus({ minutes: 30 }).toUTC());
  assert.equal(agendas() - before, 1);
});

test("texting is off and hidden until the business connects its own Twilio account", async () => {
  const saved = one("SELECT comms_config, sms_enabled FROM businesses WHERE id = ?", business.id)!;
  saveChannels(business.id, { ...channelsFor(business), sms: { provider: "none" } });
  const fresh = one("SELECT * FROM businesses WHERE id = ?", business.id)!;
  assert.equal(smsReady(fresh), false);
  const msg = await sendSms({ business: fresh, to: CUSTOMER, body: "x", kind: "test", audience: "customer" });
  assert.equal(msg.status, "skipped");
  assert.match(msg.error, /Twilio/);
  const page = await (await fetch(`${base}/api/public/businesses/riverside-music`)).json();
  assert.equal(page.smsEnabled, false); // no "Text me" box on the booking page
  const b = createBooking({ ...bookingInput(12), smsOptIn: true }, { label: "admin:owner@demo.test" });
  assert.equal(b.sms_opt_in, 0); // consent isn't recorded for a channel the business doesn't have
  run("UPDATE businesses SET comms_config = ?, sms_enabled = ? WHERE id = ?", saved.comms_config, saved.sms_enabled, business.id);
});

test("STOP only opts out of the business that was texted", async () => {
  const ownerId = one("SELECT user_id FROM business_members WHERE business_id = ?", business.id)!.user_id;
  const other = createBusiness(ownerId, "Other Studio");
  saveChannels(other.id, { email: { provider: "none" }, sms: { provider: "test" } });
  await handleInboundSms(one("SELECT * FROM businesses WHERE id = ?", other.id)!, CUSTOMER, "STOP");
  assert.equal((await sendSms({ business, to: CUSTOMER, body: "hi", kind: "test", audience: "customer" })).status, "simulated");
  const otherRow = one("SELECT * FROM businesses WHERE id = ?", other.id)!;
  assert.equal((await sendSms({ business: otherRow, to: CUSTOMER, body: "hi", kind: "test", audience: "customer", force: true })).status, "skipped");
});

test("Twilio webhook requires a valid signature", async () => {
  const params = { From: "+15559990000", Body: "hello" };
  // Checked with the business's own auth token, at the business's own webhook address.
  saveChannels(business.id, { ...channelsFor(business), sms: { ...channelsFor(business).sms, authToken: "test-twilio-token" } });
  const post = (sig: string) => fetch(`${base}/api/webhooks/twilio/${business.id}/sms`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig }, body: new URLSearchParams(params),
  });
  assert.equal((await post("bogus")).status, 403);
  const data = `http://api.test/api/webhooks/twilio/${business.id}/sms` + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("");
  const good = await post(createHmac("sha1", "test-twilio-token").update(data).digest("base64"));
  assert.equal(good.status, 200);
  assert.match(await good.text(), /<Response>/);
});
