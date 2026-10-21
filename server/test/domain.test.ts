process.env.NODE_ENV = "test";
process.env.RENDER_EXTERNAL_URL = "https://slotwise-us9o.onrender.com";
process.env.PUBLIC_WEB_URL = "https://slotwise-us9o.onrender.com";
process.env.PUBLIC_API_URL = "https://slotwise-us9o.onrender.com";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { createHmac } from "node:crypto";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one } = await import("../src/db.js");
const { config, siteOrigins } = await import("../src/config.js");
const { saveSettings } = await import("../src/lib/platformSettings.js");
const { channelsFor, saveChannels } = await import("../src/lib/channels.js");

let server: Server, port = 0;
/** Raw requests, so the Host header can be set (as when the site is reached on different domains). */
function get(path: string, host: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  port = (server.address() as any).port;
});
after(() => server.close());

test("the website address is saved on Settings, checked, and used everywhere", () => {
  assert.throws(() => saveSettings({ PUBLIC_WEB_URL: "bookwithslotwise.com" }), /must look like/);
  assert.throws(() => saveSettings({ PUBLIC_WEB_URL: "http://bookwithslotwise.com" }), /must look like/);
  assert.throws(() => saveSettings({ PUBLIC_WEB_URL: "https://bookwithslotwise.com/admin" }), /must look like/);
  saveSettings({ PUBLIC_WEB_URL: "https://bookwithslotwise.com/" });
  assert.equal(config.webUrl, "https://bookwithslotwise.com");
  assert.equal(config.apiUrl, "https://bookwithslotwise.com", "one service, one address");
  assert.deepEqual(siteOrigins().sort(), ["https://bookwithslotwise.com", "https://slotwise-us9o.onrender.com", "https://www.bookwithslotwise.com"]);
});

test("pages on the old address (or www) move to the main one; the API, widget and embed.js don't", async () => {
  const page = await get("/login?next=/admin", "slotwise-us9o.onrender.com", { "Sec-Fetch-Dest": "document" });
  assert.equal(page.status, 301);
  assert.equal(page.headers.location, "https://bookwithslotwise.com/login?next=/admin");
  assert.equal((await get("/", "www.bookwithslotwise.com", { Accept: "text/html" })).headers.location, "https://bookwithslotwise.com/");
  assert.equal((await get("/api/health", "slotwise-us9o.onrender.com", { "Sec-Fetch-Dest": "document" })).status, 200);
  assert.notEqual((await get("/embed/riverside-music", "slotwise-us9o.onrender.com", { "Sec-Fetch-Dest": "iframe" })).status, 301);
  assert.notEqual((await get("/embed.js", "slotwise-us9o.onrender.com", { "Sec-Fetch-Dest": "script" })).status, 301);
  assert.notEqual((await get("/", "evil.example", { "Sec-Fetch-Dest": "document" })).status, 301, "not an open redirect for other hosts");
});

test("passkeys use the address the browser is on, and only the site's own addresses", async () => {
  const options = async (origin: string) => JSON.parse((await get("/api/auth/passkey/options", "bookwithslotwise.com", { Origin: origin, "Content-Type": "application/json" }, "POST", "{}")).body).options.rpId;
  assert.equal(await options("https://bookwithslotwise.com"), "bookwithslotwise.com");
  assert.equal(await options("https://slotwise-us9o.onrender.com"), "slotwise-us9o.onrender.com");
  assert.equal(await options("https://evil.example"), "bookwithslotwise.com");
});

test("Twilio texts still arrive at the old address after the switch", async () => {
  const business = one("SELECT * FROM businesses WHERE slug = 'riverside-music'")!;
  saveChannels(business.id, { ...channelsFor(business), sms: { ...channelsFor(business).sms, authToken: "tw-token" } });
  const params = { From: "+15559990000", Body: "hello" };
  const path = `/api/webhooks/twilio/${business.id}/sms`;
  const sign = (origin: string) => createHmac("sha1", "tw-token").update(origin + path + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("")).digest("base64");
  const post = (sig: string) => get(path, "slotwise-us9o.onrender.com", { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig }, "POST", new URLSearchParams(params).toString());
  assert.equal((await post(sign("https://slotwise-us9o.onrender.com"))).status, 200);
  assert.equal((await post(sign("https://bookwithslotwise.com"))).status, 200);
  assert.equal((await post(sign("https://evil.example"))).status, 403);
});
