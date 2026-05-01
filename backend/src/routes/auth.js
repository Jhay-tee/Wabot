import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { signAccessToken } from "../utils/jwt.js";
import { sendVerificationEmail } from "../lib/brevo.js";
import { env } from "../config/env.js";
import { isStrongPassword, isValidEmail, normalizeEmail, sanitizeName } from "../utils/validators.js";
import { requireAuth } from "../middleware/auth.js";

const authRouter = Router();

/* POST /api/auth/signup */
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, fullName } = req.body ?? {};
    const normalizedEmail = normalizeEmail(String(email ?? ""));

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!isStrongPassword(String(password ?? ""))) {
      return res.status(400).json({ error: "Password must be 8+ chars with uppercase letters and a number." });
    }

    const { data: existing } = await supabase
      .from("users").select("id").eq("email", normalizedEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: "An account with this email already exists." });

    const [passwordHash, verificationToken] = await Promise.all([
      bcrypt.hash(String(password), 12),
      Promise.resolve(crypto.randomBytes(32).toString("hex"))
    ]);

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email:              normalizedEmail,
        password_hash:      passwordHash,
        full_name:          sanitizeName(String(fullName ?? "")),
        email_verified:     false,
        plan_tier:          "free",
        verification_token: verificationToken
      })
      .select("id,email")
      .single();

    if (error) return res.status(500).json({ error: "Could not create account. Please try again." });

    const verifyUrl = `${env.appBaseUrl}/verify?token=${verificationToken}`;
    try {
      await sendVerificationEmail(user.email, verifyUrl);
    } catch {
      /* non-fatal: account still created, user can re-request later */
    }

    return res.status(201).json({ message: "Account created. Check your email to verify before logging in." });
  } catch {
    return res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

/* GET /api/auth/verify?token=... */
authRouter.get("/verify", async (req, res) => {
  try {
    const token = String(req.query.token ?? "");
    if (token.length < 20) return res.status(400).json({ error: "Missing or invalid verification token." });

    const { data: user, error: lookupErr } = await supabase
      .from("users")
      .select("id,email_verified")
      .eq("verification_token", token)
      .maybeSingle();

    if (lookupErr || !user) return res.status(400).json({ error: "Invalid or expired verification link." });
    if (user.email_verified) return res.json({ message: "Already verified." });

    const { error } = await supabase
      .from("users")
      .update({ email_verified: true, verification_token: null, updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (error) return res.status(500).json({ error: "Could not verify account. Please try again." });
    return res.json({ message: "Email verified successfully. You can now log in." });
  } catch {
    return res.status(500).json({ error: "Could not verify account." });
  }
});

/* POST /api/auth/login */
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    const normalizedEmail = normalizeEmail(String(email ?? ""));

    if (!isValidEmail(normalizedEmail) || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid credentials." });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,password_hash,full_name,email_verified,plan_tier")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (error || !user) return res.status(401).json({ error: "Invalid email or password." });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password." });

    const token = signAccessToken({ sub: user.id, email: user.email, plan: user.plan_tier });
    return res.json({
      token,
      user: {
        id:            user.id,
        email:         user.email,
        fullName:      user.full_name,
        emailVerified: user.email_verified,
        planTier:      user.plan_tier
      }
    });
  } catch {
    return res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

/* GET /api/auth/me */
authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,full_name,email_verified,plan_tier,created_at")
      .eq("id", req.user.sub)
      .single();

    if (error || !user) return res.status(404).json({ error: "User not found." });

    return res.json({
      id:            user.id,
      email:         user.email,
      fullName:      user.full_name,
      emailVerified: user.email_verified,
      planTier:      user.plan_tier,
      createdAt:     user.created_at
    });
  } catch {
    return res.status(500).json({ error: "Could not fetch user." });
  }
});

export default authRouter;
