import test from "node:test"
import assert from "node:assert"
import { renderGamma } from "./gamma-format.ts"
import type { GammaSnapshot } from "./types.ts"

function snap(over: Partial<GammaSnapshot>): GammaSnapshot {
  return {
    spot: 7703.52,
    netGex: -5.72e9,
    flipStrike: 7711,
    topStrikes: [],
    regime: "neutral",
    contractsCounted: 0,
    strikesCounted: 0,
    components: [],
    quoteTs: null,
    lastTradeTs: null,
    quoteDelaySec: null,
    ...over,
  }
}

test("tape line leads with the regime and spot's position against the zero-gamma level", () => {
  assert.equal(
    renderGamma("SPX", snap({})),
    "Dealer gamma SPX: neutral; spot 7703.52 is 7 pts (0.10%) below the zero-gamma level at 7711; gamma at spot -5.7bn per 1%"
  )
})

test("tape line says when there is no zero-gamma level in range", () => {
  assert.equal(
    renderGamma("NDX+QQQ", snap({ regime: "mean-reversion", netGex: 4.0e9, flipStrike: null, spot: 30519.44 })),
    "Dealer gamma NDX+QQQ: mean-reversion; spot 30519.44 has no zero-gamma level within 8%; gamma at spot 4.0bn per 1%"
  )
})

test("tape line returns null without a snapshot", () => {
  assert.strictEqual(renderGamma("SPX", null), null)
})

test("tape line says when spot is a live IB quote rather than the delayed chain", () => {
  assert.equal(
    renderGamma("SPX", snap({ spotSource: "ib", spotLabel: "SPX index last", chainSpot: 7681.07, spot: 7682.68 })),
    "Dealer gamma SPX: neutral; spot 7682.68 (live, SPX index last) is 28 pts (0.37%) below the zero-gamma level at 7711; gamma at spot -5.7bn per 1%"
  )
})
