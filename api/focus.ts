import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getSupabase } from "../lib/supabase"
import { getAuthUser } from "../lib/auth"
import { DEFAULT_MARKET_FOCUS, CONFIG_KEYS } from "../lib/config"

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const user = await getAuthUser(req)
  if (!user) return res.status(401).json({ error: "Unauthorized" })

  const supabase = getSupabase()

  if (req.method === "GET") {
    const { data } = await supabase
      .from("config")
      .select("value")
      .eq("key", CONFIG_KEYS.marketFocus)
      .single()
    return res.status(200).json({ value: data?.value ?? DEFAULT_MARKET_FOCUS })
  }

  if (req.method === "POST") {
    const { value } = req.body as { value?: string }
    if (typeof value !== "string") return res.status(400).json({ error: "Missing value" })
    const { error } = await supabase
      .from("config")
      .upsert({ key: CONFIG_KEYS.marketFocus, value: value.trim() })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: "Method not allowed" })
}
