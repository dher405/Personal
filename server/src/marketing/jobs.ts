import { all, one, run } from "../db.js";
import { articleIdeas, assessAndDraft, writeArticle } from "./agent.js";
import { communityAllowed, mayMentionProduct, promoRatio, queueFull } from "./guardrails.js";
import { discover } from "./sources.js";
import { getSettings, logEvent, now, type MarketingSettings } from "./store.js";
import { verifyPosted } from "./verify.js";

export type JobKind = "scan" | "verify" | "blog";
export const JOB_LABELS: Record<JobKind, string> = { scan: "Scan for threads", verify: "Verify posted replies", blog: "Write a blog draft" };

let running: JobKind | null = null;
export const runningJob = () => running;

/**
 * Runs a job unless another is in progress (scheduled and "Run now" share this lock).
 * Returns false if busy. Every run is recorded in marketing_runs with a one-line summary.
 */
export async function runJob(kind: JobKind, trigger: "schedule" | "manual"): Promise<boolean> {
  if (running) return false;
  running = kind;
  const runId = Number(run("INSERT INTO marketing_runs (kind, trigger, started_at) VALUES (?,?,?)", kind, trigger, now()).lastInsertRowid);
  try {
    const s = getSettings();
    const summary = kind === "scan" ? await scan(s, runId) : kind === "verify" ? await verifyPosted(s, runId) : await blog(s, runId);
    run("UPDATE marketing_runs SET status = 'ok', finished_at = ?, summary = ? WHERE id = ?", now(), summary, runId);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logEvent("error", `${JOB_LABELS[kind]} failed: ${msg}`, { level: "error", runId });
    run("UPDATE marketing_runs SET status = 'error', finished_at = ?, summary = ? WHERE id = ?", now(), msg.slice(0, 500), runId);
  } finally {
    running = null;
  }
  return true;
}

/** Starts a job without waiting for it. */
export function startJob(kind: JobKind, trigger: "schedule" | "manual") {
  if (running) return false;
  runJob(kind, trigger).catch((err) => console.error("marketing job failed", err));
  return true;
}

async function scan(s: MarketingSettings, runId: number) {
  const ev = (kind: string, message: string, url?: string, level: "info" | "success" | "warn" | "error" = "info") => logEvent(kind, message, { url, level, runId });
  const candidates = await discover(s, (msg) => ev("error", msg, undefined, "warn"));
  const fresh = candidates.filter((c) => !one("SELECT 1 FROM marketing_threads WHERE id = ?", c.id));
  ev("found", `Found ${candidates.length} matching threads, ${fresh.length} new`);

  let drafted = 0, notFit = 0, skipped = 0, errors = 0;
  for (const c of fresh.slice(0, s.search.maxCandidatesPerRun)) {
    if (queueFull(s)) {
      ev("skipped", "Review queue is full; stopped drafting until you clear it", undefined, "warn");
      break;
    }
    run("INSERT INTO marketing_threads (id, source, community, title, body, url, created_at, fetched_at) VALUES (?,?,?,?,?,?,?,?)",
      c.id, c.source, c.community, c.title, c.body, c.url, c.createdAt, now());
    const blocked = communityAllowed(s, c.community);
    if (blocked) {
      run("UPDATE marketing_threads SET status = 'skipped' WHERE id = ?", c.id);
      ev("skipped", `Limit: ${blocked} — ${c.title}`, c.url);
      skipped++;
      continue;
    }
    let result;
    try {
      result = await assessAndDraft(s, c, mayMentionProduct(s));
    } catch (err) {
      run("UPDATE marketing_threads SET status = 'error' WHERE id = ?", c.id);
      ev("error", `Claude request failed: ${(err as Error).message}`, c.url, "error");
      errors++;
      continue;
    }
    if (!result || !result.relevant || result.relevance < s.ai.minRelevance || !result.reply.trim()) {
      run("UPDATE marketing_threads SET status = 'irrelevant' WHERE id = ?", c.id);
      const why = result ? `(${result.relevance}/10): ${result.reason}` : ": the model declined or the answer was cut off";
      ev("irrelevant", `Not a fit ${why} — ${c.title}`, c.url);
      notFit++;
      continue;
    }
    run(`INSERT INTO marketing_drafts (thread_id, community, relevance, reason, rules_risk, reply, mentions_product, blog_topic, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      c.id, c.community, result.relevance, result.reason, result.rules_risk, result.reply.trim(), result.mentions_product ? 1 : 0, result.blog_topic, now());
    run("UPDATE marketing_threads SET status = 'drafted' WHERE id = ?", c.id);
    ev("drafted", `Drafted a reply (${result.relevance}/10, ${result.mentions_product ? "mentions " + s.product.name : "pure help"}) — ${c.title}`, c.url);
    drafted++;
  }
  return `${fresh.length} new threads: ${drafted} drafted, ${notFit} not a fit, ${skipped} skipped by limits, ${errors} errors. ` +
    `${Math.round(promoRatio(s) * 100)}% of recent posts mention ${s.product.name}`;
}

const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

async function blog(s: MarketingSettings, runId: number) {
  const questions = all<{ title: string; blog_topic: string }>(
    `SELECT t.title, d.blog_topic FROM marketing_drafts d JOIN marketing_threads t ON t.id = d.thread_id ORDER BY d.created_at DESC LIMIT 60`,
  ).map((q) => q.title + (q.blog_topic ? ` (suggested article: ${q.blog_topic})` : ""));
  if (!questions.length) {
    logEvent("skipped", "No blog draft yet: articles are based on questions people asked, so run a scan first", { level: "warn", runId });
    return "skipped: no collected questions yet";
  }
  const existing = all<{ title: string }>("SELECT title FROM marketing_articles").map((a) => a.title);
  for (const idea of await articleIdeas(s, questions, existing, 1)) {
    const slug = slugify(idea.title);
    if (!slug || one("SELECT 1 FROM marketing_articles WHERE slug = ?", slug)) continue;
    const body = await writeArticle(s, idea);
    if (!body) continue;
    run("INSERT INTO marketing_articles (title, slug, body, created_at) VALUES (?,?,?,?)", idea.title, slug, body, now());
    logEvent("article", `Wrote a blog draft: ${idea.title}`, { level: "success", runId });
    return `Wrote "${idea.title}"`;
  }
  return "No new article (ideas repeated earlier ones, or the model declined)";
}
