import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ConfigError } from "./api";

/** Server-only client using the service role key; never import from client components. */
export function getDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new ConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function assertNoError(error: { message?: string; code?: string } | null): void {
  if (!error) return;
  throw new Error(`database query failed: ${error.message ?? error.code ?? JSON.stringify(error)}`);
}
