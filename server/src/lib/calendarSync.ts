import { DateTime, Interval } from "luxon";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { all, audit, newId, one, run, Row } from "../db.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { badRequest } from "./errors.js";

/**
 * Two-way link between a staff member and their Google Calendar or Outlook calendar:
 * - every booking is written to it as an event (with a phone reminder) the moment it changes;
 * - their own busy events are read back so those times aren't offered to customers.
 * Changes made in Google/Outlook don't flow back into bookings; make those in Slotwise.
 */

export type CalendarProvider = "google" | "microsoft";
interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }

export const calendarProviderEnabled = (p: CalendarProvider) =>
  p === "google" ? !!(config.oauth.google.clientId && config.oauth.google.clientSecret)
    : !!(config.oauth.microsoft.clientId && config.oauth.microsoft.clientSecret);

export const calendarRedirectUri = (p: CalendarProvider) => `${config.apiUrl}/api/integrations/${p}/callback`;

const SCOPES: Record<CalendarProvider, string> = {
  google: "openid email https://www.googleapis.com/auth/calendar.events",
  microsoft: "openid email offline_access User.Read Calendars.ReadWrite",
};

export interface CalendarState { staffId: string; businessId: string; userId: string; nonce: string; provider: CalendarProvider }

export function calendarAuthorizeUrl(state: CalendarState) {
  const signed = jwt.sign(state, config.jwtSecret, { expiresIn: "15m" });
  if (state.provider === "google") {
    return `${config.oauth.google.authUrl}?` + new URLSearchParams({
      client_id: config.oauth.google.clientId, redirect_uri: calendarRedirectUri("google"), response_type: "code",
      scope: SCOPES.google, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: signed,
    });
  }
  return `${config.oauth.microsoft.authUrl}?` + new URLSearchParams({
    client_id: config.oauth.microsoft.clientId, redirect_uri: calendarRedirectUri("microsoft"), response_type: "code",
    response_mode: "query", scope: SCOPES.microsoft, prompt: "select_account", state: signed,
  });
}

async function tokenRequest(p: CalendarProvider, body: Record<string, string>) {
  const cfg = p === "google" ? config.oauth.google : config.oauth.microsoft;
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw badRequest(`Calendar connection failed: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

/** Finishes the consent screen: stores the (encrypted) tokens on the staff member. */
export async function completeConnection(state: CalendarState, code: string) {
  const json = await tokenRequest(state.provider, { grant_type: "authorization_code", code, redirect_uri: calendarRedirectUri(state.provider), ...(state.provider === "microsoft" ? { scope: SCOPES.microsoft } : {}) });
  const claims = json.id_token ? (jwt.decode(json.id_token) as Record<string, any>) : {};
  const email = claims?.email ?? claims?.preferred_username ?? null;
  const tokens: Tokens = { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  const existing = one("SELECT id FROM calendar_connections WHERE staff_id = ? AND provider = ?", state.staffId, state.provider);
  const id = existing?.id ?? newId("cal");
  if (existing) {
    run("UPDATE calendar_connections SET account_email = ?, tokens = ?, last_error = NULL WHERE id = ?", email, encryptJson(tokens), id);
  } else {
    run("INSERT INTO calendar_connections (id, staff_id, provider, account_email, tokens) VALUES (?,?,?,?,?)", id, state.staffId, state.provider, email, encryptJson(tokens));
  }
  audit({ id: state.userId, label: `calendar:${state.provider}` }, state.businessId, "calendar.connected", { staffId: state.staffId, provider: state.provider, email });
  return one("SELECT * FROM calendar_connections WHERE id = ?", id)!;
}

async function accessToken(conn: Row, force = false): Promise<string> {
  const t = decryptJson<Tokens>(conn.tokens);
  if (!force && t.expiresAt > Date.now() + 60_000) return t.accessToken;
  if (!t.refreshToken) throw new Error("Calendar access expired. Please reconnect.");
  const json = await tokenRequest(conn.provider, { grant_type: "refresh_token", refresh_token: t.refreshToken });
  const next: Tokens = { accessToken: json.access_token, refreshToken: json.refresh_token ?? t.refreshToken, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  run("UPDATE calendar_connections SET tokens = ? WHERE id = ?", encryptJson(next), conn.id);
  conn.tokens = encryptJson(next);
  return next.accessToken;
}

/** Calls the provider's API, refreshing the access token once if it has expired. */
async function call(conn: Row, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const base = conn.provider === "google" ? config.oauth.calendarApis.google : config.oauth.calendarApis.graph;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${await accessToken(conn, attempt > 0)}`, "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 && attempt === 0) continue;
    const json: any = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  }
  throw new Error("Calendar refused our access. Please reconnect.");
}

const calPath = (conn: Row) => (conn.calendar_id === "primary" ? "" : `/calendars/${encodeURIComponent(conn.calendar_id)}`);

function eventFor(conn: Row, b: Row) {
  const business = one("SELECT * FROM businesses WHERE id = ?", b.business_id)!;
  const service = one("SELECT name FROM services WHERE id = ?", b.service_id)!;
  const title = `${service.name}: ${b.customer_name}`;
  const description = [
    `Booked through Slotwise · code ${b.code}`,
    `Customer: ${b.customer_name}`,
    `Email: ${b.customer_email}`,
    b.customer_phone ? `Phone: ${b.customer_phone}` : "",
    b.notes ? `Notes: ${b.notes}` : "",
    `Manage: ${config.webUrl}/admin/${business.id}/bookings`,
    "Change or cancel it in Slotwise so the customer is told; edits made here aren't sent to them.",
  ].filter(Boolean).join("\n");
  const location = business.address ?? business.name;
  if (conn.provider === "google") {
    return {
      summary: title, description, location,
      start: { dateTime: DateTime.fromISO(b.starts_at).toUTC().toISO(), timeZone: business.timezone },
      end: { dateTime: DateTime.fromISO(b.ends_at).toUTC().toISO(), timeZone: business.timezone },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: conn.reminder_min }] },
      extendedProperties: { private: { slotwiseBookingId: b.id } },
    };
  }
  const utc = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyy-LL-dd'T'HH:mm:ss");
  return {
    subject: title, body: { contentType: "text", content: description }, location: { displayName: location },
    start: { dateTime: utc(b.starts_at), timeZone: "UTC" }, end: { dateTime: utc(b.ends_at), timeZone: "UTC" },
    isReminderOn: true, reminderMinutesBeforeStart: conn.reminder_min, showAs: "busy",
  };
}

async function upsertEvent(conn: Row, b: Row) {
  const link = one("SELECT external_id FROM calendar_events WHERE booking_id = ? AND connection_id = ?", b.id, conn.id);
  const body = eventFor(conn, b);
  const prefix = conn.provider === "google" ? `/calendars/${encodeURIComponent(conn.calendar_id)}/events` : `/me${calPath(conn)}/events`;
  if (link) {
    const itemPath = conn.provider === "google" ? `${prefix}/${encodeURIComponent(link.external_id)}` : `/me/events/${encodeURIComponent(link.external_id)}`;
    const res = await call(conn, "PATCH", itemPath, body);
    if (res.ok) return;
    if (res.status !== 404 && res.status !== 410) throw new Error(res.json.error?.message ?? `Calendar update failed (${res.status})`);
    // Someone deleted it in their calendar: put it back.
  }
  const res = await call(conn, "POST", prefix, body);
  if (!res.ok || !res.json.id) throw new Error(res.json.error?.message ?? `Calendar create failed (${res.status})`);
  run("INSERT OR REPLACE INTO calendar_events (booking_id, connection_id, external_id) VALUES (?,?,?)", b.id, conn.id, res.json.id);
}

async function deleteEvent(conn: Row, bookingId: string) {
  const link = one("SELECT external_id FROM calendar_events WHERE booking_id = ? AND connection_id = ?", bookingId, conn.id);
  if (!link) return;
  const path = conn.provider === "google"
    ? `/calendars/${encodeURIComponent(conn.calendar_id)}/events/${encodeURIComponent(link.external_id)}`
    : `/me/events/${encodeURIComponent(link.external_id)}`;
  const res = await call(conn, "DELETE", path);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(res.json.error?.message ?? `Calendar delete failed (${res.status})`);
  run("DELETE FROM calendar_events WHERE booking_id = ? AND connection_id = ?", bookingId, conn.id);
}

async function guarded(conn: Row, fn: () => Promise<void>) {
  try {
    await fn();
    run("UPDATE calendar_connections SET last_synced_at = datetime('now'), last_error = NULL WHERE id = ?", conn.id);
  } catch (err) {
    run("UPDATE calendar_connections SET last_error = ? WHERE id = ?", (err as Error).message.slice(0, 300), conn.id);
  }
}

const SHOWN = ["confirmed", "completed", "no_show"];

/** Puts one booking into (or takes it out of) every connected calendar it belongs in. */
export async function syncBookingToCalendars(bookingId: string) {
  const b = one("SELECT * FROM bookings WHERE id = ?", bookingId);
  if (!b) return;
  // Connections holding an event for this booking, plus the current staff member's.
  const conns = all(
    `SELECT DISTINCT c.* FROM calendar_connections c
      WHERE c.staff_id = ? OR c.id IN (SELECT connection_id FROM calendar_events WHERE booking_id = ?)`,
    b.staff_id, b.id,
  );
  for (const conn of conns) {
    await guarded(conn, async () => {
      if (SHOWN.includes(b.status) && conn.staff_id === b.staff_id) await upsertEvent(conn, b);
      else await deleteEvent(conn, b.id); // cancelled, unpaid, or moved to another staff member
    });
    busyCache.clear();
  }
}

/** After connecting: copy upcoming bookings in. */
export async function syncUpcomingForConnection(connId: string) {
  const conn = one("SELECT * FROM calendar_connections WHERE id = ?", connId);
  if (!conn) return 0;
  const upcoming = all("SELECT id FROM bookings WHERE staff_id = ? AND status = 'confirmed' AND ends_at > ? ORDER BY starts_at LIMIT 500", conn.staff_id, DateTime.utc().toISO());
  for (const b of upcoming) await syncBookingToCalendars(b.id);
  return upcoming.length;
}

/** Disconnecting removes our future events from their calendar (best effort), then forgets the tokens. */
export async function disconnect(connId: string) {
  const conn = one("SELECT * FROM calendar_connections WHERE id = ?", connId);
  if (!conn) return;
  const future = all(
    `SELECT e.booking_id FROM calendar_events e JOIN bookings b ON b.id = e.booking_id WHERE e.connection_id = ? AND b.ends_at > ?`,
    conn.id, DateTime.utc().toISO(),
  );
  for (const f of future) await deleteEvent(conn, f.booking_id).catch(() => {});
  run("DELETE FROM calendar_connections WHERE id = ?", conn.id);
  busyCache.clear();
}

// ---------- Reading busy times ----------

const busyCache = new Map<string, { at: number; intervals: Interval[] }>();
const CACHE_MS = 60_000;

async function listBusy(conn: Row, from: DateTime, to: DateTime, zone: string): Promise<Interval[]> {
  const ours = new Set(all("SELECT external_id FROM calendar_events WHERE connection_id = ?", conn.id).map((r) => r.external_id));
  const out: Interval[] = [];
  if (conn.provider === "google") {
    const q = new URLSearchParams({ timeMin: from.toUTC().toISO()!, timeMax: to.toUTC().toISO()!, singleEvents: "true", maxResults: "2500", fields: "items(id,start,end,transparency,status)" });
    const res = await call(conn, "GET", `/calendars/${encodeURIComponent(conn.calendar_id)}/events?${q}`);
    if (!res.ok) throw new Error(res.json.error?.message ?? `Calendar read failed (${res.status})`);
    for (const e of res.json.items ?? []) {
      if (ours.has(e.id) || e.status === "cancelled" || e.transparency === "transparent") continue;
      // All-day events carry dates (end exclusive), read in the business's time zone.
      const s = e.start?.dateTime ? DateTime.fromISO(e.start.dateTime) : DateTime.fromISO(e.start?.date, { zone });
      const en = e.end?.dateTime ? DateTime.fromISO(e.end.dateTime) : DateTime.fromISO(e.end?.date, { zone });
      if (s.isValid && en.isValid && en > s) out.push(Interval.fromDateTimes(s, en));
    }
  } else {
    const q = new URLSearchParams({ startDateTime: from.toUTC().toISO()!, endDateTime: to.toUTC().toISO()!, $select: "id,start,end,showAs,isCancelled", $top: "1000" });
    const res = await call(conn, "GET", `/me${calPath(conn)}/calendarView?${q}`, undefined, { Prefer: 'outlook.timezone="UTC"' });
    if (!res.ok) throw new Error(res.json.error?.message ?? `Calendar read failed (${res.status})`);
    for (const e of res.json.value ?? []) {
      if (ours.has(e.id) || e.isCancelled || ["free", "workingElsewhere"].includes(e.showAs)) continue;
      const s = DateTime.fromISO(`${e.start.dateTime}`.replace(/Z?$/, "Z")), en = DateTime.fromISO(`${e.end.dateTime}`.replace(/Z?$/, "Z"));
      if (s.isValid && en.isValid && en > s) out.push(Interval.fromDateTimes(s, en));
    }
  }
  return out;
}

/**
 * Busy times from connected calendars for these staff, keyed by staff id. Fails open: if a
 * calendar can't be read (outage, revoked access), its slots stay bookable and the error is shown in admin.
 */
export async function externalBusy(staffIds: string[], from: DateTime, to: DateTime, zone: string) {
  const result = new Map<string, Interval[]>();
  if (!staffIds.length) return result;
  const conns = all(`SELECT * FROM calendar_connections WHERE check_busy = 1 AND staff_id IN (${staffIds.map(() => "?").join(",")})`, ...staffIds);
  await Promise.all(conns.map(async (conn) => {
    const key = `${conn.id}:${from.toISO()}:${to.toISO()}`;
    let entry = busyCache.get(key);
    if (!entry || entry.at < Date.now() - CACHE_MS) {
      try {
        entry = { at: Date.now(), intervals: await listBusy(conn, from, to, zone) };
        busyCache.set(key, entry);
        run("UPDATE calendar_connections SET last_error = NULL WHERE id = ? AND last_error LIKE 'Calendar read%'", conn.id);
      } catch (err) {
        run("UPDATE calendar_connections SET last_error = ? WHERE id = ?", (err as Error).message.slice(0, 300), conn.id);
        return;
      }
    }
    result.set(conn.staff_id, [...(result.get(conn.staff_id) ?? []), ...entry.intervals]);
  }));
  return result;
}
