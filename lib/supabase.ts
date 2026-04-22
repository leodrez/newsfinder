import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let _client: SupabaseClient | null = null

/**
 * Server-side Supabase client using the service-role key.
 * This bypasses RLS — never expose this key to the browser.
 */
export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    _client = createClient(url, key, {
      auth: { persistSession: false },
    })
  }
  return _client
}
