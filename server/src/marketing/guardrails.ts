import { all, one } from "../db.js";
import { now, type MarketingSettings } from "./store.js";

/** Rules that keep the account looking (and being) like a helpful person, not a spammer. */

export const WEEK = 7 * 86400;

export function communityAllowed(s: MarketingSettings, community: string): string | null {
  if (s.guardrails.blockedCommunities.map((c) => c.toLowerCase()).includes(community.toLowerCase())) return "community is blocked in settings";
  const n = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM marketing_drafts WHERE community = ? AND status IN ('pending','posted') AND created_at > ?",
    community, now() - WEEK,
  )!.n;
  return n >= s.guardrails.maxDraftsPerCommunityPerWeek ? `already ${n} drafts for ${community} this week` : null;
}

export function queueFull(s: MarketingSettings) {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM marketing_drafts WHERE status = 'pending'")!.n >= s.guardrails.maxPendingDrafts;
}

/** Share of your most recent posted replies that mentioned the product. */
export function promoRatio(s: MarketingSettings) {
  const rows = all<{ m: number }>(
    "SELECT mentions_product AS m FROM marketing_drafts WHERE status = 'posted' ORDER BY decided_at DESC LIMIT ?", s.guardrails.promoWindow,
  );
  return rows.length ? rows.reduce((t, r) => t + r.m, 0) / rows.length : 0;
}

/** False once too many recent posts mentioned the product; new drafts are then pure help. */
export const mayMentionProduct = (s: MarketingSettings) => promoRatio(s) < s.guardrails.maxPromoRatio;
