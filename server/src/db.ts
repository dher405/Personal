import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { assertStorageReady } from "./lib/storage.js";

/**
 * SQLite via Node's built-in driver keeps local setup dependency-free.
 * All SQL lives behind this module, so moving to Postgres later means
 * swapping this file and the query helpers, not the routes.
 */
assertStorageReady();
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
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending_payment','requested','confirmed','cancelled','completed','no_show')),
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

/**
 * SQLite can't change a CHECK constraint in place, so adding a booking status rebuilds the table once
 * (SQLite's documented procedure): same columns and rows, new constraint, indexes recreated.
 */
function allowStatus(table: string, status: string) {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!def || def.sql.includes(`'${status}'`)) return;
  const newSql = def.sql
    .replace(/^CREATE TABLE\s+("?)\w+\1/i, `CREATE TABLE ${table}_rebuild`)
    .replace("'pending_payment',", `'pending_payment','${status}',`);
  if (newSql === def.sql || !newSql.includes(`'${status}'`)) throw new Error(`Couldn't add status ${status} to ${table}`);
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as { sql: string }[];
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(newSql);
    db.exec(`INSERT INTO ${table}_rebuild SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_rebuild RENAME TO ${table}`);
    for (const ix of indexes) db.exec(ix.sql);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
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

// --- Calendars: customer invites, owner feeds, Google/Outlook sync ---
addColumn("bookings", "ics_sequence", "INTEGER NOT NULL DEFAULT 0");
addColumn("businesses", "calendar_feed_token", "TEXT");
addColumn("businesses", "email_admin_alerts", "INTEGER NOT NULL DEFAULT 1");
db.exec(`
CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  account_email TEXT,
  tokens TEXT NOT NULL,            -- encrypted {accessToken, refreshToken, expiresAt}
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  check_busy INTEGER NOT NULL DEFAULT 1,
  reminder_min INTEGER NOT NULL DEFAULT 30,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (staff_id, provider)
);
CREATE TABLE IF NOT EXISTS calendar_events (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  PRIMARY KEY (booking_id, connection_id)
);
`);

// --- Usage-based pricing: metered uses, purchased credits, alerts sent ---
addColumn("businesses", "auto_topup", "INTEGER NOT NULL DEFAULT 0");
// --- Customer communications: each business's own email account and Twilio account (encrypted JSON) ---
addColumn("businesses", "comms_config", "TEXT NOT NULL DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  from_email TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','not_sent')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_business ON email_messages(business_id, created_at);

-- STOP is per business: each business texts from its own number.
CREATE TABLE IF NOT EXISTS business_sms_opt_outs (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, phone)
);
`);
// --- Pay-in-person requests: the slot is held as 'requested' until the business accepts or declines ---
addColumn("businesses", "cash_requests", "INTEGER NOT NULL DEFAULT 0");
addColumn("bookings", "pay_in_person", "INTEGER NOT NULL DEFAULT 0");
addColumn("bookings", "decline_reason", "TEXT");
allowStatus("bookings", "requested");

// --- Support cases between businesses and the platform ---
db.exec(`
CREATE TABLE IF NOT EXISTS support_cases (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  opened_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reply_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  -- open: needs the platform's attention; waiting: answered, waiting on the business; resolved: done
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_business ON support_cases(business_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_cases(status, updated_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('business','support')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_messages ON support_messages(case_id, created_at);
`);

// --- Where appointments happen: in person, online (a meeting link), or the customer's choice ---
addColumn("services", "location_mode", "TEXT NOT NULL DEFAULT 'in_person'");
addColumn("bookings", "meeting_mode", "TEXT NOT NULL DEFAULT 'in_person'");
addColumn("bookings", "meeting_provider", "TEXT");
addColumn("bookings", "meeting_url", "TEXT");
addColumn("bookings", "meeting_external_id", "TEXT");
addColumn("bookings", "meeting_error", "TEXT");

// When a paid plan is set to end (moving to Starter), it runs until this time (ISO, UTC), then the business moves to Starter.
addColumn("businesses", "plan_ends_at", "TEXT");
db.exec(`
CREATE TABLE IF NOT EXISTS usage_events (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('bookings','ai')),
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (metric, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_events ON usage_events(business_id, metric, created_at);
CREATE TABLE IF NOT EXISTS usage_credits (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('bookings','sms','ai')),
  quantity INTEGER NOT NULL,
  period TEXT NOT NULL,            -- YYYY-MM the credits apply to
  source TEXT NOT NULL CHECK (source IN ('purchase','auto','grant')),
  price_cents INTEGER NOT NULL DEFAULT 0,
  charge_status TEXT NOT NULL DEFAULT 'none' CHECK (charge_status IN ('none','pending','charged','failed')),
  external_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_alerts (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  period TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, metric, period, threshold)
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
