import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { all, audit, one, run } from "../db.js";
import { actorOf } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { marketingAiAvailable } from "./agent.js";
import { promoRatio, WEEK } from "./guardrails.js";
import { renderMarkdown } from "./blog.js";
import { DIRECTORIES, directory, startListing } from "./directories.js";
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
      articlesOnSite: count("SELECT COUNT(*) AS n FROM marketing_articles WHERE status = 'published' AND on_site = 1"),
      directoriesLive: count("SELECT COUNT(*) AS n FROM marketing_directories WHERE status = 'live'"),
      directoriesSubmitted: count("SELECT COUNT(*) AS n FROM marketing_directories WHERE status IN ('submitted','live')"),
      directoriesTotal: DIRECTORIES.length,
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

/** The article as it will look on the blog (same renderer), for previewing edits before saving. */
marketingRouter.post("/articles/preview", h((req) => {
  const { body } = parse(z.object({ body: z.string().max(200_000) }), req.body);
  return { html: renderMarkdown(body) };
}));

/** Saves your edits to an article's title, description or text. A published article updates on the site straight away. */
marketingRouter.patch("/articles/:id", h((req) => {
  const body = parse(z.object({ title: z.string().trim().min(3).max(200), description: z.string().trim().max(300), body: z.string().min(20).max(200_000) }), req.body);
  const r = run("UPDATE marketing_articles SET title = ?, description = ?, body = ?, updated_at = ? WHERE id = ?", body.title, body.description, body.body, now(), req.params.id);
  if (!r.changes) throw notFound("Article not found");
  return one("SELECT * FROM marketing_articles WHERE id = ?", req.params.id);
}));

/**
 * publish_site: live at /blog/<slug> on this website. publish_external: you posted it somewhere else (give the URL).
 * unpublish: back to draft (taken off the site). reject: you don't want it.
 */
marketingRouter.post("/articles/:id/status", h((req) => {
  const body = parse(z.object({ action: z.enum(["publish_site", "publish_external", "unpublish", "reject"]), publishedUrl: httpUrl }), req.body);
  const a = one("SELECT * FROM marketing_articles WHERE id = ?", req.params.id);
  if (!a) throw notFound("Article not found");
  const siteUrl = `${config.webUrl}/blog/${a.slug}`;
  if (body.action === "publish_site") {
    run("UPDATE marketing_articles SET status = 'published', on_site = 1, published_url = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?", siteUrl, now(), now(), a.id);
    logEvent("article", `Published on your site: ${a.title}`, { url: siteUrl, level: "success" });
  } else if (body.action === "publish_external") {
    if (!body.publishedUrl) throw badRequest("Add the address where you published it");
    run("UPDATE marketing_articles SET status = 'published', on_site = 0, published_url = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?", body.publishedUrl, now(), now(), a.id);
    logEvent("article", `Marked published elsewhere: ${a.title}`, { url: body.publishedUrl, level: "success" });
  } else {
    const status = body.action === "reject" ? "rejected" : "draft";
    run("UPDATE marketing_articles SET status = ?, on_site = 0, published_url = NULL, updated_at = ? WHERE id = ?", status, now(), a.id);
    logEvent("article", `${body.action === "reject" ? "Rejected" : "Unpublished"}: ${a.title}`, { level: "info" });
  }
  return one("SELECT * FROM marketing_articles WHERE id = ?", a.id);
}));

// ---------- Directory kit ----------

marketingRouter.get("/directories", h(() => {
  const rows = new Map(all("SELECT * FROM marketing_directories").map((r) => [r.id, r]));
  return DIRECTORIES.map((d) => {
    const r = rows.get(d.id);
    return { ...d, status: r?.status ?? "todo", copy: r?.copy ? JSON.parse(r.copy) : null, listingUrl: r?.listing_url ?? null,
      notes: r?.notes ?? "", error: r?.error ?? null, submittedAt: r?.submitted_at ?? null, updatedAt: r?.updated_at ?? null };
  });
}));

marketingRouter.post("/directories/:id/write", h((req) => {
  const d = directory(String(req.params.id));
  if (!d) throw notFound("Unknown directory");
  const { instruction } = parse(z.object({ instruction: z.string().trim().max(500).optional() }), req.body ?? {});
  return { started: startListing(d, instruction || undefined) };
}));

/** Your edits to the copy, where you submitted it, and how far it's got. */
marketingRouter.patch("/directories/:id", h((req) => {
  const d = directory(String(req.params.id));
  if (!d) throw notFound("Unknown directory");
  const body = parse(z.object({
    status: z.enum(["todo", "ready", "submitted", "live", "skipped"]).optional(),
    listingUrl: httpUrl,
    notes: z.string().max(2000).optional(),
    copy: z.record(z.string(), z.string().max(20000)).optional(),
  }), req.body);
  const r = one("SELECT * FROM marketing_directories WHERE id = ?", d.id);
  if (r?.status === "drafting") throw badRequest("The agent is still writing this listing");
  const status = body.status ?? r?.status ?? "todo";
  const listingUrl = body.listingUrl === undefined ? r?.listing_url ?? null : body.listingUrl || null;
  run(`INSERT INTO marketing_directories (id, status, copy, listing_url, notes, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, copy = excluded.copy, listing_url = excluded.listing_url,
         notes = excluded.notes, submitted_at = excluded.submitted_at, updated_at = excluded.updated_at`,
    d.id, status, body.copy ? JSON.stringify(body.copy) : r?.copy ?? null, listingUrl, body.notes ?? r?.notes ?? "",
    ["submitted", "live"].includes(status) ? r?.submitted_at ?? now() : null, now());
  if (body.status && body.status !== r?.status && ["submitted", "live", "skipped"].includes(body.status)) {
    const verb = { submitted: "Submitted to", live: "Listing live on", skipped: "Skipped" }[body.status as "submitted" | "live" | "skipped"];
    logEvent("directory", `${verb} ${d.name}`, { url: listingUrl ?? d.url, level: body.status === "skipped" ? "info" : "success" });
  }
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
