export interface Headline {
  title: string
  url: string
  source: string
  published_ts: number
  fetched_ts: number
}

export interface ScoredHeadline extends Headline {
  relevance: number
  impact: "high" | "medium" | "low" | "none"
  summary: string
}

export interface GammaStrike {
  strike: number
  gex: number
}

export interface GammaSnapshot {
  spot: number
  /** Net dealer gamma in dollars per 1% move. Positive = dealers long gamma. */
  netGex: number
  /** Strike where cumulative GEX crosses from negative to positive, or null. */
  flipStrike: number | null
  topStrikes: GammaStrike[]
  regime: "mean-reversion" | "trending"
  contractsCounted: number
  strikesCounted: number
}

export type QuoteGroup = "futures" | "rates" | "global" | "commods" | "vol"

export interface OvernightQuote {
  symbol: string
  label: string
  group: QuoteGroup
  last: number
  anchor: number
  change: number
  changePct: number
}

export interface BriefDriver {
  headline: string
  why: string
}

export interface BriefSummary {
  summary: string
  sentiment: number
  sentimentLabel: string
  keyDrivers: BriefDriver[]
  riskEvents: string[]
}

export interface BriefErrors {
  quotes?: Record<string, string>
  gamma?: string
  summary?: string
}

export interface BriefPayload {
  quotes: OvernightQuote[]
  gamma: GammaSnapshot | null
  keyDrivers: BriefDriver[]
  riskEvents: string[]
  sentimentLabel: string
  headlineCount: number
  errors: BriefErrors
}

export interface MarketBrief {
  generated_ts: number
  window_start_ts: number
  window_end_ts: number
  summary: string
  sentiment: number
  payload: BriefPayload
}
