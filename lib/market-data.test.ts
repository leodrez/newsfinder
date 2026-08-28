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

test("rth-close spec falls back to chartPreviousClose when no completed 15:00 ET bar exists", () => {
  const spec = BOARD.find((s) => s.symbol === "ES=F")!
  // Only 14:00 and 16:00 ET bars — no 15:00 ET bar at all.
  const timestamps = [THU_1500_ET - HOUR, THU_1500_ET + HOUR]
  const closes = [7690, 7710]
  const result: YahooChartResult = {
    meta: { symbol: "ES=F", regularMarketPrice: 7777, chartPreviousClose: 7669.75 },
    timestamp: timestamps,
    indicators: { quote: [{ close: closes }] },
  }
  const q = quoteFromChart(spec, result, FRI_0925_ET)
  assert.equal(q.anchor, 7669.75)
})

test("the RTH-anchor fallback is flagged on the quote so the UI can footnote it", () => {
  const spec = BOARD.find((s) => s.symbol === "ES=F")!
  // Only 14:00 and 16:00 ET bars — no 15:00 ET bar at all.
  const timestamps = [THU_1500_ET - HOUR, THU_1500_ET + HOUR]
  const result: YahooChartResult = {
    meta: { symbol: "ES=F", regularMarketPrice: 7679, chartPreviousClose: 7628.5 },
    timestamp: timestamps,
    indicators: { quote: [{ close: [7690, 7710] }] },
  }
  const q = quoteFromChart(spec, result, FRI_0925_ET)
  assert.equal(q.anchorFallback, true)
  assert.equal(q.anchor, 7628.5)
  // The substitution flips the sign: -0.27% against the true RTH close of 7700.
  assert.ok(q.changePct > 0, `got ${q.changePct}`)
  // Same chart anchored to its real 15:00 ET bar would have been negative, so the
  // fallback genuinely inverts the reported direction — hence the UI footnote.
  const withRthBar = quoteFromChart(
    spec,
    { ...result, timestamp: [THU_1500_ET, ...timestamps], indicators: { quote: [{ close: [7700, 7690, 7710] }] } },
    FRI_0925_ET
  )
  assert.equal(withRthBar.anchor, 7700)
  assert.ok(withRthBar.changePct < 0, `got ${withRthBar.changePct}`)
})

test("a quote anchored to a real 15:00 ET bar carries no fallback flag", () => {
  const spec = BOARD.find((s) => s.symbol === "ES=F")!
  const { timestamps, closes } = bars()
  const result: YahooChartResult = {
    meta: { symbol: "ES=F", regularMarketPrice: 7777, chartPreviousClose: 7669.75 },
    timestamp: timestamps,
    indicators: { quote: [{ close: closes }] },
  }
  assert.equal(quoteFromChart(spec, result, FRI_0925_ET).anchorFallback, undefined)
})

test("prev-close instruments are not flagged as fallbacks — that is their normal anchor", () => {
  const spec = BOARD.find((s) => s.symbol === "^TNX")!
  const result: YahooChartResult = {
    meta: { symbol: "^TNX", regularMarketPrice: 4.706, chartPreviousClose: 4.658 },
    timestamp: [],
    indicators: { quote: [{ close: [] }] },
  }
  assert.equal(quoteFromChart(spec, result, FRI_0925_ET).anchorFallback, undefined)
})
