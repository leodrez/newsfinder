import { createClient } from "@supabase/supabase-js"

/**
 * Browser-side Supabase client using the public anon key.
 * Safe to expose — RLS restricts this to read-only access on headlines.
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
)
