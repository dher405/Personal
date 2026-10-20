import { config } from "../config.js";
import { one, run, Row } from "../db.js";
import { channelsFor, type MeetingChannel, type MeetingProvider } from "./channels.js";

/**
 * Online appointments get a meeting link from the business's chosen tool:
 * - Google Meet / Microsoft Teams: created on the event in the staff member's connected Google / Outlook calendar
 *   (lib/calendarSync.ts adds the conference and saves the join link back on the booking);
 * - Zoom / RingCentral Video: created through the business's own app credentials;
 * - a fixed link the business pastes in.
 * The link is made before the confirmation goes out, so it's in the email, the calendar invite, the text and the manage page.
 */

export const MEETING_LABEL: Record<MeetingProvider, string> = {
  none: "Not set up", google_meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom", ringcentral: "RingCentral Video", custom: "your meeting link",
};
/** Which calendar connection makes the link, for the providers that live on a calendar event. */
export const CALENDAR_FOR: Partial<Record<MeetingProvider, "google" | "microsoft">> = { google_meet: "google", teams: "microsoft" };

export const meetingsReady = (business: Row) => {
  const m = channelsFor(business).meetings;
  switch (m.provider) {
    case "zoom": return !!(m.zoomAccountId && m.zoomClientId && m.zoomClientSecret);
    case "ringcentral": return !!(m.rcClientId && m.rcClientSecret && m.rcJwt);
    case "custom": return !!m.customUrl;
    case "google_meet": case "teams": return true; // per staff member: needs their calendar connected
    default: return false;
  }
};

/** Where a booking happens, for emails, invites and texts. */
export function whereText(b: Row, business: Row) {
  if (b.meeting_mode !== "online") return business.address ? `In person at ${business.address}` : `In person at ${business.name}`;
  return b.meeting_url ? `Online (${MEETING_LABEL[(b.meeting_provider ?? "custom") as MeetingProvider]}): ${b.meeting_url}` : `Online: ${business.name} will send you the meeting link`;
}

// ---------- Zoom (Server-to-Server OAuth) ----------

async function zoomToken(m: MeetingChannel) {
  const res = await fetch(`${config.meetingApis.zoomOauth}?grant_type=account_credentials&account_id=${encodeURIComponent(m.zoomAccountId!)}`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${m.zoomClientId}:${m.zoomClientSecret}`).toString("base64")}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Zoom didn't accept the app credentials: ${json.reason ?? json.error ?? res.status}`);
  return json.access_token as string;
}

async function zoom(m: MeetingChannel, method: string, path: string, body?: unknown) {
  const res = await fetch(`${config.meetingApis.zoomApi}${path}`, {
    method, headers: { Authorization: `Bearer ${await zoomToken(m)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`Zoom: ${json.message ?? res.status}`);
  return json;
}

const zoomTimes = (b: Row) => ({
  start_time: new Date(b.starts_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
  duration: Math.max(5, Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000)),
});

// ---------- RingCentral Video (JWT auth flow) ----------

async function rcToken(m: MeetingChannel) {
  const res = await fetch(`${config.meetingApis.ringcentral}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${m.rcClientId}:${m.rcClientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: m.rcJwt! }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`RingCentral didn't accept the app credentials: ${json.error_description ?? json.message ?? res.status}`);
  return json.access_token as string;
}

async function rc(m: MeetingChannel, method: string, path: string, body?: unknown) {
  const res = await fetch(`${config.meetingApis.ringcentral}${path}`, {
    method, headers: { Authorization: `Bearer ${await rcToken(m)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`RingCentral: ${json.message ?? json.errorCode ?? res.status}`);
  return json;
}

/** Checks the business's saved Zoom / RingCentral credentials (the "Test" button). */
export async function testMeetings(business: Row): Promise<string> {
  const m = channelsFor(business).meetings;
  if (m.provider === "zoom") {
    const me = await zoom(m, "GET", "/users/me");
    return `Connected to Zoom as ${me.email ?? me.first_name ?? "your account"}. New online bookings will get a Zoom meeting.`;
  }
  if (m.provider === "ringcentral") {
    const me = await rc(m, "GET", "/restapi/v1.0/account/~/extension/~");
    return `Connected to RingCentral as ${me.name ?? me.contact?.email ?? "your account"}. New online bookings will get a RingCentral Video meeting.`;
  }
  if (m.provider === "custom") return `Every online booking will use ${m.customUrl}.`;
  if (m.provider === "google_meet" || m.provider === "teams") {
    const kind = CALENDAR_FOR[m.provider]!;
    const staff = one<{ total: number; connected: number }>(
      `SELECT COUNT(*) AS total, SUM(EXISTS (SELECT 1 FROM calendar_connections c WHERE c.staff_id = s.id AND c.provider = ?)) AS connected
         FROM staff s WHERE s.business_id = ? AND s.active = 1`, kind, business.id,
    )!;
    const where = kind === "google" ? "Google Calendar" : "Outlook";
    return staff.connected
      ? `${staff.connected} of ${staff.total} staff have ${where} connected, so their online bookings get a ${MEETING_LABEL[m.provider]} link.${staff.connected < staff.total ? ` Connect ${where} for the others under Calendar sync.` : ""}`
      : `No staff member has ${where} connected yet. Connect it under Calendar sync; that's where ${MEETING_LABEL[m.provider]} links are made.`;
  }
  throw new Error("Choose a meeting tool first");
}

/**
 * Makes sure an online booking has a working meeting link for its current time, before the customer is told.
 * Never throws: a failure is saved on the booking (meeting_error) so the business can retry or paste a link.
 */
export async function prepareMeeting(bookingId: string, change: "confirmed" | "rescheduled" | "cancelled"): Promise<void> {
  const b = one("SELECT * FROM bookings WHERE id = ?", bookingId);
  if (!b || b.meeting_mode !== "online") return;
  const business = one("SELECT * FROM businesses WHERE id = ?", b.business_id)!;
  const m = channelsFor(business).meetings;
  const fail = (message: string) => { run("UPDATE bookings SET meeting_error = ? WHERE id = ?", message.slice(0, 300), b.id); };
  try {
    if (change === "cancelled") {
      if (b.meeting_provider === "zoom" && b.meeting_external_id) await zoom(m, "DELETE", `/meetings/${b.meeting_external_id}`);
      if (b.meeting_provider === "ringcentral" && b.meeting_external_id) await rc(m, "DELETE", `/rcvideo/v2/bridges/${b.meeting_external_id}`);
      return; // Google Meet / Teams links go with the calendar event, which calendar sync removes.
    }
    // A link already made with the current tool: just keep it in step with the time.
    if (b.meeting_url && b.meeting_provider === m.provider) {
      if (change === "rescheduled" && m.provider === "zoom" && b.meeting_external_id) await zoom(m, "PATCH", `/meetings/${b.meeting_external_id}`, zoomTimes(b));
      if (CALENDAR_FOR[m.provider]) await ensureCalendarMeeting(b); // a new staff member's calendar may make a new link
      run("UPDATE bookings SET meeting_error = NULL WHERE id = ?", b.id);
      return;
    }
    if (b.meeting_url && b.meeting_provider === "manual") return; // pasted in by the business: leave it alone
    const service = one("SELECT name FROM services WHERE id = ?", b.service_id)!;
    const topic = `${service.name}: ${b.customer_name} (${business.name})`;
    switch (m.provider) {
      case "custom":
        if (!m.customUrl) return fail("Online meetings use a fixed link, but none is saved (Online meetings tab)");
        run("UPDATE bookings SET meeting_provider = 'custom', meeting_url = ?, meeting_external_id = NULL, meeting_error = NULL WHERE id = ?", m.customUrl, b.id);
        return;
      case "zoom": {
        const z = await zoom(m, "POST", "/users/me/meetings", {
          topic, type: 2, ...zoomTimes(b), timezone: business.timezone, agenda: `Booking ${b.code}`,
          settings: { join_before_host: false, waiting_room: true },
        });
        run("UPDATE bookings SET meeting_provider = 'zoom', meeting_url = ?, meeting_external_id = ?, meeting_error = NULL WHERE id = ?", z.join_url, String(z.id), b.id);
        return;
      }
      case "ringcentral": {
        const bridge = await rc(m, "POST", "/rcvideo/v2/account/~/extension/~/bridges", { name: topic, type: "Instant" });
        if (!bridge.discovery?.web) throw new Error("RingCentral didn't return a join link");
        run("UPDATE bookings SET meeting_provider = 'ringcentral', meeting_url = ?, meeting_external_id = ?, meeting_error = NULL WHERE id = ?", bridge.discovery.web, String(bridge.id), b.id);
        return;
      }
      case "google_meet": case "teams":
        run("UPDATE bookings SET meeting_provider = ?, meeting_url = NULL WHERE id = ?", m.provider, b.id);
        await ensureCalendarMeeting(one("SELECT * FROM bookings WHERE id = ?", b.id)!);
        return;
      default:
        return fail("Online meetings aren't set up yet (Online meetings tab), so no link was created");
    }
  } catch (err) {
    console.error("meeting link failed", err);
    fail((err as Error).message);
  }
}

/** Google Meet / Teams: the link comes from the event in the staff member's own calendar. */
async function ensureCalendarMeeting(b: Row) {
  const kind = CALENDAR_FOR[b.meeting_provider as MeetingProvider]!;
  const staff = one("SELECT name FROM staff WHERE id = ?", b.staff_id)!;
  const conn = one("SELECT * FROM calendar_connections WHERE staff_id = ? AND provider = ?", b.staff_id, kind);
  const label = MEETING_LABEL[b.meeting_provider as MeetingProvider];
  if (!conn) {
    run("UPDATE bookings SET meeting_error = ? WHERE id = ?",
      `${staff.name} hasn't connected ${kind === "google" ? "Google Calendar" : "Outlook"} (Calendar sync), which is where ${label} links are made`, b.id);
    return;
  }
  const { syncBookingToCalendars } = await import("./calendarSync.js");
  await syncBookingToCalendars(b.id);
  const after = one("SELECT meeting_url FROM bookings WHERE id = ?", b.id)!;
  if (!after.meeting_url) {
    const err = one("SELECT last_error FROM calendar_connections WHERE id = ?", conn.id)?.last_error;
    run("UPDATE bookings SET meeting_error = ? WHERE id = ?", `Couldn't create the ${label} link${err ? `: ${err}` : ""}`, b.id);
  }
}
