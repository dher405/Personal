import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
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

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors({ origin: config.isProduction ? config.webUrl : true }));
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
