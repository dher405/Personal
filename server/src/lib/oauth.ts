import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { audit, newId, one, run } from "../db.js";
import type { AuthUser } from "./auth.js";
import { badRequest } from "./errors.js";

export type Provider = "google" | "apple";

export const providerEnabled = (p: Provider) =>
  p === "google"
    ? !!(config.oauth.google.clientId && config.oauth.google.clientSecret)
    : !!(config.oauth.apple.clientId && config.oauth.apple.teamId && config.oauth.apple.keyId && config.oauth.apple.privateKey);

export const redirectUri = (p: Provider) => `${config.apiUrl}/api/auth/oauth/${p}/callback`;

export interface OAuthState { state: string; nonce: string; provider: Provider; intent: "signin" | "business"; next: string }

export function newState(provider: Provider, intent: OAuthState["intent"], next: string): OAuthState {
  return { state: randomBytes(16).toString("hex"), nonce: randomBytes(16).toString("hex"), provider, intent, next };
}

export function authorizeUrl(s: OAuthState) {
  if (s.provider === "google") {
    const q = new URLSearchParams({
      client_id: config.oauth.google.clientId, redirect_uri: redirectUri("google"), response_type: "code",
      scope: "openid email profile", state: s.state, nonce: s.nonce, prompt: "select_account",
    });
    return `${config.oauth.google.authUrl}?${q}`;
  }
  const q = new URLSearchParams({
    client_id: config.oauth.apple.clientId, redirect_uri: redirectUri("apple"), response_type: "code",
    response_mode: "form_post", scope: "name email", state: s.state, nonce: s.nonce,
  });
  return `${config.oauth.apple.authUrl}?${q}`;
}

/** Apple's client secret is a short-lived ES256 JWT signed with your .p8 key. */
function appleClientSecret() {
  const a = config.oauth.apple;
  return jwt.sign({}, a.privateKey, {
    algorithm: "ES256", keyid: a.keyId, issuer: a.teamId, audience: "https://appleid.apple.com", subject: a.clientId, expiresIn: "5m",
  });
}

interface Profile { subject: string; email: string | null; emailVerified: boolean; name: string | null }

/**
 * Swaps the authorization code for an ID token. The token comes straight from
 * Google/Apple over TLS in exchange for our client secret, so (per OpenID
 * Connect Core §3.1.3.7) we validate its claims rather than its signature.
 */
export async function exchangeCode(provider: Provider, code: string, nonce: string): Promise<Profile> {
  const isGoogle = provider === "google";
  const cfg = isGoogle ? config.oauth.google : config.oauth.apple;
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri(provider), client_id: cfg.clientId,
      client_secret: isGoogle ? config.oauth.google.clientSecret : appleClientSecret(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id_token) throw badRequest(`${isGoogle ? "Google" : "Apple"} sign-in failed: ${json.error_description ?? json.error ?? res.status}`);

  const claims = jwt.decode(json.id_token) as Record<string, any> | null;
  const issuers = isGoogle ? ["https://accounts.google.com", "accounts.google.com"] : ["https://appleid.apple.com"];
  const audOk = Array.isArray(claims?.aud) ? claims!.aud.includes(cfg.clientId) : claims?.aud === cfg.clientId;
  if (!claims || !issuers.includes(claims.iss) || !audOk || claims.exp * 1000 < Date.now() || claims.nonce !== nonce || !claims.sub) {
    throw badRequest("Sign-in response could not be verified. Please try again.");
  }
  return {
    subject: String(claims.sub),
    email: claims.email ? String(claims.email).toLowerCase() : null,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name ?? null,
  };
}

/** Finds the account for this Google/Apple identity, linking by verified email or creating a customer account. */
export function findOrCreateUser(provider: Provider, profile: Profile, appleName?: string | null): { user: AuthUser; created: boolean } {
  const select = "SELECT id, email, name, role FROM users WHERE id = ?";
  const linked = one("SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?", provider, profile.subject);
  if (linked) return { user: one<AuthUser>(select, linked.user_id)!, created: false };

  if (!profile.email) throw badRequest(`Your ${provider === "google" ? "Google" : "Apple"} account didn't share an email address, which we need to create your account.`);
  const label = { label: `${provider}:${profile.email}` };

  // Only a verified email may claim an existing account (otherwise anyone could add an unverified address and take it over).
  const existing = one("SELECT id FROM users WHERE email = ?", profile.email);
  if (existing) {
    if (!profile.emailVerified) throw badRequest("That email isn't verified with your provider. Sign in with your password instead.");
    run("INSERT INTO user_identities (provider, subject, user_id, email) VALUES (?,?,?,?)", provider, profile.subject, existing.id, profile.email);
    audit({ id: existing.id, ...label }, null, "user.identity_linked", { provider });
    return { user: one<AuthUser>(select, existing.id)!, created: false };
  }

  const id = newId("usr");
  const name = profile.name || appleName || profile.email.split("@")[0];
  run("INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,'',?, 'customer')", id, profile.email, name);
  run("INSERT INTO user_identities (provider, subject, user_id, email) VALUES (?,?,?,?)", provider, profile.subject, id, profile.email);
  audit({ id, ...label }, null, "user.created", { provider });
  return { user: one<AuthUser>(select, id)!, created: true };
}
