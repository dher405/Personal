import { config } from "../config.js";
import { all, audit, newId, one, run, tx, Row } from "../db.js";
import type { AuthUser } from "./auth.js";
import { emailLive, sendEmail } from "./email.js";
import { badRequest, notFound } from "./errors.js";

/**
 * A simple support desk between each business and the platform. A business opens a case from its
 * portal; the super admin answers it under Super admin → Support. Everyone is emailed (through the
 * platform's email account) with a link back to the case, where replies are written.
 */

export const CATEGORIES = { bookings: "Bookings & calendar", payments: "Payments", billing: "My plan & billing", email_texts: "Emails & texts", website: "Website & embed", account: "Account & sign-in", other: "Something else" } as const;
export type Category = keyof typeof CATEGORIES;
export type CaseStatus = "open" | "waiting" | "resolved";

export interface SupportSettings {
  /** Who hears about support activity (the super admin's own inboxes). */
  notifyEmails: string[];
  onNewCase: boolean;
  onBusinessReply: boolean;
  /** Also copy the notify list on replies sent from Super admin (handy when several people answer cases). */
  onSupportReply: boolean;
}

const DEFAULTS: SupportSettings = { notifyEmails: [], onNewCase: true, onBusinessReply: true, onSupportReply: false };

export function supportSettings(): SupportSettings {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'support'");
  const saved = row ? JSON.parse(row.value) : {};
  // Until a list is saved, tell the super admin account(s).
  const fallback = all<{ email: string }>("SELECT email FROM users WHERE role = 'superadmin' ORDER BY created_at").map((u) => u.email);
  return { ...DEFAULTS, ...saved, notifyEmails: saved.notifyEmails?.length ? saved.notifyEmails : fallback };
}

export function saveSupportSettings(s: SupportSettings) {
  run("INSERT INTO platform_settings (key, value) VALUES ('support', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(s));
}

export const caseRef = (number: number) => `SW-${number}`;
const businessLink = (c: Row) => `${config.webUrl}/admin/${c.business_id}/support/${c.id}`;
const superLink = (c: Row) => `${config.webUrl}/super/support/${c.id}`;

export function getCase(id: string) {
  const c = one("SELECT * FROM support_cases WHERE id = ?", id);
  if (!c) throw notFound("Case not found");
  return c;
}

export function serializeCase(c: Row, withMessages = false) {
  const business = one("SELECT name FROM businesses WHERE id = ?", c.business_id);
  const last = one("SELECT author_role, created_at FROM support_messages WHERE case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", c.id);
  return {
    id: c.id, number: c.number, ref: caseRef(c.number), businessId: c.business_id, businessName: business?.name ?? "",
    subject: c.subject, category: c.category, categoryLabel: CATEGORIES[c.category as Category] ?? c.category,
    status: c.status, replyEmail: c.reply_email, createdAt: c.created_at, updatedAt: c.updated_at,
    lastReplyBy: last?.author_role ?? null,
    messageCount: one<{ n: number }>("SELECT COUNT(*) AS n FROM support_messages WHERE case_id = ?", c.id)!.n,
    ...(withMessages ? { messages: all("SELECT id, author_name, author_role, body, created_at FROM support_messages WHERE case_id = ? ORDER BY created_at, rowid", c.id) } : {}),
  };
}

const quote = (body: string) => body.split("\n").map((l) => `> ${l}`).join("\n");

/** Best-effort: support email failures are logged, never block the case being saved. */
async function mail(to: string[], subject: string, text: string) {
  for (const address of [...new Set(to.map((t) => t.trim().toLowerCase()).filter(Boolean))]) {
    await sendEmail({ to: address, subject, text }).catch((err) => console.error("support email failed", err));
  }
}

export function createCase(business: Row, user: AuthUser, input: { subject: string; body: string; replyEmail: string; category: Category }) {
  const c = tx(() => {
    const number = one<{ n: number }>("SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM support_cases")!.n;
    const id = newId("case");
    run(
      "INSERT INTO support_cases (id, number, business_id, opened_by, reply_email, subject, category) VALUES (?,?,?,?,?,?,?)",
      id, number, business.id, user.id, input.replyEmail.trim().toLowerCase(), input.subject.trim(), input.category,
    );
    run("INSERT INTO support_messages (id, case_id, author_id, author_name, author_role, body) VALUES (?,?,?,?, 'business', ?)",
      newId("msg"), id, user.id, user.name || user.email, input.body.trim());
    audit({ id: user.id, label: `admin:${user.email}` }, business.id, "support.case_opened", { caseId: id, number });
    return getCase(id);
  });
  const ref = caseRef(c.number);
  const settings = supportSettings();
  if (settings.onNewCase) {
    mail(settings.notifyEmails, `[${ref}] New support case from ${business.name}: ${c.subject}`, [
      `${business.name} opened a support case.`,
      `Category: ${CATEGORIES[input.category]}\nFrom: ${user.name || user.email} (reply email: ${c.reply_email})`,
      quote(input.body.trim()),
      `Answer it here: ${superLink(c)}`,
    ].join("\n\n"));
  }
  mail([c.reply_email], `[${ref}] We've received your support request: ${c.subject}`, [
    `Hi ${(user.name || "there").split(" ")[0]},`,
    `Thanks for getting in touch. Your case number is ${ref}. We'll email you here as soon as we reply.`,
    quote(input.body.trim()),
    `You can add details or follow the case in your portal: ${businessLink(c)}`,
  ].join("\n\n"));
  return c;
}

/** A reply on the case. Business replies reopen it; support replies set it to waiting (or the status given). */
export function addReply(caseId: string, user: AuthUser, role: "business" | "support", body: string, status?: CaseStatus) {
  const text = body.trim();
  if (!text && !status) throw badRequest("Write a reply");
  const before = getCase(caseId);
  const next: CaseStatus = status ?? (role === "business" ? "open" : "waiting");
  if (text) {
    run("INSERT INTO support_messages (id, case_id, author_id, author_name, author_role, body) VALUES (?,?,?,?,?,?)",
      newId("msg"), caseId, user.id, role === "support" ? "Slotwise support" : user.name || user.email, role, text);
  }
  run("UPDATE support_cases SET status = ?, updated_at = datetime('now') WHERE id = ?", next, caseId);
  audit({ id: user.id, label: `${role === "support" ? "superadmin" : "admin"}:${user.email}` }, before.business_id,
    text ? "support.reply" : "support.status_changed", { caseId, role, status: next });

  const c = getCase(caseId);
  const ref = caseRef(c.number);
  const business = one("SELECT name FROM businesses WHERE id = ?", c.business_id)!;
  const settings = supportSettings();
  if (role === "business" && settings.onBusinessReply && text) {
    mail(settings.notifyEmails, `[${ref}] ${business.name} replied: ${c.subject}`, [
      `${user.name || user.email} at ${business.name} replied on ${ref}.`, quote(text), `Answer it here: ${superLink(c)}`,
    ].join("\n\n"));
  }
  if (role === "support") {
    const resolvedNote = next === "resolved" ? "We've marked this case as resolved. If anything still isn't right, just reply in your portal and it reopens." : "";
    if (text || next === "resolved") {
      mail([c.reply_email], `[${ref}] ${next === "resolved" ? "Resolved" : "Reply"}: ${c.subject}`, [
        `Hello from Slotwise support,`, text ? quote(text) : "", resolvedNote, `Reply or follow the case in your portal: ${businessLink(c)}`,
      ].filter(Boolean).join("\n\n"));
    }
    if (settings.onSupportReply && text) {
      mail(settings.notifyEmails, `[${ref}] Support replied to ${business.name}: ${c.subject}`, [quote(text), superLink(c)].join("\n\n"));
    }
  }
  return c;
}

export async function sendTestNotification(to: string[]) {
  if (!emailLive()) throw badRequest("Email isn't set up for the platform yet: add a Resend or Postmark key under Settings → Email.");
  for (const address of to) {
    await sendEmail({ to: address, subject: "Slotwise support notifications are working", text: `This address will be told about new support cases and replies.\n\n${config.webUrl}/super/support` });
  }
}
