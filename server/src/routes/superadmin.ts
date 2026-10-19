import { Router } from "express";
import { z } from "zod";
import { all, audit, one, run } from "../db.js";
import { actorOf, hashPassword } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { getPlans, savePlans } from "../lib/plans.js";
import { setPlan } from "../lib/platformBilling.js";
import { emailResetLink } from "../lib/passwordReset.js";

/** Platform-wide controls. Mounted behind requireSuperAdmin. Business-level actions reuse /api/admin/:bid. */
export const superRouter = Router();

superRouter.get("/overview", h(() => ({
  businesses: one("SELECT COUNT(*) AS n FROM businesses")!.n,
  users: one("SELECT COUNT(*) AS n FROM users")!.n,
  bookings30d: one("SELECT COUNT(*) AS n FROM bookings WHERE created_at >= datetime('now', '-30 days')")!.n,
  gmv30dCents: one("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS n FROM payments WHERE status IN ('paid','partially_refunded') AND created_at >= datetime('now','-30 days')")!.n,
  platformFees30dCents: one("SELECT COALESCE(SUM(platform_fee_cents), 0) AS n FROM payments WHERE status IN ('paid','partially_refunded') AND created_at >= datetime('now','-30 days')")!.n,
  byPlan: all("SELECT plan, COUNT(*) AS n FROM businesses GROUP BY plan"),
  sms30d: one("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'outbound' AND status NOT IN ('failed','skipped') AND created_at >= datetime('now','-30 days')")!.n,
})));

superRouter.get("/businesses", h((req) => {
  const q = `%${String(req.query.q ?? "")}%`;
  return all(
    `SELECT b.id, b.name, b.slug, b.plan, b.plan_status, b.suspended, b.payment_provider, b.created_at,
            (SELECT COUNT(*) FROM bookings k WHERE k.business_id = b.id) AS booking_count,
            (SELECT COUNT(*) FROM sms_messages m WHERE m.business_id = b.id AND m.direction = 'outbound' AND m.status NOT IN ('failed','skipped')
               AND m.created_at >= datetime('now','start of month')) AS sms_this_month,
            (SELECT GROUP_CONCAT(u.email) FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = b.id) AS admins
       FROM businesses b WHERE b.name LIKE ? OR b.slug LIKE ? ORDER BY b.created_at DESC LIMIT 500`, q, q,
  );
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

superRouter.get("/plans", h(() => getPlans()));

superRouter.put("/plans", h((req) => {
  const plans = parse(z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
    monthlyPriceCents: z.number().int().min(0), platformFeeBps: z.number().int().min(0).max(3000),
    maxStaff: z.number().int().min(1), aiChat: z.boolean(), smsPerMonth: z.number().int().min(0),
  })).min(1), req.body);
  if (!plans.some((p) => p.id === "free")) throw badRequest("A 'free' plan must exist (it is the fallback when subscriptions end)");
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
