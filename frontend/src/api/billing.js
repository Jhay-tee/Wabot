import { apiFetch } from "./client.js";

export const billingApi = {
  checkout: ()  => apiFetch("/billing/checkout", { method: "POST" }),
  portal:   ()  => apiFetch("/billing/portal",   { method: "POST" }),
  status:   ()  => apiFetch("/billing/status"),
  cancel:   ()  => apiFetch("/billing/cancel",   { method: "POST" }),
};
