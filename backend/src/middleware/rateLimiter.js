import rateLimit from "express-rate-limit";
import { env }   from "../config/env.js";

const IS_PROD = env.isProd;

const make = (opts) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders:   false,
    skipSuccessfulRequests: false,
    ...opts,
    message: { error: opts.message ?? "Too many requests. Please slow down." }
  });

/** Strict: signup / login / password reset — 15 req / 15 min */
export const authLimiter = make({
  windowMs: 15 * 60 * 1000,
  max:      IS_PROD ? 15 : 60,
  message:  "Too many auth attempts. Try again in 15 minutes."
});

/** General dashboard API — 120 req / min per IP */
export const apiLimiter = make({
  windowMs: 60 * 1000,
  max:      IS_PROD ? 120 : 600
});

/** Bot deploy — prevent spam-deploying — 5 / min */
export const deployLimiter = make({
  windowMs: 60 * 1000,
  max:      IS_PROD ? 5 : 30,
  message:  "Slow down — maximum 5 bot deployments per minute."
});

/**
 * v1 Public API — per-plan per-user rate limit.
 * Free users : 30 calls / min
 * Pro  users : 300 calls / min
 * Key is per-user (sub), not IP — fairer for shared hosting.
 */
export const v1PlanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => {
    if (!req.user) return 30;
    return req.user.plan === "paid" ? 300 : 30;
  },
  keyGenerator: (req) => `v1:${req.user?.sub ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: false,
  message: {
    error: "API rate limit reached. Free plan: 30 calls/min · Pro: 300 calls/min. Wait a moment and try again.",
    code:  "RATE_LIMIT_EXCEEDED",
    upgrade: "Upgrade to Pro for 10× higher rate limits."
  }
});

/** Admin routes — very strict, 30 req / min per IP */
export const adminLimiter = make({
  windowMs: 60 * 1000,
  max:      30,
  message:  "Admin rate limit exceeded."
});
