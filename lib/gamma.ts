import type { GammaComponent, GammaSnapshot, GammaStrike, Regime } from "./types"

const FETCH_TIMEOUT_MS = 15000
const DAY_MS = 86400000

/** Root, 2-digit YY MM DD, C or P, then strike * 1000 padded to 8 digits. */
const OSI_RE = /^([A-Z^]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/

/** Only near-dated contracts carry meaningful dealer hedging pressure. */
export const MAX_DTE = 45
/** Contracts inside this many days are tapered; 0DTE contributes nothing. */
export const DTE_WEIGHT_FULL = 5
/** Cboe reports junk IV (e.g. 5.54) on deep-ITM rows; treat outside this as unpriced. */
export const MIN_IV = 0.01
export const MAX_IV = 2
/** Profile runs spot × (1 ± HALF_WIDTH) in steps of STEP. */
export const PROFILE_HALF_WIDTH = 0.15
export const PROFILE_STEP = 0.001
/** A crossing further than this from spot is a far-tail artifact, not a level. */
export const MAX_FLIP_DISTANCE = 0.08
/** Within this fraction of spot from the flip, hedging flows are too small to set a regime. */
export const NEUTRAL_BAND = 0.0025

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
  /** Implied volatility as a decimal. Cboe's own `gamma` field is not used: it
   *  is zeroed on far-OTM rows and cannot be re-priced away from spot. */
  iv?: number
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

const pad2 = (n: number) => String(n).padStart(2, "0")

/**
 * Years (of 365 days) from `nowMs` to the 16:00 ET close on the expiry date.
 * Measuring to the close rather than to midnight is what makes a Black-Scholes
 * re-price agree with Cboe's own gamma on short-dated rows.
 */
export function yearsToExpiry(year: number, month: number, day: number, nowMs: number): number {
  const close = parseEasternTimestamp(`${year}-${pad2(month)}-${pad2(day)}T16:00:00`)
  if (close == null) return 0
  return Math.max(close - nowMs, 0) / (365 * DAY_MS)
}

/** Single-chain convenience over computeCombinedGamma. */
export function computeGamma(chain: CboeChain, now: Date): GammaSnapshot {
  return computeCombinedGamma([chain], now)
}

/**
 * Turns one chain's rows into priced contracts on the base axis. Strikes are
 * scaled by `strikeRatio` and snapped to `strikeBucket`, so an ETF strike and
 * the index strike it corresponds to land on one level.
 */
function priceChain(
  chain: CboeChain,
  now: Date,
  strikeRatio: number,
  strikeBucket: number
): PricedContract[] {
  const spot = chain.data.current_price
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const contracts: PricedContract[] = []

  for (const option of chain.data.options) {
    const match = OSI_RE.exec(option.option)
    if (!match) continue

    const year = 2000 + Number(match[2])
    const month = Number(match[3])
    const day = Number(match[4])
    const dte = (Date.UTC(year, month - 1, day) - todayUtc) / DAY_MS
    if (dte < 0 || dte > MAX_DTE) continue

    const openInterest = option.open_interest ?? 0
    const iv = option.iv ?? 0
    if (!openInterest || iv < MIN_IV || iv > MAX_IV) continue

    const weight = dteWeight(dte)
    const years = yearsToExpiry(year, month, day, now.getTime())
    if (weight <= 0 || years <= 0) continue

    const strike = Number(match[6]) / 1000
    const scaled = strike * strikeRatio
    const bucket = strikeBucket > 0 ? Math.round(scaled / strikeBucket) * strikeBucket : scaled

    contracts.push({
      spot,
      strike,
      bucket,
      sign: match[5] === "C" ? 1 : -1,
      openInterest,
      iv,
      years,
      weight,
    })
  }
  return contracts
}

interface ChainTally {
  component: GammaComponent
  contracts: PricedContract[]
  quoteTs: number | null
  lastTradeTs: number | null
}

function tallyChain(chain: CboeChain, now: Date, strikeRatio: number, strikeBucket: number): ChainTally {
  const contracts = priceChain(chain, now, strikeRatio, strikeBucket)
  return {
    component: {
      symbol: chain.data.symbol ?? "unknown",
      strikeRatio,
      netGex: profileValue(contracts, 1),
      contractsCounted: contracts.reduce((total, c) => total + c.openInterest, 0),
    },
    contracts,
    quoteTs: parseChainStamp(chain.timestamp),
    lastTradeTs: parseEasternTimestamp(chain.data.last_trade_time),
  }
}

/**
 * Merges several option chains on the same underlying into one dealer-gamma
 * reading. `chains[0]` is the base: the snapshot's spot, and the strike axis
 * every other chain is scaled onto.
 *
 * Exposure is the weighted book re-priced with Black-Scholes. The same
 * evaluation gives gamma at spot (`netGex`), the per-strike split
 * (`topStrikes`) and, swept across a range of hypothetical spot levels, the
 * zero-gamma level (`flipStrike`), so the three can never disagree.
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

  const tallies = chains.map((chain) => {
    const spot = chain.data.current_price
    // A chain with no usable spot cannot be placed on the base axis; it still
    // contributes dollar gamma, so scale it by 1 rather than by NaN.
    const ratio = spot && baseSpot ? baseSpot / spot : 1
    return tallyChain(chain, now, ratio, strikeBucket)
  })
  const contracts = tallies.flatMap((t) => t.contracts)

  const byStrike = new Map<number, number>()
  for (const c of contracts) byStrike.set(c.bucket, (byStrike.get(c.bucket) ?? 0) + contractGex(c, 1))
  const strikes: GammaStrike[] = [...byStrike.entries()].map(([strike, gex]) => ({ strike, gex }))
  const topStrikes = [...strikes].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 5)

  const netGex = profileValue(contracts, 1)
  const flipMultiplier = findFlipMultiplier(contracts)
  const flipStrike = flipMultiplier == null ? null : Math.round(flipMultiplier * baseSpot * 100) / 100

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
    regime: classifyRegime(netGex, baseSpot, flipStrike),
    contractsCounted: tallies.reduce((total, t) => total + t.component.contractsCounted, 0),
    strikesCounted: strikes.length,
    components: tallies.map((t) => t.component),
    quoteTs,
    lastTradeTs,
    quoteDelaySec: delays.length ? Math.max(...delays) : null,
  }
}

/** A midnight build read at 09:30 ET is ~9h old; yesterday's build read today is ~33h. */
export const MAX_CHAIN_AGE_MS = 20 * 3600 * 1000

const ET_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/**
 * Validates that a snapshot contains usable, current market data. Returns an
 * error message naming `label`'s chain if the snapshot is not trustworthy,
 * null if valid — with several indices in play, a bare failure would not say
 * which.
 */
export function isGammaSnapshotTrustworthy(
  snapshot: GammaSnapshot,
  label: string,
  now: Date
): string | null {
  if (!snapshot.spot || !isFinite(snapshot.spot)) {
    return `Cboe ${label} chain returned no usable spot price`
  }
  if (snapshot.strikesCounted === 0) {
    return `Cboe ${label} chain yielded no priced strikes within ${MAX_DTE} DTE`
  }
  if (snapshot.quoteTs != null && now.getTime() - snapshot.quoteTs > MAX_CHAIN_AGE_MS) {
    const hours = Math.round((now.getTime() - snapshot.quoteTs) / 3600000)
    // Intl gives "Fri, Aug 28, 10:30"; drop the first comma only.
    const built = ET_SHORT.format(new Date(snapshot.quoteTs)).replace(",", "")
    return `Cboe ${label} chain is stale: built ${built} ET, ${hours}h ago`
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
  // cdn.cboe.com now answers 307 to this host; go straight to it.
  return `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${symbol}.json`
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
  const trustError = isGammaSnapshotTrustworthy(snapshot, index.label, now)
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

// ── Option math ──────────────────────────────────────────────────────────────
// Method follows what SpotGamma, MenthorQ, perfiliev and ZeroGEX publish: the
// book's gamma is re-priced at a range of hypothetical spot levels, the
// zero-gamma level is where that profile crosses zero, and the regime is which
// side of that level spot sits on. See
// docs/superpowers/specs/2026-09-25-gamma-regime-redesign.md.

export interface PricedContract {
  /** Spot of the chain this contract belongs to. */
  spot: number
  /** The contract's own strike, in its own underlying's points. */
  strike: number
  /** Strike on the base axis after scaling and snapping; what topStrikes reports. */
  bucket: number
  /** +1 call (dealer long), -1 put (dealer short). */
  sign: 1 | -1
  openInterest: number
  /** Implied volatility as a decimal, e.g. 0.19. */
  iv: number
  /** Time to expiry in years of 365 days. */
  years: number
  /** DTE taper, 0..1. */
  weight: number
}

/** Standard normal density. */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Black-Scholes gamma per share with zero rate and dividend, which is how the
 * published profile methods price it. Same for calls and puts. Checked against
 * Cboe's own gamma field on a live chain: median ratio 1.000 for 1-7 DTE.
 */
export function bsGamma(spot: number, strike: number, years: number, iv: number): number {
  if (years <= 0 || iv <= 0 || spot <= 0 || strike <= 0) return 0
  const sigmaRootT = iv * Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * years) / sigmaRootT
  return phi(d1) / (spot * sigmaRootT)
}

/**
 * ZeroGEX's taper: a same-day contract's 1/sqrt(T) gamma spike must not set a
 * multi-day level, and Cboe's participant data shows market-maker net 0DTE
 * gamma is near zero anyway.
 */
export function dteWeight(dte: number): number {
  return Math.max(0, Math.min(1, dte / DTE_WEIGHT_FULL))
}

/** Signed dollar gamma per 1% move, with the contract re-priced at spot × multiplier. */
export function contractGex(c: PricedContract, multiplier: number): number {
  const level = c.spot * multiplier
  const gamma = bsGamma(level, c.strike, c.years, c.iv)
  return c.sign * c.weight * c.openInterest * 100 * gamma * level * level * 0.01
}

export function profileValue(contracts: PricedContract[], multiplier: number): number {
  let total = 0
  for (const c of contracts) total += contractGex(c, multiplier)
  return total
}

/**
 * Walks the profile across the grid and returns the multiplier of the zero
 * crossing nearest spot, or null when none lies within MAX_FLIP_DISTANCE.
 * Crossings in either direction count: the regime is the sign at spot, and the
 * nearest crossing is its boundary whichever way the curve runs.
 */
export function findFlipMultiplier(contracts: PricedContract[]): number | null {
  if (!contracts.length) return null
  const steps = Math.round((2 * PROFILE_HALF_WIDTH) / PROFILE_STEP)
  let best: number | null = null
  let prevM = 1 - PROFILE_HALF_WIDTH
  let prevV = profileValue(contracts, prevM)

  for (let i = 1; i <= steps; i++) {
    const m = 1 - PROFILE_HALF_WIDTH + i * PROFILE_STEP
    const v = profileValue(contracts, m)
    const crosses = (prevV < 0 && v >= 0) || (prevV > 0 && v <= 0)
    if (crosses) {
      const mStar = prevM + (m - prevM) * (prevV / (prevV - v))
      const distance = Math.abs(mStar - 1)
      if (distance <= MAX_FLIP_DISTANCE && (best === null || distance < Math.abs(best - 1))) {
        best = mStar
      }
    }
    prevM = m
    prevV = v
  }
  return best
}

export function classifyRegime(netGex: number, spot: number, flipStrike: number | null): Regime {
  if (flipStrike != null && spot > 0 && Math.abs(spot - flipStrike) / spot < NEUTRAL_BAND) {
    return "neutral"
  }
  return netGex >= 0 ? "mean-reversion" : "trending"
}
