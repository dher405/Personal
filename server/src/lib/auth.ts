import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { one } from "../db.js";
import { HttpError, forbidden, notFound } from "./errors.js";

export type Role = "superadmin" | "admin" | "customer";
export interface AuthUser { id: string; email: string; name: string; role: Role }

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
/** Accounts created through Google/Apple have no password until they set one. */
export const checkPassword = (pw: string, hash: string) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

/** `ver` is bumped on password reset so tokens issued before it stop working. */
export function signToken(user: AuthUser) {
  const row = one<{ token_version: number }>("SELECT token_version FROM users WHERE id = ?", user.id);
  return jwt.sign({ sub: user.id, ver: row?.token_version ?? 0 }, config.jwtSecret, { expiresIn: "7d" });
}

/** Attaches req.user when a valid bearer token is present; never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string; ver?: number };
      const user = one<AuthUser & { token_version: number }>("SELECT id, email, name, role, token_version FROM users WHERE id = ?", payload.sub);
      if (user && (payload.ver ?? 0) === user.token_version) {
        req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
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
