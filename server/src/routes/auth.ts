import express, { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { emailLive } from "../lib/email.js";
import { emailResetLink, resetPassword } from "../lib/passwordReset.js";
import { authorizeUrl, exchangeCode, findOrCreateUser, newState, providerEnabled, type OAuthState, type Provider } from "../lib/oauth.js";
import { z } from "zod";
import { audit, newId, one, run, all } from "../db.js";
import { actorOf, checkPassword, hashPassword, requireAuth, signToken, type AuthUser } from "../lib/auth.js";
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
  const body = parse(z.object({ name: z.string().min(2), timezone: z.string().optional() }), req.body);
  // A customer account (e.g. created with Google/Apple) becomes an admin when it opens a business.
  if (req.user!.role === "customer") run("UPDATE users SET role = 'admin' WHERE id = ?", req.user!.id);
  const biz = createBusiness(req.user!.id, body.name, body.timezone);
  audit(actorOf(req.user), biz.id, "business.created", {});
  return { business: biz, session: session(one<AuthUser>("SELECT id, email, name, role FROM users WHERE id = ?", req.user!.id)!) };
}));

// ---------- Password reset & change ----------

authRouter.get("/providers", h(() => ({ google: providerEnabled("google"), apple: providerEnabled("apple"), emailConfigured: emailLive() })));

const RESET_MESSAGE = "If an account exists for that email, we've sent a link to reset the password. It expires in 1 hour.";

authRouter.post("/forgot-password", rateLimit({ windowMs: 15 * 60_000, max: 5 }), h(async (req) => {
  const { email } = parse(z.object({ email: z.string().trim().min(3) }), req.body);
  const user = one("SELECT id, email, name FROM users WHERE email = ?", email);
  // Same answer whether or not the account exists, so this can't be used to discover who has an account.
  if (user) {
    try {
      await emailResetLink(user as any);
    } catch (err) {
      console.error("reset email failed", err);
    }
  }
  return { message: RESET_MESSAGE };
}));

authRouter.post("/reset-password", rateLimit({ windowMs: 15 * 60_000, max: 10 }), h(async (req) => {
  const body = parse(z.object({ token: z.string().min(20), password: z.string().min(8) }), req.body);
  const user = await resetPassword(body.token, body.password);
  return session(user as AuthUser);
}));

authRouter.get("/account", requireAuth, h((req) => ({
  hasPassword: !!one("SELECT password_hash FROM users WHERE id = ?", req.user!.id)!.password_hash,
  identities: all("SELECT provider, email, created_at FROM user_identities WHERE user_id = ?", req.user!.id),
})));

authRouter.post("/change-password", requireAuth, rateLimit({ windowMs: 15 * 60_000, max: 10 }), h(async (req) => {
  const body = parse(z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(8) }), req.body);
  const row = one("SELECT password_hash FROM users WHERE id = ?", req.user!.id)!;
  // Google/Apple-only accounts can add a password without a current one.
  if (row.password_hash && !(await checkPassword(body.currentPassword ?? "", row.password_hash))) {
    throw new HttpError(400, "Current password is incorrect");
  }
  run("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?", await hashPassword(body.newPassword), req.user!.id);
  audit(actorOf(req.user), null, "user.password_changed", {});
  return session(req.user!); // fresh token; other devices are signed out
}));

// ---------- Sign in with Google / Apple ----------

const STATE_COOKIE = "sw_oauth";
const secureCookies = () => config.apiUrl.startsWith("https://");

function readCookie(req: Request, name: string) {
  const match = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

const loginError = (res: Response, message: string) =>
  res.redirect(`${config.webUrl}/login?error=${encodeURIComponent(message)}`);

const asProvider = (p: string): Provider | null => (p === "google" || p === "apple" ? p : null);

authRouter.get("/oauth/:provider/start", h((req, res) => {
  const provider = asProvider(req.params.provider as string);
  if (!provider || !providerEnabled(provider)) return loginError(res, "That sign-in option isn't set up yet.");
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : "/";
  const state = newState(provider, req.query.intent === "business" ? "business" : "signin", next);
  // Apple posts the result back cross-site, which needs SameSite=None (and therefore HTTPS).
  res.cookie(STATE_COOKIE, jwt.sign(state, config.jwtSecret, { expiresIn: "10m" }), {
    httpOnly: true, secure: secureCookies(), sameSite: secureCookies() ? "none" : "lax", maxAge: 10 * 60_000, path: "/api/auth/oauth",
  });
  res.redirect(authorizeUrl(state));
}));

// Google returns with GET; Apple with a form POST (response_mode=form_post).
const callback = h(async (req, res) => {
  const provider = asProvider(req.params.provider as string);
  const params = { ...req.query, ...(req.body ?? {}) } as Record<string, string>;
  res.clearCookie(STATE_COOKIE, { path: "/api/auth/oauth" });
  if (!provider) return loginError(res, "Unknown sign-in option.");
  if (params.error) return loginError(res, params.error === "access_denied" || params.error === "user_cancelled_authorize" ? "Sign-in was cancelled." : `Sign-in failed (${params.error}).`);

  let state: OAuthState;
  try {
    state = jwt.verify(readCookie(req, STATE_COOKIE) ?? "", config.jwtSecret) as OAuthState;
  } catch {
    return loginError(res, "Your sign-in attempt expired. Please try again.");
  }
  if (state.provider !== provider || state.state !== params.state || !params.code) return loginError(res, "Sign-in could not be verified. Please try again.");

  try {
    const profile = await exchangeCode(provider, params.code, state.nonce);
    // Apple sends the person's name only on their very first sign-in, alongside the code.
    let appleName: string | null = null;
    if (provider === "apple" && params.user) {
      try {
        const u = JSON.parse(params.user);
        appleName = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(" ") || null;
      } catch { /* ignore */ }
    }
    const { user } = findOrCreateUser(provider, profile, appleName);
    const hasBusiness = !!one("SELECT 1 FROM business_members WHERE user_id = ?", user.id);
    const next = state.intent === "business" && !hasBusiness && user.role !== "superadmin" ? "/start-business" : state.next;
    // The token travels in the URL fragment, which browsers never send to servers or log.
    res.redirect(`${config.webUrl}/auth/callback#token=${encodeURIComponent(signToken(user))}&next=${encodeURIComponent(next)}`);
  } catch (err) {
    loginError(res, (err as Error).message);
  }
});
authRouter.get("/oauth/:provider/callback", callback);
authRouter.post("/oauth/:provider/callback", express.urlencoded({ extended: false }), callback);

authRouter.get("/my-bookings", requireAuth, h((req) => all(
  `SELECT b.code, b.starts_at, b.status, b.manage_token, s.name AS service_name, z.name AS business_name
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN businesses z ON z.id = b.business_id
    WHERE b.customer_id = ? OR b.customer_email = ? ORDER BY b.starts_at DESC LIMIT 100`,
  req.user!.id, req.user!.email,
)));
