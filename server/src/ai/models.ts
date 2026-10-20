import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * Anthropic's Models API lists the models this key can use, with their capabilities, but not their prices.
 * Prices come from this table (Anthropic's published per-million-token rates, first-party API, as of
 * October 2026); a model that isn't here is still listed, as "price not listed". Update it when prices change.
 */
const PRICES: Record<string, { input: number; output: number; note?: string }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, note: "$0.50 / $2.50 for prompts over 100K tokens" },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * A booking-chat reply sends the system prompt, tool definitions and conversation so far, and gets a short answer:
 * roughly 5,000 tokens in and 500 out (less once prompt caching kicks in). Used only for the rough cost shown to the super admin.
 */
const TYPICAL_REPLY = { input: 5_000, output: 500 };

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). Others reject the parameter. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
export const supportsFallback = (model: string) => FALLBACK_MODELS.has(model);

export interface ModelChoice {
  id: string;
  name: string;
  releasedAt: string;
  price: { input: number; output: number; note?: string } | null;
  /** Rough cost of 1,000 booking-chat replies on this model, in dollars. */
  per1000Replies: number | null;
  effortLevels: string[];
}

type Caps = Record<string, any> | undefined;
const capsCache = new Map<string, { caps: Caps; at: number }>();

const effortLevelsOf = (caps: Caps) =>
  caps?.effort?.supported ? ["low", "medium", "high", "xhigh", "max"].filter((l) => caps.effort?.[l]?.supported) : [];

/** Fresh list from the Models API on every call (the settings page loads it each visit), newest first. */
export async function listModels(apiKey = config.ai.apiKey): Promise<ModelChoice[]> {
  if (!apiKey) throw new Error("Save an Anthropic API key first, then the list of models appears here.");
  const client = new Anthropic({ apiKey });
  const out: ModelChoice[] = [];
  for await (const m of client.models.list()) {
    const caps = (m as any).capabilities as Caps;
    capsCache.set(m.id, { caps, at: Date.now() });
    const price = PRICES[m.id] ?? null;
    out.push({
      id: m.id, name: m.display_name ?? m.id, releasedAt: m.created_at, price,
      per1000Replies: price ? Math.round(((TYPICAL_REPLY.input * price.input + TYPICAL_REPLY.output * price.output) / 1000) * 100) / 100 : null,
      effortLevels: effortLevelsOf(caps),
    });
  }
  return out.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}

/**
 * The effort level to send for this model: the configured one if the model supports it, else none.
 * Capabilities come from the Models API (cached for an hour); if they can't be fetched, the setting is sent as is.
 */
export async function effortFor(client: Anthropic, model: string, wanted: string): Promise<string | undefined> {
  let entry = capsCache.get(model);
  if (!entry || Date.now() - entry.at > 3_600_000) {
    try {
      const m = await client.models.retrieve(model);
      entry = { caps: (m as any).capabilities, at: Date.now() };
      capsCache.set(model, entry);
    } catch {
      return wanted;
    }
  }
  if (!entry.caps) return wanted;
  const levels = effortLevelsOf(entry.caps);
  return levels.includes(wanted) ? wanted : levels.length ? levels[0] : undefined;
}
