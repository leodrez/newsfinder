import type { GammaSnapshot, GammaStrike } from "./types"

const CBOE_SPX_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"
const FETCH_TIMEOUT_MS = 15000
const DAY_MS = 86400000

/** Root, 2-digit YY MM DD, C or P, then strike * 1000 padded to 8 digits. */
const OSI_RE = /^([A-Z^]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/

/** Only near-dated contracts carry meaningful dealer hedging pressure. */
export const MAX_DTE = 45

export interface CboeOption {
  option: string
  open_interest?: number
  gamma?: number
}

export interface CboeChain {
  data: {
    current_price: number
    options: CboeOption[]
  }
}

/**
 * Aggregates dealer gamma exposure by strike under the standard
 * dealer-long-calls / dealer-short-puts convention. Result is dollars of
 * gamma per 1% move in spot.
 */
export function computeGamma(chain: CboeChain, now: Date): GammaSnapshot {
  const spot = chain.data.current_price
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const dollarGammaPerPct = spot * spot * 0.01

  const byStrike = new Map<number, number>()
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

    const strike = Number(match[6]) / 1000
    const sign = match[5] === "C" ? 1 : -1
    const gex = gamma * openInterest * 100 * dollarGammaPerPct * sign

    byStrike.set(strike, (byStrike.get(strike) ?? 0) + gex)
    contractsCounted += openInterest
  }

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

  return {
    spot,
    netGex,
    flipStrike,
    topStrikes,
    regime: netGex >= 0 ? "mean-reversion" : "trending",
    contractsCounted,
    strikesCounted: strikes.length,
  }
}

/**
 * Validates that a snapshot contains usable market data.
 * Returns an error message if the snapshot is not trustworthy, null if valid.
 */
export function isGammaSnapshotTrustworthy(snapshot: GammaSnapshot): string | null {
  if (!snapshot.spot || !isFinite(snapshot.spot)) {
    return "Cboe SPX chain returned no usable spot price"
  }
  if (snapshot.strikesCounted === 0) {
    return "Cboe SPX chain yielded no priced strikes within 45 DTE"
  }
  return null
}

/**
 * Fetches the full SPX chain (~12.8MB), aggregates it, and discards the raw
 * payload. Throws with a specific, user-facing reason on every failure path.
 */
export async function fetchGamma(now: Date = new Date()): Promise<GammaSnapshot> {
  let response: Response
  try {
    response = await fetch(CBOE_SPX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    throw new Error(
      isTimeout
        ? `SPX option chain timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `SPX option chain request failed: ${(err as Error).message}`
    )
  }

  if (!response.ok) {
    throw new Error(`Cboe returned HTTP ${response.status} for the SPX option chain`)
  }

  let chain: CboeChain
  try {
    chain = (await response.json()) as CboeChain
  } catch (err) {
    throw new Error(
      `Cboe SPX chain response was malformed: ${(err as Error).message}`
    )
  }

  if (!chain?.data?.options?.length) {
    throw new Error("Cboe SPX chain response contained no option data")
  }

  const snapshot = computeGamma(chain, now)
  const trustError = isGammaSnapshotTrustworthy(snapshot)
  if (trustError) throw new Error(trustError)

  return snapshot
}
