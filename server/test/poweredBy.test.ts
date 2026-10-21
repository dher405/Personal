process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");
const { getPlans, savePlans } = await import("../src/lib/plans.js");
const { sendBusinessEmail } = await import("../src/lib/email.js");
const { saveChannels } = await import("../src/lib/channels.js");

let server: Server, base = "", bid = "";
const page = async () => (await (await fetch(`${base}/api/public/businesses/riverside-music`)).json()).poweredBy;

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
});
after(() => server.close());

test("free plans say Powered by Slotwise; paid plans and the home page demo don't; the super admin can change it per plan", async () => {
  run("UPDATE businesses SET plan = 'free' WHERE id = ?", bid);
  assert.equal(await page(), true);
  run("UPDATE businesses SET plan = 'pro' WHERE id = ?", bid);
  assert.equal(await page(), false);
  savePlans(getPlans().map((p) => (p.id === "pro" ? { ...p, poweredBy: true } : p)));
  assert.equal(await page(), true);
  run("UPDATE businesses SET is_demo = 1 WHERE id = ?", bid);
  assert.equal(await page(), false, "the demo looks like a real customer's page");
  run("UPDATE businesses SET is_demo = 0, plan = 'free' WHERE id = ?", bid);
});

test("free plans' customer emails end with a one-line Powered by Slotwise footer", async () => {
  saveChannels(bid, { email: { provider: "resend", fromEmail: "hello@riverside.test", resendApiKey: "re_biz" }, sms: { provider: "none" } });
  const real = globalThis.fetch;
  let sent = "";
  globalThis.fetch = (async (input: any, init?: any) => (String(input).includes("resend.com") ? ((sent = JSON.parse(init.body).text), new Response("{}")) : real(input, init))) as typeof fetch;
  try {
    await sendBusinessEmail(one("SELECT * FROM businesses WHERE id = ?", bid)!, { kind: "test", to: "c@example.com", subject: "Hi", text: "Your lesson is booked." });
  } finally {
    globalThis.fetch = real;
  }
  assert.match(sent, /^Your lesson is booked\.\n\n--\nBooking powered by Slotwise\. .*\/\?ref=email$/);
});
