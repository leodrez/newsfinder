export interface FeedConfig {
  name: string
  url: string
  type: "rss"
}

export const feeds: FeedConfig[] = [
  {
    name: "Reuters Business",
    url: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best",
    type: "rss",
  },
  {
    name: "CNBC Top News",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    type: "rss",
  },
  {
    name: "CNBC World News",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362",
    type: "rss",
  },
  {
    name: "MarketWatch Top Stories",
    url: "https://feeds.marketwatch.com/marketwatch/topstories/",
    type: "rss",
  },
  {
    name: "MarketWatch Market Pulse",
    url: "https://feeds.marketwatch.com/marketwatch/marketpulse/",
    type: "rss",
  },
  {
    name: "Yahoo Finance",
    url: "https://finance.yahoo.com/news/rssindex",
    type: "rss",
  },
  {
    name: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    type: "rss",
  },
]

export const LLM_MODEL = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001"
export const LLM_MAX_BATCH = 5

/** Only process headlines published within this rolling real-time window. */
export const MAX_HEADLINE_AGE_SEC = 6 * 60 * 60

/** How long a title hash is remembered for dedup (replaces the old Redis TTL). */
export const DEDUP_TTL_SEC = 24 * 60 * 60

/** Headlines older than this (by fetched_ts) are purged during cleanup. */
export const HEADLINE_RETENTION_SEC = 7 * 24 * 60 * 60

/** Cleanup (retention + dedup purge) runs at most once per this interval. */
export const CLEANUP_INTERVAL_SEC = 60 * 60

/**
 * Invariant: the freshness window MUST stay strictly below the dedup TTL.
 * If an item can still be "fresh" after its dedup hash expires, it will be
 * re-scored and re-inserted on every poll — the daily-repeat bug. Enforce it
 * at module load so a future edit to either constant fails loudly.
 */
if (MAX_HEADLINE_AGE_SEC >= DEDUP_TTL_SEC) {
  throw new Error(
    `Config invariant violated: MAX_HEADLINE_AGE_SEC (${MAX_HEADLINE_AGE_SEC}) ` +
      `must be < DEDUP_TTL_SEC (${DEDUP_TTL_SEC}) to prevent re-insertion of stale headlines.`
  )
}

/** Server-side auto-pause: seconds from `polling_resumed_at` until polling turns off. */
export const POLLING_AUTO_PAUSE_SEC = 60 * 60

export const DEFAULT_MARKET_FOCUS =
  "S&P 500 (SPY, ES) and Nasdaq 100 (QQQ, NQ) index futures and ETFs. " +
  "Interested in: Fed rate decisions, CPI/PPI/jobs data, big tech earnings " +
  "(AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA), geopolitical shocks, " +
  "oil/energy disruptions, Treasury yields, and sector rotation signals."

// Supabase config table keys
export const CONFIG_KEYS = {
  marketFocus: "market_focus",
  llmModel: "llm_model",
  lastPollTs: "last_poll_ts",
  pollingEnabled: "polling_enabled",
  /** Unix seconds when polling was last set to enabled (start of auto-pause window). */
  pollingResumedAt: "polling_resumed_at",
  /** Unix seconds when cleanup (retention + dedup purge) last ran. */
  lastCleanupTs: "last_cleanup_ts",
} as const
