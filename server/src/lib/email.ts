import nodemailer from "nodemailer";
import { config } from "../config.js";
import { newId, one, run, type Row } from "../db.js";
import { channelsFor, emailReady, type EmailChannel } from "./channels.js";
import { showsPoweredBy } from "./plans.js";

export interface Attachment { filename: string; content: string; contentType: string }
export interface Email { to: string; subject: string; text: string; html?: string; attachments?: Attachment[] }

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * Platform email (to business owners: password resets, usage alerts, booking alerts) through Resend or Postmark (whichever key is set).
 * Without either, emails are printed to the server log so flows still work in
 * development; callers that need a fallback (password reset) also return the link.
 */
export const emailLive = () => !!(config.email.resendApiKey || config.email.postmarkToken);

/**
 * The last time the platform's email provider refused a message (cleared by the next one it accepts), so the super
 * admin overview can say what's wrong; sign-in codes depend on it.
 */
export function platformEmailFailure(): { at: string; error: string } | null {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'email_failure'");
  return row ? JSON.parse(row.value) : null;
}

export async function sendEmail(msg: Email): Promise<{ delivered: boolean }> {
  try {
    const result = await sendPlatformEmail(msg);
    if (result.delivered) run("DELETE FROM platform_settings WHERE key = 'email_failure'");
    return result;
  } catch (err) {
    run("INSERT INTO platform_settings (key, value) VALUES ('email_failure', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ at: new Date().toISOString(), error: (err as Error).message.slice(0, 500) }));
    throw err;
  }
}

async function sendPlatformEmail(msg: Email): Promise<{ delivered: boolean }> {
  if (config.email.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.email.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.email.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: b64(a.content), content_type: a.contentType })),
      }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
    return { delivered: true };
  }
  if (config.email.postmarkToken) {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": config.email.postmarkToken, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        From: config.email.from, To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, MessageStream: "outbound",
        Attachments: msg.attachments?.map((a) => ({ Name: a.filename, Content: b64(a.content), ContentType: a.contentType })),
      }),
    });
    if (!res.ok) throw new Error(`Postmark error ${res.status}: ${await res.text()}`);
    return { delivered: true };
  }
  if (process.env.NODE_ENV !== "test") console.log(`[email:not-sent] to ${msg.to}: ${msg.subject}\n${msg.text}`);
  return { delivered: false };
}

// ---------- Emails to a business's customers: always from the business's own email account ----------

export interface BusinessEmail extends Email { kind: string; bookingId?: string | null }

const quoteName = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

/** Opens one connection to the business's own mail server (Gmail, Microsoft 365, their host…). */
function smtpTransport(e: EmailChannel) {
  const ssl = (e.smtpSecurity ?? (e.smtpPort === 465 ? "ssl" : "starttls")) === "ssl";
  return nodemailer.createTransport({
    host: e.smtpHost, port: e.smtpPort ?? (ssl ? 465 : 587), secure: ssl, requireTLS: !ssl,
    auth: { user: e.smtpUser, pass: e.smtpPass },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

const UNREACHABLE = new Set(["ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED", "EHOSTUNREACH", "ECONNRESET", "ESOCKET", "ECONNECTION"]);

/**
 * Mail servers are tried address by address (IPv4 first), and the error reported is the last one, often a
 * misleading IPv6 "ENETUNREACH". When nothing could be reached, say so plainly: the usual cause is the
 * hosting provider blocking outgoing mail ports (Render's free plan blocks 25, 465 and 587).
 */
function explainSmtpError(err: any, e: EmailChannel): Error {
  const code = String(err?.code ?? "");
  const where = `${e.smtpHost}:${e.smtpPort ?? (e.smtpSecurity === "ssl" ? 465 : 587)}`;
  if (UNREACHABLE.has(code) || /ENETUNREACH|ETIMEDOUT|ECONNREFUSED|timeout/i.test(String(err?.message))) {
    return new Error(`Couldn't connect to ${where}. The server Slotwise runs on may be blocking outgoing email ports (some hosts, including Render's free plan, block them). Use Resend instead, or ask your Slotwise administrator. (${code || err?.message})`);
  }
  if (code === "EAUTH") return new Error(`${e.smtpHost} didn't accept the user name and password. For Gmail, Yahoo and iCloud use an app password, not your normal password. (${err.response ?? err.message})`);
  if (code === "EENVELOPE" || /sender|from address/i.test(String(err?.response))) return new Error(`${e.smtpHost} wouldn't send from ${e.fromEmail}. Use the address of the account you signed in with, or an alias it's allowed to send as. (${err.response ?? err.message})`);
  return err instanceof Error ? err : new Error(String(err));
}

async function deliver(e: EmailChannel, msg: Email, fromName: string) {
  const from = `${quoteName(e.fromName || fromName)} <${e.fromEmail}>`;
  if (e.provider === "smtp") {
    try {
      await smtpTransport(e).sendMail({
        from, to: msg.to, replyTo: e.replyTo || undefined, subject: msg.subject, text: msg.text, html: msg.html,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
    } catch (err) {
      throw explainSmtpError(err, e);
    }
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${e.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [msg.to], reply_to: e.replyTo || undefined, subject: msg.subject, text: msg.text, html: msg.html,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: b64(a.content), content_type: a.contentType })),
    }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

/** Sends through the business's own email account and records it in the business's email log. Never throws. */
export async function sendBusinessEmail(business: Row, msg: BusinessEmail): Promise<Row> {
  const e = channelsFor(business).email;
  const id = newId("eml");
  const record = (status: "sent" | "failed" | "not_sent", error?: string) => {
    run(
      `INSERT INTO email_messages (id, business_id, booking_id, kind, to_email, from_email, subject, body, status, error) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, business.id, msg.bookingId ?? null, msg.kind, msg.to, e.fromEmail ?? null, msg.subject, msg.text, status, error ?? null,
    );
    return one("SELECT * FROM email_messages WHERE id = ?", id)!;
  };
  if (business.is_demo) return record("not_sent", "Demo business: emails aren't sent");
  if (!emailReady(business)) return record("not_sent", "Customer email isn't set up yet (Admin → Email)");
  // Free plans carry a small "Powered by Slotwise" line, which helps other businesses find it.
  if (showsPoweredBy(business)) msg = { ...msg, text: `${msg.text}\n\n--\nBooking powered by Slotwise. Take bookings like this for free: ${config.webUrl}/?ref=email` };
  try {
    await deliver(e, msg, business.name);
    return record("sent");
  } catch (err) {
    console.error("business email failed", err);
    return record("failed", (err as Error).message.slice(0, 500));
  }
}
