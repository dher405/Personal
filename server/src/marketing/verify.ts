import { all, run } from "../db.js";
import { getJson, reddit, redditConfigured, stripHtml } from "./sources.js";
import { logEvent, now, type MarketingSettings } from "./store.js";

/**
 * Finds your actual posted comments, stores a direct link to each, compares the live text with what you approved,
 * and keeps checking for 30 days. A reply that moderators removed is the earliest warning sign before a ban.
 */

const RECHECK_SECONDS = 6 * 3600;
const WATCH_DAYS = 30;

interface Found { status: "live" | "removed"; url?: string; text?: string; score?: number | null }

/** How closely the live text matches the approved draft, 0-100 (word overlap; ignores case and spacing). */
export function textMatch(drafted: string, live: string | null | undefined) {
  if (!live) return null;
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const a = words(drafted), b = words(live);
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const w of b) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of a) if ((counts.get(w) ?? 0) > 0) { common++; counts.set(w, counts.get(w)! - 1); }
  return Math.round((200 * common) / (a.length + b.length));
}

export async function verifyPosted(s: MarketingSettings, runId: number) {
  const rows = all(
    `SELECT d.*, t.url AS thread_url, t.title FROM marketing_drafts d JOIN marketing_threads t ON t.id = d.thread_id
      WHERE d.status = 'posted' AND d.live_status != 'removed' AND d.decided_at > ?
        AND (d.last_checked IS NULL OR d.last_checked < ?)`,
    now() - WATCH_DAYS * 86400, now() - RECHECK_SECONDS,
  );
  const counts = { live: 0, removed: 0, not_found: 0, error: 0 };
  for (const d of rows) {
    let found: Found | null;
    try {
      found = await locate(s, d);
    } catch (err) {
      counts.error++;
      logEvent("error", `Couldn't check your reply in ${d.community}: ${(err as Error).message} — ${d.title}`, { url: d.thread_url, level: "error", runId });
      continue;
    }
    const status = found?.status ?? "not_found";
    counts[status]++;
    run(
      `UPDATE marketing_drafts SET live_status = ?, posted_url = COALESCE(?, posted_url), live_text = COALESCE(?, live_text),
         live_score = COALESCE(?, live_score), last_checked = ? WHERE id = ?`,
      status, found?.url ?? null, found?.text ?? null, found?.score ?? null, now(), d.id,
    );
    if (status === "removed") {
      logEvent("removed", `Your reply was REMOVED in ${d.community} — ${d.title}`, { url: found?.url ?? d.thread_url, level: "error", runId });
    } else if (status === "live" && d.live_status !== "live") {
      const match = textMatch(d.reply, found!.text);
      logEvent("verified", `Verified live in ${d.community}${match === null ? "" : ` (text ${match}% match to the approved draft)`} — ${d.title}`, { url: found!.url, level: "success", runId });
    } else if (status === "not_found" && d.live_status === "unverified") {
      logEvent("not_found", `Couldn't find your reply in ${d.community} yet. Check your username under Marketing → Settings, or paste the link on the Posted log — ${d.title}`, { url: d.thread_url, level: "warn", runId });
    }
  }
  return `Checked ${rows.length}: ${counts.live} live, ${counts.removed} removed, ${counts.not_found} not found, ${counts.error} errors`;
}

async function locate(s: MarketingSettings, d: any): Promise<Found | null> {
  const [source, ...rest] = String(d.thread_id).split(":");
  if (source === "hn") return hackerNews(s.accounts.hnUsername, rest.join(":"), d.posted_url);
  if (source === "se") return stackExchange(rest[0], rest[1], s.accounts.stackexchangeUserIds[rest[0]], d.posted_url);
  if (source === "reddit") return redditComment(s.accounts.redditUsername, rest.join(":"), d.posted_url);
  return null;
}

async function hackerNews(username: string, objectId: string, postedUrl: string | null): Promise<Found | null> {
  let commentId = postedUrl?.match(/[?&]id=(\d+)/)?.[1];
  if (!commentId && username) {
    const params = new URLSearchParams({ tags: `comment,author_${username}`, hitsPerPage: "100" });
    const data = await getJson(`https://hn.algolia.com/api/v1/search_by_date?${params}`);
    commentId = (data.hits ?? []).find((h: any) => String(h.parent_id) === objectId || String(h.story_id) === objectId)?.objectID;
  }
  if (!commentId) return null;
  const item = (await getJson(`https://hacker-news.firebaseio.com/v0/item/${commentId}.json`)) ?? {};
  return { status: item.dead || item.deleted ? "removed" : "live", url: `https://news.ycombinator.com/item?id=${commentId}`, text: stripHtml(item.text), score: null };
}

const seDomain = (site: string) => (["stackoverflow", "superuser", "serverfault", "askubuntu"].includes(site) ? `${site}.com` : `${site}.stackexchange.com`);

async function stackExchange(site: string, questionId: string, userId: number | undefined, postedUrl: string | null): Promise<Found | null> {
  const data = await getJson(`https://api.stackexchange.com/2.3/questions/${questionId}/answers?${new URLSearchParams({ site, filter: "withbody", pagesize: "100" })}`);
  const m = postedUrl?.match(/\/a\/(\d+)|#(\d+)$/);
  const wanted = m ? Number(m[1] ?? m[2]) : null;
  const answer = (data.items ?? []).find((a: any) => (wanted ? a.answer_id === wanted : !!userId && a.owner?.user_id === userId));
  // A link you saved that no longer appears among the answers means it was deleted.
  if (!answer) return wanted ? { status: "removed", url: postedUrl! } : null;
  return { status: "live", url: `https://${seDomain(site)}/a/${answer.answer_id}`, text: stripHtml(answer.body), score: answer.score ?? null };
}

async function redditComment(username: string, postId: string, postedUrl: string | null): Promise<Found | null> {
  if (!redditConfigured()) throw new Error("Reddit app ID/secret aren't set (Super admin → Settings → Marketing agent)");
  let c: any = null;
  const fromLink = postedUrl?.match(/\/comments\/\w+\/[^/]*\/(\w+)/)?.[1];
  if (fromLink) {
    c = (await reddit(`/api/info?id=t1_${fromLink}`)).data?.children?.[0]?.data ?? null;
  } else if (username) {
    const data = await reddit(`/user/${encodeURIComponent(username)}/comments?limit=100`);
    c = (data.data?.children ?? []).map((x: any) => x.data).find((x: any) => x.link_id === `t3_${postId}`) ?? null;
  }
  if (!c) return null;
  const removed = c.body === "[removed]" || c.body === "[deleted]" || !!c.removed_by_category;
  return { status: removed ? "removed" : "live", url: `https://www.reddit.com${c.permalink}`, text: c.body, score: c.score ?? null };
}
