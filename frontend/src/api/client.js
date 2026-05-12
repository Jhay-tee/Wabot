function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeApiBase(value) {
  const trimmed = value?.trim();
  if (!trimmed) return "/api";

  const base = trimTrailingSlash(trimmed);
  return base.endsWith("/api") ? base : `${base}/api`;
}

const ENV_BASE = typeof import.meta !== "undefined"
  ? import.meta.env.VITE_API_BASE_URL
  : "";

export const BASE = normalizeApiBase(ENV_BASE);

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name   = "ApiError";
  }
}

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("wabot_token");

  const headers = { ...(options.headers ?? {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers });
  } catch {
    throw new ApiError("Network error — is the server running?", 0);
  }

  if (res.status === 204) return null;

  let data;
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

/**
 * Open an SSE (Server-Sent Events) stream.
 * Returns an unsubscribe function.
 */
export function openEventStream(path, onEvent, onError) {
  const token = localStorage.getItem("wabot_token");
  const url   = `${BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token ?? "")}`;

  /* SSE doesn't support custom headers — pass token as query param.
     The backend reads it from ?token= for SSE endpoints. */
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch {}
  };
  es.onerror = (e) => { onError?.(e); };
  return () => es.close();
}
