import test from "node:test"
import assert from "node:assert"
import { formatQuoteChange } from "./quote-format.ts"

/** A 10Y yield that moved 4.8bp: 4.658 -> 4.706, i.e. +1.03% relative. */
const TNX = {
  symbol: "^TNX",
  last: 4.706,
  anchor: 4.658,
  changePct: ((4.706 - 4.658) / 4.658) * 100,
}

test("the 10Y yield is quoted in basis points, not as a percent change", () => {
  assert.equal(formatQuoteChange(TNX), "+4.8bp")
  // The bug this replaces: the same move rendered as a relative percent.
  assert.ok(Math.abs(TNX.changePct - 1.03) < 0.01, `got ${TNX.changePct}`)
})

test("a falling yield keeps the minus sign and the bp unit", () => {
  assert.equal(
    formatQuoteChange({ symbol: "^TNX", last: 4.61, anchor: 4.658, changePct: -1.0305 }),
    "-4.8bp"
  )
})

test("DX-Y.NYB shares the rates group but is not a yield, so it stays a percent", () => {
  assert.equal(
    formatQuoteChange({ symbol: "DX-Y.NYB", last: 98.42, anchor: 98.15, changePct: 0.27509 }),
    "+0.28%"
  )
})

test("ordinary instruments render a signed percent to two decimals", () => {
  assert.equal(
    formatQuoteChange({ symbol: "ES=F", last: 7679, anchor: 7700, changePct: -0.27272 }),
    "-0.27%"
  )
  assert.equal(
    formatQuoteChange({ symbol: "BTC-USD", last: 101000, anchor: 100000, changePct: 1 }),
    "+1.00%"
  )
})

test("an unchanged quote renders as a signed zero, never a bare 0", () => {
  assert.equal(formatQuoteChange({ symbol: "^VIX", last: 15, anchor: 15, changePct: 0 }), "+0.00%")
  assert.equal(formatQuoteChange({ symbol: "^TNX", last: 4.658, anchor: 4.658, changePct: 0 }), "+0.0bp")
})
