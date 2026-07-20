import type { VercelRequest, VercelResponse } from "@vercel/node"
import { Receiver } from "@upstash/qstash"
import { getSupabase } from "../lib/supabase"
import { fetchAllFeeds } from "../lib/rss"
import { filterNew } from "../lib/dedup"
import { runCleanupIfDue } from "../lib/cleanup"
import { scoreHeadlines } from "../lib/llm"
import {
  feeds,
  LLM_MODEL,
  DEFAULT_MARKET_FOCUS,
  DEFAULT_MIN_RELEVANCE,
  CONFIG_KEYS,
  MAX_HEADLINE_AGE_SEC,
  POLLING_AUTO_PAUSE_SEC,
} from "../lib/config"
import type { Headline, ScoredHeadline } from "../lib/types"

// Function duration is configured in vercel.json (single source of truth).

const MAX_FUTURE_SKEW_SEC = 5 * 60

function isCurrentHeadline(headline: Headline, now: number): boolean {
  const publishedTs = headline.published_ts
  return (
    Number.isFinite(publishedTs) &&
    publishedTs > 0 &&
    publishedTs <= now + MAX_FUTURE_SKEW_SEC &&
    now - publishedTs <= MAX_HEADLINE_AGE_SEC
  )
}

async function runPoll(): Promise<{ stored: number; skipped?: boolean }> {
  const supabase = getSupabase()

  // Housekeeping (throttled): runs whenever the endpoint is hit, even while
  // polling is paused, so retention/dedup purge keep working.
  await runCleanupIfDue(supabase)

  const { data: pollCfgRows } = await supabase
    .from("config")
    .select("key, value")
    .in("key", [CONFIG_KEYS.pollingEnabled, CONFIG_KEYS.pollingResumedAt])

  const pollCfg = Object.fromEntries(
    (pollCfgRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value])
  )

  if (pollCfg[CONFIG_KEYS.pollingEnabled] === "false") {
    return { stored: 0, skipped: true }
  }

  const now = Math.floor(Date.now() / 1000)
  const rawResumed = pollCfg[CONFIG_KEYS.pollingResumedAt]
  const resumedAt = rawResumed ? parseInt(rawResumed, 10) : NaN
  const needsResumeInit = !rawResumed || Number.isNaN(resumedAt) || resumedAt <= 0

  if (needsResumeInit) {
    await supabase
      .from("config")
      .upsert({ key: CONFIG_KEYS.pollingResumedAt, value: String(now) })
  } else if (now - resumedAt >= POLLING_AUTO_PAUSE_SEC) {
    await supabase.from("config").upsert({ key: CONFIG_KEYS.pollingEnabled, value: "false" })
    console.log(`[poll] Auto-paused after ${POLLING_AUTO_PAUSE_SEC}s since resume`)
    return { stored: 0, skipped: true }
  }

  // Fetch all feeds in parallel (all feeds are RSS)
  const all = await fetchAllFeeds(feeds)
  const currentHeadlines = all.filter((h) => isCurrentHeadline(h, now))

  // Dedup — filterNew handles Supabase upsert + stale hash cleanup
  const newHeadlines = await filterNew(currentHeadlines)
  console.log(
    `[poll] ${all.length} fetched, ${currentHeadlines.length} current, ${newHeadlines.length} new`
  )
  if (!newHeadlines.length) {
    await supabase
      .from("config")
      .upsert({ key: CONFIG_KEYS.lastPollTs, value: String(Math.floor(Date.now() / 1000)) })
    return { stored: 0 }
  }

  // Get market focus + min relevance from the config table
  const { data: settingRows } = await supabase
    .from("config")
    .select("key, value")
    .in("key", [CONFIG_KEYS.marketFocus, CONFIG_KEYS.minRelevance])
  const settings = Object.fromEntries(
    (settingRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value])
  )
  const marketFocus = settings[CONFIG_KEYS.marketFocus] ?? DEFAULT_MARKET_FOCUS
  const rawMinRel = parseInt(settings[CONFIG_KEYS.minRelevance] ?? "", 10)
  const minRelevance = Number.isFinite(rawMinRel) ? rawMinRel : DEFAULT_MIN_RELEVANCE

  // Score with LLM, then keep only headlines at or above the relevance floor
  const scored: ScoredHeadline[] = await scoreHeadlines(newHeadlines, marketFocus)
  const relevant = scored.filter((h) => h.relevance >= minRelevance)
  console.log(`[poll] ${scored.length} scored, ${relevant.length} >= relevance ${minRelevance}`)

  if (!relevant.length) {
    await supabase
      .from("config")
      .upsert({ key: CONFIG_KEYS.lastPollTs, value: String(Math.floor(Date.now() / 1000)) })
    return { stored: 0 }
  }

  // Insert into headlines table — Supabase Realtime will broadcast each insert
  const rows = relevant.map((h) => ({
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

  return { stored: relevant.length }
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
