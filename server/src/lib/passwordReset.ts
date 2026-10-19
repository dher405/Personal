import { createHash, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { audit, one, run } from "../db.js";
import { hashPassword } from "./auth.js";
import { sendEmail } from "./email.js";
import { badRequest } from "./errors.js";

const RESET_TTL_MINUTES = 60;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a single-use reset link (only its hash is stored). */
export function createResetLink(userId: string) {
  const token = randomBytes(32).toString("base64url");
  run(
    "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)",
    hash(token), userId, DateTime.utc().plus({ minutes: RESET_TTL_MINUTES }).toISO(),
  );
  return `${config.webUrl}/reset-password?token=${token}`;
}

export async function emailResetLink(user: { id: string; email: string; name: string }) {
  const link = createResetLink(user.id);
  const { delivered } = await sendEmail({
    to: user.email,
    subject: "Reset your Slotwise password",
    text: `Hi ${user.name},\n\nUse this link to choose a new password. It works once and expires in ${RESET_TTL_MINUTES} minutes:\n\n${link}\n\n` +
      `If you didn't ask for this, you can ignore this email — your password won't change.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Use this link to choose a new password. It works once and expires in ${RESET_TTL_MINUTES} minutes:</p>` +
      `<p><a href="${link}">Reset my password</a></p><p>If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
  });
  return { link, delivered };
}

export async function resetPassword(token: string, newPassword: string) {
  const row = one("SELECT * FROM password_resets WHERE token_hash = ?", hash(token));
  if (!row || row.used_at || DateTime.fromISO(row.expires_at) < DateTime.utc()) {
    throw badRequest("This reset link is invalid or has expired. Please request a new one.");
  }
  run("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?", row.token_hash);
  // Other outstanding links for this account stop working too, and existing sign-ins are logged out.
  run("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", row.user_id);
  run("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?", await hashPassword(newPassword), row.user_id);
  audit({ id: row.user_id, label: "password-reset" }, null, "user.password_reset", { userId: row.user_id });
  return one("SELECT id, email, name, role FROM users WHERE id = ?", row.user_id)!;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
