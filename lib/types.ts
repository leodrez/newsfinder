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
