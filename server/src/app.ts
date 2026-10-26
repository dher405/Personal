import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config, siteOrigins } from "./config.js";
// Loads keys saved on Super admin → Settings before anything reads them.
import "./lib/platformSettings.js";
import { optionalAuth, requireAuth, requireSuperAdmin } from "./lib/auth.js";
import { errorHandler } from "./lib/http.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";
import { adminRouter } from "./routes/admin.js";
import { superRouter } from "./routes/superadmin.js";
import { paymentsRouter } from "./routes/payments.js";
import { smsWebhookRouter } from "./routes/sms.js";
import { adminCalendarRouter, calendarPublicRouter } from "./routes/calendars.js";
import { marketingRouter } from "./marketing/router.js";

/**
 * Pages opened on another of the site's addresses (the old onrender.com one, or www/bare) move to the main address,
 * so sign-in, passkeys and cookies all happen on one domain. The API (webhooks, the booking widget's calls), the
 * widget itself and embed.js answer on every address, so integrations set up with the old address keep working.
 */
function canonicalHost(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/embed")) return next();
  const main = new URL(config.webUrl);
  const host = req.hostname;
  if (!host || host === main.hostname) return next();
  const known = siteOrigins().some((o) => new URL(o).hostname === host);
  // Only whole-page visits, never pages shown inside another site (the widget) or files fetched by scripts.
  const dest = req.headers["sec-fetch-dest"];
  if (known && (dest === "document" || (!dest && String(req.headers.accept ?? "").includes("text/html")))) {
    return res.redirect(301, `${main.origin}${req.originalUrl}`);
  }
  next();
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors({ origin: config.isProduction ? (origin, cb) => cb(null, !origin || siteOrigins().includes(origin)) : true }));
  app.use(canonicalHost);
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // Mounted before express.json so webhook routes receive the raw body.
  app.use("/api", paymentsRouter);
  app.use("/api", smsWebhookRouter);
  app.use(express.json({ limit: "200kb" }));
  app.use(optionalAuth);
  app.use("/api/auth", authRouter);
  app.use("/api/public", publicRouter);
  app.use("/api", calendarPublicRouter);
  app.use("/api/admin/:bid", requireAuth, adminRouter);
  app.use("/api/admin/:bid", requireAuth, adminCalendarRouter);
  app.use("/api/super/marketing", requireAuth, requireSuperAdmin, marketingRouter);
  app.use("/api/super", requireAuth, requireSuperAdmin, superRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // In a single-service deploy the API also serves the built website (web/dist).
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    // Client-side routes (/b/:slug, /admin/...) all load index.html.
    app.get(/^\/(?!api\/).*/, (req, res) => {
      // Only the booking widget may be framed by other sites; everything else (admin!) refuses, which blocks clickjacking.
      // The widget sends no frame-ancestors at all: "*" would still refuse pages opened from a file or sandboxed frames.
      if (!req.path.startsWith("/embed/")) {
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
      }
      res.sendFile(`${webDist}/index.html`, { maxAge: 0 });
    });
  }
  app.use(errorHandler);
  return app;
}
