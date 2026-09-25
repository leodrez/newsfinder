import type { GammaSnapshot } from "./types"

/**
 * One tape line per index for the summarizer. Leads with the regime and
 * spot's position against the zero-gamma level so the model reasons from the
 * level, then gives gamma at spot as supporting size. Lives apart from
 * summarize.ts so it can be unit-tested without the LLM client.
 */
export function renderGamma(label: string, gamma: GammaSnapshot | null): string | null {
  if (!gamma) return null
  const flip = gamma.flipStrike
  const position =
    flip == null
      ? "has no zero-gamma level within 8%"
      : `is ${Math.abs(gamma.spot - flip).toFixed(0)} pts ` +
        `(${(Math.abs(gamma.spot / flip - 1) * 100).toFixed(2)}%) ` +
        `${gamma.spot >= flip ? "above" : "below"} the zero-gamma level at ${flip}`
  return (
    `Dealer gamma ${label}: ${gamma.regime}; spot ${gamma.spot} ${position}; ` +
    `gamma at spot ${(gamma.netGex / 1e9).toFixed(1)}bn per 1%`
  )
}
