import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { env } from "../config/env.js";

if (!env.supabaseUrl) {
  throw new Error("SUPABASE_URL is missing");
}

if (!env.supabaseServiceRoleKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
}

export const supabase = createClient(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  {
    auth: { persistSession: false },
    realtime: { transport: ws }
  }
);

// Optional anon client for read-only operations that may be needed in some legacy
// code paths. Prefer using the server `supabase` (service-role) for all backend
// operations. If SUPABASE_ANON_KEY is present, expose it as `supabaseAnon`.
export const supabaseAnon = (function () {
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!anonKey) return null;
  try {
    return createClient(env.supabaseUrl, anonKey, { auth: { persistSession: false }, realtime: { transport: ws } });
  } catch {
    return null;
  }
})();