import test from "node:test"
import assert from "node:assert"
import { readFileSync } from "node:fs"
import {
  GAMMA_INDICES,
  computeCombinedGamma,
  fetchGammaSet,
  fetchIndexGamma,
  computeGamma,
  isGammaSnapshotTrustworthy,
  parseEasternTimestamp,
} from "./gamma.ts"
import type { CboeChain } from "./gamma.ts"

const chain = JSON.parse(
  readFileSync(new URL("./fixtures/spx-chain.json", import.meta.url), "utf8")
) as CboeChain
const NOW = new Date("2026-08-28T00:00:00Z")

test("nets calls positive and puts negative", () => {
  const g = computeGamma(chain, NOW)
  assert.equal(g.netGex, 50000)
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
  assert.equal(g.contractsCounted, 2800, "the 112-DTE contract's 9999 OI must be excluded")
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

test("validation rejects zero or non-finite spot price", () => {
  const zeroSpot = computeGamma(
    { data: { current_price: 0, options: [{ option: "SPX260918C00100000", open_interest: 100, gamma: 0.01 }] } },
    NOW
  )
  const error = isGammaSnapshotTrustworthy(zeroSpot, "SPX")
  assert.equal(error, "Cboe SPX chain returned no usable spot price")
})

test("validation rejects snapshot with no priced strikes", () => {
  const noStrikes = computeGamma(
    { data: { current_price: 100, options: [{ option: "SPX260918C00100000", open_interest: 0, gamma: 0.01 }] } },
    NOW
  )
  const error = isGammaSnapshotTrustworthy(noStrikes, "SPX")
  assert.equal(error, "Cboe SPX chain yielded no priced strikes within 45 DTE")
})

test("includes contracts at exactly 45 DTE", () => {
  // SPX261012 expires 2026-10-12, which is exactly 45 DTE from 2026-08-28
  const exactly45Dte: CboeChain = {
    data: {
      current_price: 100,
      options: [{ option: "SPX261012C00100000", open_interest: 500, gamma: 0.01 }],
    },
  }
  const g = computeGamma(exactly45Dte, NOW)
  assert.equal(g.contractsCounted, 500, "45-DTE contract must be included")
  assert.equal(g.strikesCounted, 1)
})

test("reads an Eastern daylight-time stamp as the correct instant", () => {
  assert.equal(
    parseEasternTimestamp("2026-08-31T12:07:12"),
    Date.parse("2026-08-31T16:07:12Z"),
    "August is EDT, four hours behind UTC"
  )
})

test("reads an Eastern standard-time stamp as the correct instant", () => {
  assert.equal(
    parseEasternTimestamp("2026-01-15T12:07:12"),
    Date.parse("2026-01-15T17:07:12Z"),
    "January is EST, five hours behind UTC"
  )
})

test("resolves stamps on both sides of the spring-forward boundary", () => {
  // 2026-03-08 02:00 ET is the transition; 01:30 is still EST, 03:30 is EDT.
  assert.equal(parseEasternTimestamp("2026-03-08T01:30:00"), Date.parse("2026-03-08T06:30:00Z"))
  assert.equal(parseEasternTimestamp("2026-03-08T03:30:00"), Date.parse("2026-03-08T07:30:00Z"))
})

test("returns null for an unparseable Eastern stamp", () => {
  assert.equal(parseEasternTimestamp("not a timestamp"), null)
  assert.equal(parseEasternTimestamp(undefined), null)
})

test("reports the chain stamp, the tape stamp, and the delay between them", () => {
  const g = computeGamma(chain, NOW)
  assert.equal(g.quoteTs, Date.parse("2026-08-28T14:30:00Z"), "top-level timestamp is UTC")
  assert.equal(g.lastTradeTs, Date.parse("2026-08-28T14:15:00Z"), "last_trade_time is Eastern")
  assert.equal(g.quoteDelaySec, 900, "quotes lag the tape by 15 minutes")
})

test("reports a null delay when either stamp is missing", () => {
  const undated: CboeChain = {
    data: {
      current_price: 100,
      options: [{ option: "SPX260918C00100000", open_interest: 100, gamma: 0.01 }],
    },
  }
  const g = computeGamma(undated, NOW)
  // strictEqual, not equal: `undefined == null` would let a missing field pass.
  assert.strictEqual(g.quoteTs, null)
  assert.strictEqual(g.lastTradeTs, null)
  assert.strictEqual(g.quoteDelaySec, null)
})

const ndxChain = JSON.parse(
  readFileSync(new URL("./fixtures/ndx-chain.json", import.meta.url), "utf8")
) as CboeChain
const qqqChain = JSON.parse(
  readFileSync(new URL("./fixtures/qqq-chain.json", import.meta.url), "utf8")
) as CboeChain

test("sums dollar gamma across chains and reports the base chain's spot", () => {
  // Each fixture contract is built to contribute exactly $90m per 1% move, so
  // four contracts across two chains must net $360m regardless of scale.
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.equal(g.netGex, 3.6e8)
  assert.equal(g.spot, 30000, "the merged snapshot reports the base chain's spot")
})

test("scales overlay strikes onto the base chain's axis by the spot ratio", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  // QQQ 750 x (30000/750) lands on NDX 30000; QQQ 760 lands on 30400.
  assert.deepEqual(g.topStrikes.map((s) => s.strike).sort((a, b) => a - b), [30000, 30400])
})

test("buckets merged strikes onto a common grid", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.equal(g.strikesCounted, 2, "NDX 30390 must bucket onto 30400 with QQQ 760")
  const merged = g.topStrikes.find((s) => s.strike === 30400)
  assert.equal(merged?.gex, 1.8e8, "both chains' exposure lands in one bucket")
})

test("counts open interest across every chain", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.equal(g.contractsCounted, 8200)
})

test("reports each chain's own contribution and strike ratio", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.deepEqual(g.components, [
    { symbol: "^NDX", strikeRatio: 1, netGex: 1.8e8, contractsCounted: 200 },
    { symbol: "QQQ", strikeRatio: 40, netGex: 1.8e8, contractsCounted: 8000 },
  ])
})

test("reports the worst delay and the stalest stamps across chains", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.equal(g.quoteTs, Date.parse("2026-08-28T14:30:00Z"), "oldest chain build wins")
  assert.equal(g.lastTradeTs, Date.parse("2026-08-28T14:05:00Z"), "stalest tape stamp wins")
  assert.equal(g.quoteDelaySec, 1800, "QQQ lags 30 min, so the merged reading is 30 min")
})

test("names the index in trust errors so a failure says which chain broke", () => {
  const noStrikes = computeCombinedGamma(
    [{ data: { current_price: 30000, options: [] } }],
    NOW
  )
  assert.equal(
    isGammaSnapshotTrustworthy(noStrikes, "Nasdaq 100"),
    "Cboe Nasdaq 100 chain yielded no priced strikes within 45 DTE"
  )
})

/** Minimal stand-in for the one boundary that cannot be exercised for real. */
function stubFetch(bodies: Record<string, unknown>, events: string[] = []) {
  return async (url: string): Promise<Response> => {
    const symbol = /options\/([^.]+)\.json/.exec(url)?.[1] ?? url
    events.push(`start ${symbol}`)
    const body = bodies[symbol]
    if (body === undefined) throw new Error("connection reset")
    await new Promise((resolve) => setTimeout(resolve, 5))
    events.push(`done ${symbol}`)
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response
  }
}

test("fetches an index's chains one at a time rather than concurrently", async () => {
  const events: string[] = []
  await fetchIndexGamma(
    GAMMA_INDICES.nq,
    NOW,
    stubFetch({ _NDX: ndxChain, QQQ: qqqChain }, events)
  )
  assert.deepEqual(events, ["start _NDX", "done _NDX", "start QQQ", "done QQQ"])
})

test("merges an index's chains into one snapshot", async () => {
  const g = await fetchIndexGamma(
    GAMMA_INDICES.nq,
    NOW,
    stubFetch({ _NDX: ndxChain, QQQ: qqqChain })
  )
  assert.equal(g.netGex, 3.6e8)
  assert.deepEqual(g.components.map((c) => c.symbol), ["^NDX", "QQQ"])
})

test("fails the whole index when one of its chains is unavailable", async () => {
  await assert.rejects(
    () => fetchIndexGamma(GAMMA_INDICES.nq, NOW, stubFetch({ _NDX: ndxChain })),
    // QQQ carries more dealer gamma than NDX itself, so a merged number that
    // silently dropped it would be wrong rather than merely incomplete.
    /Nasdaq 100 \(QQQ\) option chain request failed: connection reset/
  )
})

test("gathers every index, keeping one index's failure off the others", async () => {
  const set = await fetchGammaSet(NOW, stubFetch({ _NDX: ndxChain, QQQ: qqqChain }))
  assert.equal(set.nq?.netGex, 3.6e8, "NQ still reports despite SPX being unavailable")
  assert.strictEqual(set.spx, null)
  assert.match(set.errors.spx ?? "", /S&P 500 \(SPX\) option chain request failed/)
  assert.strictEqual(set.errors.nq, undefined)
})

test("fetches indices one after another, never overlapping their chains", async () => {
  const events: string[] = []
  await fetchGammaSet(NOW, stubFetch({ _SPX: chain, _NDX: ndxChain, QQQ: qqqChain }, events))
  assert.deepEqual(events, [
    "start _SPX",
    "done _SPX",
    "start _NDX",
    "done _NDX",
    "start QQQ",
    "done QQQ",
  ])
})
