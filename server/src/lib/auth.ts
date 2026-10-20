import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { one } from "../db.js";
import { HttpError, forbidden, notFound } from "./errors.js";
import { deviceActive } from "./twoFactor.js";

export type Role = "superadmin" | "admin" | "customer";
export interface AuthUser { id: string; email: string; name: string; role: Role }

declare global {
  namespace Express {
    interface Request { user?: AuthUser; /** The signed-in device (Account → Security lists them). */ deviceId?: string }
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
/** Accounts created through Google/Apple have no password until they set one. */
export const checkPassword = (pw: string, hash: string) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

/**
 * `ver` is bumped on password reset so tokens issued before it stop working. `dev` is the signed-in device: signing a
 * device out (Account → Security) ends its token too. Use issueSession (routes/auth.ts) rather than calling this.
 */
export function signToken(user: AuthUser, deviceId: string) {
  const row = one<{ token_version: number }>("SELECT token_version FROM users WHERE id = ?", user.id);
  return jwt.sign({ sub: user.id, ver: row?.token_version ?? 0, dev: deviceId }, config.jwtSecret, { expiresIn: "7d" });
}

/** Attaches req.user when a valid bearer token is present; never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string; ver?: number; dev?: string };
      const user = one<AuthUser & { token_version: number }>("SELECT id, email, name, role, token_version FROM users WHERE id = ?", payload.sub);
      // Tokens from before devices existed (no `dev`) no longer count: everyone signs in once more, with the second step.
      if (user && (payload.ver ?? 0) === user.token_version && payload.dev && deviceActive(user.id, payload.dev)) {
        req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
        req.deviceId = payload.dev;
      }
    } catch {
      // invalid/expired token: treat as anonymous
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Sign in required"));
  next();
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "superadmin") return next(forbidden("Super admin only"));
  next();
}

/** Super admins can manage every business; admins only businesses they are members of. */
export function assertBusinessAccess(user: AuthUser | undefined, businessId: string) {
  if (!user) throw new HttpError(401, "Sign in required");
  const business = one("SELECT id FROM businesses WHERE id = ?", businessId);
  if (!business) throw notFound("Business not found");
  if (user.role === "superadmin") return;
  const member = one("SELECT 1 FROM business_members WHERE business_id = ? AND user_id = ?", businessId, user.id);
  if (!member) throw forbidden("You do not manage this business");
}

export function actorOf(user: AuthUser | undefined) {
  return user ? { id: user.id, label: `${user.role}:${user.email}` } : { id: null, label: "anonymous" };
}
