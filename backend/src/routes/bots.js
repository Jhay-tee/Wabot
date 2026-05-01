import { Router } from "express";
import QRCode from "qrcode";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const botRouter = Router();
botRouter.use(requireAuth);

const FREE_BOT_LIMIT = 2;
const PRO_BOT_LIMIT  = 100;

/* GET /api/bots/dashboard */
botRouter.get("/dashboard", async (req, res) => {
  const userId = req.user.sub;

  const [
    { data: user,     error: uErr },
    { data: bots,     error: bErr },
    { data: activity, error: aErr }
  ] = await Promise.all([
    supabase.from("users").select("id,email,full_name,email_verified,plan_tier").eq("id", userId).single(),
    supabase.from("bots").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("bot_activity").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(30)
  ]);

  if (uErr) return res.status(500).json({ error: "Could not fetch dashboard data." });

  return res.json({
    user:     user,
    bots:     bots     ?? [],
    activity: activity ?? []
  });
});

/* POST /api/bots/deploy */
botRouter.post("/deploy", async (req, res) => {
  const userId = req.user.sub;
  const botName = String(req.body?.botName ?? "").trim();

  if (botName.length < 2 || botName.length > 64) {
    return res.status(400).json({ error: "Bot name must be 2–64 characters." });
  }
  if (!/^[\w\s\-]+$/.test(botName)) {
    return res.status(400).json({ error: "Bot name may only contain letters, numbers, spaces, hyphens, and underscores." });
  }

  const { data: user, error: uErr } = await supabase
    .from("users")
    .select("id,email_verified,plan_tier")
    .eq("id", userId)
    .single();

  if (uErr || !user) return res.status(500).json({ error: "Could not fetch user." });

  if (!user.email_verified) {
    return res.status(403).json({ error: "Please verify your email address before deploying bots." });
  }

  const { count, error: cntErr } = await supabase
    .from("bots")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (cntErr) return res.status(500).json({ error: "Could not check bot count." });

  const maxBots = user.plan_tier === "paid" ? PRO_BOT_LIMIT : FREE_BOT_LIMIT;
  if ((count ?? 0) >= maxBots) {
    return res.status(403).json({
      error: `You've reached the ${user.plan_tier === "paid" ? "Pro" : "Free"} plan limit of ${maxBots} bot${maxBots === 1 ? "" : "s"}. ${
        user.plan_tier !== "paid" ? "Upgrade to Pro to deploy up to 100 bots." : ""
      }`.trim()
    });
  }

  const qrPayload    = `wwabot:${userId}:${Date.now()}:${botName}`;
  const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
    width: 400,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" }
  });

  const { data: bot, error: botErr } = await supabase
    .from("bots")
    .insert({
      user_id:    userId,
      bot_name:   botName,
      status:     "awaiting_qr_scan",
      qr_payload: qrPayload
    })
    .select("*")
    .single();

  if (botErr) return res.status(500).json({ error: "Could not create bot. Please try again." });

  await supabase.from("bot_activity").insert({
    user_id:    userId,
    bot_id:     bot.id,
    event_type: "deploy_started",
    details:    `Bot "${botName}" deployed — awaiting QR scan`
  });

  return res.status(201).json({ bot, qrCodeDataUrl });
});

/* GET /api/bots/:id/qr — regenerate QR for an existing bot */
botRouter.get("/:id/qr", async (req, res) => {
  const userId = req.user.sub;
  const { id }  = req.params;

  const { data: bot, error } = await supabase
    .from("bots")
    .select("id,bot_name,qr_payload,user_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });
  if (!bot.qr_payload) return res.status(404).json({ error: "No QR payload for this bot." });

  const qrCodeDataUrl = await QRCode.toDataURL(bot.qr_payload, {
    width: 400, margin: 2,
    color: { dark: "#000000", light: "#ffffff" }
  });

  return res.json({ qrCodeDataUrl });
});

/* DELETE /api/bots/:id */
botRouter.delete("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id }  = req.params;

  const { data: bot, error: fetchErr } = await supabase
    .from("bots")
    .select("id,bot_name,user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  const { error: delErr } = await supabase.from("bots").delete().eq("id", id);
  if (delErr) return res.status(500).json({ error: "Could not delete bot." });

  await supabase.from("bot_activity").insert({
    user_id:    userId,
    bot_id:     null,
    event_type: "bot_deleted",
    details:    `Bot "${bot.bot_name}" was deleted`
  });

  return res.status(204).send();
});

export default botRouter;
