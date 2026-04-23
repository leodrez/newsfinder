import type { VercelRequest } from "@vercel/node"
import { getSupabase } from "./supabase"

/**
 * Verifies the Bearer JWT from an incoming request.
 * Uses the existing service-role client — no extra env vars needed.
 *
 * Returns the authenticated user, or null if the token is missing/invalid.
 */
export async function getAuthUser(req: VercelRequest) {
  const authHeader = req.headers.authorization ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return null

  const { data, error } = await getSupabase().auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}
