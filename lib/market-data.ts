import type { OvernightQuote, QuoteGroup } from "./types"

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
const FETCH_TIMEOUT_MS = 10000
const HOUR_SEC = 3600
/** Yahoo labels hourly bars by start time, so 15:00 ET closes at the 16:00 cash close. */
const RTH_CLOSE_BAR_HOUR_ET = 15

const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
})

export interface SymbolSpec {
  symbol: string
  label: string
  group: QuoteGroup
  /**
   * `rth-close` derives the anchor from hourly bars because Yahoo's
   * chartPreviousClose is unstable for futures across range parameters.
   */
  anchor: "rth-close" | "prev-close"
}

export interface YahooChartResult {
  meta: { symbol: string; regularMarketPrice: number; chartPreviousClose: number }
  timestamp: number[]
  indicators: { quote: Array<{ close: (number | null)[] }> }
}

export const BOARD: SymbolSpec[] = [
  { symbol: "ES=F", label: "S&P 500 (ES)", group: "futures", anchor: "rth-close" },
  { symbol: "NQ=F", label: "Nasdaq 100 (NQ)", group: "futures", anchor: "rth-close" },
  { symbol: "^TNX", label: "US 10Y Yield", group: "rates", anchor: "prev-close" },
  { symbol: "DX-Y.NYB", label: "Dollar Index", group: "rates", anchor: "prev-close" },
  { symbol: "^N225", label: "Nikkei 225", group: "global", anchor: "prev-close" },
  { symbol: "^HSI", label: "Hang Seng", group: "global", anchor: "prev-close" },
  { symbol: "^GDAXI", label: "DAX", group: "global", anchor: "prev-close" },
  { symbol: "^FTSE", label: "FTSE 100", group: "global", anchor: "prev-close" },
  { symbol: "CL=F", label: "Crude Oil", group: "commods", anchor: "prev-close" },
  { symbol: "GC=F", label: "Gold", group: "commods", anchor: "prev-close" },
  { symbol: "BTC-USD", label: "Bitcoin", group: "commods", anchor: "prev-close" },
  { symbol: "^VIX", label: "VIX", group: "vol", anchor: "prev-close" },
]

function etHour(ts: number): number {
  return Number(ET_HOUR.format(new Date(ts * 1000)))
}

/**
 * Close of the most recent completed 15:00-16:00 ET hourly bar — the prior RTH
 * cash close. Returns null if no such bar is present.
 */
export function rthCloseAnchor(
  timestamps: number[],
  closes: (number | null)[],
  now: number
): number | null {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const close = closes[i]
    if (close == null) continue
    const ts = timestamps[i]
    if (ts + HOUR_SEC > now) continue
    if (etHour(ts) !== RTH_CLOSE_BAR_HOUR_ET) continue
    return close
  }
  return null
}

export function quoteFromChart(
  spec: SymbolSpec,
  result: YahooChartResult,
  now: number
): OvernightQuote {
  const last = result.meta.regularMarketPrice
  const closes = result.indicators.quote[0]?.close ?? []

  let anchor: number | null = null
  if (spec.anchor === "rth-close") {
    anchor = rthCloseAnchor(result.timestamp ?? [], closes, now)
  }
  if (anchor == null) anchor = result.meta.chartPreviousClose

  if (!Number.isFinite(last) || !Number.isFinite(anchor) || anchor === 0) {
    throw new Error(`${spec.symbol} returned no usable price`)
  }

  const change = last - anchor
  return {
    symbol: spec.symbol,
    label: spec.label,
    group: spec.group,
    last,
    anchor,
    change,
    changePct: (change / anchor) * 100,
  }
}

async function fetchOne(spec: SymbolSpec, now: number): Promise<OvernightQuote> {
  const range = spec.anchor === "rth-close" ? "5d" : "2d"
  const interval = spec.anchor === "rth-close" ? "1h" : "1d"
  const url = `${CHART_BASE}/${encodeURIComponent(spec.symbol)}?range=${range}&interval=${interval}&includePrePost=true`

  let response: Response
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "NewsFinder/2.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    throw new Error(
      isTimeout
        ? `${spec.label} timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `${spec.label} request failed: ${(err as Error).message}`
    )
  }

  if (!response.ok) throw new Error(`${spec.label} returned HTTP ${response.status}`)

  const body = (await response.json()) as { chart?: { result?: YahooChartResult[] } }
  const result = body.chart?.result?.[0]
  if (!result) throw new Error(`${spec.label} returned no chart data`)

  return quoteFromChart(spec, result, now)
}

/** Fetches the whole board in parallel. One symbol failing never sinks the rest. */
export async function fetchQuotes(
  now: number = Math.floor(Date.now() / 1000)
): Promise<{ quotes: OvernightQuote[]; errors: Record<string, string> }> {
  const settled = await Promise.allSettled(BOARD.map((spec) => fetchOne(spec, now)))

  const quotes: OvernightQuote[] = []
  const errors: Record<string, string> = {}

  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      quotes.push(outcome.value)
    } else {
      const reason = outcome.reason
      errors[BOARD[i].symbol] = reason instanceof Error ? reason.message : String(reason)
      console.warn(`[market-data] ${BOARD[i].symbol}: ${errors[BOARD[i].symbol]}`)
    }
  })

  return { quotes, errors }
}
