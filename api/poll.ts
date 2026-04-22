import type { VercelRequest, VercelResponse } from "@vercel/node"
import { Receiver } from "@upstash/qstash"
import { getSupabase } from "../lib/supabase"
import { fetchAllFeeds } from "../lib/rss"
import { scrapeAll } from "../lib/scraper"
import { filterNew } from "../lib/dedup"
import { scoreHeadlines } from "../lib/llm"
import { feeds, LLM_MODEL, DEFAULT_MARKET_FOCUS, CONFIG_KEYS } from "../lib/config"
import type { ScoredHeadline } from "../lib/types"

export const config = { maxDuration: 60 }

async function runPoll(): Promise<{ stored: number }> {
  const supabase = getSupabase()

  // Fetch all feeds in parallel
  const rssFeeds = feeds.filter((f) => f.type === "rss")
  const [rssHeadlines, scrapedHeadlines] = await Promise.all([
    fetchAllFeeds(rssFeeds),
    scrapeAll(feeds),
  ])
  const all = [...rssHeadlines, ...scrapedHeadlines]

  // Dedup — filterNew handles Supabase upsert + stale hash cleanup
  const newHeadlines = await filterNew(all)
  if (!newHeadlines.length) {
    await supabase
      .from("config")
      .upsert({ key: CONFIG_KEYS.lastPollTs, value: String(Math.floor(Date.now() / 1000)) })
    return { stored: 0 }
  }

  console.log(`[poll] ${all.length} fetched, ${newHeadlines.length} new`)

  // Get current market focus from config table
  const { data: focusRow } = await supabase
    .from("config")
    .select("value")
    .eq("key", CONFIG_KEYS.marketFocus)
    .single()
  const marketFocus = focusRow?.value ?? DEFAULT_MARKET_FOCUS

  // Score with LLM
  const scored: ScoredHeadline[] = await scoreHeadlines(newHeadlines, marketFocus)

  // Insert into headlines table — Supabase Realtime will broadcast each insert
  const rows = scored.map((h) => ({
    title: h.title,
    url: h.url,
    source: h.source,
    published_ts: h.published_ts,
    fetched_ts: h.fetched_ts,
    relevance: h.relevance,
    impact: h.impact,
    summary: h.summary,
  }))

  const { error } = await supabase.from("headlines").insert(rows)
  if (error) console.error("[poll] Insert error:", error.message)

  // Update config metadata
  await supabase.from("config").upsert([
    { key: CONFIG_KEYS.lastPollTs, value: String(Math.floor(Date.now() / 1000)) },
    { key: CONFIG_KEYS.llmModel, value: LLM_MODEL },
  ])

  return { stored: scored.length }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()

  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY
  const isDev = !signingKey

  // In production, verify the request came from QStash
  if (!isDev) {
    const signature = req.headers["upstash-signature"] as string | undefined
    if (!signature) return res.status(401).json({ error: "Missing signature" })

    const receiver = new Receiver({
      currentSigningKey: signingKey,
      nextSigningKey: nextKey ?? signingKey,
    })

    try {
      const rawBody = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk) => (data += chunk))
        req.on("end", () => resolve(data))
      })
      await receiver.verify({ signature, body: rawBody })
    } catch {
      return res.status(401).json({ error: "Invalid signature" })
    }
  }

  try {
    const result = await runPoll()
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    console.error("[poll] Error:", err)
    return res.status(500).json({ error: String(err) })
  }
}
