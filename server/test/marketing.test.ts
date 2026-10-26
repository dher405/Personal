import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// A stand-in for Anthropic. Structured requests get a JSON verdict; the blog article is streamed back.
const requests: any[] = [];
let fake: Server;
const fakeUrl = await new Promise<string>((resolve) => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url!.startsWith("/v1/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: "claude-opus-5-5", capabilities: {} })); }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const user = JSON.stringify(parsed.messages[0].content);
      if (parsed.stream) {
        // The blog article, as server-sent events.
        res.setHeader("content-type", "text/event-stream");
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", { message: { id: "msg_blog", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "---\ntitle: Choosing a booking app\ndescription: How to pick booking software for a small salon.\nslug: choosing\n---\n# Choosing a booking app\n\nStart with **reminders**. <script>alert(1)</script> [bad](javascript:alert(1)) [good](https://example.com)\n" } });
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
        send("message_stop", {});
        return res.end();
      }
      const props = parsed.output_config?.format?.schema?.properties ?? {};
      const ideas = !!props.ideas;
      const listing = !ideas && !("relevant" in props);
      const answer = ideas
        ? { ideas: [{ title: "How to choose a booking app for your salon", target_query: "salon booking app", why: "Several people asked" }] }
        : listing
        ? Object.fromEntries(Object.keys(props).map((k) => [k, k === "tagline" ? "Online booking for independent pros" : `Sample ${k} for Slotwise`]))
        : {
            relevant: !user.includes("unrelated"), relevance: user.includes("unrelated") ? 2 : 8,
            reason: user.includes("unrelated") ? "Not about booking" : "Asks for a salon booking tool",
            rules_risk: "none", reply: "Here's what worked for me... (Disclosure: I'm the founder of Slotwise.)",
            mentions_product: !user.includes("Do NOT mention"), blog_topic: "Choosing a salon booking app",
          };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `msg_${requests.length}`, type: "message", role: "assistant", model: parsed.model,
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      }));
    });
  }).listen(0, () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
});

// Stand-ins for Hacker News and Stack Exchange; everything on 127.0.0.1 (the app and fake Anthropic) goes through.
const now = Math.floor(Date.now() / 1000);
const realFetch = globalThis.fetch;
const external: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  external.push(url.href);
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  if (url.hostname === "hn.algolia.com" && url.searchParams.get("query")) {
    const q = url.searchParams.get("query")!;
    return json({ hits: [
      { objectID: `${q.length}01`, title: `Ask HN: ${q} for my salon?`, story_text: "<p>Looking for &amp; comparing</p>", created_at_i: now - 600 },
      { objectID: `${q.length}02`, title: `Ask HN: ${q} again?`, story_text: "Need one", created_at_i: now - 700 },
      { objectID: `${q.length}03`, title: `Show HN: unrelated ${q}`, story_text: "My new game", created_at_i: now - 800 },
    ] });
  }
  if (url.hostname === "hn.algolia.com") { // the verifier: comments by our account
    // One reply from our account under each thread: comment "9<thread id>".
    const threads = ["1701", "1702", "1703", "1501", "1502", "1503"];
    return json({ hits: threads.map((id) => ({ objectID: `9${id}`, parent_id: Number(id), story_id: Number(id) })) });
  }
  if (url.hostname === "hacker-news.firebaseio.com") {
    const dead = url.pathname.includes("9002");
    return json({ id: 1, text: "Here&#x27;s what worked for me... (Disclosure: I&#x27;m the founder of Slotwise.)", dead });
  }
  if (url.hostname === "api.stackexchange.com") return json({ items: [], backoff: 0 });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test";
process.env.ANTHROPIC_BASE_URL = fakeUrl;
process.env.SUPERADMIN_EMAIL = "boss@slotwise.test";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");
const { tick } = await import("../src/marketing/scheduler.js");

let server: Server, base = "", owner = "", boss = "";
async function api(method: string, path: string, body?: unknown, token = boss) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function waitForIdle() {
  for (let i = 0; i < 200; i++) {
    const o = (await api("GET", "/api/super/marketing/overview")).body;
    if (!o.running) return o;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job never finished");
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  boss = (await api("POST", "/api/auth/login", { email: "boss@slotwise.test", password: "super1234" }, "")).body.token;
});
after(() => { server.close(); fake.close(); globalThis.fetch = realFetch; });

test("only the super admin can see it, and it's off until switched on", async () => {
  assert.equal((await api("GET", "/api/super/marketing/overview", undefined, owner)).status, 403);
  assert.equal((await api("GET", "/api/super/marketing/overview", undefined, "")).status, 401);
  const o = (await api("GET", "/api/super/marketing/overview")).body;
  assert.equal(o.enabled, false);
  assert.equal(tick(), null, "nothing runs on a schedule while it's off");
  assert.equal(external.length, 0, "no outside site was contacted");
});

test("settings are validated and saved", async () => {
  const { settings } = (await api("GET", "/api/super/marketing/settings")).body;
  assert.equal(settings.product.name, "Slotwise");
  assert.equal((await api("PUT", "/api/super/marketing/settings", { ...settings, product: { ...settings.product, url: "not a url" } })).status, 400);
  const next = {
    ...settings,
    search: { ...settings.search, queries: ["salon booking app", "scheduling tool"] },
    sources: { ...settings.sources, reddit: false, stackexchangeSites: ["webapps"] },
    accounts: { ...settings.accounts, hnUsername: "founder" },
  };
  const saved = await api("PUT", "/api/super/marketing/settings", next);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings.search.queries, ["salon booking app", "scheduling tool"]);
  assert.ok(one("SELECT 1 FROM audit_log WHERE action = 'marketing.settings_updated'"));
});

test("a scan drafts replies for relevant threads, within the per-community limit", async () => {
  assert.equal((await api("POST", "/api/super/marketing/run/scan")).body.started, true);
  const o = await waitForIdle();
  const scan = o.jobs.find((j: any) => j.kind === "scan").lastRun;
  assert.equal(scan.status, "ok", scan.summary);
  assert.equal(scan.trigger, "manual");

  const drafts = (await api("GET", "/api/super/marketing/drafts")).body;
  assert.equal(drafts.length, 2, "at most 2 drafts per community per week");
  assert.ok(drafts.every((d: any) => d.community === "hackernews" && d.mentions_product === 1));

  // The model got the product brief, the thread as untrusted data, a JSON schema, and the refusal fallback.
  const first = requests[0];
  assert.match(first.system[0].text, /<product>[\s\S]*Slotwise/);
  assert.match(first.system[0].text, /untrusted data/);
  assert.match(first.messages[0].content, /<thread url="https:\/\/news\.ycombinator\.com/);
  assert.equal(first.output_config.format.type, "json_schema");
  assert.equal(first.fallbacks, "default");

  const kinds = (await api("GET", "/api/super/marketing/events?kind=skipped")).body;
  assert.ok(kinds.some((e: any) => /already 2 drafts for hackernews/.test(e.message)), "the limit is logged with the reason");
});

test("posting: the verifier links your real comment and flags one moderators removed", async () => {
  const [live, other] = (await api("GET", "/api/super/marketing/drafts")).body;

  assert.equal((await api("POST", `/api/super/marketing/drafts/${live.id}`, { action: "posted", reply: live.reply, postedUrl: "javascript:alert(1)" })).status, 400);
  assert.equal((await api("POST", `/api/super/marketing/drafts/${live.id}`, { action: "posted", reply: live.reply })).status, 200);
  await waitForIdle();
  // A link pasted by hand that points at a comment moderators killed.
  assert.equal((await api("POST", `/api/super/marketing/drafts/${other.id}`, { action: "posted", reply: other.reply, postedUrl: "https://news.ycombinator.com/item?id=9002" })).status, 200);
  await waitForIdle();

  const posted = (await api("GET", "/api/super/marketing/posted")).body;
  const a = posted.find((d: any) => d.id === live.id), b = posted.find((d: any) => d.id === other.id);
  assert.equal(a.live_status, "live");
  assert.equal(a.posted_url, `https://news.ycombinator.com/item?id=9${live.thread_id.slice(3)}`, "found by username, linked directly");
  assert.equal(a.match, 100, "live text matches what was approved");
  assert.equal(b.live_status, "removed");
  const o = (await api("GET", "/api/super/marketing/overview")).body;
  assert.equal(o.removed.length, 1);
  assert.equal(o.totals.posted, 2);
  assert.ok(o.events.some((e: any) => e.kind === "removed" && e.url === "https://news.ycombinator.com/item?id=9002"));
});

test("once too many posts mention the product, new drafts are pure help", async () => {
  run("DELETE FROM marketing_drafts WHERE status = 'pending'");
  run("UPDATE marketing_drafts SET created_at = created_at - 8 * 86400"); // last week's: the weekly limit resets
  run("DELETE FROM marketing_threads WHERE status != 'drafted'");
  await api("POST", "/api/super/marketing/run/scan");
  await waitForIdle();
  const latest = requests.filter((r) => !r.stream).at(-1);
  assert.match(latest.messages[0].content, /Do NOT mention the product/);
  const drafts = (await api("GET", "/api/super/marketing/drafts")).body;
  assert.ok(drafts.length > 0 && drafts.every((d: any) => d.mentions_product === 0));
});

test("with no questions collected yet, blog drafts are planned from the audience's common searches", async () => {
  const before = requests.length;
  const { articleIdeas } = await import("../src/marketing/agent.js");
  const { getSettings } = await import("../src/marketing/store.js");
  const ideas = await articleIdeas(getSettings(), [], [], 1);
  assert.equal(ideas.length, 1);
  assert.match(requests[before].messages[0].content, /No questions have been collected yet/);
});

test("blog drafts are based on collected questions", async () => {
  await api("POST", "/api/super/marketing/run/blog");
  await waitForIdle();
  const [article] = (await api("GET", "/api/super/marketing/articles")).body;
  assert.equal(article.title, "How to choose a booking app for your salon");
  assert.match(article.body, /^---\ntitle:/);
  assert.equal(article.description, "How to pick booking software for a small salon.", "taken from the article's header");
  const ideasRequest = requests.findLast((r) => r.output_config?.format?.schema?.properties?.ideas);
  assert.match(ideasRequest.messages[0].content, /salon booking app for my salon/);
});

test("publishing on the site: /blog pages, safe rendering, sitemap and robots.txt", async () => {
  const [article] = (await api("GET", "/api/super/marketing/articles")).body;
  const page = (path: string) => fetch(base + path).then(async (r) => ({ status: r.status, text: await r.text(), type: r.headers.get("content-type") }));

  // Drafts aren't public.
  assert.notEqual((await page(`/blog/${article.slug}`)).status, 200);
  assert.doesNotMatch((await page("/blog")).text, /choose a booking app/);

  // Edit, preview, publish.
  const edited = await api("PATCH", `/api/super/marketing/articles/${article.id}`, { title: "Choosing booking software for a salon", description: "A short guide.", body: article.body });
  assert.equal(edited.status, 200);
  const preview = (await api("POST", "/api/super/marketing/articles/preview", { body: article.body })).body.html;
  assert.match(preview, /<strong>reminders<\/strong>/);
  assert.doesNotMatch(preview, /<script>/, "raw HTML from the model is never run");
  assert.doesNotMatch(preview, /javascript:/);
  assert.equal((await api("POST", `/api/super/marketing/articles/${article.id}/status`, { action: "publish_site" }, owner)).status, 403);
  const published = (await api("POST", `/api/super/marketing/articles/${article.id}/status`, { action: "publish_site" })).body;
  assert.equal(published.status, "published");
  assert.equal(published.on_site, 1);
  assert.match(published.published_url, new RegExp(`/blog/${article.slug}$`));

  const post = await page(`/blog/${article.slug}`);
  assert.equal(post.status, 200);
  assert.match(post.type!, /text\/html/);
  assert.match(post.text, /<title>Choosing booking software for a salon \| Slotwise<\/title>/);
  assert.match(post.text, /<meta name="description" content="A short guide.">/);
  assert.match(post.text, new RegExp(`<link rel="canonical" href="[^"]+/blog/${article.slug}">`));
  assert.match(post.text, /"@type":"BlogPosting"/);
  assert.match(post.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "shown as text, not run");
  assert.doesNotMatch(post.text, /<script>alert/);
  assert.match(post.text, /href="https:\/\/example.com" rel="nofollow noopener"/);
  assert.match(post.text, /Create your booking page/);
  assert.doesNotMatch(post.text, /^---/m, "the header block isn't shown");

  assert.match((await page("/blog")).text, /Choosing booking software for a salon/);
  const sitemap = await page("/sitemap.xml");
  assert.match(sitemap.type!, /xml/);
  assert.match(sitemap.text, new RegExp(`/blog/${article.slug}</loc>`));
  const robots = await page("/robots.txt");
  assert.match(robots.text, /Disallow: \/super/);
  assert.match(robots.text, /Sitemap: .*\/sitemap.xml/);

  // Unpublish takes it off the site.
  await api("POST", `/api/super/marketing/articles/${article.id}/status`, { action: "unpublish" });
  assert.notEqual((await page(`/blog/${article.slug}`)).status, 200);
  assert.doesNotMatch((await page("/sitemap.xml")).text, new RegExp(article.slug));
  // Published somewhere else needs its address.
  assert.equal((await api("POST", `/api/super/marketing/articles/${article.id}/status`, { action: "publish_external" })).status, 400);
  assert.equal((await api("POST", `/api/super/marketing/articles/${article.id}/status`, { action: "publish_external", publishedUrl: "https://medium.com/@me/post" })).body.published_url, "https://medium.com/@me/post");
});

test("directory kit: listing copy for each directory's fields, then tracking", async () => {
  const list = (await api("GET", "/api/super/marketing/directories")).body;
  assert.ok(list.length >= 8);
  const ph = list.find((d: any) => d.id === "producthunt");
  assert.equal(ph.status, "todo");
  assert.equal((await api("POST", "/api/super/marketing/directories/nope/write")).status, 404);

  assert.equal((await api("POST", "/api/super/marketing/directories/producthunt/write", { instruction: "Focus on music teachers" })).body.started, true);
  let d: any;
  for (let i = 0; i < 100; i++) {
    d = (await api("GET", "/api/super/marketing/directories")).body.find((x: any) => x.id === "producthunt");
    if (d.status !== "drafting") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(d.status, "ready", d.error);
  assert.deepEqual(Object.keys(d.copy).sort(), ph.fields.map((f: any) => f.key).sort(), "one value per form field");
  assert.equal(d.copy.tagline, "Online booking for independent pros");
  const req = requests.findLast((r) => r.output_config?.format?.schema?.properties?.first_comment);
  assert.match(req.messages[0].content, /Product Hunt/);
  assert.match(req.messages[0].content, /Focus on music teachers/);
  assert.match(req.system[0].text, /Never invent customer numbers, ratings, awards, reviews or testimonials/);

  // Your edits, then submitted and live with the listing's link.
  assert.equal((await api("PATCH", "/api/super/marketing/directories/producthunt", { copy: { ...d.copy, tagline: "Booking for music teachers" } })).status, 200);
  assert.equal((await api("PATCH", "/api/super/marketing/directories/producthunt", { status: "submitted", listingUrl: "javascript:alert(1)" })).status, 400);
  await api("PATCH", "/api/super/marketing/directories/producthunt", { status: "submitted", listingUrl: "https://www.producthunt.com/products/slotwise" });
  await api("PATCH", "/api/super/marketing/directories/producthunt", { status: "live" });
  d = (await api("GET", "/api/super/marketing/directories")).body.find((x: any) => x.id === "producthunt");
  assert.equal(d.status, "live");
  assert.equal(d.copy.tagline, "Booking for music teachers");
  assert.equal(d.listingUrl, "https://www.producthunt.com/products/slotwise", "kept when only the status changes");
  assert.ok(d.submittedAt);
  const o = (await api("GET", "/api/super/marketing/overview")).body;
  assert.equal(o.totals.directoriesLive, 1);
  const events = (await api("GET", "/api/super/marketing/events?kind=directory")).body;
  assert.ok(events.some((e: any) => e.message === "Listing live on Product Hunt" && e.url === "https://www.producthunt.com/products/slotwise"));
});

test("switched on, the scheduler runs whatever is due", async () => {
  const { settings } = (await api("GET", "/api/super/marketing/settings")).body;
  await api("PUT", "/api/super/marketing/settings", { ...settings, enabled: true, schedule: { scanEveryHours: 0, verifyEveryHours: 0, blogEveryDays: 0 } });
  assert.equal(tick(), null, "nothing scheduled");
  run("DELETE FROM marketing_runs WHERE kind = 'verify'");
  await api("PUT", "/api/super/marketing/settings", { ...settings, enabled: true, schedule: { scanEveryHours: 0, verifyEveryHours: 6, blogEveryDays: 0 } });
  assert.equal(tick(), "verify");
  await waitForIdle();
  assert.equal(tick(), null, "not due again for 6 hours");
});
