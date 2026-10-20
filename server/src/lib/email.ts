import nodemailer from "nodemailer";
import { config } from "../config.js";
import { newId, one, run, type Row } from "../db.js";
import { channelsFor, emailReady, type EmailChannel } from "./channels.js";

export interface Attachment { filename: string; content: string; contentType: string }
export interface Email { to: string; subject: string; text: string; html?: string; attachments?: Attachment[] }

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * Platform email (to business owners: password resets, usage alerts, booking alerts) through Resend or Postmark (whichever key is set).
 * Without either, emails are printed to the server log so flows still work in
 * development; callers that need a fallback (password reset) also return the link.
 */
export const emailLive = () => !!(config.email.resendApiKey || config.email.postmarkToken);

export async function sendEmail(msg: Email): Promise<{ delivered: boolean }> {
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

async function deliver(e: EmailChannel, msg: Email, fromName: string) {
  const from = `${quoteName(e.fromName || fromName)} <${e.fromEmail}>`;
  if (e.provider === "smtp") {
    await smtpTransport(e).sendMail({
      from, to: msg.to, replyTo: e.replyTo || undefined, subject: msg.subject, text: msg.text, html: msg.html,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
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
  if (!emailReady(business)) return record("not_sent", "Customer email isn't set up yet (Admin → Email)");
  try {
    await deliver(e, msg, business.name);
    return record("sent");
  } catch (err) {
    console.error("business email failed", err);
    return record("failed", (err as Error).message.slice(0, 500));
  }
}
