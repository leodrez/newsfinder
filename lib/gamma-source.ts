import { evaluateGammaBooks, fetchGammaBooks } from "./gamma"
import { fetchIbLiveSpots, probeIb } from "./ib-quotes"
import type { GammaBooks, GammaSet } from "./gamma"
import type { IbProbe } from "./ib-quotes"

/**
 * Picks where a gamma reading's spot comes from. "cboe" is the delayed chain's
 * own spot and works everywhere; "ib" re-reads the same Cboe book at a live
 * price from a local IB Gateway.
 */
export type GammaSourceChoice = "cboe" | "ib"

export function parseGammaSource(value: unknown): GammaSourceChoice {
  return value === "ib" ? "ib" : "cboe"
}

export interface SourcedGammaSet extends GammaSet {
  source: GammaSourceChoice
  /** Why the live spot was not applied, when "ib" was asked for. The reading
   *  still renders, on the Cboe spot, so a Gateway hiccup never blanks the panel. */
  liveError?: string
}

/**
 * The priced books change only when Cboe rebuilds its chains, so a live panel
 * refreshing every minute re-reads the same book instead of re-downloading
 * ~25MB. Kept per process: under `vercel dev` that is the local server.
 */
const BOOK_TTL_MS = 5 * 60 * 1000
let cached: { books: GammaBooks; at: number } | null = null

async function books(now: Date, useCache: boolean): Promise<GammaBooks> {
  if (useCache && cached && now.getTime() - cached.at < BOOK_TTL_MS) return cached.books
  const fresh = await fetchGammaBooks(now)
  // Only a complete fetch is worth reusing; a failed index should retry next time.
  if (!fresh.errors.spx && !fresh.errors.nq) cached = { books: fresh, at: now.getTime() }
  return fresh
}

export async function getGammaSet(
  source: GammaSourceChoice,
  opts: { useCache?: boolean; now?: Date } = {}
): Promise<SourcedGammaSet> {
  const now = opts.now ?? new Date()
  if (source === "cboe") {
    return { ...evaluateGammaBooks(await books(now, opts.useCache ?? false), now), source }
  }

  // Chains and the live quote are independent; fetch them side by side.
  const [bookSet, live] = await Promise.all([books(now, opts.useCache ?? false), fetchIbLiveSpots()])
  const set = evaluateGammaBooks(bookSet, now, live.spots)

  const problems: string[] = []
  for (const key of ["spx", "nq"] as const) {
    if (live.errors[key]) problems.push(live.errors[key]!)
    else if (set[key] && set[key]!.spotSource !== "ib") {
      problems.push(`IB ${key.toUpperCase()} price ${live.spots[key]?.price} is inconsistent with the Cboe chain; using the chain's spot`)
    }
  }
  const liveError = [...new Set(problems)].join("; ")
  return { ...set, source, ...(liveError ? { liveError } : {}) }
}

export { probeIb }
export type { IbProbe }
