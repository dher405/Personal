import { one } from "../db.js";
import { startJob, type JobKind } from "./jobs.js";
import { getSettings, now, type MarketingSettings } from "./store.js";

/** Seconds between runs of each job; 0 = never runs on its own. */
export function intervals(s: MarketingSettings): Record<JobKind, number> {
  return {
    scan: s.schedule.scanEveryHours * 3600,
    verify: s.schedule.verifyEveryHours * 3600,
    blog: s.schedule.blogEveryDays * 86400,
  };
}

/** When each job next runs on its own (unix seconds), or null when the agent is off or the job isn't scheduled. */
export function nextDue(s: MarketingSettings): Record<JobKind, number | null> {
  const every = intervals(s);
  const out = {} as Record<JobKind, number | null>;
  for (const kind of Object.keys(every) as JobKind[]) {
    const last = one<{ t: number | null }>("SELECT MAX(started_at) AS t FROM marketing_runs WHERE kind = ?", kind)!.t;
    out[kind] = s.enabled && every[kind] ? (last ? last + every[kind] : now()) : null;
  }
  return out;
}

/** Starts at most one due job per tick. Due times come from the database, so deploys and restarts don't double up. */
export function tick() {
  const s = getSettings();
  if (!s.enabled) return null;
  const due = Object.entries(nextDue(s)).find(([, t]) => t !== null && t <= now());
  if (due && startJob(due[0] as JobKind, "schedule")) return due[0];
  return null;
}

export function startMarketingScheduler() {
  setInterval(() => {
    try { tick(); } catch (err) { console.error("marketing scheduler failed", err); }
  }, 5 * 60_000).unref();
}
