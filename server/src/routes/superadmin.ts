import { config } from "../config.js";
import { Router } from "express";
import { z } from "zod";
import { all, audit, one, run } from "../db.js";
import { actorOf, hashPassword } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { getPacks, getPlan, getPlans, savePacks, savePlans } from "../lib/plans.js";
import { grantCredits, usageFor } from "../lib/usage.js";
import { describeSettings, saveSettings, testSettings } from "../lib/platformSettings.js";
import { setPlan } from "../lib/platformBilling.js";
import { emailResetLink } from "../lib/passwordReset.js";
import { storageStatus } from "../lib/storage.js";
import { emailLive, platformEmailFailure } from "../lib/email.js";
import { listModels } from "../ai/models.js";
import { issueReport, latestTriage, startTriage, supportAiAvailable } from "../ai/supportAgent.js";
import { addReply, getCase, saveSupportSettings, sendTestNotification, serializeCase, supportSettings } from "../lib/support.js";

/** Platform-wide controls. Mounted behind requireSuperAdmin. Business-level actions reuse /api/admin/:bid. */
export const superRouter = Router();

superRouter.get("/overview", h(() => ({
  businesses: one("SELECT COUNT(*) AS n FROM businesses")!.n,
  users: one("SELECT COUNT(*) AS n FROM users")!.n,
  bookings30d: one("SELECT COUNT(*) AS n FROM bookings WHERE created_at >= datetime('now', '-30 days')")!.n,
  gmv30dCents: one("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS n FROM payments WHERE status IN ('paid','partially_refunded') AND created_at >= datetime('now','-30 days')")!.n,
  packs30dCents: one("SELECT COALESCE(SUM(price_cents), 0) AS n FROM usage_credits WHERE source IN ('purchase','auto') AND created_at >= datetime('now','-30 days')")!.n,
  payingBusinesses: one("SELECT COUNT(*) AS n FROM businesses WHERE platform_subscription_id IS NOT NULL AND suspended = 0")!.n,
  byPlan: all("SELECT plan, COUNT(*) AS n FROM businesses GROUP BY plan"),
  sms30d: one("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'outbound' AND status NOT IN ('failed','skipped') AND created_at >= datetime('now','-30 days')")!.n,
  storage: storageStatus(),
  // Two-step sign-in emails codes through the platform email; without it, sign-in falls back to passwords only.
  twoFactorEmail: emailLive(),
  emailFailure: platformEmailFailure(),
  openCases: one("SELECT COUNT(*) AS n FROM support_cases WHERE status = 'open'")!.n,
})));

// ---------- Support cases ----------

superRouter.get("/support", h((req) => {
  const status = String(req.query.status ?? "");
  const q = `%${String(req.query.q ?? "").trim()}%`;
  const rows = all(
    `SELECT c.* FROM support_cases c JOIN businesses b ON b.id = c.business_id
      WHERE (? = '' OR c.status = ?) AND (c.subject LIKE ? OR b.name LIKE ? OR c.reply_email LIKE ? OR ('SW-' || c.number) LIKE ?)
      ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, c.updated_at DESC LIMIT 300`,
    status, status, q, q, q, q,
  );
  return {
    counts: Object.fromEntries(all("SELECT status, COUNT(*) AS n FROM support_cases GROUP BY status").map((r) => [r.status, r.n])),
    cases: rows.map((c) => {
      const t = latestTriage(c.id);
      return { ...serializeCase(c), triage: t ? { status: t.status, category: t.category, severity: t.severity, draftPending: t.status === "done" && t.draft_status === "pending" } : null };
    }),
  };
}));

// ---------- Support assistant: triage, drafts and the issues it finds ----------

superRouter.get("/support/issues", h((req) => {
  const status = String(req.query.status ?? "open");
  const where = status === "open" ? "WHERE i.status IN ('new','investigating')" : status === "all" ? "" : "WHERE i.status = ?";
  return all(
    `SELECT i.*, (SELECT COUNT(*) FROM support_issue_cases ic WHERE ic.issue_id = i.id) AS case_count,
            (SELECT GROUP_CONCAT('SW-' || c.number || '|' || c.id) FROM support_issue_cases ic JOIN support_cases c ON c.id = ic.case_id WHERE ic.issue_id = i.id) AS cases
       FROM support_issues i ${where} ORDER BY CASE i.status WHEN 'new' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END, case_count DESC, i.updated_at DESC`,
    ...(where.includes("?") ? [status] : []),
  ).map((i) => ({ ...i, cases: i.cases ? String(i.cases).split(",").map((x) => { const [ref, id] = x.split("|"); return { ref, id }; }) : [] }));
}));

superRouter.patch("/support/issues/:id", h((req) => {
  const body = parse(z.object({ status: z.enum(["new", "investigating", "fixed", "wont_fix"]).optional(), title: z.string().min(3).max(200).optional() }), req.body);
  if (!one("SELECT 1 FROM support_issues WHERE id = ?", req.params.id)) throw notFound();
  if (body.status) run("UPDATE support_issues SET status = ?, updated_at = datetime('now') WHERE id = ?", body.status, req.params.id);
  if (body.title) run("UPDATE support_issues SET title = ? WHERE id = ?", body.title, req.params.id);
  audit(actorOf(req.user), null, "support.issue_updated", { issueId: req.params.id, ...body });
  return one("SELECT * FROM support_issues WHERE id = ?", req.params.id);
}));

superRouter.get("/support/issues/:id/report", h((req) => {
  if (!one("SELECT 1 FROM support_issues WHERE id = ?", req.params.id)) throw notFound();
  return { report: issueReport(req.params.id as string) };
}));

superRouter.get("/support/settings", h(() => ({ ...supportSettings(), aiAvailable: supportAiAvailable(), aiModel: config.supportAi.model })));

superRouter.put("/support/settings", h((req) => {
  const body = parse(z.object({
    notifyEmails: z.array(z.email()).max(20), onNewCase: z.boolean(), onBusinessReply: z.boolean(), onSupportReply: z.boolean(),
    aiAutoTriage: z.boolean().default(true), aiInstructions: z.string().max(4000).default(""),
  }), req.body);
  saveSupportSettings(body);
  audit(actorOf(req.user), null, "support.settings_updated", body);
  return supportSettings();
}));

superRouter.post("/support/settings/test", h(async () => {
  const { notifyEmails } = supportSettings();
  await sendTestNotification(notifyEmails);
  return { ok: true, message: `Test email sent to ${notifyEmails.join(", ")}.` };
}));

function caseForSuper(id: string) {
  const c = getCase(id);
  return {
    ...serializeCase(c, true),
    triage: latestTriage(c.id),
    issues: all("SELECT i.id, i.number, i.title, i.kind, i.status FROM support_issue_cases ic JOIN support_issues i ON i.id = ic.issue_id WHERE ic.case_id = ?", c.id),
    aiAvailable: supportAiAvailable(),
  };
}

superRouter.get("/support/:cid", h((req) => caseForSuper(req.params.cid as string)));

/** Ask the assistant to (re)analyse a case, optionally with an instruction ("check their email log", "shorter reply"). */
superRouter.post("/support/:cid/triage", h((req) => {
  const c = getCase(req.params.cid as string);
  if (!supportAiAvailable()) throw badRequest("Add an Anthropic API key under Settings → Support assistant (or AI assistant) first");
  const { instruction } = parse(z.object({ instruction: z.string().max(2000).optional() }), req.body ?? {});
  startTriage(c.id, instruction?.trim() || undefined);
  return caseForSuper(c.id);
}));

/** The super admin approves the assistant's draft (as written or edited): it's sent like any support reply. */
superRouter.post("/support/:cid/draft/send", h((req) => {
  const c = getCase(req.params.cid as string);
  const t = latestTriage(c.id);
  if (!t || t.status !== "done" || t.draft_status !== "pending") throw badRequest("There's no draft waiting to be sent");
  const body = parse(z.object({ body: z.string().min(1).max(10_000), status: z.enum(["open", "waiting", "resolved"]).optional() }), req.body);
  addReply(c.id, req.user!, "support", body.body, body.status);
  run("UPDATE support_triage SET draft_status = 'sent' WHERE id = ?", t.id);
  audit(actorOf(req.user), c.business_id, "support.draft_sent", { caseId: c.id, triageId: t.id, edited: body.body.trim() !== String(t.draft_reply).trim() });
  return caseForSuper(c.id);
}));

superRouter.post("/support/:cid/draft/discard", h((req) => {
  const c = getCase(req.params.cid as string);
  run("UPDATE support_triage SET draft_status = 'discarded' WHERE case_id = ? AND draft_status = 'pending'", c.id);
  return caseForSuper(c.id);
}));

superRouter.post("/support/:cid/messages", h((req) => {
  const body = parse(z.object({ body: z.string().max(10_000).default(""), status: z.enum(["open", "waiting", "resolved"]).optional() }), req.body);
  const c = addReply(getCase(req.params.cid as string).id, req.user!, "support", body.body, body.status);
  // A reply written by hand replaces any draft that was waiting.
  if (body.body.trim()) run("UPDATE support_triage SET draft_status = 'discarded' WHERE case_id = ? AND draft_status = 'pending'", c.id);
  return caseForSuper(c.id);
}));

superRouter.get("/businesses", h((req) => {
  const q = `%${String(req.query.q ?? "")}%`;
  const rows = all(
    `SELECT b.id, b.name, b.slug, b.plan, b.plan_status, b.suspended, b.payment_provider, b.created_at,
            (SELECT COUNT(*) FROM bookings k WHERE k.business_id = b.id) AS booking_count,
            (SELECT COUNT(*) FROM sms_messages m WHERE m.business_id = b.id AND m.direction = 'outbound' AND m.status NOT IN ('failed','skipped')
               AND m.created_at >= datetime('now','start of month')) AS sms_this_month,
            (SELECT GROUP_CONCAT(u.email) FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = b.id) AS admins
       FROM businesses b WHERE b.name LIKE ? OR b.slug LIKE ? ORDER BY b.created_at DESC LIMIT 500`, q, q,
  );
  return rows.map((r) => ({ ...r, usage: usageFor(r) }));
}));

/** Everything the platform owner needs about one business, beside the business's own admin tabs. */
superRouter.get("/businesses/:id", h((req) => {
  const b = one("SELECT * FROM businesses WHERE id = ?", req.params.id);
  if (!b) throw notFound();
  const month = "datetime('now','start of month')";
  return {
    business: {
      id: b.id, name: b.name, slug: b.slug, plan: b.plan, plan_status: b.plan_status, suspended: !!b.suspended,
      created_at: b.created_at, payment_provider: b.payment_provider, auto_topup: !!b.auto_topup,
      platform_customer_id: b.platform_customer_id, platform_subscription_id: b.platform_subscription_id, plan_ends_at: b.plan_ends_at,
    },
    stripeMode: config.stripe.secretKey ? (config.stripe.secretKey.startsWith("sk_live") ? "live" : "test") : "off",
    admins: all(
      `SELECT u.id, u.email, u.name, m.role, u.created_at,
              (SELECT GROUP_CONCAT(provider) FROM user_identities i WHERE i.user_id = u.id) AS providers
         FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = ? ORDER BY m.role, u.email`, b.id,
    ),
    usage: usageFor(b),
    credits: all("SELECT * FROM usage_credits WHERE business_id = ? ORDER BY created_at DESC LIMIT 50", b.id),
    revenue: {
      planMonthlyCents: getPlan(b.plan).monthlyPriceCents,
      packsAllTimeCents: one("SELECT COALESCE(SUM(price_cents),0) AS n FROM usage_credits WHERE business_id = ? AND source IN ('purchase','auto')", b.id)!.n,
      packsThisMonthCents: one(`SELECT COALESCE(SUM(price_cents),0) AS n FROM usage_credits WHERE business_id = ? AND source IN ('purchase','auto') AND created_at >= ${month}`, b.id)!.n,
      customerPaymentsThisMonthCents: one(`SELECT COALESCE(SUM(amount_cents - refunded_cents),0) AS n FROM payments WHERE business_id = ? AND status IN ('paid','partially_refunded') AND created_at >= ${month}`, b.id)!.n,
    },
    stats: {
      bookingsThisMonth: one(`SELECT COUNT(*) AS n FROM bookings WHERE business_id = ? AND created_at >= ${month}`, b.id)!.n,
      bookingsAllTime: one("SELECT COUNT(*) AS n FROM bookings WHERE business_id = ?", b.id)!.n,
      staff: one("SELECT COUNT(*) AS n FROM staff WHERE business_id = ? AND active = 1", b.id)!.n,
    },
    audit: all("SELECT * FROM audit_log WHERE business_id = ? ORDER BY created_at DESC LIMIT 100", b.id),
  };
}));

superRouter.delete("/businesses/:id/members/:userId", h((req) => {
  const member = one("SELECT * FROM business_members WHERE business_id = ? AND user_id = ?", req.params.id, req.params.userId);
  if (!member) throw notFound();
  const owners = one<{ n: number }>("SELECT COUNT(*) AS n FROM business_members WHERE business_id = ? AND role = 'owner'", req.params.id)!.n;
  if (member.role === "owner" && owners <= 1) throw badRequest("Add another owner before removing the last one");
  run("DELETE FROM business_members WHERE business_id = ? AND user_id = ?", req.params.id, req.params.userId);
  audit(actorOf(req.user), req.params.id as string, "member.removed", { userId: req.params.userId });
  return { ok: true };
}));

superRouter.patch("/businesses/:id", h((req) => {
  const b = one("SELECT * FROM businesses WHERE id = ?", req.params.id);
  if (!b) throw notFound();
  const body = parse(z.object({ suspended: z.boolean().optional(), plan: z.string().optional() }), req.body);
  if (body.suspended !== undefined) {
    run("UPDATE businesses SET suspended = ? WHERE id = ?", Number(body.suspended), b.id);
    audit(actorOf(req.user), b.id, body.suspended ? "business.suspended" : "business.unsuspended");
  }
  // Manual override (comped accounts, support credits). Does not touch Stripe.
  if (body.plan) setPlan(b.id, body.plan, "active", actorOf(req.user));
  return one("SELECT id, name, plan, plan_status, suspended FROM businesses WHERE id = ?", b.id);
}));

superRouter.post("/businesses/:id/members", h((req) => {
  const body = parse(z.object({ email: z.email(), role: z.enum(["owner", "manager"]).default("manager") }), req.body);
  const user = one("SELECT * FROM users WHERE email = ?", body.email);
  if (!user) throw badRequest("No user with that email; ask them to sign up first");
  if (user.role === "customer") run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
  run("INSERT OR REPLACE INTO business_members (business_id, user_id, role) VALUES (?,?,?)", req.params.id, user.id, body.role);
  audit(actorOf(req.user), req.params.id as string, "member.added", { email: body.email, role: body.role });
  return { ok: true };
}));

superRouter.get("/users", h((req) => {
  const q = `%${String(req.query.q ?? "")}%`;
  return all(
    `SELECT u.id, u.email, u.name, u.role, u.created_at, u.password_hash != '' AS has_password,
            (SELECT GROUP_CONCAT(provider) FROM user_identities i WHERE i.user_id = u.id) AS providers,
            (SELECT GROUP_CONCAT(b.name, ', ') FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = u.id) AS businesses
       FROM users u WHERE u.email LIKE ? OR u.name LIKE ? ORDER BY u.created_at DESC LIMIT 500`, q, q,
  );
}));

superRouter.patch("/users/:id", h(async (req) => {
  const body = parse(z.object({ role: z.enum(["superadmin", "admin", "customer"]).optional(), password: z.string().min(8).optional() }), req.body);
  const user = one("SELECT * FROM users WHERE id = ?", req.params.id);
  if (!user) throw notFound();
  if (body.role) run("UPDATE users SET role = ? WHERE id = ?", body.role, user.id);
  // Setting a password signs the user out everywhere (their old sessions may be compromised).
  if (body.password) run("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?", await hashPassword(body.password), user.id);
  audit(actorOf(req.user), null, "user.updated", { userId: user.id, role: body.role, passwordReset: !!body.password });
  return one("SELECT id, email, name, role FROM users WHERE id = ?", user.id);
}));

/** Emails the user a reset link and also returns it, so it can be shared another way if email isn't set up. */
superRouter.post("/users/:id/send-reset", h(async (req) => {
  const user = one("SELECT id, email, name FROM users WHERE id = ?", req.params.id);
  if (!user) throw notFound();
  const result = await emailResetLink(user as any);
  audit(actorOf(req.user), null, "user.reset_link_sent", { userId: user.id, emailed: result.delivered });
  return result;
}));

// ---------- Platform settings: API keys and webhooks for every integration ----------

superRouter.get("/settings", h(() => ({ groups: describeSettings(), encryptionKeySet: !!config.encryptionKey })));

superRouter.put("/settings", h((req) => {
  const body = parse(z.object({ values: z.record(z.string(), z.string().max(10000).nullable()) }), req.body);
  const changed = saveSettings(body.values);
  // Record which settings changed, never their values.
  audit(actorOf(req.user), null, "settings.updated", { changed });
  return { groups: describeSettings() };
}));

superRouter.post("/settings/test/:group", h((req) => testSettings(req.params.group as string)));

/** The models the saved Anthropic key can use, fetched fresh each time, with prices for the model picker. */
superRouter.get("/settings/ai-models", h(async (req) => {
  // ?for=support lists what the support assistant's key can use.
  const support = req.query.for === "support";
  try {
    return { models: await listModels(support ? config.supportAi.apiKey : config.ai.apiKey), current: support ? config.supportAi.model : config.ai.model };
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}));

superRouter.get("/plans", h(() => getPlans()));

superRouter.get("/packs", h(() => getPacks()));

superRouter.put("/packs", h((req) => {
  const packs = parse(z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/), metric: z.enum(["bookings", "ai"]),
    quantity: z.number().int().min(1), priceCents: z.number().int().min(0),
  })), req.body);
  savePacks(packs);
  audit(actorOf(req.user), null, "packs.updated", { packs });
  return packs;
}));

/** Free extra uses for this month (support credit, goodwill). */
superRouter.post("/businesses/:id/credits", h((req) => {
  const b = one("SELECT * FROM businesses WHERE id = ?", req.params.id);
  if (!b) throw notFound();
  const body = parse(z.object({ metric: z.enum(["bookings", "ai"]), quantity: z.number().int().min(1).max(100000) }), req.body);
  grantCredits(b.id, { id: "grant", metric: body.metric, quantity: body.quantity, priceCents: 0 }, 1, "grant", actorOf(req.user));
  return usageFor(b);
}));

superRouter.put("/plans", h((req) => {
  const plans = parse(z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
    monthlyPriceCents: z.number().int().min(0),
    maxStaff: z.number().int().min(1), aiChat: z.boolean(),
    bookingsPerMonth: z.number().int().min(0), aiMessagesPerMonth: z.number().int().min(0),
    visible: z.boolean().default(true),
  })).min(1), req.body);
  if (!plans.some((p) => p.id === "free")) throw badRequest("A 'free' plan must exist (it is the fallback when subscriptions end)");
  if (!plans.find((p) => p.id === "free")!.visible) throw badRequest("The 'free' plan must stay visible: it's the plan new businesses start on");
  savePlans(plans);
  audit(actorOf(req.user), null, "plans.updated", { plans });
  return plans;
}));

superRouter.get("/payments", h(() => all(
  `SELECT p.*, z.name AS business_name, b.code AS booking_code FROM payments p
     JOIN businesses z ON z.id = p.business_id LEFT JOIN bookings b ON b.id = p.booking_id
    ORDER BY p.created_at DESC LIMIT 500`,
)));

superRouter.get("/audit", h(() => all("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500")));
