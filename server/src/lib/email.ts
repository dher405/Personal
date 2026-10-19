import { config } from "../config.js";

export interface Email { to: string; subject: string; text: string; html?: string }

/**
 * Transactional email through Resend or Postmark (whichever key is set).
 * Without either, emails are printed to the server log so flows still work in
 * development; callers that need a fallback (password reset) also return the link.
 */
export const emailLive = () => !!(config.email.resendApiKey || config.email.postmarkToken);

export async function sendEmail(msg: Email): Promise<{ delivered: boolean }> {
  if (config.email.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.email.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.email.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
    return { delivered: true };
  }
  if (config.email.postmarkToken) {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": config.email.postmarkToken, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ From: config.email.from, To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, MessageStream: "outbound" }),
    });
    if (!res.ok) throw new Error(`Postmark error ${res.status}: ${await res.text()}`);
    return { delivered: true };
  }
  if (process.env.NODE_ENV !== "test") console.log(`[email:not-sent] to ${msg.to}: ${msg.subject}\n${msg.text}`);
  return { delivered: false };
}
