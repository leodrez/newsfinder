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

export interface GammaComponent {
  /** Cboe's own symbol for the chain, e.g. "^NDX" or "QQQ". */
  symbol: string
  /** Factor this chain's strikes were scaled by to reach the base axis. */
  strikeRatio: number
  netGex: number
  contractsCounted: number
}

/** Side of the zero-gamma level spot sits on; "neutral" within 0.25% of it. */
export type Regime = "mean-reversion" | "trending" | "neutral"

export interface GammaSnapshot {
  spot: number
  /**
   * Dealer gamma at spot in dollars per 1% move: the 1-45 DTE book, DTE-weighted
   * and re-priced with Black-Scholes. Positive = dealers long gamma at this level.
   */
  netGex: number
  /**
   * Zero-gamma level: where the re-priced book's exposure crosses zero, taking
   * the crossing nearest spot within 8%. Base-axis points, 2 dp, or null.
   */
  flipStrike: number | null
  topStrikes: GammaStrike[]
  regime: Regime
  contractsCounted: number
  strikesCounted: number
  /** Per-chain contributions; one entry for a single-chain snapshot. */
  components: GammaComponent[]
  /** When Cboe built the chain (epoch ms), or null if it carried no stamp. */
  quoteTs: number | null
  /** Last trade in the underlying (epoch ms), or null if it carried no stamp. */
  lastTradeTs: number | null
  /** Seconds the quotes lag the tape. Null when either stamp is missing. */
  quoteDelaySec: number | null
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
  /**
   * True when the prior RTH close was unavailable and `chartPreviousClose` was
   * substituted. That substitution can flip the sign of the headline move, so
   * the UI must footnote the row rather than present it as a clean reading.
   */
  anchorFallback?: boolean
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
  gammaNq?: string
  summary?: string
}

export interface BriefPayload {
  quotes: OvernightQuote[]
  /** S&P 500 (SPX). Kept under its original key so stored briefs still read. */
  gamma: GammaSnapshot | null
  /** Nasdaq 100 (NDX + QQQ). Absent from briefs generated before it existed. */
  gammaNq?: GammaSnapshot | null
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
