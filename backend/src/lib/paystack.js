/**
 * Paystack API client — thin wrapper using native fetch (no external SDK).
 * Docs: https://paystack.com/docs/api/
 */

import { env } from "../config/env.js";

const BASE = "https://api.paystack.co";

async function paystackRequest(path, options = {}) {
  const key = env.paystackSecretKey;
  if (!key) throw new Error("Paystack is not configured. Set PAYSTACK_SECRET_KEY.");

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization:  `Bearer ${key}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) {
    throw new Error(json.message ?? `Paystack API error: ${res.status}`);
  }
  return json.data;
}

export const paystack = {
  /** Initialize a Paystack transaction / subscription checkout */
  initializeTransaction: (body) =>
    paystackRequest("/transaction/initialize", {
      method: "POST",
      body:   JSON.stringify(body),
    }),

  /** Fetch a subscription by its subscription_code */
  fetchSubscription: (code) =>
    paystackRequest(`/subscription/${encodeURIComponent(code)}`),

  /** Disable (cancel) a subscription.
   *  Requires the subscription_code and the email_token from the subscription object. */
  disableSubscription: (code, token) =>
    paystackRequest("/subscription/disable", {
      method: "POST",
      body:   JSON.stringify({ code, token }),
    }),
};
