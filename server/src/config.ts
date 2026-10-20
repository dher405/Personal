import "dotenv/config";
import { existsSync } from "node:fs";

const env = process.env;

/** Values saved on the super admin Settings page; installed by lib/platformSettings.ts at startup. */
let savedSetting: (name: string) => string | undefined = () => undefined;
export function installSettingsReader(reader: (name: string) => string | undefined) {
  savedSetting = reader;
}
/** Settings page value, else environment variable, else the default. */
const v = (name: string, fallback = "") => savedSetting(name) || env[name] || fallback;

/**
 * Public URL the browser uses. Hosted environments supply it automatically:
 * Render sets RENDER_EXTERNAL_URL; in GitHub Codespaces the Vite port (5173) is
 * forwarded and proxies /api, so the API shares that origin. Local `localhost`
 * values from .env.example are ignored there because the browser can't reach them.
 */
function hostedUrl() {
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL;
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return `https://${env.CODESPACE_NAME}-5173.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  }
  return null;
}
const pick = (value: string | undefined, fallback: string) =>
  value && !(hostedUrl() && value.includes("localhost")) ? value : hostedUrl() ?? fallback;

export const config = {
  port: Number(env.PORT ?? 4000),
  webUrl: pick(env.PUBLIC_WEB_URL, "http://localhost:5173"),
  apiUrl: pick(env.PUBLIC_API_URL, "http://localhost:4000"),
  /** Test deployments: allow fake "test mode" payments and auto-create demo data. Never set on a real launch. */
  demoMode: env.DEMO_MODE === "true",
  jwtSecret: env.JWT_SECRET ?? "dev-only-secret",
  encryptionKey: env.APP_ENCRYPTION_KEY ?? "",
  // On Render, a disk mounted at /var/data is used automatically even if DATABASE_PATH wasn't set.
  databasePath: env.DATABASE_PATH ?? (env.RENDER && existsSync("/var/data") ? "/var/data/slotwise.db" : "./slotwise.db"),
  isProduction: env.NODE_ENV === "production",
  // Integration settings are getters: each read checks the super admin's Settings page first
  // (stored encrypted in the database), then the environment. Changes apply without a redeploy.
  get ai() {
    return {
      apiKey: v("ANTHROPIC_API_KEY"),
      model: v("AI_MODEL", "claude-opus-5-5"),
      effort: v("AI_EFFORT", "low") as "low" | "medium" | "high" | "xhigh" | "max",
    };
  },
  /** The support assistant (Super admin → Support): its own key if one is saved, else the AI assistant's. */
  get supportAi() {
    return {
      apiKey: v("SUPPORT_ANTHROPIC_API_KEY") || v("ANTHROPIC_API_KEY"),
      model: v("SUPPORT_AI_MODEL", "claude-opus-5-5"),
    };
  },
  get stripe() {
    return {
      secretKey: v("STRIPE_SECRET_KEY"),
      webhookSecret: v("STRIPE_WEBHOOK_SECRET"),
    };
  },
  get email() {
    return {
      // EMAIL_FROM must be a sender your provider has verified, e.g. "Slotwise <no-reply@yourdomain.com>".
      from: v("EMAIL_FROM", "Slotwise <no-reply@example.com>"),
      resendApiKey: v("RESEND_API_KEY"),
      postmarkToken: v("POSTMARK_SERVER_TOKEN"),
    };
  },
  get oauth() {
    return {
      google: {
        clientId: v("GOOGLE_CLIENT_ID"),
        clientSecret: v("GOOGLE_CLIENT_SECRET"),
        authUrl: v("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
        tokenUrl: v("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
      },
      microsoft: {
        // Azure portal → App registrations; "Accounts in any organizational directory and personal Microsoft accounts".
        clientId: v("MICROSOFT_CLIENT_ID"),
        clientSecret: v("MICROSOFT_CLIENT_SECRET"),
        authUrl: v("MICROSOFT_AUTH_URL", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"),
        tokenUrl: v("MICROSOFT_TOKEN_URL", "https://login.microsoftonline.com/common/oauth2/v2.0/token"),
      },
      calendarApis: {
        google: v("GOOGLE_CALENDAR_API", "https://www.googleapis.com/calendar/v3"),
        graph: v("MS_GRAPH_URL", "https://graph.microsoft.com/v1.0"),
      },
      apple: {
        // The Services ID (not the App ID) from developer.apple.com, e.g. com.slotwise.web
        clientId: v("APPLE_SERVICES_ID"),
        teamId: v("APPLE_TEAM_ID"),
        keyId: v("APPLE_KEY_ID"),
        // Contents of the .p8 key; "\n" sequences are turned into newlines so it fits in one env var.
        privateKey: v("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
        authUrl: v("APPLE_AUTH_URL", "https://appleid.apple.com/auth/authorize"),
        tokenUrl: v("APPLE_TOKEN_URL", "https://appleid.apple.com/auth/token"),
      },
    };
  },
  /** Meeting providers' API addresses (overridable for tests). Each business uses its own Zoom / RingCentral app. */
  meetingApis: {
    zoomOauth: env.ZOOM_OAUTH_URL ?? "https://zoom.us/oauth/token",
    zoomApi: env.ZOOM_API_URL ?? "https://api.zoom.us/v2",
    ringcentral: env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com",
  },
  /** Country code assumed for phone numbers typed without one (1 = US/Canada). Texts go through each business's own Twilio. */
  get smsDefaultCountryCode() {
    return v("SMS_DEFAULT_COUNTRY_CODE", "1");
  },
};

if (config.isProduction) {
  for (const [name, value] of [
    ["JWT_SECRET", env.JWT_SECRET],
    ["APP_ENCRYPTION_KEY", env.APP_ENCRYPTION_KEY],
  ]) {
    if (!value) throw new Error(`${name} must be set in production`);
  }
}
