import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getSupabase } from "../lib/supabase"
import { CONFIG_KEYS } from "../lib/config"

function nowUnixSec(): string {
  return String(Math.floor(Date.now() / 1000))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()

  const supabase = getSupabase()

  if (req.method === "GET") {
    const { data } = await supabase
      .from("config")
      .select("value")
      .eq("key", CONFIG_KEYS.pollingEnabled)
      .single()
    // Default to enabled if the key doesn't exist yet
    const enabled = data?.value !== "false"
    return res.status(200).json({ enabled })
  }

  if (req.method === "POST") {
    const { enabled } = req.body as { enabled?: boolean }
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "Missing enabled boolean" })
    if (enabled) {
      const ts = nowUnixSec()
      const { error } = await supabase.from("config").upsert([
        { key: CONFIG_KEYS.pollingEnabled, value: "true" },
        { key: CONFIG_KEYS.pollingResumedAt, value: ts },
      ])
      if (error) return res.status(500).json({ error: error.message })
    } else {
      const { error } = await supabase
        .from("config")
        .upsert({ key: CONFIG_KEYS.pollingEnabled, value: "false" })
      if (error) return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true, enabled })
  }

  return res.status(405).json({ error: "Method not allowed" })
}
