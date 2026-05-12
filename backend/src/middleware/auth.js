import { verifyAccessToken } from "../utils/jwt.js";
import { supabase }          from "../lib/supabase.js";
import crypto                from "node:crypto";

async function loadUserContextById(userId) {
  const { data } = await supabase
    .from("users")
    .select("id, email, plan_tier, email_verified")
    .eq("id", userId)
    .maybeSingle();
  return data;
}

/**
 * requireAuth — accepts either:
 *   1. JWT Bearer token  (Authorization: Bearer <jwt>)
 *   2. WaBot API key     (Authorization: Bearer wbk_...)
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  /* EventSource (SSE) cannot set custom headers — allow token via query param */
  const rawToken = header?.startsWith("Bearer ")
    ? header.slice(7)
    : (typeof req.query.token === "string" ? req.query.token : null);

  if (!rawToken) {
    return res.status(401).json({ error: "Unauthorized — Bearer token required." });
  }

  const token = rawToken;

  /* ── API key path ─────────────────────────────────────────── */
  if (token.startsWith("wbk_")) {
    try {
      const keyHash = crypto.createHash("sha256").update(token).digest("hex");
      const { data: apiKey, error } = await supabase
        .from("api_keys")
        .select("id, user_id, users!inner(id, email, plan_tier, email_verified)")
        .eq("key_hash", keyHash)
        .maybeSingle();

      if (error || !apiKey) return res.status(401).json({ error: "Invalid API key." });

      const user = apiKey.users;
      if (!user?.id) return res.status(401).json({ error: "Invalid API key." });

      /* Update last_used timestamp (fire-and-forget) */
      supabase.from("api_keys")
        .update({ last_used: new Date().toISOString() })
        .eq("id", apiKey.id)
        .then(() => {}).catch(() => {});

      req.user = {
        sub:           user.id,
        email:         user.email,
        plan:          user.plan_tier,
        emailVerified: user.email_verified,
        via:           "api_key"
      };
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid API key." });
    }
  }

  /* ── JWT path ─────────────────────────────────────────────── */
  try {
    const payload = verifyAccessToken(token);
    const user = await loadUserContextById(payload.sub);

    if (!user) {
      return res.status(401).json({ error: "User account not found." });
    }

    req.user = {
      ...payload,
      sub:           user.id,
      email:         user.email,
      plan:          user.plan_tier,
      emailVerified: user.email_verified,
      via:           "jwt"
    };
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

/** Restrict endpoint to users on the 'paid' plan. */
export function requirePro(req, res, next) {
  if (req.user?.plan !== "paid") {
    return res.status(403).json({
      error: "This feature requires the Pro plan. Upgrade at /dashboard?tab=billing."
    });
  }
  return next();
}
