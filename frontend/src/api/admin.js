import { apiFetch } from "./client.js";

export const adminApi = {
  stats:    ()                => apiFetch("/admin/stats"),
  users:    (page = 1, limit = 50) => apiFetch(`/admin/users?page=${page}&limit=${limit}`),
  activity: (limit = 100)    => apiFetch(`/admin/activity?limit=${limit}`),
  bots:     ()               => apiFetch("/admin/bots"),
};
