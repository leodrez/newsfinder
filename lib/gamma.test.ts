import test from "node:test"
import assert from "node:assert"
import { readFileSync } from "node:fs"
import { computeGamma } from "./gamma.ts"
import type { CboeChain } from "./gamma.ts"

const chain = JSON.parse(
  readFileSync(new URL("./fixtures/spx-chain.json", import.meta.url), "utf8")
) as CboeChain
const NOW = new Date("2026-08-28T00:00:00Z")

test("nets calls positive and puts negative", () => {
  const g = computeGamma(chain, NOW)
  assert.equal(g.netGex, 40000)
  assert.equal(g.spot, 100)
})

test("positive net GEX classifies as mean-reversion", () => {
  assert.equal(computeGamma(chain, NOW).regime, "mean-reversion")
})

test("negative net GEX classifies as trending", () => {
  const bearish: CboeChain = {
    data: {
      current_price: 100,
      options: [{ option: "SPX260918P00090000", open_interest: 500, gamma: 0.02 }],
    },
  }
  assert.equal(computeGamma(bearish, NOW).regime, "trending")
})

test("excludes contracts beyond 45 DTE, without gamma, or without open interest", () => {
  const g = computeGamma(chain, NOW)
  assert.equal(g.strikesCounted, 3, "105 and 95 must not create strikes")
  assert.equal(g.contractsCounted, 2700, "the 112-DTE contract's 9999 OI must be excluded")
})

test("finds the zero-gamma flip where cumulative GEX turns positive", () => {
  assert.equal(computeGamma(chain, NOW).flipStrike, 110)
})

test("returns a null flip when cumulative GEX never turns positive", () => {
  const allNegative: CboeChain = {
    data: {
      current_price: 100,
      options: [{ option: "SPX260918P00090000", open_interest: 500, gamma: 0.02 }],
    },
  }
  assert.equal(computeGamma(allNegative, NOW).flipStrike, null)
})

test("ranks top strikes by absolute exposure", () => {
  const g = computeGamma(chain, NOW)
  assert.deepEqual(g.topStrikes.map((s) => s.strike), [90, 110, 100])
})

test("ignores symbols that are not OSI-format", () => {
  assert.equal(computeGamma(chain, NOW).strikesCounted, 3)
})
