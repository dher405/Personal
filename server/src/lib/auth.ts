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
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(user: AuthUser) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: "7d" });
}

/** Attaches req.user when a valid bearer token is present; never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string };
      const user = one<AuthUser>("SELECT id, email, name, role FROM users WHERE id = ?", payload.sub);
      if (user) req.user = user;
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
