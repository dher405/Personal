import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { optionalAuth, requireAuth, requireSuperAdmin } from "./lib/auth.js";
import { errorHandler } from "./lib/http.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";
import { adminRouter } from "./routes/admin.js";
import { superRouter } from "./routes/superadmin.js";
import { paymentsRouter } from "./routes/payments.js";
import { smsWebhookRouter } from "./routes/sms.js";

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
  app.use("/api/admin/:bid", requireAuth, adminRouter);
  app.use("/api/super", requireAuth, requireSuperAdmin, superRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // In a single-service deploy the API also serves the built website (web/dist).
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    // Client-side routes (/b/:slug, /admin/...) all load index.html.
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(`${webDist}/index.html`, { maxAge: 0 }));
  }
  app.use(errorHandler);
  return app;
}
