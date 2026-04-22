export interface FeedConfig {
  name: string
  url: string
  type: "rss" | "scrape"
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
    name: "AP News Business",
    url: "https://rsshub.app/apnews/topics/business",
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
  {
    name: "Finviz News",
    url: "https://finviz.com/news.ashx",
    type: "scrape",
  },
]

export const LLM_MODEL = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001"
export const LLM_MAX_BATCH = 5

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
} as const
