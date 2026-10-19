import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";

// Stand-in for Google's and Apple's token endpoints. Each test sets the identity it should return.
let nextIdentity: Record<string, unknown> = {};
const tokenRequests: URLSearchParams[] = [];
let fake: Server;
const fakeUrl = await new Promise<string>((resolve) => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      tokenRequests.push(new URLSearchParams(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id_token: jwt.sign({ exp: Math.floor(Date.now() / 1000) + 600, ...nextIdentity }, "not-checked") }));
    });
  }).listen(0, () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
});

const appleKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
Object.assign(process.env, {
  NODE_ENV: "test", PUBLIC_API_URL: "http://api.test", PUBLIC_WEB_URL: "http://web.test",
  GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret", GOOGLE_TOKEN_URL: `${fakeUrl}/google`,
  APPLE_SERVICES_ID: "com.slotwise.web", APPLE_TEAM_ID: "TEAM123", APPLE_KEY_ID: "KEY123",
  APPLE_PRIVATE_KEY: appleKey.replace(/\n/g, "\\n"), APPLE_TOKEN_URL: `${fakeUrl}/apple`,
});

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");

let server: Server;
let base = "";
before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); fake.close(); });

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = (email: string, password: string) => api("POST", "/api/auth/login", { email, password });

/** Runs the redirect dance: /start → (provider) → /callback. Returns where the browser ends up. */
async function oauth(provider: "google" | "apple", identity: Record<string, unknown>, opts: { intent?: string; tamperState?: boolean; appleUser?: object } = {}) {
  const start = await fetch(`${base}/api/auth/oauth/${provider}/start?next=/me${opts.intent ? `&intent=${opts.intent}` : ""}`, { redirect: "manual" });
  const authorize = new URL(start.headers.get("location")!);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  nextIdentity = {
    iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
    aud: provider === "google" ? "google-client" : "com.slotwise.web",
    nonce: authorize.searchParams.get("nonce"), ...identity,
  };
  const params = { code: "auth-code", state: opts.tamperState ? "wrong" : authorize.searchParams.get("state")! };
  const res = provider === "google"
    ? await fetch(`${base}/api/auth/oauth/google/callback?${new URLSearchParams(params)}`, { redirect: "manual", headers: { cookie } })
    : await fetch(`${base}/api/auth/oauth/apple/callback`, {
        method: "POST", redirect: "manual", headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, ...(opts.appleUser ? { user: JSON.stringify(opts.appleUser) } : {}) }),
      });
  const location = new URL(res.headers.get("location")!);
  const hash = new URLSearchParams(location.hash.slice(1));
  return { location, authorize, token: hash.get("token"), next: hash.get("next"), error: location.searchParams.get("error") };
}

test("forgot password answers the same whether or not the account exists", async () => {
  const a = await api("POST", "/api/auth/forgot-password", { email: "owner@demo.test" });
  const b = await api("POST", "/api/auth/forgot-password", { email: "nobody@nowhere.test" });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  const owner = one("SELECT id FROM users WHERE email = 'owner@demo.test'")!;
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?", owner.id)!.n, 1);
});

test("reset link sets a new password once, and signs out old sessions", async () => {
  const oldToken = (await login("owner@demo.test", "demo1234")).body.token;
  const superToken = (await login("super@slotwise.test", "super1234")).body.token;
  const owner = one("SELECT id FROM users WHERE email = 'owner@demo.test'")!;

  const sent = await api("POST", `/api/super/users/${owner.id}/send-reset`, {}, superToken);
  assert.equal(sent.body.delivered, false); // no email provider in tests
  const token = new URL(sent.body.link).searchParams.get("token")!;

  const reset = await api("POST", "/api/auth/reset-password", { token, password: "new-pass-123" });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.token, "logged straight in");
  assert.equal((await api("GET", "/api/auth/me", undefined, oldToken)).status, 401, "old session revoked");
  assert.equal((await login("owner@demo.test", "demo1234")).status, 401);
  assert.equal((await login("owner@demo.test", "new-pass-123")).status, 200);
  assert.equal((await api("POST", "/api/auth/reset-password", { token, password: "again-123" })).status, 400, "single use");

  // Expired links are refused; earlier unused links were invalidated by the reset.
  const sent2 = await api("POST", `/api/super/users/${owner.id}/send-reset`, {}, superToken);
  run("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00Z' WHERE used_at IS NULL");
  assert.equal((await api("POST", "/api/auth/reset-password", { token: new URL(sent2.body.link).searchParams.get("token"), password: "x-1234567" })).status, 400);
});

test("providers endpoint reports which buttons to show", async () => {
  const res = await api("GET", "/api/auth/providers");
  assert.deepEqual(res.body, { google: true, apple: true, emailConfigured: false });
});

test("Google: new person gets a customer account; same verified email links to the existing admin", async () => {
  const fresh = await oauth("google", { sub: "g-1", email: "Newbie@Gmail.com", email_verified: true, name: "New Bee" });
  assert.equal(fresh.authorize.searchParams.get("redirect_uri"), "http://api.test/api/auth/oauth/google/callback");
  assert.equal(fresh.location.origin + fresh.location.pathname, "http://web.test/auth/callback");
  assert.equal(fresh.next, "/me");
  const me = await api("GET", "/api/auth/me", undefined, fresh.token!);
  assert.equal(me.body.user.email, "newbie@gmail.com");
  assert.equal(me.body.user.role, "customer");
  assert.equal(tokenRequests.at(-1)!.get("client_secret"), "google-secret");

  const linked = await oauth("google", { sub: "g-owner", email: "owner@demo.test", email_verified: true });
  const owner = await api("GET", "/api/auth/me", undefined, linked.token!);
  assert.equal(owner.body.user.role, "admin");
  assert.equal(owner.body.businesses[0].slug, "riverside-music");
  // Second time: found by the linked identity even if the provider omits the email.
  const again = await oauth("google", { sub: "g-owner" });
  assert.equal((await api("GET", "/api/auth/me", undefined, again.token!)).body.user.email, "owner@demo.test");
});

test("Google: an unverified email can't take over an existing account; bad state is rejected", async () => {
  const takeover = await oauth("google", { sub: "g-evil", email: "super@slotwise.test", email_verified: false });
  assert.equal(takeover.token, null);
  assert.match(takeover.error!, /isn't verified/);
  const tampered = await oauth("google", { sub: "g-2", email: "x@gmail.com", email_verified: true }, { tamperState: true });
  assert.match(tampered.error!, /could not be verified/);
  const wrongNonce = await (async () => {
    const r = await oauth("google", { sub: "g-3", email: "y@gmail.com", email_verified: true, nonce: "replayed" });
    return r.error;
  })();
  assert.match(wrongNonce!, /could not be verified/);
});

test("Apple: form-post callback with first-time name; signs a client secret with the .p8 key", async () => {
  const res = await oauth("apple", { sub: "a-1", email: "abc123@privaterelay.appleid.com", email_verified: "true" }, {
    appleUser: { name: { firstName: "Robin", lastName: "Ng" } },
  });
  assert.equal(res.authorize.searchParams.get("response_mode"), "form_post");
  const me = await api("GET", "/api/auth/me", undefined, res.token!);
  assert.equal(me.body.user.name, "Robin Ng");
  const secret = jwt.decode(tokenRequests.at(-1)!.get("client_secret")!, { complete: true })!;
  assert.equal(secret.header.alg, "ES256");
  assert.equal((secret.payload as any).iss, "TEAM123");
  assert.equal((secret.payload as any).sub, "com.slotwise.web");
});

test("'List your business' with Google: lands on business setup, then becomes an admin", async () => {
  const res = await oauth("google", { sub: "g-biz", email: "studio@gmail.com", email_verified: true, name: "Studio Owner" }, { intent: "business" });
  assert.equal(res.next, "/start-business");
  const created = await api("POST", "/api/auth/businesses", { name: "Yoga Loft", timezone: "America/Chicago" }, res.token!);
  assert.equal(created.status, 200);
  assert.equal(created.body.session.user.role, "admin");
  assert.equal(created.body.session.businesses[0].name, "Yoga Loft");

  // A Google-only account has no password; it can add one without a "current password".
  const account = await api("GET", "/api/auth/account", undefined, created.body.session.token);
  assert.equal(account.body.hasPassword, false);
  const set = await api("POST", "/api/auth/change-password", { newPassword: "studio-pass-1" }, created.body.session.token);
  assert.equal(set.status, 200);
  assert.equal((await login("studio@gmail.com", "studio-pass-1")).status, 200);
  assert.equal((await api("POST", "/api/auth/change-password", { newPassword: "zzz-12345" }, set.body.token)).status, 400, "now needs current password");
});
