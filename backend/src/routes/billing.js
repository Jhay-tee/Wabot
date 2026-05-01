import { Router } from "express";
import express from "express";
import { env } from "../config/env.js";
import { stripe } from "../lib/stripe.js";
import { requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";

const billingRouter = Router();

/* Guard — return 503 if Stripe is not configured */
function requireStripe(_req, res, next) {
  if (!env.hasStripe) {
    return res.status(503).json({
      error: "Billing is not configured on this server. Set STRIPE_SECRET_KEY to enable paid plans."
    });
  }
  return next();
}

/* ── POST /api/billing/checkout ──────────────────────────────── */
billingRouter.post("/checkout", requireAuth, requireStripe, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { data: user } = await supabase
      .from("users").select("id,email,plan_tier").eq("id", userId).single();

    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.plan_tier === "paid")
      return res.status(400).json({ error: "You are already on the Pro plan." });

    if (!env.stripePriceIdGrowth)
      return res.status(503).json({ error: "Stripe price ID is not configured. Set STRIPE_PRICE_ID_GROWTH." });

    const session = await stripe.checkout.sessions.create({
      mode:           "subscription",
      line_items:     [{ price: env.stripePriceIdGrowth, quantity: 1 }],
      customer_email: user.email,
      success_url:    `${env.appBaseUrl}/dashboard?billing=success`,
      cancel_url:     `${env.appBaseUrl}/dashboard?billing=cancelled`,
      metadata:       { userId }
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/checkout]", err.message);
    return res.status(500).json({ error: "Could not create checkout session." });
  }
});

/* ── POST /api/billing/webhook ───────────────────────────────── */
billingRouter.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!env.hasStripe || !env.stripeWebhookSecret) {
      return res.status(503).json({ error: "Stripe webhook is not configured." });
    }

    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook signature error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId  = session.metadata?.userId;
        if (userId) {
          await Promise.all([
            supabase.from("users").update({ plan_tier: "paid" }).eq("id", userId),
            supabase.from("subscriptions").upsert(
              {
                user_id:                userId,
                stripe_customer_id:     session.customer,
                stripe_subscription_id: session.subscription,
                status:                 "active",
                plan_tier:              "paid"
              },
              { onConflict: "user_id" }
            )
          ]);
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { data: row } = await supabase
          .from("subscriptions").select("user_id")
          .eq("stripe_subscription_id", sub.id).single();
        await Promise.all([
          supabase.from("subscriptions").update({ status: "canceled" }).eq("stripe_subscription_id", sub.id),
          row?.user_id
            ? supabase.from("users").update({ plan_tier: "free" }).eq("id", row.user_id)
            : Promise.resolve()
        ]);
      }

      if (event.type === "customer.subscription.updated") {
        const sub       = event.data.object;
        const newStatus = sub.status === "active" ? "active" : "inactive";
        await supabase.from("subscriptions").update({ status: newStatus })
          .eq("stripe_subscription_id", sub.id);
      }
    } catch (err) {
      console.error("[billing/webhook]", err.message);
    }

    return res.json({ received: true });
  }
);

export default billingRouter;
