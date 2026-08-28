import test from "node:test"
import assert from "node:assert"
import { BOARD, rthCloseAnchor, quoteFromChart } from "./market-data.ts"
import type { YahooChartResult } from "./market-data.ts"

const HOUR = 3600
// 2026-08-27 15:00 ET (the 15:00-16:00 bar, closing at the 16:00 cash close) = 19:00 UTC
const THU_1500_ET = Math.floor(Date.parse("2026-08-27T19:00:00Z") / 1000)
const FRI_0925_ET = Math.floor(Date.parse("2026-08-28T13:25:00Z") / 1000)

/** Hourly bars every hour from THU_1500_ET through the following morning. */
function bars(): { timestamps: number[]; closes: (number | null)[] } {
  const timestamps: number[] = []
  const closes: (number | null)[] = []
  for (let i = 0; i < 19; i++) {
    timestamps.push(THU_1500_ET + i * HOUR)
    closes.push(7700 + i)
  }
  return { timestamps, closes }
}

test("anchors futures to the 15:00 ET bar close, not chartPreviousClose", () => {
  const { timestamps, closes } = bars()
  assert.equal(rthCloseAnchor(timestamps, closes, FRI_0925_ET), 7700)
})

test("skips bars that have not finished yet", () => {
  const timestamps = [THU_1500_ET, THU_1500_ET + 24 * HOUR]
  const closes = [7700, 7999]
  // The second 15:00 ET bar starts 25 minutes before `now`, so it is incomplete.
  const now = THU_1500_ET + 24 * HOUR + 25 * 60
  assert.equal(rthCloseAnchor(timestamps, closes, now), 7700)
})

test("skips null closes from thin overnight bars", () => {
  const timestamps = [THU_1500_ET - 24 * HOUR, THU_1500_ET]
  const closes: (number | null)[] = [7600, null]
  assert.equal(rthCloseAnchor(timestamps, closes, FRI_0925_ET), 7600)
})

test("returns null when no completed 15:00 ET bar exists", () => {
  const timestamps = [THU_1500_ET + HOUR, THU_1500_ET + 2 * HOUR]
  assert.equal(rthCloseAnchor(timestamps, [7701, 7702], FRI_0925_ET), null)
})

test("prev-close instruments use chartPreviousClose", () => {
  const spec = BOARD.find((s) => s.symbol === "^N225")!
  const result: YahooChartResult = {
    meta: { symbol: "^N225", regularMarketPrice: 66405.56, chartPreviousClose: 66131.98 },
    timestamp: [],
    indicators: { quote: [{ close: [] }] },
  }
  const q = quoteFromChart(spec, result, FRI_0925_ET)
  assert.equal(q.anchor, 66131.98)
  assert.ok(Math.abs(q.changePct - 0.4137) < 0.001, `got ${q.changePct}`)
})

test("futures quote derives change from the RTH anchor", () => {
  const spec = BOARD.find((s) => s.symbol === "ES=F")!
  const { timestamps, closes } = bars()
  const result: YahooChartResult = {
    meta: { symbol: "ES=F", regularMarketPrice: 7777, chartPreviousClose: 7669.75 },
    timestamp: timestamps,
    indicators: { quote: [{ close: closes }] },
  }
  const q = quoteFromChart(spec, result, FRI_0925_ET)
  assert.equal(q.anchor, 7700, "must ignore chartPreviousClose of 7669.75")
  assert.equal(q.change, 77)
})

test("the board covers all twelve instruments the spec requires", () => {
  assert.equal(BOARD.length, 12)
  for (const s of ["ES=F", "NQ=F", "^TNX", "DX-Y.NYB", "^N225", "^HSI", "^GDAXI", "^FTSE", "CL=F", "GC=F", "BTC-USD", "^VIX"]) {
    assert.ok(BOARD.some((b) => b.symbol === s), `${s} missing from BOARD`)
  }
})
