import test from "node:test"
import assert from "node:assert"
import { briefWindow, priorRthCloseTs, MIN_WINDOW_SEC, MAX_WINDOW_SEC } from "./window.ts"

// 2026-08-28 is a Friday. 09:25 ET = 13:25 UTC (EDT, UTC-4).
const FRI_0925_ET = Math.floor(Date.parse("2026-08-28T13:25:00Z") / 1000)
// 2026-08-31 is a Monday. 09:25 ET = 13:25 UTC.
const MON_0925_ET = Math.floor(Date.parse("2026-08-31T13:25:00Z") / 1000)
// 2026-08-28 17:00 ET = 21:00 UTC, one hour after the cash close.
const FRI_1700_ET = Math.floor(Date.parse("2026-08-28T21:00:00Z") / 1000)

test("priorRthCloseTs returns the previous 16:00 ET", () => {
  // Thursday 2026-08-27 16:00 ET = 20:00 UTC
  assert.equal(priorRthCloseTs(FRI_0925_ET), Math.floor(Date.parse("2026-08-27T20:00:00Z") / 1000))
})

test("priorRthCloseTs uses today's close once it has passed", () => {
  assert.equal(priorRthCloseTs(FRI_1700_ET), Math.floor(Date.parse("2026-08-28T20:00:00Z") / 1000))
})

test("a normal morning looks back to the prior cash close", () => {
  const { start, end } = briefWindow(FRI_0925_ET)
  assert.equal(end, FRI_0925_ET)
  assert.equal(start, priorRthCloseTs(FRI_0925_ET))
  const span = end - start
  assert.ok(span > MIN_WINDOW_SEC && span < MAX_WINDOW_SEC, `span ${span} should sit inside the clamp`)
})

test("a Monday open clamps to 24h instead of reaching back to Friday", () => {
  const { start, end } = briefWindow(MON_0925_ET)
  assert.equal(end - start, MAX_WINDOW_SEC)
})

test("just after the close floors at 12h rather than 1h", () => {
  const { start, end } = briefWindow(FRI_1700_ET)
  assert.equal(end - start, MIN_WINDOW_SEC)
})
