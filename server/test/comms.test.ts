process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DateTime } from "luxon";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { all, one } = await import("../src/db.js");

let server: Server, base = "", owner = "", bid = "", svc = "";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
let cursor = 0;
async function book(email: string) {
  let d = DateTime.now().setZone("America/New_York").plus({ days: 3 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${d.toISODate()}&to=${d.plus({ days: 6 }).toISODate()}`, undefined, "")).body;
  const s = slots[cursor++ * 3];
  const res = await api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: svc, staffId: s.staffId, start: s.start, name: "Mail Tester", email }, "");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await settle();
}
const emailsTo = (to: string) => all("SELECT * FROM email_messages WHERE to_email = ? ORDER BY rowid", to);

// Resend is called with fetch; capture those calls instead of sending.
const realFetch = globalThis.fetch;
const resendCalls: any[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).startsWith("https://api.resend.com/")) {
    resendCalls.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
  svc = one("SELECT id FROM services WHERE business_id = ? AND price_cents = 0", bid)!.id;
  await api("PATCH", `/api/admin/${bid}`, { require_payment: false });
});
after(() => { server.close(); globalThis.fetch = realFetch; });

test("customer emails aren't sent until the business sets up its own email, and the log says why", async () => {
  const comms = (await api("GET", `/api/admin/${bid}/communications`)).body;
  assert.equal(comms.email.provider, "none");
  await book("nobody-set-up@example.com");
  const [logged] = emailsTo("nobody-set-up@example.com");
  assert.equal(logged.status, "not_sent");
  assert.match(logged.error, /isn't set up/);
  assert.equal(resendCalls.length, 0);
  assert.equal((await api("POST", `/api/admin/${bid}/communications/email/test`, {})).status, 400);
});

test("customer emails come from the business's own address once it's set up", async () => {
  const bad = await api("PUT", `/api/admin/${bid}/communications/email`, { provider: "resend", resendApiKey: "re_secret_1234" });
  assert.equal(bad.status, 400, "a from address is required");
  const saved = await api("PUT", `/api/admin/${bid}/communications/email`, {
    provider: "resend", fromName: "Riverside Music", fromEmail: "hello@riverside.test", replyTo: "dana@riverside.test", resendApiKey: "re_secret_1234",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.email.ready, true);
  assert.equal(saved.body.email.resendApiKey, "••••1234", "secrets are never sent back");
  assert.ok(!JSON.stringify((await api("GET", `/api/admin/${bid}`)).body).includes("re_secret"), "or leaked in business settings");

  await book("pat@example.com");
  const call = resendCalls.at(-1);
  assert.equal(call.headers.Authorization, "Bearer re_secret_1234");
  assert.equal(call.body.from, `"Riverside Music" <hello@riverside.test>`);
  assert.equal(call.body.reply_to, "dana@riverside.test");
  assert.deepEqual(call.body.to, ["pat@example.com"]);
  assert.match(call.body.subject, /Your booking is confirmed/);
  assert.equal(call.body.attachments[0].filename, "invite.ics");
  assert.equal(emailsTo("pat@example.com")[0].status, "sent");

  // Leaving the key blank keeps the saved one.
  const again = await api("PUT", `/api/admin/${bid}/communications/email`, { provider: "resend", fromName: "Riverside", fromEmail: "hello@riverside.test", resendApiKey: "" });
  assert.equal(again.body.email.resendApiKey, "••••1234");

  const t = await api("POST", `/api/admin/${bid}/communications/email/test`, {});
  assert.equal(t.status, 200);
  assert.equal(resendCalls.at(-1).body.to[0], "owner@demo.test");
});

test("a provider error is logged as failed with the reason", async () => {
  globalThis.fetch = (async (input: any, init?: any) => String(input).startsWith("https://api.resend.com/")
    ? new Response("domain not verified", { status: 403 }) : realFetch(input, init)) as typeof fetch;
  await book("fails@example.com");
  const [logged] = emailsTo("fails@example.com");
  assert.equal(logged.status, "failed");
  assert.match(logged.error, /403.*domain not verified/);
  const log = (await api("GET", `/api/admin/${bid}/communications`)).body.emails;
  assert.ok(log.some((e: any) => e.to_email === "fails@example.com" && e.status === "failed"));
});

test("Twilio settings: test mode only off-production, switching it off turns texting off, secrets masked", async () => {
  assert.equal((await api("PATCH", `/api/admin/${bid}`, { sms_enabled: true })).status, 200, "demo is in test mode");
  const off = await api("PUT", `/api/admin/${bid}/communications/sms`, { provider: "none" });
  assert.equal(off.body.sms.configured, false);
  assert.equal(one("SELECT sms_enabled FROM businesses WHERE id = ?", bid)!.sms_enabled, 0);
  assert.equal((await api("PATCH", `/api/admin/${bid}`, { sms_enabled: true })).status, 400, "can't switch on without Twilio");
  assert.equal((await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body.smsEnabled, false);

  const tw = await api("PUT", `/api/admin/${bid}/communications/sms`, { provider: "twilio", accountSid: "AC123", authToken: "secret-token-9876", fromNumber: "(555) 222-3333" });
  assert.equal(tw.body.sms.configured, true);
  assert.equal(tw.body.sms.authToken, "••••9876");
  assert.equal(tw.body.sms.fromNumber, "+15552223333");
  assert.ok(tw.body.sms.webhooks.incoming.endsWith(`/api/webhooks/twilio/${bid}/sms`));
  assert.equal((await api("POST", `/api/admin/${bid}/sms/simulate`, { from: "+15550001111", body: "C" })).status, 403, "simulator is test mode only");
});
