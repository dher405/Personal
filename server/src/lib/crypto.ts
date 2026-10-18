import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "../config.js";

// Payment provider credentials (e.g. a business's Square access token) are encrypted at rest.
function key() {
  if (config.encryptionKey) return Buffer.from(config.encryptionKey, "base64");
  return createHash("sha256").update(`dev-key:${config.jwtSecret}`).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptJson<T = Record<string, string>>(blob: string): T {
  if (!blob) return {} as T;
  const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

export function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function randomToken() {
  return randomBytes(24).toString("base64url");
}
