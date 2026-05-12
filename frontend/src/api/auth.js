import { apiFetch } from "./client.js";

export const authApi = {
  signup:  (body)  => apiFetch("/auth/signup",  { method: "POST",  body: JSON.stringify(body) }),
  login:   (body)  => apiFetch("/auth/login",   { method: "POST",  body: JSON.stringify(body) }),
  verify:  (token) => apiFetch(`/auth/verify?token=${encodeURIComponent(token)}`),
  me:      ()      => apiFetch("/auth/me"),
  patchMe: (body)  => apiFetch("/auth/me",      { method: "PATCH", body: JSON.stringify(body) }),
  password:(body)  => apiFetch("/auth/password",{ method: "POST",  body: JSON.stringify(body) }),

  /* API Keys */
  listApiKeys:   ()        => apiFetch("/auth/apikeys"),
  createApiKey:  (body)    => apiFetch("/auth/apikeys",              { method: "POST",   body: JSON.stringify(body) }),
  rotateApiKey:  (keyId)   => apiFetch(`/auth/apikeys/${keyId}/rotate`, { method: "POST" }),
  deleteApiKey:  (keyId)   => apiFetch(`/auth/apikeys/${keyId}`,    { method: "DELETE" }),
};
