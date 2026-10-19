import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, audit, newId, one, run, Row } from "../db.js";
import { stripe } from "../payments/stripe.js";
import type { AuthUser } from "./auth.js";
import { sendEmail } from "./email.js";
import { badRequest } from "./errors.js";
import { getPacks, getPlan, getPlans, type Plan, type UsagePack } from "./plans.js";

/**
 * Usage-based pricing: businesses pay by the number of bookings they take (plus texts and AI messages).
 * Each plan includes a monthly allowance per meter; packs or auto top-up add more. Every booking counts,
 * online or entered by the business, once confirmed (an online booking whose payment was never completed
 * doesn't). Months are calendar months in UTC, so meters reset on the 1st.
 */

export type Metric = "bookings" | "sms" | "ai";
export const METRICS: Metric[] = ["bookings", "sms", "ai"];
export const METRIC_LABEL: Record<Metric, string> = { bookings: "bookings", sms: "text messages", ai: "AI assistant messages" };
const PLAN_FIELD: Record<Metric, keyof Plan> = { bookings: "bookingsPerMonth", sms: "smsPerMonth", ai: "aiMessagesPerMonth" };
/** Warnings at 80% and 90% (before the wall), then a notice at 100%. */
export const ALERT_THRESHOLDS = [80, 90, 100];

export const currentPeriod = () => DateTime.utc().toFormat("yyyy-LL");

function usedThisMonth(businessId: string, metric: Metric): number {
  if (metric === "sms") {
    return one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sms_messages WHERE business_id = ? AND direction = 'outbound'
         AND status NOT IN ('failed','skipped') AND created_at >= datetime('now','start of month')`, businessId,
    )!.n;
  }
  return one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM usage_events WHERE business_id = ? AND metric = ? AND created_at >= datetime('now','start of month')",
    businessId, metric,
  )!.n;
}

export interface MeterReading { metric: Metric; label: string; used: number; included: number; extra: number; limit: number; remaining: number; percent: number }

export function meter(business: Row, metric: Metric): MeterReading {
  const included = Number(getPlan(business.plan)[PLAN_FIELD[metric]] ?? 0);
  const extra = one<{ n: number }>(
    "SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_credits WHERE business_id = ? AND metric = ? AND period = ?", business.id, metric, currentPeriod(),
  )!.n;
  const used = usedThisMonth(business.id, metric);
  const limit = included + extra;
  return {
    metric, label: METRIC_LABEL[metric], used, included, extra, limit,
    remaining: Math.max(0, limit - used), percent: limit ? Math.min(999, Math.round((used / limit) * 100)) : used ? 100 : 0,
  };
}

export const usageFor = (business: Row) => METRICS.map((m) => meter(business, m));

const smallestPack = (metric: Metric) => getPacks().filter((p) => p.metric === metric).sort((a, b) => a.quantity - b.quantity)[0];

/**
 * True if one more use fits. When it doesn't and the business has auto top-up on, the smallest
 * pack is added right away (charged to their card in the background) so customers never notice.
 */
export function hasCapacity(business: Row, metric: Metric): boolean {
  const m = meter(business, metric);
  if (m.used < m.limit) return true;
  const pack = smallestPack(metric);
  const canBill = !config.stripe.secretKey || !!business.platform_customer_id;
  if (!business.auto_topup || !pack || !canBill) return false;
  const id = grantCredits(business.id, pack, 1, "auto", { label: "auto-top-up" });
  chargeAutoTopUp(id).catch((err) => console.error("auto top-up charge failed", err));
  notifyAdmins(business, `Auto top-up: ${pack.quantity} more ${METRIC_LABEL[metric]} added`,
    `You reached your ${METRIC_LABEL[metric]} allowance, so ${pack.quantity} more were added automatically for ${money(pack.priceCents)}. ` +
    `It will appear on your next invoice. Turn auto top-up off or change plan: ${billingUrl(business)}`).catch(() => {});
  return true;
}

/** Counts one use (idempotent per ref id), then sends any 80% / 100% alerts due. */
export function recordUse(business: Row, metric: Exclude<Metric, "sms">, refId: string) {
  const res = run("INSERT OR IGNORE INTO usage_events (business_id, metric, ref_id) VALUES (?,?,?)", business.id, metric, refId);
  if (res.changes) checkAlerts(business, metric).catch((err) => console.error("usage alert failed", err));
}

export function grantCredits(businessId: string, pack: UsagePack, packs: number, source: "purchase" | "auto" | "grant", actor: { id?: string | null; label: string }, externalRef?: string) {
  const id = newId("crd");
  run(
    `INSERT INTO usage_credits (id, business_id, metric, quantity, period, source, price_cents, charge_status, external_ref) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, businessId, pack.metric, pack.quantity * packs, currentPeriod(), source,
    source === "grant" ? 0 : pack.priceCents * packs, source === "auto" ? "pending" : source === "purchase" ? "charged" : "none", externalRef ?? null,
  );
  audit(actor, businessId, "usage.credits_added", { metric: pack.metric, quantity: pack.quantity * packs, source });
  return id;
}

/** Auto top-ups go on the business's next subscription invoice as a one-off line. */
async function chargeAutoTopUp(creditId: string) {
  const credit = one("SELECT * FROM usage_credits WHERE id = ?", creditId)!;
  const business = one("SELECT * FROM businesses WHERE id = ?", credit.business_id)!;
  if (!config.stripe.secretKey) {
    run("UPDATE usage_credits SET charge_status = 'none' WHERE id = ?", creditId); // local/demo: nothing to charge
    return;
  }
  try {
    const item = await stripe().invoiceItems.create({
      customer: business.platform_customer_id, amount: credit.price_cents, currency: "usd",
      description: `Auto top-up: ${credit.quantity} ${METRIC_LABEL[credit.metric as Metric]} (${credit.period})`,
      metadata: { businessId: business.id, creditId },
    });
    run("UPDATE usage_credits SET charge_status = 'charged', external_ref = ? WHERE id = ?", item.id, creditId);
  } catch (err) {
    run("UPDATE usage_credits SET charge_status = 'failed' WHERE id = ?", creditId);
    throw err;
  }
}

/** Buying packs: Stripe Checkout on the platform's account; applied directly when Stripe isn't configured (dev/demo). */
export async function buyPacks(business: Row, packId: string, packs: number, user: AuthUser) {
  const pack = getPacks().find((p) => p.id === packId);
  if (!pack) throw badRequest("Unknown pack");
  if (!config.stripe.secretKey) {
    grantCredits(business.id, pack, packs, "purchase", { id: user.id, label: `admin:${user.email}` });
    return { applied: true, url: billingUrl(business) };
  }
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer: business.platform_customer_id ?? undefined,
    customer_email: business.platform_customer_id ? undefined : user.email,
    line_items: [{ quantity: packs, price_data: { currency: "usd", unit_amount: pack.priceCents, product_data: { name: `${pack.quantity} extra ${METRIC_LABEL[pack.metric]}` } } }],
    metadata: { kind: "usage_pack", businessId: business.id, packId, packs: String(packs) },
    success_url: `${billingUrl(business)}?pack=1`,
    cancel_url: billingUrl(business),
  });
  return { applied: false, url: session.url! };
}

/** Stripe webhook: a pack checkout was paid. Idempotent on the session id. */
export function applyPaidPackCheckout(sessionId: string, metadata: Record<string, string>) {
  if (one("SELECT 1 FROM usage_credits WHERE external_ref = ?", sessionId)) return;
  const pack = getPacks().find((p) => p.id === metadata.packId);
  if (!pack || !one("SELECT 1 FROM businesses WHERE id = ?", metadata.businessId)) return;
  grantCredits(metadata.businessId, pack, Math.max(1, Number(metadata.packs) || 1), "purchase", { label: "stripe-checkout" }, sessionId);
}

// ---------- Alerts ----------

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const billingUrl = (business: Row) => `${config.webUrl}/admin/${business.id}/billing`;

async function notifyAdmins(business: Row, subject: string, text: string) {
  const admins = all("SELECT u.email FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = ?", business.id);
  for (const a of admins) await sendEmail({ to: a.email, subject, text });
}

/** Next plan up that includes more of this meter, for the "upgrade" suggestion. */
function upgradeFor(business: Row, metric: Metric) {
  const current = getPlan(business.plan);
  return getPlans()
    .filter((p) => p.monthlyPriceCents > current.monthlyPriceCents && Number(p[PLAN_FIELD[metric]]) > Number(current[PLAN_FIELD[metric]]))
    .sort((a, b) => a.monthlyPriceCents - b.monthlyPriceCents)[0];
}

/** Emails every admin once per meter per month at each threshold crossed (80%, 90%, 100%). */
export async function checkAlerts(business: Row, metric: Metric) {
  const fresh = one("SELECT * FROM businesses WHERE id = ?", business.id)!;
  const m = meter(fresh, metric);
  if (!m.limit) return;
  const period = currentPeriod();
  const due = ALERT_THRESHOLDS.filter((t) => m.percent >= t);
  const threshold = due.at(-1);
  if (threshold === undefined) return;
  // Claim the alert first so two uses at the same moment can't both send it.
  const claimed = run("INSERT OR IGNORE INTO usage_alerts (business_id, metric, period, threshold) VALUES (?,?,?,?)", fresh.id, metric, period, threshold);
  for (const t of due) run("INSERT OR IGNORE INTO usage_alerts (business_id, metric, period, threshold) VALUES (?,?,?,?)", fresh.id, metric, period, t);
  if (!claimed.changes) return;

  const pack = smallestPack(metric);
  const upgrade = upgradeFor(fresh, metric);
  const full = threshold >= 100;
  const resets = DateTime.utc().plus({ months: 1 }).startOf("month").toFormat("LLLL d");
  const paused = { bookings: "New bookings, online or entered by you, are paused", sms: "Texts are paused", ai: "The AI assistant is paused" }[metric];
  const lines = [
    `${fresh.name} has used ${m.used} of ${m.limit} ${m.label} this month (${m.percent}%).`,
    full
      ? fresh.auto_topup ? "Auto top-up is on, so more will be added automatically as you need them." : `${paused} until you add more or your allowance resets on ${resets}.`
      : `You have ${m.remaining} left until it resets on ${resets}. ${metric === "bookings" ? "When they're used up, new bookings pause until you add more." : "When they're used up, this pauses until you add more."}`,
    "Your options:",
    pack ? `- Buy ${pack.quantity} more ${m.label} for ${money(pack.priceCents)} (good until the end of this month)` : "",
    upgrade ? `- Upgrade to ${upgrade.name} (${money(upgrade.monthlyPriceCents)}/month), which includes ${upgrade[PLAN_FIELD[metric]]} ${m.label} a month` : "",
    !fresh.auto_topup && pack ? "- Turn on auto top-up so you never run out" : "",
    `Manage it here: ${billingUrl(fresh)}`,
  ].filter(Boolean);
  await notifyAdmins(fresh, full ? `You've used all your ${m.label} for this month` : `You've used ${threshold}% of your ${m.label} this month`, lines.join("\n\n"));
}
