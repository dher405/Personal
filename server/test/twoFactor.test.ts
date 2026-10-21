process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = "re_platform_test"; // platform email on, so two-step sign-in is enforced
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");
const { config } = await import("../src/config.js");

const sent: { to: string; subject: string; text: string }[] = [];
let resendDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input) === "https://api.resend.com/emails") {
    if (resendDown) return new Response('{"message":"The bookwithslotwise.com domain is not verified"}', { status: 403 });
    const b = JSON.parse(init.body);
    sent.push({ to: b.to[0], subject: b.subject, text: b.text });
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let server: Server, base = "";
async function api(method: string, path: string, body?: unknown, token = "") {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const OWNER = { email: "owner@demo.test", password: "demo1234" };
const lastCode = (to: string) => sent.filter((m) => m.to === to).at(-1)!.subject.match(/^(\d{6}) is your Slotwise sign-in code/)?.[1];
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); globalThis.fetch = realFetch; });

let laptop = ""; // the device token a browser keeps after "remember this device"

test("a password alone isn't enough on a new device: an emailed code finishes signing in", async () => {
  const first = await api("POST", "/api/auth/login", OWNER);
  assert.equal(first.status, 200);
  assert.equal(first.body.token, undefined, "no session yet");
  assert.deepEqual(first.body.twoFactor.methods, ["email"]);
  assert.equal(first.body.twoFactor.codeSent, true);
  assert.equal(first.body.twoFactor.email, "o••••@demo.test");
  const code = lastCode(OWNER.email)!;
  assert.match(sent.at(-1)!.text, new RegExp(`${code}[\\s\\S]*expires in 10 minutes`));

  const wrong = await api("POST", "/api/auth/2fa/verify", { challengeId: first.body.twoFactor.id, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /4 tries left/);

  const ok = await api("POST", "/api/auth/2fa/verify", { challengeId: first.body.twoFactor.id, code, remember: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token && ok.body.deviceToken);
  laptop = ok.body.deviceToken;
  assert.equal((await api("GET", "/api/auth/me", undefined, ok.body.token)).status, 200);
  assert.equal((await api("POST", "/api/auth/2fa/verify", { challengeId: first.body.twoFactor.id, code })).status, 400, "a code works once");
});

test("a remembered device skips the code for 30 days; other devices still need it", async () => {
  const before = sent.length;
  const again = await api("POST", "/api/auth/login", { ...OWNER, deviceToken: laptop });
  assert.ok(again.body.token, "straight in");
  assert.equal(again.body.deviceToken, laptop);
  assert.equal(sent.length, before, "no code emailed");

  const phone = await api("POST", "/api/auth/login", OWNER);
  assert.ok(phone.body.twoFactor, "a different device needs the code");
  const notRemembered = await api("POST", "/api/auth/2fa/verify", { challengeId: phone.body.twoFactor.id, code: lastCode(OWNER.email), remember: false, deviceName: "Slotwise app (iOS)" });
  await settle();
  assert.match(sent.at(-1)!.subject, /New sign-in to your Slotwise account/);
  assert.match(sent.at(-1)!.text, /Slotwise app \(iOS\)/);
  const next = await api("POST", "/api/auth/login", { ...OWNER, deviceToken: notRemembered.body.deviceToken });
  assert.ok(next.body.twoFactor, "not remembered, so the code is asked for again");

  // Trust runs out.
  run("UPDATE devices SET trusted_until = ? WHERE secret_hash IS NOT NULL AND name = 'Chrome on Windows'", "2020-01-01T00:00:00Z");
  assert.ok((await api("POST", "/api/auth/login", { ...OWNER, deviceToken: laptop })).body.twoFactor);
});

test("five wrong codes end the attempt, and codes can't be re-sent too fast", async () => {
  const first = await api("POST", "/api/auth/login", OWNER);
  const id = first.body.twoFactor.id;
  assert.match((await api("POST", "/api/auth/2fa/send-code", { challengeId: id })).body.error, /just sent/);
  const right = lastCode(OWNER.email)!;
  const bad = right === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) await api("POST", "/api/auth/2fa/verify", { challengeId: id, code: bad });
  const late = await api("POST", "/api/auth/2fa/verify", { challengeId: id, code: right });
  assert.equal(late.status, 400);
  assert.match(late.body.error, /Too many wrong codes/);
});

async function signIn(remember = true) {
  const first = await api("POST", "/api/auth/login", OWNER);
  return (await api("POST", "/api/auth/2fa/verify", { challengeId: first.body.twoFactor.id, code: lastCode(OWNER.email), remember })).body;
}

test("Account → Security lists devices; signing one out ends its session", async () => {
  const a = await signIn(), b = await signIn();
  const sec = (await api("GET", "/api/auth/security", undefined, a.token)).body;
  assert.equal(sec.twoFactorOn, true);
  assert.equal(sec.rememberDays, 30);
  const mine = sec.devices.find((d: any) => d.current);
  assert.equal(mine.name, "Chrome on Windows");
  assert.equal(mine.trusted, true);

  const bId = (await api("GET", "/api/auth/security", undefined, b.token)).body.devices.find((d: any) => d.current).id;
  assert.equal((await api("DELETE", `/api/auth/devices/${bId}`, undefined, a.token)).status, 200);
  assert.equal((await api("GET", "/api/auth/me", undefined, b.token)).status, 401, "signed out");
  assert.ok((await api("POST", "/api/auth/login", { ...OWNER, deviceToken: b.deviceToken })).body.twoFactor, "and no longer trusted");

  const c = await signIn();
  assert.ok((await api("POST", "/api/auth/devices/sign-out-others", {}, a.token)).body.count >= 1);
  assert.equal((await api("GET", "/api/auth/me", undefined, c.token)).status, 401);
  assert.equal((await api("GET", "/api/auth/me", undefined, a.token)).status, 200, "this one stays signed in");

});

test("tokens from before devices existed no longer work", async () => {
  const user = one("SELECT id, token_version FROM users WHERE email = ?", OWNER.email)!;
  const old = jwt.sign({ sub: user.id, ver: user.token_version }, config.jwtSecret, { expiresIn: "7d" });
  assert.equal((await api("GET", "/api/auth/me", undefined, old)).status, 401);
});

test("new accounts confirm their email with a code before they're signed in", async () => {
  const res = await api("POST", "/api/auth/register", { name: "Pat New", email: "pat@example.com", password: "password123" });
  assert.equal(res.body.token, undefined);
  assert.ok(res.body.twoFactor.codeSent);
  assert.match(sent.at(-1)!.text, /confirm your email and finish creating your Slotwise account/);
  const ok = await api("POST", "/api/auth/2fa/verify", { challengeId: res.body.twoFactor.id, code: lastCode("pat@example.com"), remember: true });
  assert.equal(ok.body.user.email, "pat@example.com");
});

test("a password reset link counts as the second step but signs every other device out", async () => {
  const other = await signIn();
  const { emailResetLink } = await import("../src/lib/passwordReset.js");
  await emailResetLink(one("SELECT id, email, name FROM users WHERE email = ?", OWNER.email) as any);
  const link = sent.filter((m) => m.to === OWNER.email).at(-1)!.text.match(/token=([\w-]+)/)![1];
  const reset = await api("POST", "/api/auth/reset-password", { token: link, password: "newpass123" });
  assert.ok(reset.body.token);
  assert.equal((await api("GET", "/api/auth/me", undefined, other.token)).status, 401);
  assert.ok((await api("POST", "/api/auth/login", { email: OWNER.email, password: "newpass123", deviceToken: other.deviceToken })).body.twoFactor);
});

test("passkeys: sign-in options only offer the person's own passkeys, and work without a password too", async () => {
  const first = await api("POST", "/api/auth/login", { email: OWNER.email, password: "newpass123" });
  assert.match((await api("POST", "/api/auth/passkey/options", { challengeId: first.body.twoFactor.id })).body.error, /haven't added a passkey/);
  const open = (await api("POST", "/api/auth/passkey/options", {})).body;
  assert.equal(open.options.userVerification, "required");
  assert.equal(open.options.rpId, new URL(config.webUrl).hostname);
  const bogus = await api("POST", "/api/auth/passkey/verify", { challengeId: open.challengeId, response: { id: "nope", rawId: "nope", type: "public-key", response: {} } });
  assert.match(bogus.body.error, /isn't registered/);
});

test("if the email provider refuses the code, sign-in carries on (nobody is locked out) and the super admin is told why", async () => {
  resendDown = true;
  try {
    const res = await api("POST", "/api/auth/login", { email: "pat@example.com", password: "password123" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.token, "signed in without the code");
    const { createOAuthChallenge } = await import("../src/lib/twoFactor.js");
    const resumed = await api("POST", "/api/auth/2fa/resume", { challengeId: createOAuthChallenge(one("SELECT id FROM users WHERE email = 'pat@example.com'")!.id, "/me") });
    assert.equal(resumed.status, 200, "Google/Apple sign-in too");
    assert.ok(resumed.body.token);
    const { platformEmailFailure } = await import("../src/lib/email.js");
    assert.match(platformEmailFailure()!.error, /domain is not verified/);
  } finally {
    resendDown = false;
  }
  await api("POST", "/api/auth/login", { email: "pat@example.com", password: "password123" });
  const { platformEmailFailure } = await import("../src/lib/email.js");
  assert.equal(platformEmailFailure(), null, "cleared once an email gets through");
});

test("saving new email settings clears an old failure", async () => {
  run("INSERT INTO platform_settings (key, value) VALUES ('email_failure', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ at: new Date().toISOString(), error: "The example.com domain is not verified" }));
  const { saveSettings } = await import("../src/lib/platformSettings.js");
  const { platformEmailFailure } = await import("../src/lib/email.js");
  saveSettings({ EMAIL_FROM: "Slotwise <no-reply@bookwithslotwise.com>" });
  assert.equal(platformEmailFailure(), null);
});
