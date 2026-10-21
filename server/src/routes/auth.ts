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
import {
  addPasskey, checkCode, checkPasskey, completeWithoutSecondStep, createOAuthChallenge, describeChallenge, findDevice, getChallenge,
  isTrusted, listDevices, listPasskeys, passkeyRegistrationOptions, passkeySignInOptions, removePasskey, revokeDevice,
  revokeOtherDevices, sendCode, signInDevice, startSecondStep, TRUST_DAYS, twoFactorRequired, CodeEmailError,
} from "../lib/twoFactor.js";

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

/** The session for a device that's already signed in (refreshing /me, opening a business…). */
function session(user: AuthUser, deviceId: string) {
  const businesses = user.role === "customer" ? [] : all(
    user.role === "superadmin"
      ? "SELECT id, name, slug FROM businesses ORDER BY name"
      : "SELECT b.id, b.name, b.slug FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE m.user_id = ? ORDER BY b.name",
    ...(user.role === "superadmin" ? [] : [user.id]),
  );
  return { token: signToken(user, deviceId), user, businesses };
}

const userById = (id: string) => one<AuthUser>("SELECT id, email, name, role FROM users WHERE id = ?", id)!;

/** Fields every sign-in step accepts: the device token a browser or app kept from last time, and whether to trust it. */
const deviceFields = { deviceToken: z.string().max(200).optional(), deviceName: z.string().max(60).optional(), remember: z.boolean().optional() };
type DeviceFields = { deviceToken?: string; deviceName?: string; remember?: boolean };

/** Signs a device in. Also returns its device token, which the browser or app keeps to be recognised next time. */
function issueSession(req: Request, user: AuthUser, d: DeviceFields, verifiedWith: string | null) {
  const { deviceId, deviceToken } = signInDevice(req, user, { ...d, verifiedWith });
  return { ...session(user, deviceId), deviceToken };
}

/**
 * After the first step (password, Google/Apple, new account): a trusted device goes straight in; otherwise the
 * response is `{ twoFactor }` and the sign-in page asks for the emailed code or a passkey.
 */
async function afterFirstStep(req: Request, user: AuthUser, d: DeviceFields, purpose: "login" | "oauth" | "register", next?: string) {
  if (!twoFactorRequired(user)) return issueSession(req, user, d, null);
  if (purpose !== "register" && isTrusted(findDevice(user.id, d.deviceToken))) return issueSession(req, user, d, null);
  try {
    return { twoFactor: { ...(await startSecondStep(user, purpose, next)), next: next ?? null } };
  } catch (err) {
    return withoutCodeEmail(req, user, d, err);
  }
}

/**
 * The email provider refused the code (for example the sending domain isn't verified yet). Rather than lock
 * everyone out (the super admin included, who has to fix it), sign-in carries on without the second step, as when
 * email isn't set up. The error shows on the super admin overview until an email gets through again.
 */
function withoutCodeEmail(req: Request, user: AuthUser, d: DeviceFields, err: unknown) {
  if (!(err instanceof CodeEmailError)) throw err;
  audit({ id: user.id, label: `${user.role}:${user.email}` }, null, "auth.code_email_failed", { error: err.reason });
  return issueSession(req, user, d, null);
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
    ...deviceFields,
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
  // New accounts confirm their email with a code before they're signed in.
  return afterFirstStep(req, userById(id), body, "register");
}));

authRouter.post("/login", rateLimit({ windowMs: 15 * 60_000, max: 30 }), h(async (req) => {
  const body = parse(z.object({ email: z.string(), password: z.string(), ...deviceFields }), req.body);
  const row = one("SELECT * FROM users WHERE email = ?", body.email.trim());
  if (!row || !(await checkPassword(body.password, row.password_hash))) throw new HttpError(401, "Wrong email or password");
  return afterFirstStep(req, { id: row.id, email: row.email, name: row.name, role: row.role }, body, "login");
}));

// ---------- The second step: emailed code or passkey ----------

const challengeId = z.string().min(5).max(60);

/** Emails a (new) code. */
authRouter.post("/2fa/send-code", rateLimit({ windowMs: 15 * 60_000, max: 15 }), h(async (req) => {
  const body = parse(z.object({ challengeId }), req.body);
  await sendCode(body.challengeId);
  const c = getChallenge(body.challengeId, ["login", "oauth", "register"]);
  return describeChallenge(c, userById(c.user_id));
}));

authRouter.post("/2fa/verify", rateLimit({ windowMs: 15 * 60_000, max: 30 }), h((req) => {
  const body = parse(z.object({ challengeId, code: z.string().min(4).max(12), ...deviceFields }), req.body);
  const c = checkCode(body.challengeId, body.code);
  return { ...issueSession(req, userById(c.user_id), body, "email"), next: c.next };
}));

/** Passkey options: for the second step (with a challengeId) or to sign in with a passkey alone (without). */
authRouter.post("/passkey/options", rateLimit({ windowMs: 15 * 60_000, max: 30 }), h(async (req) => {
  const body = parse(z.object({ challengeId: challengeId.optional() }), req.body);
  return passkeySignInOptions(body.challengeId, req.headers.origin);
}));

authRouter.post("/passkey/verify", rateLimit({ windowMs: 15 * 60_000, max: 30 }), h(async (req) => {
  const body = parse(z.object({ challengeId, response: z.any(), ...deviceFields }), req.body);
  const { challenge, userId } = await checkPasskey(body.challengeId, body.response);
  return { ...issueSession(req, userById(userId), body, "passkey"), next: challenge.next };
}));

/** Back from Google/Apple: the browser says which device it is; a trusted device goes straight in. */
authRouter.post("/2fa/resume", rateLimit({ windowMs: 15 * 60_000, max: 30 }), h(async (req) => {
  const body = parse(z.object({ challengeId, ...deviceFields }), req.body);
  const c = getChallenge(body.challengeId, ["oauth"]);
  const user = userById(c.user_id);
  if (!twoFactorRequired(user) || isTrusted(findDevice(user.id, body.deviceToken))) {
    completeWithoutSecondStep(c.id);
    return { ...issueSession(req, user, body, null), next: c.next };
  }
  // Reuse this challenge for the second step.
  if (!listPasskeys(user.id).length) {
    try {
      await sendCode(c.id);
    } catch (err) {
      completeWithoutSecondStep(c.id);
      return { ...withoutCodeEmail(req, user, body, err), next: c.next };
    }
  }
  return { twoFactor: { ...describeChallenge(getChallenge(c.id, ["oauth"]), user), next: c.next } };
}));

authRouter.get("/me", requireAuth, h((req) => session(req.user!, req.deviceId!)));

// ---------- Account → Security: passkeys and signed-in devices ----------

authRouter.get("/security", requireAuth, h((req) => ({
  twoFactorOn: twoFactorRequired(req.user!),
  emailWorking: emailLive(),
  rememberDays: TRUST_DAYS,
  passkeys: listPasskeys(req.user!.id),
  devices: listDevices(req.user!.id, req.deviceId),
})));

authRouter.post("/passkeys/options", requireAuth, h((req) => passkeyRegistrationOptions(req.user!, req.headers.origin)));

authRouter.post("/passkeys", requireAuth, h(async (req) => {
  const body = parse(z.object({ challengeId, response: z.any(), name: z.string().max(60).optional() }), req.body);
  return addPasskey(req.user!, body.challengeId, body.response, body.name);
}));

authRouter.delete("/passkeys/:id", requireAuth, h((req) => { removePasskey(req.user!, req.params.id as string); return { ok: true }; }));

/** Signs a device out (and forgets that it was trusted). Signing out the current one ends this session. */
authRouter.delete("/devices/:id", requireAuth, h((req) => {
  revokeDevice(req.user!.id, req.params.id as string);
  audit(actorOf(req.user), null, "auth.device_signed_out", { deviceId: req.params.id });
  return { ok: true, signedOut: req.params.id === req.deviceId };
}));

authRouter.post("/devices/sign-out-others", requireAuth, h((req) => {
  const n = revokeOtherDevices(req.user!.id, req.deviceId);
  audit(actorOf(req.user), null, "auth.devices_signed_out", { count: n });
  return { ok: true, count: n };
}));

/** Lets an existing admin open an additional business (e.g. a second location). */
authRouter.post("/businesses", requireAuth, h((req) => {
  const body = parse(z.object({ name: z.string().min(2), timezone: z.string().optional() }), req.body);
  // A customer account (e.g. created with Google/Apple) becomes an admin when it opens a business.
  if (req.user!.role === "customer") run("UPDATE users SET role = 'admin' WHERE id = ?", req.user!.id);
  const biz = createBusiness(req.user!.id, body.name, body.timezone);
  audit(actorOf(req.user), biz.id, "business.created", {});
  return { business: biz, session: session(userById(req.user!.id), req.deviceId!) };
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
  const body = parse(z.object({ token: z.string().min(20), password: z.string().min(8), ...deviceFields }), req.body);
  const user = await resetPassword(body.token, body.password) as AuthUser;
  // The reset link proved the person has the mailbox (the same proof as a code). Other devices are signed out.
  revokeOtherDevices(user.id);
  return issueSession(req, user, { ...body, remember: false }, "reset");
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
  revokeOtherDevices(req.user!.id, req.deviceId);
  audit(actorOf(req.user), null, "user.password_changed", {});
  return session(req.user!, req.deviceId!); // fresh token; other devices are signed out and must do the second step again
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
    // Google/Apple is the first step. The sign-in page then sends this browser's device token to /2fa/resume, which
    // signs a trusted device straight in or asks for the second step. (The fragment is never sent to servers or logged.)
    res.redirect(`${config.webUrl}/auth/callback#challenge=${encodeURIComponent(createOAuthChallenge(user.id, next))}`);
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
