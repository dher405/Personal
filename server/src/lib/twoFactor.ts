import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Request } from "express";
import { DateTime } from "luxon";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { config, siteOrigins } from "../config.js";
import { all, audit, newId, one, run, type Row } from "../db.js";
import type { AuthUser } from "./auth.js";
import { emailLive, sendEmail } from "./email.js";
import { badRequest, HttpError } from "./errors.js";

/**
 * Two-step sign-in. Every sign-in (password, Google/Apple, new account) on a device that isn't trusted needs a
 * second step: a 6-digit code emailed to the account's address, or a passkey. Each signed-in browser or app is a
 * device; ticking "remember this device" trusts it for TRUST_DAYS. Signing in with a passkey alone counts as both
 * steps (the passkey is on the device and unlocked with a fingerprint, face or PIN).
 */

export const TRUST_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;
const RESEND_SECONDS = 30;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = () => DateTime.utc().toISO()!;

export const hasPasskeys = (userId: string) => !!one("SELECT 1 FROM passkeys WHERE user_id = ?", userId);

/** The demo accounts (…@demo.test) can't receive email, so they sign in without a code in demo mode. */
const demoAccount = (email: string) => config.demoMode && /\.test$/i.test(email);

/**
 * Codes go by email, so two-step sign-in needs the platform's email (Super admin → Settings → Email). Until that
 * works it's paused (people with a passkey still use it) rather than locking everyone out.
 */
export function twoFactorRequired(user: { id: string; email: string }) {
  if (demoAccount(user.email)) return false;
  return emailLive() || hasPasskeys(user.id);
}

export const maskEmail = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, c: string) => `${a}${"•".repeat(Math.min(Math.max(b.length, 1), 6))}${c}`);

// ---------- Devices ----------

/** "Chrome on Windows", "Safari on iPhone"… good enough for someone to recognise their own devices. */
export function deviceName(req: Request, given?: string) {
  if (given?.trim()) return given.trim().slice(0, 60);
  const ua = String(req.headers["user-agent"] ?? "");
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** The device a returning browser or app says it is (its device token), if it belongs to this user and is still signed in or trusted. */
export function findDevice(userId: string, deviceToken?: string | null) {
  if (!deviceToken) return undefined;
  return one("SELECT * FROM devices WHERE user_id = ? AND secret_hash = ? AND revoked_at IS NULL", userId, sha(deviceToken));
}

export const isTrusted = (d: Row | undefined) => !!d?.trusted_until && DateTime.fromISO(d.trusted_until) > DateTime.utc();

/**
 * Records a sign-in on a device and returns its id and token (the secret the browser or app keeps to say which device
 * it is next time). `verifiedWith` is the second step used; `remember` trusts the device for TRUST_DAYS.
 */
export function signInDevice(req: Request, user: AuthUser, opts: { deviceToken?: string | null; deviceName?: string; verifiedWith: string | null; remember?: boolean }) {
  const existing = findDevice(user.id, opts.deviceToken);
  const trustedUntil = opts.verifiedWith && opts.remember ? DateTime.utc().plus({ days: TRUST_DAYS }).toISO() : null;
  const ip = req.ip ?? null;
  if (existing) {
    // A trusted device stays trusted; a second step can renew or (if "remember" was unticked) end that trust.
    const trust = opts.verifiedWith ? trustedUntil : existing.trusted_until;
    run("UPDATE devices SET trusted_until = ?, verified_with = COALESCE(?, verified_with), last_seen_at = ?, last_ip = ? WHERE id = ?",
      trust, opts.verifiedWith, nowIso(), ip, existing.id);
    return { deviceId: existing.id as string, deviceToken: opts.deviceToken! };
  }
  const token = randomBytes(32).toString("base64url");
  const id = newId("dev");
  const name = deviceName(req, opts.deviceName);
  run("INSERT INTO devices (id, user_id, secret_hash, name, verified_with, trusted_until, last_ip, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, user.id, sha(token), name, opts.verifiedWith, trustedUntil, ip, nowIso(), nowIso());
  audit({ id: user.id, label: `${user.role}:${user.email}` }, null, "auth.new_device", { device: name, verifiedWith: opts.verifiedWith, ip });
  // Tell the person when a new device signs in to their account, so a sign-in they didn't make stands out.
  if (opts.verifiedWith && emailLive() && all("SELECT 1 FROM devices WHERE user_id = ?", user.id).length > 1) {
    sendEmail({
      to: user.email, subject: "New sign-in to your Slotwise account",
      text: [
        `Hi ${user.name.split(" ")[0] || "there"},`,
        `Your Slotwise account was just signed in to on a new device: ${name}${ip ? ` (IP address ${ip})` : ""}, ${DateTime.utc().toFormat("d LLL yyyy, HH:mm")} UTC.`,
        `If this was you, there's nothing to do. If it wasn't, change your password now and sign that device out under Account → Security:\n${config.webUrl}/account`,
      ].join("\n\n"),
    }).catch((err) => console.error("new-device email failed", err));
  }
  return { deviceId: id, deviceToken: token };
}

/** Whether a token's device is still signed in (and notes when it was last used). */
export function deviceActive(userId: string, deviceId: string) {
  const d = one<{ last_seen_at: string }>("SELECT last_seen_at FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL", deviceId, userId);
  if (!d) return false;
  // Written by SQLite ("2026-10-20 14:00:00", UTC) or by us (ISO); refreshed at most every 5 minutes.
  const seen = d.last_seen_at.includes("T") ? DateTime.fromISO(d.last_seen_at) : DateTime.fromSQL(d.last_seen_at, { zone: "utc" });
  if (!seen.isValid || seen < DateTime.utc().minus({ minutes: 5 })) {
    run("UPDATE devices SET last_seen_at = ? WHERE id = ?", nowIso(), deviceId);
  }
  return true;
}

export function listDevices(userId: string, currentId?: string) {
  return all("SELECT id, name, verified_with, trusted_until, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC", userId)
    .map((d) => ({ ...d, trusted: isTrusted(d), current: d.id === currentId }));
}

export function revokeDevice(userId: string, deviceId: string) {
  const r = run("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL", nowIso(), deviceId, userId);
  if (!r.changes) throw new HttpError(404, "Device not found");
}

export function revokeOtherDevices(userId: string, keepId?: string) {
  return run("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?", nowIso(), userId, keepId ?? null).changes;
}

// ---------- Challenges (the second step) ----------

type Purpose = "login" | "oauth" | "register" | "passkey" | "add_passkey";

function newChallenge(userId: string | null, purpose: Purpose, next?: string) {
  const id = newId("chl");
  run("INSERT INTO login_challenges (id, user_id, purpose, next, expires_at) VALUES (?,?,?,?,?)",
    id, userId, purpose, next ?? null, DateTime.utc().plus({ minutes: CODE_MINUTES }).toISO());
  return id;
}

/** A live challenge, or a clear error if it has expired, been used or had too many wrong codes. */
export function getChallenge(id: string, purposes: Purpose[]) {
  const c = one("SELECT * FROM login_challenges WHERE id = ?", id);
  if (!c || !purposes.includes(c.purpose)) throw badRequest("That sign-in has expired. Please start again.");
  if (c.done_at) throw badRequest("That sign-in was already completed. Please start again.");
  if (DateTime.fromISO(c.expires_at) < DateTime.utc()) throw badRequest("That sign-in has expired. Please start again.");
  if (c.attempts >= MAX_ATTEMPTS) throw badRequest("Too many wrong codes. Please start signing in again.");
  return c;
}

const finish = (id: string) => run("UPDATE login_challenges SET done_at = ? WHERE id = ?", nowIso(), id);

/** What the sign-in page needs to show the second step. */
export function describeChallenge(c: Row, user: { id: string; email: string }) {
  const passkeys = hasPasskeys(user.id);
  return {
    id: c.id, email: maskEmail(user.email), codeSent: !!c.code_sent_at,
    methods: [...(passkeys ? ["passkey"] : []), ...(emailLive() ? ["email"] : [])],
    rememberDays: TRUST_DAYS,
  };
}

/**
 * Starts the second step. People with a passkey are offered it first (no email sent unless they ask for a code);
 * everyone else is emailed a code straight away.
 */
export async function startSecondStep(user: AuthUser, purpose: "login" | "oauth" | "register", next?: string) {
  const id = newChallenge(user.id, purpose, next);
  if (!hasPasskeys(user.id) && emailLive()) await sendCode(id);
  return describeChallenge(one("SELECT * FROM login_challenges WHERE id = ?", id)!, user);
}

export async function sendCode(challengeId: string) {
  const c = getChallenge(challengeId, ["login", "oauth", "register"]);
  if (!emailLive()) throw badRequest("Email codes aren't available right now. Use your passkey.");
  if (c.sends >= MAX_SENDS) throw badRequest("We've sent several codes already. Please start signing in again.");
  if (c.code_sent_at && DateTime.fromISO(c.code_sent_at) > DateTime.utc().minus({ seconds: RESEND_SECONDS })) {
    throw badRequest("A code was just sent. Wait a few seconds before asking for another, and check your spam folder.");
  }
  const user = one("SELECT email, name FROM users WHERE id = ?", c.user_id)!;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  run("UPDATE login_challenges SET code_hash = ?, code_sent_at = ?, sends = sends + 1, attempts = 0, expires_at = ? WHERE id = ?",
    sha(`${c.id}:${code}`), nowIso(), DateTime.utc().plus({ minutes: CODE_MINUTES }).toISO(), c.id);
  const what = c.purpose === "register" ? "confirm your email and finish creating your Slotwise account" : "finish signing in to Slotwise";
  await sendEmail({
    to: user.email, subject: `${code} is your Slotwise sign-in code`,
    text: [
      `Hi ${String(user.name).split(" ")[0] || "there"},`,
      `Enter this code to ${what}:\n\n    ${code}\n\nIt expires in ${CODE_MINUTES} minutes.`,
      `Didn't try to sign in? Someone may know your password. Change it at ${config.webUrl}/account, and don't share this code with anyone, including people saying they're from Slotwise.`,
    ].join("\n\n"),
  }).catch((err) => {
    console.error("sign-in code email failed", err);
    throw new CodeEmailError((err as Error).message);
  });
}

/** The email provider refused the sign-in code (domain not verified, wrong key…). */
export class CodeEmailError extends HttpError {
  constructor(public reason: string) {
    super(503, "We couldn't email your sign-in code just now. Please try again in a few minutes, or use your passkey.");
  }
}

/** Checks an emailed code. Returns the challenge (with its user) when it's right. */
export function checkCode(challengeId: string, code: string) {
  const c = getChallenge(challengeId, ["login", "oauth", "register"]);
  if (!c.code_hash) throw badRequest("Ask for a code first.");
  if (sha(`${c.id}:${code.replace(/\D/g, "")}`) !== c.code_hash) {
    run("UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?", c.id);
    const left = MAX_ATTEMPTS - c.attempts - 1;
    throw badRequest(left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Please start signing in again.");
  }
  finish(c.id);
  return c;
}

/** For the Google/Apple return trip: the challenge is made on the server, and the browser then says which device it is. */
export function createOAuthChallenge(userId: string, next: string) {
  return newChallenge(userId, "oauth", next);
}

export function completeWithoutSecondStep(challengeId: string) { finish(challengeId); }

// ---------- Passkeys ----------

/**
 * Passkeys belong to a domain. They're made for the address the browser is on (normally the main website address;
 * the old Render address redirects there), and checked against any of the site's own addresses.
 */
const rp = (origin?: string) => {
  const url = new URL(origin && siteOrigins().includes(origin) ? origin : config.webUrl);
  return { id: url.hostname, name: "Slotwise" };
};
const expected = () => ({ expectedOrigin: siteOrigins(), expectedRPID: [...new Set(siteOrigins().map((o) => new URL(o).hostname))] });

const credentialOf = (p: Row) => ({
  id: p.credential_id as string, publicKey: isoBase64URL.toBuffer(p.public_key), counter: p.counter as number,
  transports: p.transports ? JSON.parse(p.transports) : undefined,
});

export function listPasskeys(userId: string) {
  return all("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at", userId);
}

export async function passkeyRegistrationOptions(user: AuthUser, origin?: string) {
  const id = newChallenge(user.id, "add_passkey");
  const options = await generateRegistrationOptions({
    rpName: rp().name, rpID: rp(origin).id, userName: user.email, userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id), attestationType: "none",
    excludeCredentials: all("SELECT * FROM passkeys WHERE user_id = ?", user.id).map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    // Saved on the device (so it can sign in without typing an email) and unlocked with a fingerprint, face or PIN.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  run("UPDATE login_challenges SET webauthn_challenge = ? WHERE id = ?", options.challenge, id);
  return { challengeId: id, options };
}

export async function addPasskey(user: AuthUser, challengeId: string, response: RegistrationResponseJSON, name?: string) {
  const c = getChallenge(challengeId, ["add_passkey"]);
  if (c.user_id !== user.id) throw badRequest("That passkey setup has expired. Please try again.");
  const result = await verifyRegistrationResponse({
    response, expectedChallenge: c.webauthn_challenge, ...expected(), requireUserVerification: false,
  }).catch((err) => { throw badRequest(`The passkey couldn't be checked: ${err.message}`); });
  if (!result.verified) throw badRequest("The passkey couldn't be verified. Please try again.");
  finish(c.id);
  const cred = result.registrationInfo.credential;
  const id = newId("pk");
  const label = name?.trim().slice(0, 60) || `Passkey ${listPasskeys(user.id).length + 1}`;
  run("INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name) VALUES (?,?,?,?,?,?,?)",
    id, user.id, cred.id, isoBase64URL.fromBuffer(cred.publicKey), cred.counter, cred.transports ? JSON.stringify(cred.transports) : null, label);
  audit({ id: user.id, label: `${user.role}:${user.email}` }, null, "auth.passkey_added", { name: label });
  return { id, name: label };
}

export function removePasskey(user: AuthUser, id: string) {
  const r = run("DELETE FROM passkeys WHERE id = ? AND user_id = ?", id, user.id);
  if (!r.changes) throw new HttpError(404, "Passkey not found");
  audit({ id: user.id, label: `${user.role}:${user.email}` }, null, "auth.passkey_removed", { id });
}

/**
 * Passkey options. With a challenge from a password/Google sign-in, only that person's passkeys are offered (the
 * second step). Without one, any passkey saved for this site can sign in on its own.
 */
export async function passkeySignInOptions(challengeId?: string, origin?: string) {
  let id = challengeId;
  let allowCredentials: { id: string; transports?: any }[] | undefined;
  if (challengeId) {
    const c = getChallenge(challengeId, ["login", "oauth", "register"]);
    allowCredentials = all("SELECT * FROM passkeys WHERE user_id = ?", c.user_id).map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined }));
    if (!allowCredentials.length) throw badRequest("You haven't added a passkey yet. Use the emailed code.");
  } else {
    id = newChallenge(null, "passkey");
  }
  const options = await generateAuthenticationOptions({ rpID: rp(origin).id, allowCredentials, userVerification: challengeId ? "preferred" : "required" });
  run("UPDATE login_challenges SET webauthn_challenge = ? WHERE id = ?", options.challenge, id);
  return { challengeId: id!, options };
}

/** Checks a passkey. Returns the user it belongs to and the challenge it completed. */
export async function checkPasskey(challengeId: string, response: AuthenticationResponseJSON) {
  const c = getChallenge(challengeId, ["login", "oauth", "register", "passkey"]);
  const pk = one("SELECT * FROM passkeys WHERE credential_id = ?", response.id);
  if (!pk || (c.user_id && pk.user_id !== c.user_id)) {
    run("UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?", c.id);
    throw badRequest("That passkey isn't registered to a Slotwise account. Sign in with your email and password instead.");
  }
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: c.webauthn_challenge ?? "", ...expected(),
    credential: credentialOf(pk), requireUserVerification: c.purpose === "passkey",
  }).catch((err) => { throw badRequest(`The passkey couldn't be checked: ${err.message}`); });
  if (!result.verified) throw badRequest("The passkey couldn't be verified. Please try again.");
  run("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", result.authenticationInfo.newCounter, nowIso(), pk.id);
  finish(c.id);
  return { challenge: c, userId: pk.user_id as string };
}
