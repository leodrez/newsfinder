import { getSupabase } from "./supabase"
import { fetchAllFeeds } from "./rss"
import { feeds, MAX_FUTURE_SKEW_SEC } from "./config"
import { briefWindow } from "./window"
import { fetchQuotes } from "./market-data"
import { fetchGammaSet } from "./gamma"
import { summarizeOvernight } from "./summarize"
import type {
  BriefErrors,
  BriefPayload,
  GammaSnapshot,
  Headline,
  MarketBrief,
  OvernightQuote,
} from "./types"

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Builds a brief from three independent sources. Quotes and gamma degrade to a
 * recorded reason; only a total news failure is fatal, since the summary cannot
 * exist without headlines.
 *
 * Reads feeds but never writes to `headlines` or `headline_dedup` — see the
 * freshness invariant in lib/config.ts.
 */
export async function generateBrief(): Promise<MarketBrief> {
  const now = Math.floor(Date.now() / 1000)
  const { start, end } = briefWindow(now)

  const [newsOutcome, quoteOutcome, gammaOutcome] = await Promise.allSettled([
    fetchAllFeeds(feeds),
    fetchQuotes(now),
    fetchGammaSet(),
  ])

  const errors: BriefErrors = {}

  // fetchAllFeeds (lib/rss.ts) catches every per-feed error internally and
  // never rejects today; this branch is a defensive guard against a future
  // change to that contract, not currently reachable.
  if (newsOutcome.status === "rejected") {
    throw new Error(`Could not fetch any news feeds: ${reasonOf(newsOutcome.reason)}`)
  }
  const allItems = newsOutcome.value
  if (!allItems.length) {
    throw new Error("No feed returned any items — the feeds are unreachable or all failed")
  }
  // Allow a small future-skew tolerance on the upper bound: an undated item is
  // stamped with fetchFeed's own `now` (lib/rss.ts), captured after network
  // I/O and therefore strictly later than this window's `now`/`end`.
  const headlines: Headline[] = allItems.filter(
    (h) => h.published_ts >= start && h.published_ts <= end + MAX_FUTURE_SKEW_SEC
  )
  if (!headlines.length) {
    throw new Error(
      `No headlines were published between ${new Date(start * 1000).toISOString()} and now`
    )
  }

  let quotes: OvernightQuote[] = []
  if (quoteOutcome.status === "fulfilled") {
    quotes = quoteOutcome.value.quotes
    if (Object.keys(quoteOutcome.value.errors).length) errors.quotes = quoteOutcome.value.errors
  } else {
    // fetchQuotes (lib/market-data.ts) uses Promise.allSettled internally and
    // never rejects today; this branch is a defensive guard against a future
    // change to that contract, not currently reachable.
    errors.quotes = { board: `Quote board failed: ${reasonOf(quoteOutcome.reason)}` }
  }

  let gamma: GammaSnapshot | null = null
  let gammaNq: GammaSnapshot | null = null
  if (gammaOutcome.status === "fulfilled") {
    gamma = gammaOutcome.value.spx
    gammaNq = gammaOutcome.value.nq
    if (gammaOutcome.value.errors.spx) errors.gamma = gammaOutcome.value.errors.spx
    if (gammaOutcome.value.errors.nq) errors.gammaNq = gammaOutcome.value.errors.nq
  } else {
    // fetchGammaSet catches per-index failures internally and never rejects
    // today; this branch guards a future change to that contract.
    const reason = reasonOf(gammaOutcome.reason)
    errors.gamma = reason
    errors.gammaNq = reason
  }

  let summary = ""
  let sentiment = 0
  let keyDrivers: BriefPayload["keyDrivers"] = []
  let riskEvents: string[] = []
  let sentimentLabel = ""

  try {
    const result = await summarizeOvernight(headlines, quotes, gamma, gammaNq)
    summary = result.summary
    sentiment = result.sentiment
    sentimentLabel = result.sentimentLabel
    keyDrivers = result.keyDrivers
    riskEvents = result.riskEvents
  } catch (err) {
    errors.summary = reasonOf(err)
  }

  const payload: BriefPayload = {
    quotes,
    gamma,
    gammaNq,
    keyDrivers,
    riskEvents,
    sentimentLabel,
    headlineCount: headlines.length,
    errors,
  }

  const brief: MarketBrief = {
    generated_ts: now,
    window_start_ts: start,
    window_end_ts: end,
    summary,
    sentiment,
    payload,
  }

  const { error } = await getSupabase().from("market_briefs").insert(brief)
  if (error) console.warn("[brief] Insert error:", error.message)

  console.log(
    `[brief] ${headlines.length} headlines, ${quotes.length} quotes, ` +
      `gamma spx ${gamma ? gamma.regime : "failed"}, nq ${gammaNq ? gammaNq.regime : "failed"}, ` +
      `errors ${Object.keys(errors).length}`
  )

  return brief
}

/** Most recently generated brief, or null if none exists yet. */
export async function getLatestBrief(): Promise<MarketBrief | null> {
  const { data, error } = await getSupabase()
    .from("market_briefs")
    .select("generated_ts, window_start_ts, window_end_ts, summary, sentiment, payload")
    .order("generated_ts", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn("[brief] Fetch error:", error.message)
    return null
  }
  return (data as MarketBrief | null) ?? null
}
