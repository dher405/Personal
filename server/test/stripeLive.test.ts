process.env.NODE_ENV = "test";
import { test, before } from "node:test";
import assert from "node:assert/strict";

const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");
const { saveSettings } = await import("../src/lib/platformSettings.js");
const { checkoutTax } = await import("../src/lib/platformBilling.js");
const { config } = await import("../src/config.js");

let paid = "", comped = "";
before(async () => {
  await seed();
  paid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
  run("INSERT INTO businesses (id, name, slug, timezone, plan) VALUES ('biz_comped', 'Comped', 'comped', 'America/New_York', 'business')");
  comped = "biz_comped";
});

test("moving from sandbox to live keys clears test-mode billing ids; test subscribers go back to Starter", () => {
  saveSettings({ STRIPE_SECRET_KEY: "sk_test_abc123", STRIPE_WEBHOOK_SECRET: "whsec_test" });
  run("UPDATE businesses SET plan = 'pro', platform_customer_id = 'cus_test1', platform_subscription_id = 'sub_test1' WHERE id = ?", paid);
  saveSettings({ STRIPE_SECRET_KEY: "sk_test_other" }); // same mode: nothing changes
  assert.equal(one("SELECT platform_subscription_id FROM businesses WHERE id = ?", paid)!.platform_subscription_id, "sub_test1");

  saveSettings({ STRIPE_SECRET_KEY: "sk_live_xyz789", STRIPE_WEBHOOK_SECRET: "whsec_live" });
  assert.equal(config.stripe.mode, "live");
  const b = one("SELECT * FROM businesses WHERE id = ?", paid)!;
  assert.equal(b.plan, "free");
  assert.equal(b.platform_customer_id, null);
  assert.equal(b.platform_subscription_id, null);
  assert.equal(one("SELECT plan FROM businesses WHERE id = ?", comped)!.plan, "business", "plans given by the super admin are kept");
  assert.ok(one("SELECT 1 FROM audit_log WHERE action = 'billing.stripe_mode_changed'"));
});

test("with Charge tax on, checkouts use Stripe Tax and collect a billing address", () => {
  assert.deepEqual(checkoutTax(false), {}, "off by default");
  saveSettings({ STRIPE_TAX: "on", STRIPE_TAX_BEHAVIOR: "inclusive" });
  assert.deepEqual(checkoutTax(true), { automatic_tax: { enabled: true }, billing_address_collection: "required", tax_id_collection: { enabled: true }, customer_update: { address: "auto", name: "auto" } });
  assert.equal(config.stripe.taxBehavior, "inclusive");
  assert.throws(() => saveSettings({ STRIPE_TAX: "maybe" }), /must be one of/);
});
