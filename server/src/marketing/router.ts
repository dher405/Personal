import { Router } from "express";
import { z } from "zod";
import { all, audit, one, run } from "../db.js";
import { actorOf } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { marketingAiAvailable } from "./agent.js";
import { promoRatio, WEEK } from "./guardrails.js";
import { JOB_LABELS, runningJob, startJob, type JobKind } from "./jobs.js";
import { nextDue } from "./scheduler.js";
import { redditConfigured } from "./sources.js";
import { getSettings, logEvent, now, saveSettings, SettingsSchema } from "./store.js";
import { textMatch } from "./verify.js";

/** Super admin → Marketing. Mounted at /api/super/marketing behind requireSuperAdmin. */
export const marketingRouter = Router();

const count = (sql: string, ...params: any[]) => one<{ n: number }>(sql, ...params)!.n;
const httpUrl = z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).optional();

marketingRouter.get("/overview", h(() => {
  const s = getSettings();
  const due = nextDue(s);
  const lastRuns = Object.fromEntries(all("SELECT * FROM marketing_runs WHERE id IN (SELECT MAX(id) FROM marketing_runs GROUP BY kind)").map((r) => [r.kind, r]));
  return {
    enabled: s.enabled,
    productName: s.product.name,
    aiAvailable: marketingAiAvailable(),
    redditReady: !s.sources.reddit || redditConfigured(),
    running: runningJob(),
    jobs: (Object.keys(JOB_LABELS) as JobKind[]).map((kind) => ({ kind, label: JOB_LABELS[kind], lastRun: lastRuns[kind] ?? null, nextDue: due[kind] })),
    totals: {
      pending: count("SELECT COUNT(*) AS n FROM marketing_drafts WHERE status = 'pending'"),
      posted: count("SELECT COUNT(*) AS n FROM marketing_drafts WHERE status = 'posted'"),
      postedWeek: count("SELECT COUNT(*) AS n FROM marketing_drafts WHERE status = 'posted' AND decided_at > ?", now() - WEEK),
      live: count("SELECT COUNT(*) AS n FROM marketing_drafts WHERE status = 'posted' AND live_status = 'live'"),
      removed: count("SELECT COUNT(*) AS n FROM marketing_drafts WHERE status = 'posted' AND live_status = 'removed'"),
      threads: count("SELECT COUNT(*) AS n FROM marketing_threads"),
      articles: count("SELECT COUNT(*) AS n FROM marketing_articles WHERE status = 'draft'"),
      promoRatio: promoRatio(s),
      maxPromoRatio: s.guardrails.maxPromoRatio,
    },
    removed: all(
      `SELECT d.id, d.community, d.posted_url, t.url AS thread_url, t.title FROM marketing_drafts d JOIN marketing_threads t ON t.id = d.thread_id
        WHERE d.status = 'posted' AND d.live_status = 'removed' ORDER BY d.last_checked DESC LIMIT 10`),
    events: all("SELECT * FROM marketing_events ORDER BY id DESC LIMIT 25"),
  };
}));

marketingRouter.post("/run/:kind", h((req) => {
  const kind = parse(z.enum(["scan", "verify", "blog"]), req.params.kind);
  return { started: startJob(kind, "manual"), running: runningJob() };
}));

marketingRouter.get("/events", h((req) => {
  const kind = String(req.query.kind ?? "all");
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  return all(
    `SELECT * FROM marketing_events WHERE id < ? AND (? = 'all' OR kind = ?) ORDER BY id DESC LIMIT 100`, before, kind, kind,
  );
}));

// ---------- Review queue ----------

marketingRouter.get("/drafts", h(() => all(
  `SELECT d.*, t.title, t.url AS thread_url, t.body AS thread_body, t.created_at AS thread_created_at
     FROM marketing_drafts d JOIN marketing_threads t ON t.id = d.thread_id
    WHERE d.status = 'pending' ORDER BY d.relevance DESC, d.created_at DESC`,
)));

marketingRouter.post("/drafts/:id", h((req) => {
  const body = parse(z.object({ action: z.enum(["posted", "skipped"]), reply: z.string().max(10000).optional(), postedUrl: httpUrl }), req.body);
  const d = one(`SELECT d.*, t.title, t.url AS thread_url FROM marketing_drafts d JOIN marketing_threads t ON t.id = d.thread_id WHERE d.id = ?`, req.params.id);
  if (!d || d.status !== "pending") throw notFound("Draft not found");
  run("UPDATE marketing_drafts SET status = ?, reply = ?, posted_url = ?, decided_at = ? WHERE id = ?",
    body.action, body.reply ?? d.reply, body.postedUrl || null, now(), d.id);
  logEvent(body.action, `You ${body.action} a reply in ${d.community} — ${d.title}`, { url: body.postedUrl || d.thread_url, level: body.action === "posted" ? "success" : "info" });
  // Look for the new comment right away (it's rechecked every few hours anyway).
  if (body.action === "posted") startJob("verify", "manual");
  return { ok: true };
}));

// ---------- Posted log ----------

marketingRouter.get("/posted", h(() => all(
  `SELECT d.*, t.title, t.url AS thread_url FROM marketing_drafts d JOIN marketing_threads t ON t.id = d.thread_id
    WHERE d.status = 'posted' ORDER BY d.decided_at DESC LIMIT 300`,
).map((d) => ({ ...d, match: textMatch(d.reply, d.live_text) }))));

marketingRouter.post("/posted/:id/link", h((req) => {
  const { postedUrl } = parse(z.object({ postedUrl: httpUrl }), req.body);
  const r = run("UPDATE marketing_drafts SET posted_url = ?, live_status = 'unverified', last_checked = NULL WHERE id = ? AND status = 'posted'", postedUrl || null, req.params.id);
  if (!r.changes) throw notFound("Posted reply not found");
  return { started: startJob("verify", "manual") };
}));

// ---------- Blog drafts ----------

marketingRouter.get("/articles", h(() => all("SELECT * FROM marketing_articles ORDER BY created_at DESC")));

marketingRouter.patch("/articles/:id", h((req) => {
  const body = parse(z.object({ status: z.enum(["draft", "published", "rejected"]), publishedUrl: httpUrl }), req.body);
  const a = one("SELECT title FROM marketing_articles WHERE id = ?", req.params.id);
  if (!a) throw notFound("Article not found");
  run("UPDATE marketing_articles SET status = ?, published_url = ? WHERE id = ?", body.status, body.publishedUrl || null, req.params.id);
  logEvent("article", `Article marked ${body.status}: ${a.title}`, { url: body.publishedUrl || null, level: body.status === "published" ? "success" : "info" });
  return { ok: true };
}));

// ---------- Settings ----------

marketingRouter.get("/settings", h(() => ({ settings: getSettings(), redditConfigured: redditConfigured(), aiAvailable: marketingAiAvailable() })));

marketingRouter.put("/settings", h((req) => {
  const s = parse(SettingsSchema, req.body);
  const was = getSettings().enabled;
  saveSettings(s);
  audit(actorOf(req.user), null, "marketing.settings_updated", { enabled: s.enabled });
  if (was !== s.enabled) logEvent("settings", `Marketing agent turned ${s.enabled ? "on" : "off"}`, { level: "info" });
  return { settings: getSettings() };
}));
