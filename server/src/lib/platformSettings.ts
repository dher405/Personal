import Stripe from "stripe";
import Anthropic from "@anthropic-ai/sdk";
import { config, installSettingsReader } from "../config.js";
import { all, run } from "../db.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { badRequest } from "./errors.js";
import { syncStripeMode } from "./stripeMode.js";

/**
 * Integration keys the super admin manages on Super admin → Settings. Stored encrypted
 * (APP_ENCRYPTION_KEY) in platform_settings as `cfg:<NAME>`; NAME is also the environment
 * variable that serves as a fallback, so existing Render setups keep working.
 */

export interface SettingField { name: string; label: string; secret?: boolean; help?: string; placeholder?: string; options?: string[]; multiline?: boolean; /** Shown as a list of the models the saved key can use. */ modelPicker?: boolean }
export interface SettingGroup { id: string; title: string; description: string; fields: SettingField[]; urls?: (api: string) => { label: string; url: string }[]; testable?: boolean }

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "site", title: "Website address",
    description: "The address people use for Slotwise, such as https://bookwithslotwise.com. Links in emails and texts, sign-in with Google/Apple/Microsoft, calendar connections, passkeys and payment return pages all use it. First add the domain under Custom Domains in Render and wait until Render shows it as verified (with a certificate), then save it here. Visitors to the old Render address are sent to this one; webhooks and website embeds that use the old address keep working.",
    fields: [
      { name: "PUBLIC_WEB_URL", label: "Website address", placeholder: "https://bookwithslotwise.com", help: "Starts with https://, nothing after the domain" },
    ],
    urls: (api) => [
      { label: "Google: Authorized redirect URI (sign-in)", url: `${api}/api/auth/oauth/google/callback` },
      { label: "Google: Authorized redirect URI (Calendar)", url: `${api}/api/integrations/google/callback` },
      { label: "Microsoft: Redirect URI (Outlook Calendar)", url: `${api}/api/integrations/microsoft/callback` },
      { label: "Apple: Return URL", url: `${api}/api/auth/oauth/apple/callback` },
      { label: "Stripe: platform webhook endpoint", url: `${api}/api/webhooks/stripe` },
      { label: "Privacy policy (Google & Apple consent screens)", url: `${api}/privacy` },
      { label: "Terms of service", url: `${api}/terms` },
    ],
  },
  {
    id: "stripe", title: "Stripe", testable: true,
    description: "How you bill businesses: plan subscriptions, extra booking packs and auto top-ups. (Businesses take their customers' payments with their own accounts on their Payments tab.) Keys: dashboard.stripe.com → Developers → API keys. Use sk_test_… to try it out, sk_live_… for real money.",
    fields: [
      { name: "STRIPE_SECRET_KEY", label: "Secret key", secret: true, placeholder: "sk_live_… or sk_test_…" },
      { name: "STRIPE_WEBHOOK_SECRET", label: "Webhook signing secret", secret: true, placeholder: "whsec_…", help: "Add the webhook URL above in Stripe → Developers → Webhooks with events checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, then copy its signing secret" },
      { name: "STRIPE_TAX", label: "Charge tax (Stripe Tax)", options: ["off", "on"], placeholder: "off", help: "on = Stripe works out and adds sales tax / VAT on plans, packs and top-ups from each business's billing address. Turn on Stripe Tax in Stripe first (Settings → Tax: your business address and where you're registered)" },
      { name: "STRIPE_TAX_BEHAVIOR", label: "Plan prices", options: ["exclusive", "inclusive"], placeholder: "exclusive", help: "exclusive = tax is added on top ($29 + tax); inclusive = $29 already includes tax" },
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
      { name: "AI_MODEL", label: "Model", placeholder: "claude-opus-5-5", modelPicker: true, help: "Listed live from Anthropic for your key. The rough cost assumes a typical booking-chat reply (about 5,000 tokens in, 500 out)" },
      { name: "AI_EFFORT", label: "Effort", options: ["low", "medium", "high"], help: "Low is fast and cheap, and is plenty for booking chat" },
    ],
  },
  {
    id: "support_ai", title: "Support assistant (Anthropic)", testable: true,
    description: "Reads support cases, checks the business's setup and logs, drafts replies for you to approve, and flags bugs and process issues (Super admin → Support). It never sends anything on its own. Leave the key blank to use the AI assistant key above.",
    fields: [
      { name: "SUPPORT_ANTHROPIC_API_KEY", label: "API key (optional)", secret: true, placeholder: "sk-ant-… (blank = use the AI assistant key)" },
      { name: "SUPPORT_AI_MODEL", label: "Model", placeholder: "claude-opus-5-5", modelPicker: true, help: "Listed live from Anthropic. Support cases are few, so a capable model is worth it here" },
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
  {
    id: "legal", title: "Legal pages (Terms & Privacy)",
    description: "Fills in the details on the public Terms of Service (/terms) and Privacy Policy (/privacy) pages. They're a starting template written around how Slotwise actually works: have a lawyer review them before you rely on them.",
    fields: [
      { name: "LEGAL_COMPANY_NAME", label: "Legal name of your business", placeholder: "Slotwise LLC", help: "The company or person who runs Slotwise" },
      { name: "LEGAL_CONTACT_EMAIL", label: "Contact email for legal and privacy questions", placeholder: "privacy@bookwithslotwise.com" },
      { name: "LEGAL_ADDRESS", label: "Mailing address", multiline: true, placeholder: "123 Main St, Springfield, IL 62701, USA" },
      { name: "LEGAL_GOVERNING_LAW", label: "Governing law (state / country)", placeholder: "the State of Illinois, USA" },
      { name: "LEGAL_EFFECTIVE_DATE", label: "Effective date", placeholder: "October 20, 2026", help: "Change this when you update the terms" },
    ],
  },
];

/** The details shown on /terms and /privacy (blank fields fall back to sensible placeholders on the page). */
export function legalInfo() {
  const get = (name: string) => cache.get(name) || process.env[name] || "";
  return {
    companyName: get("LEGAL_COMPANY_NAME"), contactEmail: get("LEGAL_CONTACT_EMAIL"), address: get("LEGAL_ADDRESS"),
    governingLaw: get("LEGAL_GOVERNING_LAW"), effectiveDate: get("LEGAL_EFFECTIVE_DATE"),
  };
}

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
    let value = (raw ?? "").trim();
    if (field.options && value && !field.options.includes(value)) throw badRequest(`${field.label} must be one of ${field.options.join(", ")}`);
    if (name === "PUBLIC_WEB_URL" && value) {
      let url: URL | null = null;
      try { url = new URL(value); } catch { /* reported below */ }
      const local = url?.hostname === "localhost";
      if (!url || (url.protocol !== "https:" && !local) || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
        throw badRequest("The website address must look like https://bookwithslotwise.com (https, and nothing after the domain)");
      }
      value = url.origin; // saved without a trailing slash
    }
    if (value) {
      run("INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", PREFIX + name, encryptJson({ v: value }));
    } else {
      run("DELETE FROM platform_settings WHERE key = ?", PREFIX + name);
    }
  }
  load();
  if ("STRIPE_SECRET_KEY" in values) syncStripeMode();
  // New email settings: an earlier failure (e.g. sent from an unverified address) no longer applies.
  if (Object.keys(values).some((k) => SETTING_GROUPS.find((g) => g.id === "email")!.fields.some((f) => f.name === k))) {
    run("DELETE FROM platform_settings WHERE key = 'email_failure'");
  }
  return Object.keys(values);
}

/** Sends a real email to the super admin who clicked Test: the only proof the whole path works (and it clears an old failure). */
async function sendTestEmail(to: string | undefined, checked: string) {
  if (!to) return { ok: true, message: checked };
  const { sendEmail } = await import("./email.js");
  try {
    await sendEmail({ to, subject: "Slotwise email is working", text: `This test email came from ${config.email.from}. Sign-in codes, password resets and owner alerts will be sent the same way.` });
    return { ok: true, message: `${checked} A test email was sent to ${to}: check your inbox (and spam folder).` };
  } catch (err) {
    return { ok: false, message: `${checked} But sending a test email to ${to} failed: ${(err as Error).message}` };
  }
}

/** "Test" button: one harmless call per service to prove the saved keys work. */
export async function testSettings(group: string, testRecipient?: string): Promise<{ ok: boolean; message: string }> {
  try {
    if (group === "stripe") {
      if (!config.stripe.secretKey) return { ok: false, message: "No secret key saved" };
      const client = new Stripe(config.stripe.secretKey);
      const account = await client.accounts.retrieveCurrent();
      const mode = config.stripe.mode;
      const notes: string[] = [];
      let ok = true;
      if (!account.charges_enabled) { ok = mode === "test"; notes.push("this account can't take payments yet: finish activating it in Stripe"); }
      if (!config.stripe.webhookSecret) { ok = false; notes.push("add the webhook signing secret"); }
      // The "Manage billing" button needs the customer portal saved once in this mode.
      const portals = await client.billingPortal.configurations.list({ limit: 1 }).catch(() => null);
      if (portals && !portals.data.length) { ok = false; notes.push(`save the customer portal once in Stripe (Settings → Billing → Customer portal, in ${mode} mode)`); }
      if (config.stripe.tax) {
        const tax = await client.tax.settings.retrieve().catch((err: Error) => ({ status: "error", error: err.message }) as any);
        if (tax.status === "active") notes.push(`Stripe Tax is on (prices ${config.stripe.taxBehavior === "inclusive" ? "include" : "plus"} tax)`);
        else { ok = false; notes.push(`"Charge tax" is on but Stripe Tax isn't ready in ${mode} mode: in Stripe open Settings → Tax, add your business address and where you collect tax${tax.error ? ` (${tax.error})` : ""}`); }
      } else notes.push("tax isn't being charged (Charge tax is off)");
      return { ok, message: `Connected to ${account.settings?.dashboard?.display_name ?? account.email ?? account.id} (${mode} mode). ${notes.map((n) => n[0].toUpperCase() + n.slice(1)).join(". ")}.` };
    }
    if (group === "email") {
      if (config.email.resendApiKey) {
        const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${config.email.resendApiKey}` } });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, message: json.message ?? `Resend said ${res.status}` };
        const verified = (json.data ?? []).filter((d: any) => d.status === "verified").map((d: any) => d.name);
        if (!verified.length) return { ok: false, message: "The Resend key works, but no domain is verified yet, so emails can't be sent. Finish the DNS records in Resend → Domains and click Verify." };
        // The From address must be on a verified domain (or a subdomain of one), or Resend refuses every email.
        const fromDomain = (config.email.from.match(/@([^>\s]+)/)?.[1] ?? "").toLowerCase();
        const fromOk = verified.some((d: string) => fromDomain === d || fromDomain.endsWith(`.${d}`));
        if (!fromOk) return { ok: false, message: `The From address (${config.email.from}) isn't on a verified domain. Verified: ${verified.join(", ")}. Change the From address to use one of them.` };
        return sendTestEmail(testRecipient, `Resend key works and ${fromDomain} is verified.`);
      }
      if (config.email.postmarkToken) {
        const res = await fetch("https://api.postmarkapp.com/server", { headers: { "X-Postmark-Server-Token": config.email.postmarkToken, Accept: "application/json" } });
        const json: any = await res.json().catch(() => ({}));
        return res.ok ? sendTestEmail(testRecipient, `Postmark server "${json.Name}" connected.`) : { ok: false, message: json.Message ?? `Postmark said ${res.status}` };
      }
      return { ok: false, message: "No Resend or Postmark key saved" };
    }
    if (group === "support_ai") {
      if (!config.supportAi.apiKey) return { ok: false, message: "No API key saved here or for the AI assistant" };
      const model = await new Anthropic({ apiKey: config.supportAi.apiKey }).models.retrieve(config.supportAi.model);
      return { ok: true, message: `Key works; model ${model.display_name ?? model.id} is available${process.env.SUPPORT_ANTHROPIC_API_KEY || cache.get("SUPPORT_ANTHROPIC_API_KEY") ? "" : " (using the AI assistant key)"}` };
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
