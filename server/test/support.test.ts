process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_platform_test"; // platform email on, captured below
process.env.SUPERADMIN_EMAIL = "boss@slotwise.test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one } = await import("../src/db.js");

const sent: { to: string; subject: string; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input) === "https://api.resend.com/emails") {
    const b = JSON.parse(init.body);
    sent.push({ to: b.to[0], subject: b.subject, text: b.text });
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let server: Server, base = "", owner = "", superToken = "", bid = "";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const mailTo = (to: string) => sent.filter((m) => m.to === to);
/** Platform email is on here, so signing in takes the emailed code too. */
async function signIn(email: string, password: string) {
  const first = (await api("POST", "/api/auth/login", { email, password }, "")).body;
  const code = mailTo(email).at(-1)!.subject.match(/^(\d{6}) is your Slotwise sign-in code/)![1];
  return (await api("POST", "/api/auth/2fa/verify", { challengeId: first.twoFactor.id, code }, "")).body.token;
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = await signIn("owner@demo.test", "demo1234");
  superToken = await signIn("boss@slotwise.test", "super1234");
  sent.length = 0; // only the sign-in codes so far
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
});
after(() => { server.close(); globalThis.fetch = realFetch; });

let caseId = "";

test("a business opens a case: it gets a number, and both sides are emailed with links", async () => {
  assert.equal((await api("POST", `/api/admin/${bid}/support`, { subject: "x", body: "short", replyEmail: "dana@riverside.test" })).status, 400);
  const res = await api("POST", `/api/admin/${bid}/support`, {
    subject: "Calendar isn't syncing", body: "Bookings aren't showing in Google since yesterday.", replyEmail: "dana@riverside.test", category: "bookings",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.ref, /^SW-1\d{3}$/);
  assert.equal(res.body.status, "open");
  assert.equal(res.body.messages.length, 1);
  caseId = res.body.id;
  await settle();
  // No list saved yet: the super admin account is notified.
  const [note] = mailTo("boss@slotwise.test");
  assert.match(note.subject, new RegExp(`^\\[${res.body.ref}\\] New support case from Riverside Music`));
  assert.match(note.text, /\/super\/support\/case_/);
  const [ack] = mailTo("dana@riverside.test");
  assert.match(ack.subject, /We've received your support request/);
  assert.match(ack.text, new RegExp(`/admin/${bid}/support/${caseId}`));

  const second = await api("POST", `/api/admin/${bid}/support`, { subject: "Second question", body: "Another thing please", replyEmail: "dana@riverside.test" });
  assert.equal(second.body.number, res.body.number + 1, "numbers go up");
});

test("super admin sees it, replies (waiting), the business replies (open again), then it's resolved", async () => {
  const list = (await api("GET", "/api/super/support?status=open", undefined, superToken)).body;
  assert.ok(list.cases.some((c: any) => c.id === caseId && c.businessName === "Riverside Music"));
  assert.ok(list.counts.open >= 1);
  assert.equal((await api("GET", "/api/super/support", undefined, owner)).status, 403, "businesses can't see the desk");

  const reply = await api("POST", `/api/super/support/${caseId}/messages`, { body: "Please disconnect and reconnect, ticking the calendar box." }, superToken);
  assert.equal(reply.body.status, "waiting");
  await settle();
  const toBusiness = mailTo("dana@riverside.test").at(-1)!;
  assert.match(toBusiness.subject, /^\[SW-\d+\] Reply: Calendar isn't syncing/);
  assert.match(toBusiness.text, /> Please disconnect and reconnect/);

  const back = await api("POST", `/api/admin/${bid}/support/${caseId}/messages`, { body: "Done, it works now. Thanks!" });
  assert.equal(back.body.status, "open");
  assert.equal(back.body.messages.at(-1).author_role, "business");
  await settle();
  assert.match(mailTo("boss@slotwise.test").at(-1)!.subject, /Riverside Music replied/);

  const done = await api("POST", `/api/super/support/${caseId}/messages`, { body: "", status: "resolved" }, superToken);
  assert.equal(done.body.status, "resolved");
  await settle();
  assert.match(mailTo("dana@riverside.test").at(-1)!.subject, /Resolved/);
});

test("notification settings: chosen addresses, switches, and a test email", async () => {
  const saved = await api("PUT", "/api/super/support/settings", { notifyEmails: ["help@slotwise.test", "david@example.com"], onNewCase: true, onBusinessReply: false, onSupportReply: true }, superToken);
  assert.deepEqual(saved.body.notifyEmails, ["help@slotwise.test", "david@example.com"]);
  await api("POST", `/api/admin/${bid}/support`, { subject: "Third question", body: "Testing the notify list", replyEmail: "dana@riverside.test" });
  await settle();
  assert.equal(mailTo("help@slotwise.test").length, 1);
  assert.equal(mailTo("david@example.com").length, 1);

  await api("POST", `/api/admin/${bid}/support/${caseId}/messages`, { body: "One more thing" });
  await settle();
  assert.equal(mailTo("help@slotwise.test").length, 1, "business replies are switched off");
  await api("POST", `/api/super/support/${caseId}/messages`, { body: "Sure, go ahead" }, superToken);
  await settle();
  assert.equal(mailTo("help@slotwise.test").length, 2, "support replies are copied");

  assert.equal((await api("POST", "/api/super/support/settings/test", {}, superToken)).status, 200);
  assert.match(mailTo("david@example.com").at(-1)!.subject, /support notifications are working/);
});

test("a business only sees its own cases", async () => {
  const other = await api("GET", `/api/admin/${bid}/support`);
  assert.ok(other.body.cases.length >= 3);
  const signup = await api("POST", "/api/auth/register", { name: "Other Owner", email: "other@biz.test", password: "password123", businessName: "Other Studio", timezone: "America/New_York" }, "");
  const code = mailTo("other@biz.test").at(-1)!.subject.slice(0, 6);
  const stranger = await api("POST", "/api/auth/2fa/verify", { challengeId: signup.body.twoFactor.id, code }, "");
  const otherBid = stranger.body.businesses?.[0]?.id ?? one("SELECT business_id FROM business_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'other@biz.test'")!.business_id;
  assert.equal((await api("GET", `/api/admin/${otherBid}/support/${caseId}`, undefined, stranger.body.token)).status, 404);
  assert.equal((await api("GET", `/api/admin/${bid}/support/${caseId}`, undefined, stranger.body.token)).status, 403);
});
