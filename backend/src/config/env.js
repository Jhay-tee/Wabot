import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  jwtSecret: required("JWT_SECRET"),
  appBaseUrl: required("APP_BASE_URL"),
  apiBaseUrl: required("API_BASE_URL"),
  allowedOrigins: process.env.ALLOWED_ORIGINS || required("APP_BASE_URL"),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  brevoApiKey: required("BREVO_API_KEY"),
  brevoSenderEmail: required("BREVO_SENDER_EMAIL"),
  brevoSenderName: process.env.BREVO_SENDER_NAME || "Botify",
  stripeSecretKey: required("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
  stripePriceIdGrowth: required("STRIPE_PRICE_ID_GROWTH")
};
