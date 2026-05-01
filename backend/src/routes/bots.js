import { Router } from "express";
import QRCode from "qrcode";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const botRouter = Router();
botRouter.use(requireAuth);

botRouter.get("/dashboard", async (req, res) => {
  const userId = req.user.sub;
  const [{ data: user }, { data: bots }, { data: activity }] = await Promise.all([
    supabase.from("users").select("id,email,full_name,email_verified,plan_tier").eq("id", userId).single(),
    supabase.from("bots").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("bot_activity").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20)
  ]);

  return res.json({ user, bots: bots || [], activity: activity || [] });
});

botRouter.post("/deploy", async (req, res) => {
  const userId = req.user.sub;
  const { botName } = req.body;
  if (!botName || botName.trim().length < 2) return res.status(400).json({ error: "Bot name is required" });

  const { data: user } = await supabase
    .from("users")
    .select("id,email_verified,plan_tier")
    .eq("id", userId)
    .single();

  if (!user.email_verified) {
    return res.status(403).json({ error: "Verify your account before deploying bots" });
  }

  const { count } = await supabase.from("bots").select("*", { count: "exact", head: true }).eq("user_id", userId);
  const maxBots = user.plan_tier === "paid" ? 100 : 2;
  if ((count || 0) >= maxBots) {
    return res.status(403).json({ error: `Plan limit reached. ${user.plan_tier} allows ${maxBots} bots.` });
  }

  const qrPayload = `botify:${userId}:${Date.now()}:${botName}`;
  const qrCodeDataUrl = await QRCode.toDataURL(qrPayload);

  const { data: bot, error } = await supabase
    .from("bots")
    .insert({
      user_id: userId,
      bot_name: botName,
      status: "awaiting_qr_scan",
      qr_payload: qrPayload
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await supabase.from("bot_activity").insert({
    user_id: userId,
    bot_id: bot.id,
    event_type: "deploy_started",
    details: `${botName} deployment started and waiting for QR scan`
  });

  return res.status(201).json({ bot, qrCodeDataUrl });
});

export default botRouter;
