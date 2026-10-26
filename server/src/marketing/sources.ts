import { config } from "../config.js";
import type { MarketingSettings } from "./store.js";

/**
 * Read-only discovery of threads where people ask for booking/scheduling help, through each site's free
 * official API. Nothing in the marketing agent posts anywhere: you post every reply yourself.
 */

export interface Candidate {
  id: string;
  source: "hackernews" | "stackexchange" | "reddit";
  community: string;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  /** The community's rules, when the site exposes them, so drafts can respect them. */
  rules: string;
}

const UA = "slotwise-marketing-agent/1.0 (read-only)";

export const stripHtml = (s?: string | null) =>
  (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, "/").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

async function hackernews(queries: string[], since: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const q of queries) {
    const params = new URLSearchParams({ query: q, tags: "(story,comment)", numericFilters: `created_at_i>${since}`, hitsPerPage: "20" });
    const data = await getJson(`https://hn.algolia.com/api/v1/search_by_date?${params}`);
    for (const hit of data.hits ?? []) {
      const comment = !!hit.comment_text;
      out.push({
        id: `hn:${hit.objectID}`, source: "hackernews", community: "hackernews",
        title: hit.title || `Comment on: ${hit.story_title ?? ""}`,
        body: stripHtml(comment ? hit.comment_text : hit.story_text),
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        createdAt: hit.created_at_i,
        rules: "Hacker News guidelines: no promotion or marketing-speak. A link to your own product is tolerated only when it's genuinely on-topic, and you should say it's yours.",
      });
    }
  }
  return out;
}

async function stackexchange(queries: string[], sites: string[], since: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const site of sites) {
    for (const q of queries) {
      const params = new URLSearchParams({ order: "desc", sort: "creation", q, site, fromdate: String(since), filter: "withbody", pagesize: "10" });
      const data = await getJson(`https://api.stackexchange.com/2.3/search/advanced?${params}`);
      for (const it of data.items ?? []) {
        if (it.closed_date) continue;
        out.push({
          id: `se:${site}:${it.question_id}`, source: "stackexchange", community: `stackexchange:${site}`,
          title: stripHtml(it.title), body: stripHtml(it.body), url: it.link, createdAt: it.creation_date,
          rules: "Stack Exchange: an answer must directly answer the question, and any affiliation with a product you recommend MUST be disclosed in the answer.",
        });
      }
      // Stack Exchange asks clients to wait when it sends `backoff`; ignoring it gets the IP throttled.
      await new Promise((r) => setTimeout(r, ((data.backoff ?? 0) + 0.2) * 1000));
    }
  }
  return out;
}

// ---------- Reddit (app-only OAuth: read-only, no user login) ----------

let redditToken: { token: string; expires: number; id: string } | null = null;

export function redditConfigured() {
  return !!(config.marketing.redditClientId && config.marketing.redditClientSecret);
}

export async function reddit(path: string): Promise<any> {
  const { redditClientId: id, redditClientSecret: secret } = config.marketing;
  if (!redditToken || redditToken.expires < Date.now() || redditToken.id !== id) {
    const data = await getJson("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!data.access_token) throw new Error("Reddit didn't accept the app ID/secret");
    redditToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000, id };
  }
  return getJson(`https://oauth.reddit.com${path}`, { headers: { Authorization: `Bearer ${redditToken.token}` } });
}

async function redditThreads(subreddits: string[], queries: string[], since: number, onError: (msg: string) => void): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const name of subreddits) {
    let rules = "";
    try {
      const data = await reddit(`/r/${encodeURIComponent(name)}/about/rules`);
      rules = (data.rules ?? []).map((r: any) => `- ${r.short_name}: ${r.description}`).join("\n") || "(no rules listed)";
    } catch (err) {
      onError(`Couldn't read the rules of r/${name} (${(err as Error).message}); skipped it`);
      continue;
    }
    const seen = new Set<string>();
    for (const q of queries) {
      const params = new URLSearchParams({ q, restrict_sr: "1", sort: "new", t: "week", limit: "10" });
      const data = await reddit(`/r/${encodeURIComponent(name)}/search?${params}`);
      for (const { data: p } of data.data?.children ?? []) {
        if (seen.has(p.id) || p.created_utc < since || p.locked || p.archived) continue;
        seen.add(p.id);
        out.push({
          id: `reddit:${p.id}`, source: "reddit", community: `reddit:${name.toLowerCase()}`,
          title: p.title, body: p.selftext ?? "", url: `https://www.reddit.com${p.permalink}`,
          createdAt: Math.floor(p.created_utc), rules,
        });
      }
    }
  }
  return out;
}

/** Every recent matching thread from the enabled sources, newest first. One source failing doesn't stop the others. */
export async function discover(s: MarketingSettings, onError: (msg: string) => void): Promise<Candidate[]> {
  const since = Math.floor(Date.now() / 1000) - s.search.maxThreadAgeDays * 86400;
  const q = s.search.queries;
  const jobs: [string, boolean, () => Promise<Candidate[]>][] = [
    ["Hacker News", s.sources.hackernews, () => hackernews(q, since)],
    ["Stack Exchange", s.sources.stackexchange, () => stackexchange(q, s.sources.stackexchangeSites, since)],
    ["Reddit", s.sources.reddit, async () => {
      if (!redditConfigured()) { onError("Reddit is on but has no app ID/secret (Super admin → Settings → Marketing agent); skipped"); return []; }
      return redditThreads(s.sources.subreddits, q, since, onError);
    }],
  ];
  const found = new Map<string, Candidate>();
  for (const [name, enabled, job] of jobs) {
    if (!enabled) continue;
    try {
      for (const c of await job()) found.set(c.id, c);
    } catch (err) {
      onError(`${name} search failed: ${(err as Error).message}`);
    }
  }
  return [...found.values()].sort((a, b) => b.createdAt - a.createdAt);
}
