/**
 * /api/admin — Superadmin-only routes
 * Protected by requireAuth + requireSuperAdmin.
 * Set SUPERADMIN_EMAIL in Replit Secrets to enable.
 *
 * All responses contain aggregated/anonymised data only.
 * No passwords, no API key hashes, no payment details.
 */

import { Router }           from "express";
import { supabase }         from "../lib/supabase.js";
import { requireAuth }      from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/adminAuth.js";
import { adminLimiter }     from "../middleware/rateLimiter.js";
import { botManager }       from "../services/whatsapp/BotManager.js";

const router = Router();
router.use(requireAuth, requireSuperAdmin, adminLimiter);

/* ── GET /api/admin/stats ────────────────────────────────────── */
router.get("/stats", async (_req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const weekISO = weekStart.toISOString();

    const [
      { count: totalUsers },
      { count: proUsers },
      { count: freeUsers },
      { count: totalBots },
      { count: newUsersToday },
      { count: newUsersWeek },
      { count: botsDeployedToday },
      { count: totalApiKeys },
      { data: msgAgg },
      { data: msgMonthAgg },
      { count: activityToday },
    ] = await Promise.all([
      supabase.from("users").select("*", { count: "exact", head: true }),
      supabase.from("users").select("*", { count: "exact", head: true }).eq("plan_tier", "paid"),
      supabase.from("users").select("*", { count: "exact", head: true }).eq("plan_tier", "free"),
      supabase.from("bots").select("*",  { count: "exact", head: true }),
      supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", todayISO),
      supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", weekISO),
      supabase.from("bots").select("*",  { count: "exact", head: true }).gte("created_at", todayISO),
      supabase.from("api_keys").select("*", { count: "exact", head: true }),
      supabase.from("bots").select("messages_count").limit(10_000),
      supabase.from("users").select("messages_this_month").limit(10_000),
      supabase.from("bot_activity").select("*", { count: "exact", head: true }).gte("created_at", todayISO),
    ]);

    const totalMessages      = (msgAgg      ?? []).reduce((s, b) => s + (b.messages_count      ?? 0), 0);
    const messagesThisMonth  = (msgMonthAgg ?? []).reduce((s, u) => s + (u.messages_this_month ?? 0), 0);
    const activeBots         = botManager.instances
      ? [...botManager.instances.values()].filter((i) => i.status === "connected").length
      : 0;

    return res.json({
      users: {
        total:      totalUsers  ?? 0,
        pro:        proUsers    ?? 0,
        free:       freeUsers   ?? 0,
        newToday:   newUsersToday ?? 0,
        newThisWeek: newUsersWeek ?? 0,
      },
      bots: {
        total:         totalBots         ?? 0,
        deployedToday: botsDeployedToday ?? 0,
        activeLive:    activeBots,
      },
      apiKeys: {
        total: totalApiKeys ?? 0,
      },
      messages: {
        allTime:     totalMessages,
        thisMonth:   messagesThisMonth,
        activityToday: activityToday ?? 0,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Could not load admin stats." });
  }
});

/* ── GET /api/admin/users ────────────────────────────────────── */
/*  Returns safe, non-sensitive user list (no emails, no hashes)  */
router.get("/users", async (req, res) => {
  try {
    const pageInput = Number(req.query.page ?? 1);
    const limitInput = Number(req.query.limit ?? 50);
    const page  = Number.isFinite(pageInput) ? Math.max(1, Math.trunc(pageInput)) : 1;
    const limit = Number.isFinite(limitInput) ? Math.min(100, Math.max(10, Math.trunc(limitInput))) : 50;
    const from  = (page - 1) * limit;

    const { data: users, count, error } = await supabase
      .from("users")
      .select("id, full_name, plan_tier, email_verified, created_at, messages_this_month", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);

    if (error) return res.status(500).json({ error: "Could not load users." });

    /* Attach bot counts per user in a single query */
    const userIds = (users ?? []).map((u) => u.id);
    const { data: botCounts } = userIds.length
      ? await supabase.from("bots")
          .select("user_id")
          .in("user_id", userIds)
      : { data: [] };

    const botMap = {};
    (botCounts ?? []).forEach((b) => { botMap[b.user_id] = (botMap[b.user_id] ?? 0) + 1; });

    return res.json({
      users: (users ?? []).map((u) => ({
        id:                u.id,
        name:              u.full_name,
        plan:              u.plan_tier,
        emailVerified:     u.email_verified,
        createdAt:         u.created_at,
        messagesThisMonth: u.messages_this_month ?? 0,
        botCount:          botMap[u.id] ?? 0,
      })),
      total: count ?? 0,
      page,
      pages: Math.ceil((count ?? 0) / limit),
    });
  } catch {
    return res.status(500).json({ error: "Could not load users." });
  }
});

/* ── GET /api/admin/activity ─────────────────────────────────── */
/*  Recent system-wide activity (last 200 events)                 */
router.get("/activity", async (req, res) => {
  try {
    const limitInput = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitInput) ? Math.min(200, Math.max(1, Math.trunc(limitInput))) : 100;

    const { data, error } = await supabase
      .from("bot_activity")
      .select("id, bot_id, event_type, details, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: "Could not load activity." });
    return res.json({ activity: data ?? [], count: (data ?? []).length });
  } catch {
    return res.status(500).json({ error: "Could not load activity." });
  }
});

/* ── GET /api/admin/bots ─────────────────────────────────────── */
/*  All bots with live status overlay                             */
router.get("/bots", async (_req, res) => {
  try {
    const { data: bots, error } = await supabase
      .from("bots")
      .select("id, bot_name, bot_type, status, messages_count, messages_this_month, created_at, user_id")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) return res.status(500).json({ error: "Could not load bots." });

    return res.json({
      bots: (bots ?? []).map((b) => ({
        ...b,
        liveStatus: botManager.getStatus(b.id) || b.status
      }))
    });
  } catch {
    return res.status(500).json({ error: "Could not load bots." });
  }
});

export default router;
