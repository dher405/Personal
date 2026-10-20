import Stripe from "stripe";
import Anthropic from "@anthropic-ai/sdk";
import { config, installSettingsReader } from "../config.js";
import { all, run } from "../db.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { badRequest } from "./errors.js";

/**
 * Integration keys the super admin manages on Super admin → Settings. Stored encrypted
 * (APP_ENCRYPTION_KEY) in platform_settings as `cfg:<NAME>`; NAME is also the environment
 * variable that serves as a fallback, so existing Render setups keep working.
 */

export interface SettingField { name: string; label: string; secret?: boolean; help?: string; placeholder?: string; options?: string[]; multiline?: boolean }
export interface SettingGroup { id: string; title: string; description: string; fields: SettingField[]; urls?: (api: string) => { label: string; url: string }[]; testable?: boolean }

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "stripe", title: "Stripe", testable: true,
    description: "How you bill businesses: plan subscriptions, extra booking packs and auto top-ups. (Businesses take their customers' payments with their own accounts on their Payments tab.) Keys: dashboard.stripe.com → Developers → API keys. Use sk_test_… to try it out, sk_live_… for real money.",
    fields: [
      { name: "STRIPE_SECRET_KEY", label: "Secret key", secret: true, placeholder: "sk_live_… or sk_test_…" },
      { name: "STRIPE_WEBHOOK_SECRET", label: "Webhook signing secret", secret: true, placeholder: "whsec_…", help: "Add the webhook URL above in Stripe → Developers → Webhooks with events checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, then copy its signing secret" },
    ],
    urls: (api) => [{ label: "Webhook URL", url: `${api}/api/webhooks/stripe` }],
  },
  {
    id: "email", title: "Email", testable: true,
    description: "Emails from Slotwise to business owners: password resets, new-booking alerts, and usage and billing alerts. (Emails to a business's customers go out from that business's own email account, set up on its Email tab.) Set up one provider: Resend (resend.com → API Keys) or Postmark (Server → API Tokens). Verify your sending domain with them first.",
    fields: [
      { name: "EMAIL_FROM", label: "From address", placeholder: "Slotwise <no-reply@yourdomain.com>" },
      { name: "RESEND_API_KEY", label: "Resend API key", secret: true, placeholder: "re_…" },
      { name: "POSTMARK_SERVER_TOKEN", label: "Postmark server token (instead of Resend)", secret: true },
    ],
  },
  {
    id: "phones", title: "Phone numbers",
    description: "Each business texts its customers from its own Twilio account (its Text messages tab). This only sets how phone numbers typed without a country code are read.",
    fields: [
      { name: "SMS_DEFAULT_COUNTRY_CODE", label: "Default country code", placeholder: "1", help: "1 = US/Canada, 44 = UK, 61 = Australia" },
    ],
  },
  {
    id: "ai", title: "AI assistant (Anthropic)", testable: true,
    description: "Powers the booking chat and admin assistant. Create a key at console.anthropic.com → API Keys.",
    fields: [
      { name: "ANTHROPIC_API_KEY", label: "API key", secret: true, placeholder: "sk-ant-…" },
      { name: "AI_MODEL", label: "Model", placeholder: "claude-opus-5-5" },
      { name: "AI_EFFORT", label: "Effort", options: ["low", "medium", "high"], help: "Low is fast and cheap, and is plenty for booking chat" },
    ],
  },
  {
    id: "google", title: "Google (sign-in and Calendar)",
    description: "One OAuth client powers \"Continue with Google\" and Google Calendar sync. console.cloud.google.com → APIs & Services → Credentials → OAuth client ID (Web application). Add both redirect URIs below.",
    fields: [
      { name: "GOOGLE_CLIENT_ID", label: "Client ID", placeholder: "….apps.googleusercontent.com" },
      { name: "GOOGLE_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
    urls: (api) => [
      { label: "Authorized redirect URI (sign-in)", url: `${api}/api/auth/oauth/google/callback` },
      { label: "Authorized redirect URI (Calendar sync)", url: `${api}/api/integrations/google/callback` },
    ],
  },
  {
    id: "microsoft", title: "Microsoft (Outlook Calendar)",
    description: "For Outlook Calendar sync. portal.azure.com → App registrations → New registration (any organization + personal accounts). API permissions: Calendars.ReadWrite, User.Read, offline_access. Certificates & secrets → New client secret.",
    fields: [
      { name: "MICROSOFT_CLIENT_ID", label: "Application (client) ID" },
      { name: "MICROSOFT_CLIENT_SECRET", label: "Client secret value", secret: true },
    ],
    urls: (api) => [{ label: "Web redirect URI", url: `${api}/api/integrations/microsoft/callback` }],
  },
  {
    id: "apple", title: "Sign in with Apple",
    description: "developer.apple.com → Identifiers → Services ID (enable Sign in with Apple, add your domain and the return URL below); Keys → a key with Sign in with Apple (download the .p8 once).",
    fields: [
      { name: "APPLE_SERVICES_ID", label: "Services ID", placeholder: "com.yourcompany.slotwise.web" },
      { name: "APPLE_TEAM_ID", label: "Team ID" },
      { name: "APPLE_KEY_ID", label: "Key ID" },
      { name: "APPLE_PRIVATE_KEY", label: "Private key (.p8 contents)", secret: true, multiline: true, placeholder: "-----BEGIN PRIVATE KEY-----" },
    ],
    urls: (api) => [{ label: "Return URL", url: `${api}/api/auth/oauth/apple/callback` }],
  },
];

const FIELDS = new Map(SETTING_GROUPS.flatMap((g) => g.fields.map((f) => [f.name, f] as const)));
const PREFIX = "cfg:";
let cache = new Map<string, string>();

function load() {
  cache = new Map();
  for (const row of all<{ key: string; value: string }>("SELECT key, value FROM platform_settings WHERE key LIKE 'cfg:%'")) {
    try {
      cache.set(row.key.slice(PREFIX.length), decryptJson<{ v: string }>(row.value).v);
    } catch {
      // Saved with a different APP_ENCRYPTION_KEY: ignore it (shown as "not set") rather than crash.
    }
  }
}

load();
installSettingsReader((name) => cache.get(name));

const mask = (v: string) => (v.length <= 8 ? "••••" : `••••${v.slice(-4)}`);

/** What the Settings page shows: never a secret's value, only that it's set and its last 4 characters. */
export function describeSettings() {
  return SETTING_GROUPS.map((g) => ({
    id: g.id, title: g.title, description: g.description, testable: !!g.testable,
    urls: g.urls?.(config.apiUrl) ?? [],
    fields: g.fields.map((f) => {
      const saved = cache.get(f.name);
      const fromEnv = process.env[f.name];
      const value = saved || fromEnv || "";
      return {
        ...f,
        source: saved ? "settings" : fromEnv ? "environment" : "unset",
        value: f.secret ? "" : value,
        preview: f.secret && value ? mask(value) : "",
      };
    }),
  }));
}

/** Saves changed values. Empty string or null clears the saved value (the environment variable, if any, applies again). */
export function saveSettings(values: Record<string, string | null>) {
  for (const [name, raw] of Object.entries(values)) {
    const field = FIELDS.get(name);
    if (!field) throw badRequest(`Unknown setting ${name}`);
    const value = (raw ?? "").trim();
    if (field.options && value && !field.options.includes(value)) throw badRequest(`${field.label} must be one of ${field.options.join(", ")}`);
    if (value) {
      run("INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", PREFIX + name, encryptJson({ v: value }));
    } else {
      run("DELETE FROM platform_settings WHERE key = ?", PREFIX + name);
    }
  }
  load();
  return Object.keys(values);
}

/** "Test" button: one harmless call per service to prove the saved keys work. */
export async function testSettings(group: string): Promise<{ ok: boolean; message: string }> {
  try {
    if (group === "stripe") {
      if (!config.stripe.secretKey) return { ok: false, message: "No secret key saved" };
      const account = await new Stripe(config.stripe.secretKey).accounts.retrieveCurrent();
      const mode = config.stripe.secretKey.startsWith("sk_live") ? "live" : "test";
      return { ok: true, message: `Connected to ${account.settings?.dashboard?.display_name ?? account.email ?? account.id} (${mode} mode)${account.charges_enabled ? "" : ". Note: this account can't take payments yet; finish activating it in Stripe"}` };
    }
    if (group === "email") {
      if (config.email.resendApiKey) {
        const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${config.email.resendApiKey}` } });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, message: json.message ?? `Resend said ${res.status}` };
        const verified = (json.data ?? []).filter((d: any) => d.status === "verified").map((d: any) => d.name);
        return { ok: true, message: verified.length ? `Resend key works. Verified domains: ${verified.join(", ")}` : "Resend key works, but no domain is verified yet, so emails can't be sent from your address" };
      }
      if (config.email.postmarkToken) {
        const res = await fetch("https://api.postmarkapp.com/server", { headers: { "X-Postmark-Server-Token": config.email.postmarkToken, Accept: "application/json" } });
        const json: any = await res.json().catch(() => ({}));
        return res.ok ? { ok: true, message: `Postmark server "${json.Name}" connected` } : { ok: false, message: json.Message ?? `Postmark said ${res.status}` };
      }
      return { ok: false, message: "No Resend or Postmark key saved" };
    }
    if (group === "ai") {
      if (!config.ai.apiKey) return { ok: false, message: "No API key saved" };
      const model = await new Anthropic({ apiKey: config.ai.apiKey }).models.retrieve(config.ai.model);
      return { ok: true, message: `Key works; model ${model.display_name ?? model.id} is available` };
    }
    return { ok: false, message: "No test for this section" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
