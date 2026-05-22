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