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
  bsGamma,
  classifyRegime,
  contractGex,
  dteWeight,
  findFlipMultiplier,
  profileValue,
} from "./gamma.ts"
import type { CboeChain, PricedContract } from "./gamma.ts"

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

const near = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `${actual} not within ${tol} of ${expected}`)

test("Black-Scholes gamma matches the closed form at and away from the money", () => {
  // phi(d1) / (S sigma sqrt(T)) with d1 = (ln(S/K) + 0.5 sigma^2 T) / (sigma sqrt(T))
  near(bsGamma(100, 100, 0.25, 0.2), 0.03984439, 1e-7)
  near(bsGamma(100, 120, 0.25, 0.2), 0.008282, 1e-7)
})

test("Black-Scholes gamma is zero for expired or unpriced contracts", () => {
  assert.equal(bsGamma(100, 100, 0, 0.2), 0)
  assert.equal(bsGamma(100, 100, 0.25, 0), 0)
})

test("DTE weight excludes 0DTE and tapers to full weight at five days", () => {
  assert.equal(dteWeight(0), 0)
  near(dteWeight(1), 0.2, 1e-12)
  near(dteWeight(2), 0.4, 1e-12)
  assert.equal(dteWeight(5), 1)
  assert.equal(dteWeight(45), 1)
})

function priced(over: Partial<PricedContract>): PricedContract {
  return {
    spot: 100,
    strike: 100,
    bucket: 100,
    sign: 1,
    openInterest: 1000,
    iv: 0.2,
    years: 21 / 365,
    weight: 1,
    ...over,
  }
}

test("contract exposure is signed dollar gamma per 1% move at the shifted level", () => {
  const c = priced({ sign: -1, openInterest: 500, weight: 0.5 })
  const level = 1.02 * 100
  const expected = -1 * 0.5 * 500 * 100 * bsGamma(level, 100, 21 / 365, 0.2) * level * level * 0.01
  near(contractGex(c, 1.02), expected, 1e-9)
})

test("profile sums every contract at the same multiplier", () => {
  const book = [priced({ sign: 1 }), priced({ sign: -1, strike: 95, bucket: 95 })]
  near(profileValue(book, 1), contractGex(book[0], 1) + contractGex(book[1], 1), 1e-9)
})

test("flip is the zero crossing nearest spot, interpolated between grid points", () => {
  // Calls at 105 and puts at 95 with equal size: negative below ~100, positive above.
  const book = [priced({ sign: 1, strike: 105, bucket: 105 }), priced({ sign: -1, strike: 95, bucket: 95 })]
  const m = findFlipMultiplier(book)
  assert.ok(m != null)
  near(m!, 0.9976, 0.001, "crossing sits just below spot")
})

test("flip is null when the book never crosses zero within 8% of spot", () => {
  assert.strictEqual(findFlipMultiplier([priced({ sign: 1 })]), null, "all-call book")
  assert.strictEqual(findFlipMultiplier([priced({ sign: -1, strike: 90, bucket: 90 })]), null, "all-put book")
  assert.strictEqual(findFlipMultiplier([]), null, "empty book")
})

test("regime is neutral within the band around the flip, else the sign of gamma at spot", () => {
  assert.equal(classifyRegime(1e9, 100, 99.8), "neutral", "0.2% from the flip")
  assert.equal(classifyRegime(-1e9, 100, 100.2), "neutral", "sign is irrelevant inside the band")
  assert.equal(classifyRegime(1e9, 100, 97), "mean-reversion")
  assert.equal(classifyRegime(-1e9, 100, 103), "trending")
  assert.equal(classifyRegime(1e9, 100, null), "mean-reversion", "no flip: fall back to sign")
  assert.equal(classifyRegime(-1e9, 100, null), "trending")
})
