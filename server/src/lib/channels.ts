import { config } from "../config.js";
import { run, Row } from "../db.js";
import { decryptJson, encryptJson } from "./crypto.js";

/**
 * Each business's own customer communication channels: the email account its customers get emails
 * from, and the Twilio account its texts come from. Nothing customer-facing goes out through a
 * platform account, so a business that hasn't set a channel up simply doesn't send on it.
 */

export type EmailProvider = "none" | "smtp" | "resend";
export type SmsProvider = "none" | "twilio" | "test";

export interface EmailChannel {
  provider: EmailProvider;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  smtpHost?: string;
  smtpPort?: number;
  /** "ssl" = TLS from the start (port 465); "starttls" = upgrade after connecting (port 587). */
  smtpSecurity?: "ssl" | "starttls";
  smtpUser?: string;
  smtpPass?: string;
  resendApiKey?: string;
}

export interface SmsChannel {
  provider: SmsProvider;
  accountSid?: string;
  authToken?: string;
  messagingServiceSid?: string;
  fromNumber?: string;
}

/** How online appointments get their meeting link. Google Meet and Teams use the staff member's connected calendar. */
export type MeetingProvider = "none" | "google_meet" | "teams" | "zoom" | "ringcentral" | "custom";
export interface MeetingChannel {
  provider: MeetingProvider;
  /** Zoom Server-to-Server OAuth app (Zoom App Marketplace → Develop → Build app). */
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  /** RingCentral app using the JWT auth flow (developers.ringcentral.com → Console → Apps). */
  rcClientId?: string;
  rcClientSecret?: string;
  rcJwt?: string;
  /** The same link for every online appointment (a personal meeting room, for example). */
  customUrl?: string;
}

export interface Channels { email: EmailChannel; sms: SmsChannel; meetings: MeetingChannel }

export function channelsFor(business: Row): Channels {
  const raw = decryptJson<Partial<Channels>>(business.comms_config ?? "");
  return { email: { provider: "none", ...raw.email }, sms: { provider: "none", ...raw.sms }, meetings: { provider: "none", ...raw.meetings } };
}

export function saveChannels(businessId: string, channels: Omit<Channels, "meetings"> & { meetings?: MeetingChannel }) {
  run("UPDATE businesses SET comms_config = ? WHERE id = ?", encryptJson(channels), businessId);
}

/** Test mode (texts shown in the log, never sent) is for trying things out, not for live businesses. */
export const testModeAllowed = () => !config.isProduction || config.demoMode;

export function emailReady(business: Row) {
  const e = channelsFor(business).email;
  if (!e.fromEmail) return false;
  if (e.provider === "smtp") return !!(e.smtpHost && e.smtpUser && e.smtpPass);
  if (e.provider === "resend") return !!e.resendApiKey;
  return false;
}

export function smsConfigured(business: Row) {
  const s = channelsFor(business).sms;
  if (s.provider === "test") return testModeAllowed();
  if (s.provider === "twilio") return !!(s.accountSid && s.authToken && (s.messagingServiceSid || s.fromNumber));
  return false;
}

/** Texting is offered to customers only when the business has connected Twilio and switched texts on. */
export const smsReady = (business: Row) => !!business.sms_enabled && smsConfigured(business);

export const smsLive = (business: Row) => smsConfigured(business) && channelsFor(business).sms.provider === "twilio";

export const smsFrom = (business: Row) => {
  const s = channelsFor(business).sms;
  return s.provider === "test" ? "test-number" : s.fromNumber || s.messagingServiceSid || "";
};

export const twilioWebhookUrls = (businessId: string) => ({
  incoming: `${config.apiUrl}/api/webhooks/twilio/${businessId}/sms`,
  status: `${config.apiUrl}/api/webhooks/twilio/${businessId}/status`,
});
