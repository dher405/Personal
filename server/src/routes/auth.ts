import { Router } from "express";
import { z } from "zod";
import { audit, newId, one, run, all } from "../db.js";
import { checkPassword, hashPassword, requireAuth, signToken, type AuthUser } from "../lib/auth.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { rateLimit } from "../lib/rateLimit.js";

export const authRouter = Router();

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function uniqueSlug(base: string) {
  let slug = slugify(base) || "business";
  for (let i = 2; one("SELECT 1 FROM businesses WHERE slug = ?", slug); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

export function createBusiness(ownerId: string, name: string, timezone = "America/New_York") {
  const id = newId("biz");
  run("INSERT INTO businesses (id, name, slug, timezone) VALUES (?,?,?,?)", id, name, uniqueSlug(name), timezone);
  run("INSERT INTO business_members (business_id, user_id, role) VALUES (?,?, 'owner')", id, ownerId);
  return one("SELECT * FROM businesses WHERE id = ?", id)!;
}

function session(user: AuthUser) {
  const businesses = user.role === "customer" ? [] : all(
    user.role === "superadmin"
      ? "SELECT id, name, slug FROM businesses ORDER BY name"
      : "SELECT b.id, b.name, b.slug FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE m.user_id = ? ORDER BY b.name",
    ...(user.role === "superadmin" ? [] : [user.id]),
  );
  return { token: signToken(user), user, businesses };
}

authRouter.post("/register", rateLimit({ windowMs: 60 * 60_000, max: 20 }), h(async (req) => {
  const body = parse(z.object({
    email: z.email(),
    password: z.string().min(8),
    name: z.string().min(1),
    phone: z.string().optional(),
    // Present when signing up as a provider; omitted for customers.
    businessName: z.string().min(2).optional(),
    timezone: z.string().optional(),
  }), req.body);
  if (one("SELECT 1 FROM users WHERE email = ?", body.email)) throw badRequest("An account with that email already exists");
  const id = newId("usr");
  const role = body.businessName ? "admin" : "customer";
  run("INSERT INTO users (id, email, password_hash, name, phone, role) VALUES (?,?,?,?,?,?)",
    id, body.email.toLowerCase(), await hashPassword(body.password), body.name, body.phone ?? null, role);
  if (body.businessName) {
    const biz = createBusiness(id, body.businessName, body.timezone);
    audit({ id, label: body.email }, biz.id, "business.created", {});
  }
  return session(one<AuthUser>("SELECT id, email, name, role FROM users WHERE id = ?", id)!);
}));

authRouter.post("/login", rateLimit({ windowMs: 15 * 60_000, max: 30 }), h(async (req) => {
  const body = parse(z.object({ email: z.string(), password: z.string() }), req.body);
  const row = one("SELECT * FROM users WHERE email = ?", body.email.trim());
  if (!row || !(await checkPassword(body.password, row.password_hash))) throw new HttpError(401, "Wrong email or password");
  return session({ id: row.id, email: row.email, name: row.name, role: row.role });
}));

authRouter.get("/me", requireAuth, h((req) => session(req.user!)));

/** Lets an existing admin open an additional business (e.g. a second location). */
authRouter.post("/businesses", requireAuth, h((req) => {
  if (req.user!.role === "customer") throw new HttpError(403, "Only provider accounts can create businesses");
  const body = parse(z.object({ name: z.string().min(2), timezone: z.string().optional() }), req.body);
  return createBusiness(req.user!.id, body.name, body.timezone);
}));

authRouter.get("/my-bookings", requireAuth, h((req) => all(
  `SELECT b.code, b.starts_at, b.status, b.manage_token, s.name AS service_name, z.name AS business_name
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN businesses z ON z.id = b.business_id
    WHERE b.customer_id = ? OR b.customer_email = ? ORDER BY b.starts_at DESC LIMIT 100`,
  req.user!.id, req.user!.email,
)));
