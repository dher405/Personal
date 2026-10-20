process.env.NODE_ENV = "test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DateTime } from "luxon";

// Stand-ins for Zoom, RingCentral, Google Calendar and Microsoft Graph.
const calls: string[] = [];
let nextId = 1;
let fake: Server;
const fakeUrl = await new Promise<string>((resolve) => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const path = url.pathname;
      calls.push(`${req.method} ${path}${url.search}`);
      const send = (status: number, json: unknown = {}) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? "" : JSON.stringify(json)); };
      if (path === "/zoom/oauth/token" || path === "/rc/restapi/oauth/token") return send(200, { access_token: "tok" });
      if (path === "/zoom/v2/users/me" ) return send(200, { email: "dana@zoom.test" });
      if (path === "/zoom/v2/users/me/meetings") { const id = nextId++; return send(201, { id, join_url: `https://zoom.test/j/${id}` }); }
      if (path.startsWith("/zoom/v2/meetings/")) return send(204);
      if (path === "/rc/rcvideo/v2/account/~/extension/~/bridges") { const id = `br${nextId++}`; return send(200, { id, discovery: { web: `https://v.rc.test/join/${id}` } }); }
      if (path.startsWith("/rc/rcvideo/v2/bridges/")) return send(204);
      if (path.startsWith("/gcal/calendars/primary/events")) {
        const json = body ? JSON.parse(body) : {};
        const id = path.split("/events/")[1] ?? `gev${nextId++}`;
        if (req.method === "DELETE") return send(204);
        const meet = url.searchParams.get("conferenceDataVersion") === "1" && (json.conferenceData || req.method === "PATCH");
        return send(200, { id, ...(meet ? { hangoutLink: `https://meet.google.test/${id}` } : {}) });
      }
      if (path.startsWith("/graph/me/events")) {
        const json = body ? JSON.parse(body) : {};
        const id = path.split("/events/")[1] ?? `mev${nextId++}`;
        if (req.method === "DELETE") return send(204);
        return send(200, { id, ...(json.isOnlineMeeting ? { onlineMeeting: { joinUrl: `https://teams.test/${id}` } } : {}) });
      }
      send(404, { error: "unknown " + path });
    });
  }).listen(0, () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
});
Object.assign(process.env, {
  ZOOM_OAUTH_URL: `${fakeUrl}/zoom/oauth/token`, ZOOM_API_URL: `${fakeUrl}/zoom/v2`, RINGCENTRAL_SERVER_URL: `${fakeUrl}/rc`,
  GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs", GOOGLE_CALENDAR_API: `${fakeUrl}/gcal`,
  MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "ms", MS_GRAPH_URL: `${fakeUrl}/graph`,
});

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { all, newId, one, run } = await import("../src/db.js");
const { encryptJson } = await import("../src/lib/crypto.js");

let server: Server, base = "", owner = "", bid = "", svc = "", alex = "", sam = "";
async function api(method: string, path: string, body?: unknown, token = owner) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const settle = () => new Promise((r) => setTimeout(r, 80));
let cursor = 0;
async function book(email: string, staffId: string, extra: Record<string, unknown> = {}) {
  let d = DateTime.now().setZone("America/New_York").plus({ days: 3 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  const slots = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${d.toISODate()}&to=${d.plus({ days: 6 }).toISODate()}&staffId=${staffId}`, undefined, "")).body;
  const s = slots[cursor++ * 4];
  const res = await api("POST", "/api/public/businesses/riverside-music/bookings", { serviceId: svc, staffId, start: s.start, name: "Online Olive", email, ...extra }, "");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await settle();
  return one("SELECT * FROM bookings WHERE id = ?", res.body.booking.id)!;
}
const lastEmail = (to: string) => all("SELECT * FROM email_messages WHERE to_email = ? ORDER BY rowid", to).at(-1)!;
const setTool = (body: Record<string, unknown>) => api("PUT", `/api/admin/${bid}/meetings`, body);

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  bid = one("SELECT id FROM businesses WHERE slug = 'riverside-music'")!.id;
  svc = one("SELECT id FROM services WHERE business_id = ? AND name LIKE 'Guitar%'", bid)!.id;
  alex = one("SELECT id FROM staff WHERE business_id = ? AND name = 'Alex Kim'", bid)!.id;
  sam = one("SELECT id FROM staff WHERE business_id = ? AND name = 'Sam Ortiz'", bid)!.id;
  run("INSERT OR IGNORE INTO staff_services (staff_id, service_id) VALUES (?, ?), (?, ?)", alex, svc, sam, svc);
  await api("PATCH", `/api/admin/${bid}`, { require_payment: false });
  // Alex has Google Calendar connected; Sam has nothing.
  run("INSERT INTO calendar_connections (id, staff_id, provider, account_email, tokens) VALUES (?,?,?,?,?)",
    newId("cal"), alex, "google", "alex@gmail.test", encryptJson({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }));
});
after(() => { server.close(); fake.close(); });

test("in-person services stay in person; an online service without a tool explains the link will follow", async () => {
  const inPerson = await book("inperson@example.com", sam);
  assert.equal(inPerson.meeting_mode, "in_person");
  assert.match(lastEmail("inperson@example.com").body, /In person at 12 River St/);

  assert.equal((await api("PATCH", `/api/admin/services/${svc}`.replace("/admin/", `/admin/${bid}/`), { location_mode: "online" })).status, 200);
  const b = await book("notool@example.com", sam);
  assert.equal(b.meeting_mode, "online");
  assert.equal(b.meeting_url, null);
  assert.match(b.meeting_error, /aren't set up/);
  assert.match(lastEmail("notool@example.com").body, /will send you the meeting link/);
});

test("Zoom: a meeting is made before the confirmation, moved on reschedule and deleted on cancel", async () => {
  assert.equal((await setTool({ provider: "zoom", zoomAccountId: "acc", zoomClientId: "cid", zoomClientSecret: "secret-9999" })).body.zoomClientSecret, "••••9999");
  assert.match((await api("POST", `/api/admin/${bid}/meetings/test`)).body.message, /Connected to Zoom as dana@zoom\.test/);
  const b = await book("zoom@example.com", sam);
  assert.match(b.meeting_url, /^https:\/\/zoom\.test\/j\/\d+$/);
  assert.equal(b.meeting_provider, "zoom");
  const mail = lastEmail("zoom@example.com");
  assert.match(mail.body, new RegExp(`Online \\(Zoom\\): ${b.meeting_url.replace(/[./]/g, "\\$&")}`));
  const manage = (await api("GET", `/api/public/manage/${b.manage_token}`, undefined, "")).body.booking;
  assert.equal(manage.meetingUrl, b.meeting_url);

  const day = DateTime.fromISO(b.starts_at).setZone("America/New_York").toISODate();
  const free = (await api("GET", `/api/public/businesses/riverside-music/slots?serviceId=${svc}&from=${day}&staffId=${sam}`, undefined, "")).body;
  await api("POST", `/api/public/manage/${b.manage_token}/reschedule`, { start: free.at(-1).start }, "");
  await settle();
  assert.ok(calls.includes(`PATCH /zoom/v2/meetings/${b.meeting_external_id}`));
  await api("POST", `/api/public/manage/${b.manage_token}/cancel`, {}, "");
  await settle();
  assert.ok(calls.includes(`DELETE /zoom/v2/meetings/${b.meeting_external_id}`));
});

test("RingCentral Video: a bridge's join link is used", async () => {
  await setTool({ provider: "ringcentral", rcClientId: "rc", rcClientSecret: "rs", rcJwt: "eyJ.jwt.x" });
  const b = await book("rc@example.com", sam);
  assert.match(b.meeting_url, /^https:\/\/v\.rc\.test\/join\/br\d+$/);
});

test("Google Meet: the link comes from the staff member's calendar; without a connected calendar the owner can retry or paste one", async () => {
  await setTool({ provider: "google_meet" });
  assert.match((await api("POST", `/api/admin/${bid}/meetings/test`)).body.message, /1 of 2 staff have Google Calendar connected/);
  const withCal = await book("meet@example.com", alex);
  assert.match(withCal.meeting_url, /^https:\/\/meet\.google\.test\/gev\d+$/);
  assert.ok(calls.some((c) => c.startsWith("POST /gcal/calendars/primary/events?conferenceDataVersion=1")));
  assert.match(lastEmail("meet@example.com").body, /Online \(Google Meet\): https:\/\/meet\.google\.test/);

  const noCal = await book("meet2@example.com", sam);
  assert.equal(noCal.meeting_url, null);
  assert.match(noCal.meeting_error, /Sam Ortiz hasn't connected Google Calendar/);
  const pasted = await api("POST", `/api/admin/${bid}/bookings/${noCal.id}/meeting`, { url: "https://meet.google.com/abc-defg-hij" });
  assert.equal(pasted.body.meetingUrl, "https://meet.google.com/abc-defg-hij");
  await settle();
  assert.match(lastEmail("meet2@example.com").body, /meet\.google\.com\/abc-defg-hij/, "the customer is sent the pasted link");
});

test("customer's choice: they pick in person or online on the booking form", async () => {
  await setTool({ provider: "custom", customUrl: "https://whereby.test/riverside" });
  await api("PATCH", `/api/admin/${bid}/services/${svc}`, { location_mode: "choice" });
  const page = (await api("GET", "/api/public/businesses/riverside-music", undefined, "")).body;
  assert.equal(page.services.find((s: any) => s.id === svc).location_mode, "choice");
  const inPerson = await book("choice1@example.com", sam, { meetingMode: "in_person" });
  assert.equal(inPerson.meeting_mode, "in_person");
  const online = await book("choice2@example.com", sam, { meetingMode: "online" });
  assert.equal(online.meeting_url, "https://whereby.test/riverside");
});

test("Teams: the Outlook event is created as an online meeting", async () => {
  run("INSERT INTO calendar_connections (id, staff_id, provider, account_email, tokens) VALUES (?,?,?,?,?)",
    newId("cal"), sam, "microsoft", "sam@outlook.test", encryptJson({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }));
  await setTool({ provider: "teams" });
  await api("PATCH", `/api/admin/${bid}/services/${svc}`, { location_mode: "online" });
  const b = await book("teams@example.com", sam);
  assert.match(b.meeting_url, /^https:\/\/teams\.test\/mev\d+$/);
});
