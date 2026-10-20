import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import jwt from "jsonwebtoken";
import { DateTime } from "luxon";

// Stand-ins for Google's and Microsoft's token endpoints and calendar APIs.
type Ev = Record<string, any>;
const google = new Map<string, Ev>(), graph = new Map<string, Ev>();
const personal: Ev[] = []; // the staff member's own events in Google
const calls: string[] = [];
let tokenGrants: string[] = [];
let grantCalendarScope = true;
let fake: Server;
const fakeUrl = await new Promise<string>((resolve) => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const send = (status: number, json: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname.endsWith("/token")) {
        const form = new URLSearchParams(body);
        tokenGrants.push(form.get("grant_type")!);
        const who = url.pathname.startsWith("/google") ? "owner@gmail.com" : "owner@outlook.com";
        // Google reports which permissions were actually granted (people can untick the calendar box).
        const scope = url.pathname.startsWith("/google") ? (grantCalendarScope ? "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email" : "openid https://www.googleapis.com/auth/userinfo.email") : undefined;
        return send(200, { access_token: `at-${tokenGrants.length}`, refresh_token: "rt", expires_in: 3600, id_token: jwt.sign({ email: who }, "x"), scope });
      }
      const data = body ? JSON.parse(body) : {};
      if (url.pathname.startsWith("/gcal/calendars/primary/events")) {
        const id = url.pathname.split("/events/")[1];
        if (req.method === "POST") { const e = { ...data, id: `g${google.size + 1}` }; google.set(e.id, e); return send(200, e); }
        if (req.method === "PATCH") { if (!google.has(id)) return send(404, {}); google.set(id, { ...google.get(id), ...data }); return send(200, google.get(id)); }
        if (req.method === "DELETE") { google.delete(id); res.writeHead(204).end(); return; }
        return send(200, { items: [...google.values(), ...personal] });
      }
      if (url.pathname.startsWith("/graph/me/events")) {
        const id = url.pathname.split("/events/")[1];
        if (req.method === "POST") { const e = { ...data, id: `m${graph.size + 1}` }; graph.set(e.id, e); return send(201, e); }
        if (req.method === "PATCH") { graph.set(id, { ...graph.get(id), ...data }); return send(200, graph.get(id)); }
        if (req.method === "DELETE") { graph.delete(id); res.writeHead(204).end(); return; }
      }
      if (url.pathname === "/graph/me/calendarView") return send(200, { value: [] });
      send(404, { error: { message: "not found" } });
    });
  }).listen(0, () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
});

Object.assign(process.env, {
  NODE_ENV: "test", PUBLIC_API_URL: "http://api.test", PUBLIC_WEB_URL: "http://web.test",
  GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_TOKEN_URL: `${fakeUrl}/google/token`, GOOGLE_CALENDAR_API: `${fakeUrl}/gcal`,
  MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret", MICROSOFT_TOKEN_URL: `${fakeUrl}/ms/token`, MS_GRAPH_URL: `${fakeUrl}/graph`,
});

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run } = await import("../src/db.js");
const { inviteIcs } = await import("../src/lib/ics.js");

let server: Server, base = "", token = "", bid = "", alex = "", sam = "", piano = "", guitar = "";
const settle = () => new Promise((r) => setTimeout(r, 60));
async function api(method: string, path: string, body?: unknown, auth = token) {
  const res = await fetch(base + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
function nextWeekday(days = 4) {
  let d = DateTime.now().setZone("America/New_York").plus({ days });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  return d;
}

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  token = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  bid = (await api("GET", "/api/auth/me")).body.businesses[0].id;
  alex = one("SELECT id FROM staff WHERE name = 'Alex Kim'")!.id;
  sam = one("SELECT id FROM staff WHERE name = 'Sam Ortiz'")!.id;
  piano = one("SELECT id FROM services WHERE name = 'Piano lesson (30 min)'")!.id;
  guitar = one("SELECT id FROM services WHERE name LIKE 'Guitar%'")!.id;
  run("UPDATE businesses SET require_payment = 0"); // keep these bookings simple
});
after(() => { server.close(); fake.close(); });

async function connect(provider: "google" | "microsoft", staffId: string) {
  const start = await api("POST", `/api/admin/${bid}/staff/${staffId}/calendar/${provider}/connect`);
  assert.equal(start.status, 200);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const state = new URL(start.body.url).searchParams.get("state")!;
  const cb = await fetch(`${base}/api/integrations/${provider}/callback?code=c1&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie } });
  return { location: cb.headers.get("location")!, url: new URL(start.body.url), state, cookie };
}
const book = (serviceId: string, staffId: string, start: string, email = "cal@example.com") =>
  api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId, staffId, start, name: "Cal Customer", email }, "");

test("customer gets an .ics file and Google/Outlook links for their booking", async () => {
  const day = nextWeekday().toISODate();
  const [slot] = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${guitar}&from=${day}`, undefined, "")).body;
  const res = await book(guitar, slot.staffId, slot.start);
  const links = res.body.booking.calendarLinks;
  assert.match(links.google, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(links.outlook, /^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose\?/);
  const ics = await fetch(`${base}/api/public/manage/${res.body.booking.manageToken}/calendar.ics`);
  assert.match(ics.headers.get("content-type")!, /text\/calendar/);
  const text = await ics.text();
  assert.match(text, /BEGIN:VEVENT\r\n/);
  assert.match(text, new RegExp(`DTSTART:${DateTime.fromISO(slot.start).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'")}`));
  assert.match(text, /SUMMARY:Guitar lesson \(45 min\) with Riverside Music/);
  assert.ok(text.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines folded");
});

test("email invites keep one UID and raise SEQUENCE so calendars update; cancel sends METHOD:CANCEL", async () => {
  const b = one("SELECT * FROM bookings WHERE customer_email = 'cal@example.com'")!;
  const first = inviteIcs(b, "REQUEST");
  run("UPDATE bookings SET ics_sequence = 2 WHERE id = ?", b.id);
  const cancel = inviteIcs(one("SELECT * FROM bookings WHERE id = ?", b.id)!, "CANCEL");
  assert.match(first, /METHOD:REQUEST/);
  assert.match(first, new RegExp(`UID:${b.id}@slotwise`));
  assert.match(cancel, /METHOD:CANCEL/);
  assert.match(cancel, /SEQUENCE:2/);
  assert.match(cancel, /STATUS:CANCELLED/);
  assert.match(first, /ATTENDEE;CN=Cal Customer/);
});

test("connecting Google: consent URL asks for offline calendar access; tokens stored encrypted", async () => {
  const r = await connect("google", alex);
  assert.equal(r.url.searchParams.get("access_type"), "offline");
  assert.match(r.url.searchParams.get("scope")!, /calendar\.events/);
  assert.equal(r.url.searchParams.get("redirect_uri"), "http://api.test/api/integrations/google/callback");
  assert.equal(r.location, `http://web.test/admin/${bid}/calendars?connected=google`);
  const conn = one("SELECT * FROM calendar_connections WHERE staff_id = ? AND provider = 'google'", alex)!;
  assert.equal(conn.account_email, "owner@gmail.com");
  // Encrypted at rest: no readable token or JSON (random ciphertext can contain short strings like "rt", so check for JSON).
  assert.ok(!conn.tokens.includes("accessToken") && !conn.tokens.includes("refreshToken") && !conn.tokens.includes("at-"), "tokens encrypted at rest");

  // The same consent link without this browser's cookie is refused.
  const replay = await fetch(`${base}/api/integrations/google/callback?code=c2&state=${encodeURIComponent(r.state)}`, { redirect: "manual" });
  assert.match(replay.headers.get("location")!, /calendarError=/);
});

test("connecting Google without ticking the calendar permission is refused with what to tick", async () => {
  grantCalendarScope = false;
  const before = one("SELECT tokens FROM calendar_connections WHERE staff_id = ? AND provider = 'google'", alex)!.tokens;
  const r = await connect("google", alex);
  grantCalendarScope = true;
  const error = new URL(r.location).searchParams.get("calendarError")!;
  assert.match(error, /tick "See, edit, create and delete all your Google Calendar events"/);
  assert.equal(one("SELECT tokens FROM calendar_connections WHERE staff_id = ? AND provider = 'google'", alex)!.tokens, before, "existing connection untouched");
});

test("bookings appear, move and disappear in the connected Google Calendar, with a phone reminder", async () => {
  const day = nextWeekday(5).toISODate();
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${piano}&from=${day}&staffId=${alex}`, undefined, "")).body;
  const res = await book(piano, alex, slots[2].start, "sync@example.com");
  await settle();
  const ev = [...google.values()].find((e) => e.extendedProperties?.private?.slotwiseBookingId === res.body.booking.id)!;
  assert.ok(ev, "event created");
  assert.equal(ev.summary, "Piano lesson (30 min): Cal Customer");
  assert.deepEqual(ev.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] });
  assert.equal(DateTime.fromISO(ev.start.dateTime).toMillis(), DateTime.fromISO(slots[2].start).toMillis());

  await api("PATCH", `/api/admin/${bid}/bookings/${res.body.booking.id}`, { start: slots[6].start });
  await settle();
  assert.equal(DateTime.fromISO(google.get(ev.id)!.start.dateTime).toMillis(), DateTime.fromISO(slots[6].start).toMillis(), "event moved");

  await api("PATCH", `/api/admin/${bid}/bookings/${res.body.booking.id}`, { status: "cancelled" });
  await settle();
  assert.ok(!google.has(ev.id), "event removed on cancel");
});

test("personal Google events block those times; free events and our own events don't", async () => {
  const day = nextWeekday(6);
  const at = (h: number, m = 0) => day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  personal.push({ id: "p1", start: { dateTime: at(10).toISO() }, end: { dateTime: at(11).toISO() } });
  personal.push({ id: "p2", start: { dateTime: at(14).toISO() }, end: { dateTime: at(15).toISO() }, transparency: "transparent" });
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${piano}&from=${day.toISODate()}&staffId=${alex}`, undefined, "")).body;
  const starts = slots.map((s: any) => DateTime.fromISO(s.start).setZone("America/New_York").toFormat("HH:mm"));
  assert.ok(!starts.includes("10:00") && !starts.includes("10:30") && !starts.includes("09:45"), "busy hour (and the 30 min before it) blocked");
  assert.ok(starts.includes("11:00") && starts.includes("14:00"), "after the event, and 'free' events, still bookable");

  // A customer who loaded the page earlier still can't grab the busy time.
  const late = await book(piano, alex, at(10).toUTC().toISO()!, "late@example.com");
  assert.equal(late.status, 409);

  // A booking's own synced event doesn't block it from moving to an overlapping time.
  const own = await book(piano, alex, at(11).toUTC().toISO()!, "own@example.com");
  await settle();
  const moved = await api("POST", `/api/public/manage/${own.body.booking.manageToken}/reschedule`, { start: at(11, 15).toUTC().toISO() }, "");
  assert.equal(moved.status, 200);
});

test("expired Google access is refreshed automatically", async () => {
  const { decryptJson, encryptJson } = await import("../src/lib/crypto.js");
  const conn = one("SELECT * FROM calendar_connections WHERE staff_id = ? AND provider = 'google'", alex)!;
  run("UPDATE calendar_connections SET tokens = ? WHERE id = ?", encryptJson({ ...decryptJson(conn.tokens), expiresAt: 0 }), conn.id);
  tokenGrants = [];
  await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${piano}&from=${nextWeekday(9).toISODate()}&staffId=${alex}`, undefined, "");
  assert.deepEqual(tokenGrants, ["refresh_token"]);
});

test("Outlook: connect, then bookings are pushed with Outlook's reminder", async () => {
  const r = await connect("microsoft", sam);
  assert.match(r.url.searchParams.get("scope")!, /Calendars\.ReadWrite/);
  assert.match(r.url.searchParams.get("scope")!, /offline_access/);
  await api("PATCH", `/api/admin/${bid}/calendar-connections/${one("SELECT id FROM calendar_connections WHERE staff_id = ?", sam)!.id}`, { reminder_min: 15 });
  const day = nextWeekday(5).toISODate();
  const [slot] = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${guitar}&from=${day}&staffId=${sam}`, undefined, "")).body;
  await book(guitar, sam, slot.start, "outlook@example.com");
  await settle();
  const ev = [...graph.values()].at(-1)!;
  assert.equal(ev.subject, "Guitar lesson (45 min): Cal Customer");
  assert.equal(ev.isReminderOn, true);
  assert.equal(ev.reminderMinutesBeforeStart, 15);
  assert.equal(ev.start.timeZone, "UTC");
  const list = await api("GET", `/api/admin/${bid}/calendars`);
  const samRow = list.body.staff.find((s: any) => s.id === sam);
  assert.equal(samRow.connections[0].account_email, "owner@outlook.com");
  assert.equal(samRow.connections[0].last_error, null);
});

test("subscribe feed: whole business or one person; regenerating kills the old address", async () => {
  const list = await api("GET", `/api/admin/${bid}/calendars`);
  const feed = new URL(list.body.feed.all);
  const res = await fetch(`${base}${feed.pathname}`);
  const ics = await res.text();
  assert.match(ics, /X-WR-CALNAME:Riverside Music bookings/);
  assert.match(ics, /SUMMARY:Guitar lesson \(45 min\): Cal Customer/);
  const alexFeed = new URL(list.body.staff.find((s: any) => s.id === alex).feedUrl);
  const alexIcs = await (await fetch(`${base}${alexFeed.pathname}${alexFeed.search}`)).text();
  assert.ok(!alexIcs.includes("Guitar lesson"), "Alex's feed has only Alex's bookings");

  await api("POST", `/api/admin/${bid}/calendar-feed/regenerate`);
  assert.equal((await fetch(`${base}${feed.pathname}`)).status, 404);
  assert.equal((await fetch(`${base}/api/calendar/short.ics`)).status, 404);
});

test("other businesses' admins can't touch these calendar settings", async () => {
  const other = await api("POST", "/api/auth/register", { email: "cal-other@example.com", password: "password1", name: "O", businessName: "Other Co" }, "");
  assert.equal((await api("GET", `/api/admin/${bid}/calendars`, undefined, other.body.token)).status, 403);
  assert.equal((await api("POST", `/api/admin/${bid}/staff/${alex}/calendar/google/connect`, undefined, other.body.token)).status, 403);
  assert.equal((await api("GET", `/api/admin/${bid}/calendars`, undefined, "")).status, 401);
});

test("disconnecting removes upcoming synced events from that calendar", async () => {
  const conn = one("SELECT id FROM calendar_connections WHERE staff_id = ? AND provider = 'google'", alex)!;
  assert.ok([...google.values()].length > 0);
  await api("DELETE", `/api/admin/${bid}/calendar-connections/${conn.id}`);
  assert.equal(google.size, 0);
  assert.equal(one("SELECT COUNT(*) AS n FROM calendar_connections WHERE id = ?", conn.id)!.n, 0);
});
