/**
 * Superadmin guard middleware.
 * Requires:
 *   1. requireAuth to have already run (sets req.user)
 *   2. req.user.email matches SUPERADMIN_EMAIL env var exactly
 *
 * Set SUPERADMIN_EMAIL in your Replit Secrets panel.
 * If SUPERADMIN_EMAIL is not configured, ALL admin requests are rejected.
 */
import { env } from "../config/env.js";

export function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required." });
  }

  if (!env.superadminEmail) {
    return res.status(503).json({
      error: "Admin access is not configured on this server. Set SUPERADMIN_EMAIL in Secrets."
    });
  }

  /* Case-insensitive email comparison */
  if (req.user.email?.toLowerCase() !== env.superadminEmail.toLowerCase()) {
    return res.status(403).json({ error: "Forbidden — superadmin access only." });
  }

  next();
}
