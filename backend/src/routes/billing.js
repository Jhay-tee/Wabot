import { Router } from "express";
import express from "express";
import { env } from "../config/env.js";
import { stripe } from "../lib/stripe.js";
import { requireAuth } from "../middleware/auth.js";
import { supabase } from "../lib/supabase.js";

const billingRouter = Router();

billingRouter.post("/checkout", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const { data: user } = await supabase.from("users").select("id,email").eq("id", userId).single();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.stripePriceIdGrowth, quantity: 1 }],
    customer_email: user.email,
    success_url: `${env.appBaseUrl}/dashboard?billing=success`,
    cancel_url: `${env.appBaseUrl}/dashboard?billing=cancelled`,
    metadata: { userId }
  });

  return res.json({ url: session.url });
});

billingRouter.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, signature, env.stripeWebhookSecret);
  } catch (error) {
    return res.status(400).send(`Webhook error: ${error.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      await supabase.from("users").update({ plan_tier: "paid" }).eq("id", userId);
      await supabase.from("subscriptions").upsert({
        user_id: userId,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        status: "active",
        plan_tier: "paid"
      });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    await supabase.from("subscriptions").update({ status: "canceled" }).eq("stripe_subscription_id", subscription.id);
  }

  return res.json({ received: true });
});

export default billingRouter;
