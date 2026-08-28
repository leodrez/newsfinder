import type { OvernightQuote } from "./types"

/**
 * Symbols quoted as a yield rather than a price. A yield's move is quoted in
 * basis points, never as a percent change of the yield itself: on a 4.66% 10Y a
 * 4.8bp move is +1.03% relative, a ~40x misread of the same number.
 *
 * Keyed off the symbol and never off `group`: `DX-Y.NYB` shares the "rates"
 * group but is a price index, not a yield.
 */
const YIELD_SYMBOLS = new Set(["^TNX"])

/** The fields any renderer needs to describe a quote's overnight move. */
export type QuoteChangeFields = Pick<OvernightQuote, "symbol" | "last" | "anchor" | "changePct">

/**
 * The single source of truth for how an overnight move is written, shared by
 * the LLM prompt tape (`lib/summarize.ts`) and the UI board
 * (`frontend/src/components/overnight-board.tsx`). Both call this so a third
 * renderer cannot reintroduce the percent-change-on-a-yield bug.
 *
 * Returns a signed, unit-suffixed string: "+4.8bp" for yields, "-0.27%" otherwise.
 */
export function formatQuoteChange(quote: QuoteChangeFields): string {
  if (YIELD_SYMBOLS.has(quote.symbol)) {
    const bp = (quote.last - quote.anchor) * 100
    return `${bp >= 0 ? "+" : ""}${bp.toFixed(1)}bp`
  }
  return `${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}%`
}
