import "dotenv/config";

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  webUrl: env.PUBLIC_WEB_URL ?? "http://localhost:5173",
  apiUrl: env.PUBLIC_API_URL ?? "http://localhost:4000",
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
