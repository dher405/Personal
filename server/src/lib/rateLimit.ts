import type { Request, Response, NextFunction } from "express";

/**
 * Fixed-window, in-memory limiter keyed by IP. Protects the public AI chat
 * (each message costs API usage) and booking endpoints from abuse. Use a shared
 * store (e.g. Redis) when running more than one server instance.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === "test") return next();
    const key = `${req.ip}:${req.baseUrl}${req.route?.path ?? req.path}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many requests — please wait a moment and try again." });
    }
    next();
  };
}
