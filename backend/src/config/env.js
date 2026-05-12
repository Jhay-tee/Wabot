import "dotenv/config";

const IS_PROD = process.env.NODE_ENV === "production";

function get(name, fallback = "") {
  return process.env[name] || fallback;
}

function requireOrWarn(name) {
  const value = process.env[name];
  if (!value) {
    if (IS_PROD) throw new Error(`Missing required env var: ${name}. See backend/.env.example`);
    console.warn(`[config] ⚠  ${name} is not set — related features will be unavailable.`);
  }
  return value || "";
}

export const env = {
  port:     Number(process.env.PORT || 3000),
  nodeEnv:  get("NODE_ENV", "development"),
  isProd:   IS_PROD,

  jwtSecret:              requireOrWarn("JWT_SECRET"),
  appBaseUrl:             get("APP_BASE_URL",  "http://localhost:5000"),
  apiBaseUrl:             get("API_BASE_URL",  "http://localhost:3000"),
  allowedOrigins:         get("ALLOWED_ORIGINS","http://localhost:5000"),

  /* Superadmin — set this to YOUR email in the Replit Secrets panel.
     Only this email address can access /api/admin/* routes.            */
  superadminEmail:        get("SUPERADMIN_EMAIL", ""),

  supabaseUrl:            requireOrWarn("SUPABASE_URL"),
  supabaseServiceRoleKey: requireOrWarn("SUPABASE_SERVICE_ROLE_KEY"),

  brevoApiKey:       get("BREVO_API_KEY"),
  brevoSenderEmail:  get("BREVO_SENDER_EMAIL"),
  brevoSenderName:   get("BREVO_SENDER_NAME", "WaBot"),

  /* Paystack — payment processing */
  paystackSecretKey:     get("PAYSTACK_SECRET_KEY"),
  paystackWebhookSecret: get("PAYSTACK_WEBHOOK_SECRET"),  /* HMAC-SHA512 secret for verifying webhooks */
  paystackPlanCode:      get("PAYSTACK_PLAN_CODE"),       /* e.g. PLN_xxxxxxxxxx from Paystack dashboard */

  get hasJwt()        { return Boolean(this.jwtSecret); },
  get hasSupabase()   { return Boolean(this.supabaseUrl && this.supabaseServiceRoleKey); },
  get hasBrevo()      { return Boolean(this.brevoApiKey && this.brevoSenderEmail); },
  get hasPaystack()   { return Boolean(this.paystackSecretKey); },
  get hasSuperadmin() { return Boolean(this.superadminEmail); },
};
