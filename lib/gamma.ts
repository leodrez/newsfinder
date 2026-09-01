import type { GammaComponent, GammaSnapshot, GammaStrike } from "./types"

const FETCH_TIMEOUT_MS = 15000
const DAY_MS = 86400000

/** Root, 2-digit YY MM DD, C or P, then strike * 1000 padded to 8 digits. */
const OSI_RE = /^([A-Z^]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/

/** Only near-dated contracts carry meaningful dealer hedging pressure. */
export const MAX_DTE = 45

/** Cboe stamps `data.last_trade_time` as bare Eastern wall-clock: `YYYY-MM-DDTHH:MM:SS`. */
const ET_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

/** How far New York sits from UTC at `instant`, in ms (negative: -4h in EDT, -5h in EST). */
function easternOffsetMs(instant: number): number {
  const parts = new Map(ET_FORMAT.formatToParts(new Date(instant)).map((p) => [p.type, p.value]))
  const wallClock = Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second"))
  )
  return wallClock - instant
}

/**
 * Resolves a bare Eastern wall-clock stamp to an epoch instant. The offset is
 * looked up from the zone rather than assumed, so the quote delay we report
 * stays correct across the DST boundary instead of jumping by an hour. The
 * second pass re-reads the offset at the candidate instant, which is what
 * corrects stamps that fall just after a transition.
 */
export function parseEasternTimestamp(text: string | undefined | null): number | null {
  const match = text ? ET_STAMP_RE.exec(text.trim()) : null
  if (!match) return null

  const wallClock = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  )
  const firstPass = wallClock - easternOffsetMs(wallClock)
  return wallClock - easternOffsetMs(firstPass)
}

export interface CboeOption {
  option: string
  open_interest?: number
  gamma?: number
}

export interface CboeChain {
  /** When Cboe built this chain. UTC, space-separated. */
  timestamp?: string
  data: {
    symbol?: string
    current_price: number
    /** Last trade in the underlying, Eastern wall-clock. */
    last_trade_time?: string
    options: CboeOption[]
  }
}

/** UTC, space-separated: `YYYY-MM-DD HH:MM:SS`. */
const UTC_STAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/

function parseChainStamp(text: string | undefined): number | null {
  const match = text ? UTC_STAMP_RE.exec(text.trim()) : null
  if (!match) return null
  const ms = Date.parse(`${match[1]}T${match[2]}Z`)
  return isNaN(ms) ? null : ms
}

/**
 * Aggregates dealer gamma exposure by strike under the standard
 * dealer-long-calls / dealer-short-puts convention. Result is dollars of
 * gamma per 1% move in spot.
 */
export function computeGamma(chain: CboeChain, now: Date): GammaSnapshot {
  return computeCombinedGamma([chain], now)
}

interface ChainTally {
  component: GammaComponent
  quoteTs: number | null
  lastTradeTs: number | null
}

/**
 * Accumulates one chain's exposure into `byStrike`, which may already hold
 * another chain's. Strikes are scaled by `strikeRatio` onto the base chain's
 * axis and snapped to `strikeBucket`, so an ETF strike and the index strike it
 * corresponds to land on one level instead of two near-duplicates.
 *
 * Dollar gamma needs no such conversion: each chain's exposure is computed
 * from its own spot and expressed as dollars per 1% move, a unit that is
 * already common across underlyings and therefore additive.
 */
function tallyChain(
  chain: CboeChain,
  now: Date,
  strikeRatio: number,
  strikeBucket: number,
  byStrike: Map<number, number>
): ChainTally {
  const spot = chain.data.current_price
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const dollarGammaPerPct = spot * spot * 0.01

  let netGex = 0
  let contractsCounted = 0

  for (const option of chain.data.options) {
    const match = OSI_RE.exec(option.option)
    if (!match) continue

    const expiryUtc = Date.UTC(2000 + Number(match[2]), Number(match[3]) - 1, Number(match[4]))
    const dte = (expiryUtc - todayUtc) / DAY_MS
    if (dte < 0 || dte > MAX_DTE) continue

    const openInterest = option.open_interest ?? 0
    const gamma = option.gamma ?? 0
    if (!openInterest || !gamma) continue

    const scaled = (Number(match[6]) / 1000) * strikeRatio
    const strike = strikeBucket > 0 ? Math.round(scaled / strikeBucket) * strikeBucket : scaled
    const sign = match[5] === "C" ? 1 : -1
    const gex = gamma * openInterest * 100 * dollarGammaPerPct * sign

    byStrike.set(strike, (byStrike.get(strike) ?? 0) + gex)
    netGex += gex
    contractsCounted += openInterest
  }

  return {
    component: {
      symbol: chain.data.symbol ?? "unknown",
      strikeRatio,
      netGex,
      contractsCounted,
    },
    quoteTs: parseChainStamp(chain.timestamp),
    lastTradeTs: parseEasternTimestamp(chain.data.last_trade_time),
  }
}

/**
 * Merges several option chains on the same underlying into one dealer-gamma
 * reading. `chains[0]` is the base: the snapshot's spot, and the strike axis
 * every other chain is scaled onto.
 *
 * Staleness is reported conservatively — the oldest build, the stalest tape
 * stamp, and the worst per-chain delay — so the merged reading is never
 * presented as fresher than its least fresh input.
 */
export function computeCombinedGamma(
  chains: CboeChain[],
  now: Date,
  options: { strikeBucket?: number } = {}
): GammaSnapshot {
  const strikeBucket = options.strikeBucket ?? 0
  const baseSpot = chains[0]?.data.current_price ?? 0

  const byStrike = new Map<number, number>()
  const tallies = chains.map((chain) => {
    const spot = chain.data.current_price
    // A chain with no usable spot cannot be placed on the base axis; it still
    // contributes dollar gamma, so scale it by 1 rather than by NaN.
    const ratio = spot && baseSpot ? baseSpot / spot : 1
    return tallyChain(chain, now, ratio, strikeBucket, byStrike)
  })

  const strikes: GammaStrike[] = [...byStrike.entries()].map(([strike, gex]) => ({ strike, gex }))
  const netGex = strikes.reduce((total, s) => total + s.gex, 0)

  // Walk strikes low to high; the flip is where cumulative exposure turns positive.
  let cumulative = 0
  let flipStrike: number | null = null
  for (const s of [...strikes].sort((a, b) => a.strike - b.strike)) {
    const previous = cumulative
    cumulative += s.gex
    if (previous < 0 && cumulative >= 0) flipStrike = s.strike
  }

  const topStrikes = [...strikes].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 5)

  // Cboe's own two stamps are what let the UI state the delay as a measurement
  // rather than repeating a documented figure that could quietly stop being true.
  const oldest = (values: (number | null)[]): number | null => {
    const present = values.filter((v): v is number => v != null)
    return present.length ? Math.min(...present) : null
  }
  const quoteTs = oldest(tallies.map((t) => t.quoteTs))
  const lastTradeTs = oldest(tallies.map((t) => t.lastTradeTs))
  const delays = tallies
    .filter((t) => t.quoteTs != null && t.lastTradeTs != null)
    .map((t) => Math.round((t.quoteTs! - t.lastTradeTs!) / 1000))

  return {
    spot: baseSpot,
    netGex,
    flipStrike,
    topStrikes,
    regime: netGex >= 0 ? "mean-reversion" : "trending",
    contractsCounted: tallies.reduce((total, t) => total + t.component.contractsCounted, 0),
    strikesCounted: strikes.length,
    components: tallies.map((t) => t.component),
    quoteTs,
    lastTradeTs,
    quoteDelaySec: delays.length ? Math.max(...delays) : null,
  }
}

/**
 * Validates that a snapshot contains usable market data. Returns an error
 * message naming `label`'s chain if the snapshot is not trustworthy, null if
 * valid — with several indices in play, a bare failure would not say which.
 */
export function isGammaSnapshotTrustworthy(
  snapshot: GammaSnapshot,
  label: string
): string | null {
  if (!snapshot.spot || !isFinite(snapshot.spot)) {
    return `Cboe ${label} chain returned no usable spot price`
  }
  if (snapshot.strikesCounted === 0) {
    return `Cboe ${label} chain yielded no priced strikes within ${MAX_DTE} DTE`
  }
  return null
}

export interface GammaIndex {
  key: "spx" | "nq"
  label: string
  /**
   * Cboe CDN symbols. The first is the base: its spot and strike axis are what
   * the merged snapshot reports, and the rest are folded onto that axis.
   */
  symbols: string[]
  /** Strike grid in base-index points; 0 leaves strikes unsnapped. */
  strikeBucket: number
}

/**
 * NQ has no option chain of its own, so its dealer gamma is the Nasdaq-100
 * complex: the NDX index chain plus the QQQ ETF chain, which carries the larger
 * share of the book. Strikes are reported in NDX points, the axis NQ trades
 * against. 25 points is 0.085% of spot — tight enough to stay a meaningful
 * level, wide enough to merge a QQQ strike with the index strike beside it.
 */
export const GAMMA_INDICES: Record<"spx" | "nq", GammaIndex> = {
  spx: { key: "spx", label: "S&P 500", symbols: ["_SPX"], strikeBucket: 0 },
  nq: { key: "nq", label: "Nasdaq 100", symbols: ["_NDX", "QQQ"], strikeBucket: 25 },
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

function chainUrl(symbol: string): string {
  return `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`
}

/** Throws with a specific, user-facing reason on every failure path. */
async function fetchChain(
  symbol: string,
  label: string,
  fetchImpl: FetchImpl
): Promise<CboeChain> {
  const where = `${label} (${symbol.replace(/^_/, "")})`

  let response: Response
  try {
    response = await fetchImpl(chainUrl(symbol), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    throw new Error(
      isTimeout
        ? `${where} option chain timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `${where} option chain request failed: ${(err as Error).message}`
    )
  }

  if (!response.ok) {
    throw new Error(`Cboe returned HTTP ${response.status} for the ${where} option chain`)
  }

  let chain: CboeChain
  try {
    chain = (await response.json()) as CboeChain
  } catch (err) {
    throw new Error(`Cboe ${where} chain response was malformed: ${(err as Error).message}`)
  }

  if (!chain?.data?.options?.length) {
    throw new Error(`Cboe ${where} chain response contained no option data`)
  }

  return chain
}

/**
 * Fetches an index's chains (SPX alone is ~12.8MB), aggregates them, and
 * discards the raw payloads. Chains are fetched one at a time: two of these
 * buffering concurrently inside one serverless invocation is the memory risk
 * here, and the extra seconds cost nothing against the function's budget.
 *
 * A failure in any single chain fails the index. For NQ that is deliberate —
 * QQQ carries more dealer gamma than NDX, so a merged reading that quietly
 * dropped it would be wrong, not merely partial.
 */
export async function fetchIndexGamma(
  index: GammaIndex,
  now: Date = new Date(),
  fetchImpl: FetchImpl = fetch
): Promise<GammaSnapshot> {
  const chains: CboeChain[] = []
  for (const symbol of index.symbols) {
    chains.push(await fetchChain(symbol, index.label, fetchImpl))
  }

  const snapshot = computeCombinedGamma(chains, now, { strikeBucket: index.strikeBucket })
  const trustError = isGammaSnapshotTrustworthy(snapshot, index.label)
  if (trustError) throw new Error(trustError)

  return snapshot
}

export interface GammaSet {
  spx: GammaSnapshot | null
  nq: GammaSnapshot | null
  errors: { spx?: string; nq?: string }
}

/**
 * Gathers every index's gamma reading. Indices run one after another for the
 * same reason their chains do — only one chain is ever in flight, so peak heap
 * stays at roughly what the SPX chain alone already costs.
 *
 * Each index degrades on its own: one unreachable chain leaves that panel with
 * a reason and the other intact.
 */
export async function fetchGammaSet(
  now: Date = new Date(),
  fetchImpl: FetchImpl = fetch
): Promise<GammaSet> {
  const set: GammaSet = { spx: null, nq: null, errors: {} }

  for (const index of Object.values(GAMMA_INDICES)) {
    try {
      set[index.key] = await fetchIndexGamma(index, now, fetchImpl)
    } catch (err) {
      set.errors[index.key] = err instanceof Error ? err.message : String(err)
    }
  }

  return set
}
