import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DateTime } from "luxon";

const effort = (levels: string[]) => ({ supported: levels.length > 0, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((l) => [l, { supported: levels.includes(l) }])) });
const MODELS = [
  { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z", capabilities: { effort: effort(["low", "medium", "high", "xhigh", "max"]) } },
  { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-09-15T00:00:00Z", capabilities: { effort: effort(["low", "medium", "high", "xhigh", "max"]) } },
  { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", capabilities: { effort: effort([]) } },
  { type: "model", id: "claude-future-9", display_name: "Claude Future 9", created_at: "2027-01-01T00:00:00Z", capabilities: { effort: effort(["medium"]) } },
];

// A stand-in for the Messages API: first call asks for a tool, second call answers in text.
const requests: any[] = [];
let fake: Server;
const fakeReady = new Promise<string>((resolve) => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Models API: what the key can use, with capabilities (Haiku 4.5 has no effort setting).
      const url = new URL(req.url!, "http://x");
      if (req.method === "GET" && url.pathname.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        const id = url.pathname.split("/v1/models/")[1];
        const found = id ? MODELS.find((m) => m.id === id) : null;
        if (id && !found) { res.statusCode = 404; return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model: ${id}` } })); }
        return res.end(JSON.stringify(found ?? { data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS.at(-1)!.id }));
      }
      const parsed = JSON.parse(body);
      requests.push({ body: parsed, beta: req.headers["anthropic-beta"] });
      const last = parsed.messages.at(-1);
      const isToolResult = Array.isArray(last.content) && last.content[0]?.type === "tool_result";
      const content = isToolResult
        ? [{ type: "text", text: "We offer piano, guitar and voice lessons." }]
        : [{ type: "tool_use", id: "toolu_1", name: "list_services", input: {} }];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `msg_${requests.length}`, type: "message", role: "assistant", model: parsed.model, content,
        stop_reason: isToolResult ? "end_turn" : "tool_use", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }));
    });
  }).listen(0, () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
});

process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ANTHROPIC_BASE_URL = await fakeReady;

const { seed } = await import("../src/seed.js");
const { one } = await import("../src/db.js");
const { chat } = await import("../src/ai/chat.js");
const { toolsFor } = await import("../src/ai/tools.js");

let business: any;
before(async () => {
  await seed();
  business = one("SELECT * FROM businesses WHERE slug = 'riverside-music'");
});
after(() => fake.close());

test("chat loop runs tools, sends fallbacks, and persists append-only history", async () => {
  const first = await chat({ kind: "customer", business, message: "What lessons do you have?" });
  assert.equal(first.reply, "We offer piano, guitar and voice lessons.");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.model, "claude-opus-5-5");
  assert.equal(requests[0].body.fallbacks, "default");
  assert.match(requests[0].beta, /server-side-fallback-2026-07-01/);
  assert.ok(requests[0].body.tools.some((t: any) => t.name === "book_appointment"));
  const toolResult = requests[1].body.messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, "toolu_1");
  assert.ok(JSON.parse(toolResult.content).length === 5);

  await chat({ kind: "customer", business, sessionId: first.sessionId, message: "Thanks" });
  const history = requests.at(-1).body.messages;
  // user, assistant(tool_use), user(tool_result), assistant(text), user — prior turns resent unchanged
  assert.deepEqual(history.slice(0, 4).map((m: any) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(history[1].content, [{ type: "tool_use", id: "toolu_1", name: "list_services", input: {} }]);
});

test("customer tools: find times, book, then reschedule only with matching code + email", async () => {
  const tools = Object.fromEntries(toolsFor("customer").map((t) => [t.name, t]));
  const ctx = { business, events: [] as any[] };
  const services = (await tools.list_services.run({}, ctx)) as any[];
  const trial = services.find((s) => s.name === "Free trial lesson");

  let day = DateTime.now().setZone(business.timezone).plus({ days: 3 });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  const found = (await tools.find_available_times.run({ service_id: trial.service_id, date_from: day.toISODate() }, ctx)) as any;
  assert.ok(found.slots.length > 2);

  const [a, , b] = found.slots;
  const booked = (await tools.book_appointment.run({
    service_id: trial.service_id, staff_id: a.staff_id, start_utc: a.start_utc, customer_name: "Ria", customer_email: "ria@example.com",
  }, ctx)) as any;
  assert.equal(booked.status, "confirmed"); // free service → no payment step
  assert.equal(ctx.events[0].type, "booking_created");

  await assert.rejects(
    async () => tools.reschedule_booking.run({ booking_code: booked.booking_code, email: "someone@else.com", new_start_utc: b.start_utc }, ctx),
    /No booking matches/,
  );
  const moved = (await tools.reschedule_booking.run({ booking_code: booked.booking_code, email: "RIA@example.com", new_start_utc: b.start_utc, staff_id: b.staff_id }, ctx)) as any;
  assert.equal(moved.start_utc, DateTime.fromISO(b.start_utc).toUTC().toISO());
});

test("admin tools exclude refunds", () => {
  const names = toolsFor("admin").map((t) => t.name);
  assert.ok(names.includes("update_service") && names.includes("reschedule_booking"));
  assert.ok(!names.some((n) => n.includes("refund")));
});

test("model list: live from the Models API, newest first, with prices and a rough cost per 1,000 replies", async () => {
  const { listModels } = await import("../src/ai/models.js");
  const models = await listModels();
  assert.deepEqual(models.map((m) => m.id), ["claude-future-9", "claude-haiku-5-5", "claude-opus-5-5", "claude-haiku-4-5"]);
  const haiku = models.find((m) => m.id === "claude-haiku-5-5")!;
  assert.deepEqual([haiku.price!.input, haiku.price!.output], [0.1, 0.5]);
  assert.equal(haiku.per1000Replies, 0.75);
  assert.equal(models.find((m) => m.id === "claude-opus-5-5")!.per1000Replies, 30);
  assert.equal(models.find((m) => m.id === "claude-future-9")!.price, null, "unknown models are listed without a price");
  assert.deepEqual(models.find((m) => m.id === "claude-haiku-4-5")!.effortLevels, []);
});

test("each model gets only the options it accepts", async () => {
  const { saveSettings } = await import("../src/lib/platformSettings.js");
  const lastRequest = () => requests.at(-1).body;
  try {
    saveSettings({ AI_MODEL: "claude-haiku-5-5" });
    await chat({ kind: "customer", business, message: "Hi" });
    assert.equal(lastRequest().model, "claude-haiku-5-5");
    assert.equal(lastRequest().fallbacks, undefined, "Haiku has no server-side fallback");
    assert.equal(lastRequest().output_config.effort, "low");

    saveSettings({ AI_MODEL: "claude-haiku-4-5" });
    await chat({ kind: "customer", business, message: "Hi" });
    assert.equal(lastRequest().output_config, undefined, "no effort setting on Haiku 4.5");

    saveSettings({ AI_MODEL: "claude-future-9" });
    await chat({ kind: "customer", business, message: "Hi" });
    assert.equal(lastRequest().output_config.effort, "medium", "falls back to a level the model supports");
  } finally {
    saveSettings({ AI_MODEL: null });
  }
});
