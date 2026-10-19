import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * SQLite via Node's built-in driver keeps local setup dependency-free.
 * All SQL lives behind this module, so moving to Postgres later means
 * swapping this file and the query helpers, not the routes.
 */
export const db = new DatabaseSync(process.env.NODE_ENV === "test" ? ":memory:" : config.databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('superadmin','admin','customer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  currency TEXT NOT NULL DEFAULT 'USD',
  phone TEXT,
  address TEXT,
  slot_interval_min INTEGER NOT NULL DEFAULT 15,
  min_notice_min INTEGER NOT NULL DEFAULT 60,
  max_advance_days INTEGER NOT NULL DEFAULT 60,
  cancellation_hours INTEGER NOT NULL DEFAULT 24,
  require_payment INTEGER NOT NULL DEFAULT 0,
  payment_provider TEXT NOT NULL DEFAULT 'none' CHECK (payment_provider IN ('none','stripe','square','paypal','mock')),
  payment_config TEXT NOT NULL DEFAULT '',
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  ai_instructions TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_status TEXT NOT NULL DEFAULT 'active',
  platform_customer_id TEXT,
  platform_subscription_id TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_members (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','manager')),
  PRIMARY KEY (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  bio TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS staff_services (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS availability_rules (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_off (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  manage_token TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  customer_id TEXT REFERENCES users(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending_payment','confirmed','cancelled','completed','no_show')),
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','mobile','ai','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_staff_time ON bookings(staff_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_business_time ON bookings(business_id, starts_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  provider_payment_id TEXT,
  amount_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','partially_refunded','refunded','failed')),
  checkout_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('customer','admin')),
  user_id TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_label TEXT NOT NULL,
  business_id TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add them to existing databases.
function addColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// --- SMS (reminders, alerts, two-way replies) ---
addColumn("businesses", "sms_enabled", "INTEGER NOT NULL DEFAULT 0");
addColumn("businesses", "sms_reminder_hours", "TEXT NOT NULL DEFAULT '24,2'");
addColumn("businesses", "sms_admin_phone", "TEXT");
addColumn("businesses", "sms_admin_alerts", "INTEGER NOT NULL DEFAULT 1");
addColumn("businesses", "sms_agenda_hour", "INTEGER");
addColumn("businesses", "sms_last_agenda_date", "TEXT");
addColumn("businesses", "sms_staff_reminder_min", "INTEGER");
addColumn("staff", "phone", "TEXT");
addColumn("bookings", "sms_opt_in", "INTEGER NOT NULL DEFAULT 0");
addColumn("bookings", "customer_confirmed_at", "TEXT");
addColumn("bookings", "last_reminder_h", "INTEGER");
addColumn("bookings", "staff_reminded", "INTEGER NOT NULL DEFAULT 0");

db.exec(`
CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  audience TEXT NOT NULL DEFAULT 'customer' CHECK (audience IN ('customer','admin','staff')),
  kind TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  from_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_sid TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_business ON sms_messages(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_messages(to_phone, created_at);

-- Per-phone conversation state for two-way texting (e.g. "reply 1, 2 or 3").
CREATE TABLE IF NOT EXISTS sms_conversations (
  phone TEXT PRIMARY KEY,
  business_id TEXT,
  booking_id TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  chat_session_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- Sign-in: password resets, Google/Apple accounts, session invalidation ---
addColumn("users", "token_version", "INTEGER NOT NULL DEFAULT 0");
db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google','apple')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, subject)
);
`);

export type Row = Record<string, any>;

export function one<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Runs fn inside a transaction; BEGIN IMMEDIATE prevents two bookings racing for one slot. */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function audit(actor: { id?: string | null; label: string }, businessId: string | null, action: string, details: object = {}) {
  run(
    "INSERT INTO audit_log (id, actor_id, actor_label, business_id, action, details) VALUES (?,?,?,?,?,?)",
    newId("aud"), actor.id ?? null, actor.label, businessId, action, JSON.stringify(details),
  );
}
