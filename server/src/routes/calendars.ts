import { Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, audit, one, run } from "../db.js";
import { actorOf, assertBusinessAccess } from "../lib/auth.js";
import {
  calendarAuthorizeUrl, calendarProviderEnabled, completeConnection, disconnect, syncUpcomingForConnection,
  type CalendarProvider, type CalendarState,
} from "../lib/calendarSync.js";
import { badRequest, notFound } from "../lib/errors.js";
import { h, parse } from "../lib/http.js";
import { feedIcs } from "../lib/ics.js";

const NONCE_COOKIE = "sw_cal";
const asProvider = (p: string): CalendarProvider | null => (p === "google" || p === "microsoft" ? p : null);
const feedUrl = (token: string, staffId?: string) => `${config.apiUrl}/api/calendar/${token}.ics${staffId ? `?staff=${staffId}` : ""}`;

function feedToken(businessId: string) {
  const b = one("SELECT calendar_feed_token FROM businesses WHERE id = ?", businessId)!;
  if (b.calendar_feed_token) return b.calendar_feed_token as string;
  const token = randomBytes(24).toString("base64url");
  run("UPDATE businesses SET calendar_feed_token = ? WHERE id = ?", token, businessId);
  return token;
}

/** Mounted under /api/admin/:bid. */
export const adminCalendarRouter = Router({ mergeParams: true });
const bid = (req: Request) => req.params.bid as string;
adminCalendarRouter.use((req, _res, next) => {
  try {
    assertBusinessAccess(req.user, bid(req));
    next();
  } catch (err) {
    next(err);
  }
});

adminCalendarRouter.get("/calendars", h((req) => {
  const token = feedToken(bid(req));
  const business = one("SELECT email_admin_alerts FROM businesses WHERE id = ?", bid(req))!;
  return {
    providers: { google: calendarProviderEnabled("google"), microsoft: calendarProviderEnabled("microsoft") },
    emailAdminAlerts: !!business.email_admin_alerts,
    feed: { all: feedUrl(token) },
    staff: all("SELECT id, name, active FROM staff WHERE business_id = ? ORDER BY name", bid(req)).map((s) => ({
      ...s,
      feedUrl: feedUrl(token, s.id),
      connections: all(
        `SELECT id, provider, account_email, check_busy, reminder_min, last_synced_at, last_error, created_at,
                (SELECT COUNT(*) FROM calendar_events e WHERE e.connection_id = c.id) AS events
           FROM calendar_connections c WHERE staff_id = ?`, s.id,
      ),
    })),
  };
}));

/** Starts the Google/Microsoft consent screen for one staff member. The browser then navigates to `url`. */
adminCalendarRouter.post("/staff/:sid/calendar/:provider/connect", h((req, res) => {
  const provider = asProvider(req.params.provider as string);
  if (!provider || !calendarProviderEnabled(provider)) throw badRequest("That calendar isn't set up on this platform yet");
  const staff = one("SELECT id FROM staff WHERE id = ? AND business_id = ?", req.params.sid, bid(req));
  if (!staff) throw notFound("Staff member not found");
  const nonce = randomBytes(16).toString("hex");
  // Ties the callback to this browser, so a consent link can't be completed by someone else.
  res.cookie(NONCE_COOKIE, nonce, { httpOnly: true, secure: config.apiUrl.startsWith("https://"), sameSite: "lax", maxAge: 15 * 60_000, path: "/api/integrations" });
  const state: CalendarState = { staffId: staff.id, businessId: bid(req), userId: req.user!.id, nonce, provider };
  return { url: calendarAuthorizeUrl(state) };
}));

adminCalendarRouter.patch("/calendar-connections/:cid", h((req) => {
  const conn = one("SELECT c.* FROM calendar_connections c JOIN staff s ON s.id = c.staff_id WHERE c.id = ? AND s.business_id = ?", req.params.cid, bid(req));
  if (!conn) throw notFound();
  const body = parse(z.object({ check_busy: z.boolean(), reminder_min: z.number().int().min(0).max(24 * 60) }).partial(), req.body);
  if (body.check_busy !== undefined) run("UPDATE calendar_connections SET check_busy = ? WHERE id = ?", Number(body.check_busy), conn.id);
  if (body.reminder_min !== undefined) run("UPDATE calendar_connections SET reminder_min = ? WHERE id = ?", body.reminder_min, conn.id);
  return { ok: true };
}));

adminCalendarRouter.post("/calendar-connections/:cid/resync", h(async (req) => {
  const conn = one("SELECT c.* FROM calendar_connections c JOIN staff s ON s.id = c.staff_id WHERE c.id = ? AND s.business_id = ?", req.params.cid, bid(req));
  if (!conn) throw notFound();
  return { synced: await syncUpcomingForConnection(conn.id) };
}));

adminCalendarRouter.delete("/calendar-connections/:cid", h(async (req) => {
  const conn = one("SELECT c.* FROM calendar_connections c JOIN staff s ON s.id = c.staff_id WHERE c.id = ? AND s.business_id = ?", req.params.cid, bid(req));
  if (!conn) throw notFound();
  await disconnect(conn.id);
  audit(actorOf(req.user), bid(req), "calendar.disconnected", { connectionId: conn.id, provider: conn.provider });
  return { ok: true };
}));

/** A new feed address stops the old one working (e.g. if it was shared by mistake). */
adminCalendarRouter.post("/calendar-feed/regenerate", h((req) => {
  run("UPDATE businesses SET calendar_feed_token = NULL WHERE id = ?", bid(req));
  feedToken(bid(req));
  audit(actorOf(req.user), bid(req), "calendar.feed_regenerated", {});
  return { ok: true };
}));

adminCalendarRouter.put("/calendar-alerts", h((req) => {
  const body = parse(z.object({ emailAdminAlerts: z.boolean() }), req.body);
  run("UPDATE businesses SET email_admin_alerts = ? WHERE id = ?", Number(body.emailAdminAlerts), bid(req));
  return { ok: true };
}));

/** Public: OAuth return and the subscribable feed. */
export const calendarPublicRouter = Router();

calendarPublicRouter.get("/integrations/:provider/callback", h(async (req, res) => {
  const fail = (bizId: string | null, message: string) =>
    res.redirect(`${config.webUrl}/admin${bizId ? `/${bizId}/calendars` : ""}?calendarError=${encodeURIComponent(message)}`);
  let state: CalendarState;
  try {
    state = jwt.verify(String(req.query.state ?? ""), config.jwtSecret) as CalendarState;
  } catch {
    return fail(null, "The calendar connection expired. Please try again.");
  }
  const cookieNonce = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${NONCE_COOKIE}=`))?.slice(NONCE_COOKIE.length + 1);
  res.clearCookie(NONCE_COOKIE, { path: "/api/integrations" });
  if (state.provider !== req.params.provider || cookieNonce !== state.nonce) return fail(state.businessId, "The calendar connection couldn't be verified. Please try again.");
  if (req.query.error) return fail(state.businessId, req.query.error === "access_denied" ? "Calendar access was not allowed." : `Calendar connection failed (${req.query.error}).`);
  try {
    // The person who started it must still manage this business.
    const user = one("SELECT id, email, name, role FROM users WHERE id = ?", state.userId) as any;
    assertBusinessAccess(user, state.businessId);
    const conn = await completeConnection(state, String(req.query.code ?? ""));
    syncUpcomingForConnection(conn.id).catch((err) => console.error("initial calendar sync failed", err));
    res.redirect(`${config.webUrl}/admin/${state.businessId}/calendars?connected=${state.provider}`);
  } catch (err) {
    fail(state.businessId, (err as Error).message);
  }
}));

calendarPublicRouter.get("/calendar/:file", h((req, res) => {
  const token = String(req.params.file).replace(/\.ics$/, "");
  const business = token.length > 20 ? one("SELECT * FROM businesses WHERE calendar_feed_token = ?", token) : undefined;
  if (!business) throw notFound("Calendar not found");
  const staffId = typeof req.query.staff === "string" ? req.query.staff : undefined;
  const staff = staffId ? one("SELECT * FROM staff WHERE id = ? AND business_id = ?", staffId, business.id) : undefined;
  const bookings = all(
    `SELECT * FROM bookings WHERE business_id = ? AND status IN ('confirmed','completed','no_show') AND starts_at > ? ${staff ? "AND staff_id = ?" : ""} ORDER BY starts_at LIMIT 2000`,
    ...[business.id, DateTime.utc().minus({ days: 30 }).toISO(), ...(staff ? [staff.id] : [])],
  );
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(feedIcs(business, bookings, staff ? `${business.name}: ${staff.name}` : `${business.name} bookings`));
}));
