import { z } from "zod";
import { config } from "../config.js";
import { db, one, run } from "../db.js";

/**
 * The marketing agent's own tables. Everything is prefixed marketing_ and nothing else in Slotwise reads
 * or writes them, so the agent can't affect bookings, businesses or billing.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS marketing_threads (
  id TEXT PRIMARY KEY,                 -- "<source>:<native id>", e.g. "reddit:abc123"
  source TEXT NOT NULL,
  community TEXT NOT NULL,             -- e.g. "reddit:smallbusiness"
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,         -- unix seconds, when the thread was posted
  fetched_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'   -- new | irrelevant | drafted | skipped | error
);
CREATE TABLE IF NOT EXISTS marketing_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES marketing_threads(id),
  community TEXT NOT NULL,
  relevance INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  rules_risk TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL,                 -- the text you approved, after your edits
  mentions_product INTEGER NOT NULL DEFAULT 0,
  blog_topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | posted | skipped
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  posted_url TEXT,                     -- direct link to your live comment/answer
  live_status TEXT NOT NULL DEFAULT 'unverified', -- unverified | live | removed | not_found
  live_text TEXT,                      -- what is actually on the page
  live_score INTEGER,
  last_checked INTEGER
);
CREATE TABLE IF NOT EXISTS marketing_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | rejected
  published_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                  -- scan | verify | blog
  trigger TEXT NOT NULL DEFAULT 'schedule', -- schedule | manual
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',   -- running | ok | error
  summary TEXT
);
CREATE TABLE IF NOT EXISTS marketing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id INTEGER,
  level TEXT NOT NULL,                 -- info | success | warn | error
  kind TEXT NOT NULL,                  -- found | drafted | irrelevant | skipped | posted | verified | removed | article | error ...
  message TEXT NOT NULL,
  url TEXT
);
CREATE INDEX IF NOT EXISTS marketing_drafts_status ON marketing_drafts(status, community);
CREATE INDEX IF NOT EXISTS marketing_events_kind ON marketing_events(kind, id);
`);

// A run that was in progress when the server restarted (every deploy) can never finish.
run("UPDATE marketing_runs SET status = 'error', finished_at = started_at, summary = 'interrupted by a server restart' WHERE status = 'running'");

export const now = () => Math.floor(Date.now() / 1000);

export function logEvent(kind: string, message: string, opts: { url?: string | null; level?: "info" | "success" | "warn" | "error"; runId?: number } = {}) {
  run("INSERT INTO marketing_events (ts, run_id, level, kind, message, url) VALUES (?,?,?,?,?,?)",
    now(), opts.runId ?? null, opts.level ?? "info", kind, message.slice(0, 1000), opts.url ?? null);
}

// ---------- Settings (Super admin → Marketing → Settings) ----------

const lines = z.array(z.string().trim().min(1).max(300)).max(50);
const SettingsSchema = z.object({
  enabled: z.boolean(),
  product: z.object({
    name: z.string().trim().min(1).max(80),
    url: z.url(),
    description: z.string().trim().min(20).max(3000),
    features: lines,
    idealCustomers: lines,
    notAGoodFitFor: lines,
    pricing: z.string().trim().max(300),
    disclosure: z.string().trim().min(5).max(300),
  }),
  search: z.object({
    queries: lines.min(1),
    maxThreadAgeDays: z.number().int().min(1).max(30),
    maxCandidatesPerRun: z.number().int().min(1).max(200),
  }),
  sources: z.object({
    hackernews: z.boolean(),
    stackexchange: z.boolean(),
    stackexchangeSites: lines,
    reddit: z.boolean(),
    subreddits: lines,
  }),
  accounts: z.object({
    redditUsername: z.string().trim().max(40),
    hnUsername: z.string().trim().max(40),
    /** Your numeric user id on each Stack Exchange site (it's in your profile URL). */
    stackexchangeUserIds: z.record(z.string(), z.number().int().nonnegative()),
  }),
  ai: z.object({
    model: z.string().trim().min(1).max(80),
    effort: z.enum(["low", "medium", "high"]),
    minRelevance: z.number().int().min(0).max(10),
  }),
  guardrails: z.object({
    maxDraftsPerCommunityPerWeek: z.number().int().min(1).max(50),
    maxPendingDrafts: z.number().int().min(1).max(200),
    promoWindow: z.number().int().min(1).max(200),
    maxPromoRatio: z.number().min(0).max(1),
    blockedCommunities: lines,
  }),
  schedule: z.object({
    scanEveryHours: z.number().min(0).max(168),
    verifyEveryHours: z.number().min(0).max(168),
    blogEveryDays: z.number().min(0).max(90),
  }),
  blog: z.object({ audience: z.string().trim().min(3).max(300) }),
});
export type MarketingSettings = z.infer<typeof SettingsSchema>;
export { SettingsSchema };

export function defaultSettings(): MarketingSettings {
  return {
    enabled: false,
    product: {
      name: "Slotwise",
      url: config.webUrl,
      description:
        "Slotwise is an online booking platform for service businesses such as salons, tutors, music teachers and trainers. " +
        "A business publishes its services, staff and open times, and customers book and pay online, in the mobile app, " +
        "or by chatting with an AI booking assistant. It sends text reminders and syncs with Google and Outlook calendars.",
      features: [
        "Booking page per business, plus an embeddable booking widget for the business's own website",
        "Staff schedules, time off, buffers, minimum notice and cancellation windows",
        "Online payments and deposits through the business's own Stripe, Square or PayPal account",
        "Text message confirmations and reminders; customers can reply to confirm, reschedule or cancel",
        "Google Calendar and Outlook Calendar sync",
        "Optional AI assistant that books, reschedules and cancels by chat",
        "Online appointments with meeting links",
      ],
      idealCustomers: [
        "Salons, barbers and beauty professionals",
        "Tutors, music teachers and coaches",
        "Personal trainers and studios",
        "Small appointment-based service businesses with one or a few staff",
      ],
      notAGoodFitFor: [
        "Large enterprises needing complex resource or room scheduling",
        "Restaurants needing table reservations",
        "Event ticketing",
      ],
      pricing: "",
      disclosure: "(Disclosure: I'm the founder of Slotwise.)",
    },
    search: {
      queries: ["booking app for salon", "appointment scheduling software", "calendly alternative", "online booking system small business", "scheduling app for tutors"],
      maxThreadAgeDays: 3,
      maxCandidatesPerRun: 30,
    },
    sources: {
      hackernews: true,
      stackexchange: true,
      stackexchangeSites: ["webapps", "softwarerecs", "freelancing"],
      reddit: true,
      subreddits: ["smallbusiness", "Entrepreneur", "salons", "Hairstylist", "personaltraining", "tutor", "musicteachers"],
    },
    accounts: { redditUsername: "", hnUsername: "", stackexchangeUserIds: {} },
    ai: { model: "claude-opus-5-5", effort: "medium", minRelevance: 7 },
    guardrails: { maxDraftsPerCommunityPerWeek: 2, maxPendingDrafts: 15, promoWindow: 20, maxPromoRatio: 0.3, blockedCommunities: [] },
    schedule: { scanEveryHours: 12, verifyEveryHours: 6, blogEveryDays: 7 },
    blog: { audience: "owners of small appointment-based service businesses" },
  };
}

const KEY = "marketing:settings";

/** Saved settings merged over the defaults, so settings added in later versions get sensible values. */
export function getSettings(): MarketingSettings {
  const d = defaultSettings();
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = ?", KEY);
  if (!row) return d;
  try {
    const saved = JSON.parse(row.value);
    const merged: any = { ...d, ...saved };
    for (const k of Object.keys(d) as (keyof MarketingSettings)[]) {
      if (typeof d[k] === "object" && !Array.isArray(d[k])) merged[k] = { ...(d[k] as object), ...(saved[k] ?? {}) };
    }
    const parsed = SettingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : d;
  } catch {
    return d;
  }
}

export function saveSettings(s: MarketingSettings) {
  run("INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", KEY, JSON.stringify(s));
}
