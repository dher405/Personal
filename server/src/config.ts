import "dotenv/config";

const env = process.env;

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
  databasePath: env.DATABASE_PATH ?? "./slotwise.db",
  isProduction: env.NODE_ENV === "production",
  ai: {
    apiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.AI_MODEL ?? "claude-opus-5-5",
    effort: (env.AI_EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
  },
  square: {
    env: env.SQUARE_ENV ?? "sandbox",
    webhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? "",
    webhookUrl: env.SQUARE_WEBHOOK_URL ?? "",
  },
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID ?? "",
    authToken: env.TWILIO_AUTH_TOKEN ?? "",
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? "",
    fromNumber: env.TWILIO_FROM_NUMBER ?? "",
    defaultCountryCode: env.SMS_DEFAULT_COUNTRY_CODE ?? "1",
  },
  paypal: {
    env: env.PAYPAL_ENV ?? "sandbox",
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    webhookId: env.PAYPAL_WEBHOOK_ID ?? "",
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
