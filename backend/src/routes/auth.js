import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { signAccessToken } from "../utils/jwt.js";
import { sendVerificationEmail } from "../lib/brevo.js";
import { env } from "../config/env.js";
import { isStrongPassword, isValidEmail, normalizeEmail, sanitizeName } from "../utils/validators.js";

const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail) || !isStrongPassword(password)) {
      return res.status(400).json({ error: "Valid email and stronger password required" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString("hex");

    const { data: existing } = await supabase.from("users").select("id").eq("email", normalizedEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: "Account already exists" });

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email: normalizedEmail,
        password_hash: passwordHash,
        full_name: sanitizeName(fullName || ""),
        email_verified: false,
        plan_tier: "free",
        verification_token: verificationToken
      })
      .select("id,email")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const verifyUrl = `${env.appBaseUrl}/verify?token=${verificationToken}`;
    await sendVerificationEmail(user.email, verifyUrl);
    return res.status(201).json({ message: "Signup successful. Check email to verify account." });
  } catch {
    return res.status(500).json({ error: "Could not create account" });
  }
});

authRouter.get("/verify", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || String(token).length < 20) return res.status(400).json({ error: "Missing token" });

    const { data: user, error: lookupError } = await supabase
      .from("users")
      .select("id,email_verified")
      .eq("verification_token", token)
      .maybeSingle();

    if (lookupError || !user) return res.status(400).json({ error: "Invalid verification token" });
    if (user.email_verified) return res.json({ message: "Already verified" });

    const { error } = await supabase
      .from("users")
      .update({ email_verified: true, verification_token: null })
      .eq("id", user.id);
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ message: "Email verified successfully" });
  } catch {
    return res.status(500).json({ error: "Could not verify account" });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail) || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,password_hash,full_name,email_verified,plan_tier")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (error || !user) return res.status(401).json({ error: "Invalid credentials" });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: "Invalid credentials" });

    const token = signAccessToken({ sub: user.id, email: user.email, plan: user.plan_tier });
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        emailVerified: user.email_verified,
        planTier: user.plan_tier
      }
    });
  } catch {
    return res.status(500).json({ error: "Could not login" });
  }
});

export default authRouter;
