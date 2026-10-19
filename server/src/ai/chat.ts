import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { newId, one, run, Row } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import type { AuthUser } from "../lib/auth.js";
import { toolsFor, type AiTool, type ToolContext } from "./tools.js";
import { hasCapacity, recordUse } from "../lib/usage.js";
import { HttpError } from "../lib/errors.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;

// Rebuilt when the key changes on Super admin → Settings.
let client: { key: string; sdk: Anthropic } | null = null;
const anthropic = () => {
  if (client?.key !== config.ai.apiKey) client = { key: config.ai.apiKey, sdk: new Anthropic({ apiKey: config.ai.apiKey }) };
  return client.sdk;
};

export const aiAvailable = () => !!config.ai.apiKey;

function toApiTool(t: AiTool): Anthropic.Beta.BetaTool {
  const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, input_schema: schema as Anthropic.Beta.BetaTool.InputSchema };
}

// Kept stable per business so the prompt prefix caches; the current time goes in each user turn instead.
function systemPrompt(kind: "customer" | "admin", business: Row) {
  const shared = [
    `Business: ${business.name}${business.category ? ` (${business.category})` : ""}`,
    business.description && `About: ${business.description}`,
    business.address && `Address: ${business.address}`,
    business.phone && `Phone: ${business.phone}`,
    `Timezone: ${business.timezone}. Always state times in this timezone in a friendly format; tools take and return UTC ISO strings.`,
    `Cancellation policy: customers can cancel or reschedule online up to ${business.cancellation_hours} hours before.`,
  ].filter(Boolean).join("\n");

  if (kind === "admin") {
    return `You are the scheduling assistant for the staff and owners of ${business.name}. You help them review their calendar, ` +
      `move or cancel appointments, create bookings for customers, block time off, and adjust service prices.\n\n${shared}\n\n` +
      `Before changing a price, cancelling, or overriding availability (force=true), restate what you will do and get a yes. ` +
      `You cannot issue refunds; point the admin to the Bookings screen for that. Keep replies short.`;
  }
  return `You are the friendly booking assistant for ${business.name}, chatting with customers on its booking page. ` +
    `Help them pick a service or lesson, find a time that works, and book, reschedule, or cancel.\n\n${shared}\n\n` +
    `Guidelines:\n- Use the tools for every service, price and availability fact; never invent times.\n` +
    `- Offer a few concrete options rather than long lists.\n` +
    `- Before booking, collect the customer's name and email (phone optional), then summarize service, time, staff and price and get an explicit yes.\n` +
    (business.sms_enabled ? `- If they give a phone number, ask whether they'd like text reminders and only set sms_opt_in if they say yes.\n` : "") +
    `- To change an existing booking you need the booking code and the email used to book.\n` +
    `- If payment is required, share the payment link and explain the time is held for 30 minutes.\n` +
    `- Stay on the topic of this business's appointments; politely decline unrelated requests.\n` +
    (business.ai_instructions ? `\nInstructions from the business owner:\n${business.ai_instructions}` : "");
}

export interface ChatResult {
  sessionId: string;
  reply: string;
  events: ToolContext["events"];
}

const MAX_TOOL_ROUNDS = 8;

export async function chat(opts: {
  kind: "customer" | "admin";
  business: Row;
  sessionId?: string;
  message: string;
  admin?: AuthUser;
  /** SMS replies must be short plain text; context says who is texting and about which booking. */
  channel?: "web" | "sms";
  context?: string;
}): Promise<ChatResult> {
  if (!aiAvailable()) throw badRequest("AI chat is not configured on this server (ANTHROPIC_API_KEY)");
  const { kind, business } = opts;
  if (!hasCapacity(business, "ai")) {
    throw new HttpError(403, kind === "admin"
      ? "This month's AI assistant messages are used up. Add more or upgrade under Plan & billing."
      : "Chat isn't available right now. You can still book using the calendar on this page.");
  }

  let session = opts.sessionId ? one("SELECT * FROM chat_sessions WHERE id = ? AND business_id = ? AND kind = ?", opts.sessionId, business.id, kind) : undefined;
  if (opts.sessionId && !session) throw notFound("Chat session not found");
  if (session && kind === "admin" && session.user_id !== opts.admin?.id) throw notFound("Chat session not found");
  if (!session) {
    const id = newId("chat");
    run("INSERT INTO chat_sessions (id, business_id, kind, user_id) VALUES (?,?,?,?)", id, business.id, kind, opts.admin?.id ?? null);
    session = one("SELECT * FROM chat_sessions WHERE id = ?", id)!;
  }

  // History is append-only: assistant turns (including thinking blocks) are stored exactly as returned.
  const messages: MessageParam[] = JSON.parse(session.messages);
  const now = DateTime.now().setZone(business.timezone).toFormat("cccc, LLLL d yyyy, h:mm a ZZZZ");
  messages.push({
    role: "user",
    content: [
      { type: "text", text: `[Current date/time at the business: ${now}]` },
      ...(opts.channel === "sms"
        ? [{ type: "text" as const, text: "[Channel: SMS text message. Reply in plain text under 320 characters, no markdown.]" }]
        : []),
      ...(opts.context ? [{ type: "text" as const, text: `[${opts.context}]` }] : []),
      { type: "text", text: opts.message.slice(0, 4000) },
    ],
  });

  const tools = toolsFor(kind);
  const apiTools = tools.map(toApiTool);
  const ctx: ToolContext = { business, admin: opts.admin, events: [] };
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic().beta.messages.create({
      model: config.ai.model,
      max_tokens: 16000,
      system: systemPrompt(kind, business),
      tools: apiTools,
      messages,
      output_config: { effort: config.ai.effort },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) reply = text;

    if (response.stop_reason === "refusal") {
      reply = "Sorry, I can't help with that here. I can help you book, move, or cancel an appointment.";
      break;
    }
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const def = tools.find((t) => t.name === block.name);
      try {
        if (!def) throw new Error(`Unknown tool ${block.name}`);
        const input = def.schema.parse(block.input);
        const output = await def.run(input, ctx);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output ?? { ok: true }) });
      } catch (err) {
        const message = err instanceof z.ZodError ? `Invalid input: ${z.prettifyError(err)}` : (err as Error).message;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Hitting the round cap leaves tool results as the last turn; close it so the next user turn is valid.
  if (messages[messages.length - 1].role === "user") {
    messages.push({ role: "assistant", content: [{ type: "text", text: reply || "Let me know how you'd like to continue." }] });
  }

  run("UPDATE chat_sessions SET messages = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(messages), session.id);
  recordUse(business, "ai", `${session.id}:${messages.length}`); // one use per message answered
  return { sessionId: session.id, reply: reply || "Done.", events: ctx.events };
}
