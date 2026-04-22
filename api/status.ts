import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getSupabase } from "../lib/supabase"
import { LLM_MODEL, CONFIG_KEYS } from "../lib/config"

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" })

  const supabase = getSupabase()

  const { data: rows } = await supabase
    .from("config")
    .select("key, value")
    .in("key", [CONFIG_KEYS.llmModel, CONFIG_KEYS.lastPollTs])

  const cfg = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))

  const hasApiKey =
    !!process.env.ANTHROPIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY !== "sk-ant-your-key-here"

  return res.status(200).json({
    llm: {
      status: hasApiKey ? "connected" : "disabled",
      model: cfg[CONFIG_KEYS.llmModel] ?? LLM_MODEL,
    },
    lastPollTs: cfg[CONFIG_KEYS.lastPollTs] ? Number(cfg[CONFIG_KEYS.lastPollTs]) : null,
  })
}
