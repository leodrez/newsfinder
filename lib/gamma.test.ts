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
  yearsToExpiry,
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

const near = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `${actual} not within ${tol} of ${expected}`)

test("gamma at spot is positive when calls dominate at the money", () => {
  const g = computeGamma(chain, NOW)
  assert.ok(g.netGex > 0)
  assert.equal(g.spot, 100)
  assert.equal(g.regime, "mean-reversion")
})

test("flip is the re-priced zero crossing, not the first positive cumulative strike", () => {
  // Puts at 90 outweigh calls only well below spot. The old cumulative walk put
  // the flip at 110 (the first call wall); the profile crosses near 93.8.
  const flip = computeGamma(chain, NOW).flipStrike
  assert.ok(flip != null && flip > 92 && flip < 96, `flip ${flip}`)
})

test("regime is decided by which side of the flip spot sits on", () => {
  // Equal-size calls at 105 and puts at 95: the flip sits at ~99.76 whatever spot is.
  const book = (spot: number): CboeChain => ({
    data: {
      current_price: spot,
      options: [
        { option: "SPX260918C00105000", open_interest: 1000, iv: 0.2 },
        { option: "SPX260918P00095000", open_interest: 1000, iv: 0.2 },
      ],
    },
  })
  const atFlip = computeGamma(book(100), NOW)
  near(atFlip.flipStrike!, 99.76, 0.05)
  assert.equal(atFlip.regime, "neutral", "0.24% from the flip is inside the band")

  const above = computeGamma(book(103), NOW)
  assert.equal(above.regime, "mean-reversion")
  assert.ok(above.netGex > 0)

  const below = computeGamma(book(97), NOW)
  assert.equal(below.regime, "trending")
  assert.ok(below.netGex < 0)
})

test("a one-sided book has no flip and classifies by the sign at spot", () => {
  const onlyPuts: CboeChain = {
    data: {
      current_price: 100,
      options: [{ option: "SPX260918P00090000", open_interest: 500, iv: 0.2 }],
    },
  }
  const g = computeGamma(onlyPuts, NOW)
  assert.strictEqual(g.flipStrike, null)
  assert.equal(g.regime, "trending")
  assert.ok(g.netGex < 0)
})

test("excludes contracts beyond 45 DTE, without usable IV, without open interest, or expiring today", () => {
  const g = computeGamma(chain, NOW)
  assert.equal(g.strikesCounted, 3, "105, 95 and 120 must not create strikes")
  assert.equal(g.contractsCounted, 2800, "112-DTE 9999 OI and 0DTE 5000 OI must be excluded")
})

test("rejects a chain with no usable implied volatility", () => {
  const zeroedGreeks: CboeChain = {
    data: {
      current_price: 100,
      options: [
        { option: "SPX260918C00100000", open_interest: 1000, iv: 0 },
        { option: "SPX260918P00100000", open_interest: 1000, iv: 0 },
      ],
    },
  }
  const g = computeGamma(zeroedGreeks, NOW)
  assert.equal(isGammaSnapshotTrustworthy(g, "SPX", NOW), "Cboe SPX chain yielded no priced strikes within 45 DTE")
})

test("ranks top strikes by absolute exposure", () => {
  const g = computeGamma(chain, NOW)
  assert.deepEqual(g.topStrikes.map((s) => s.strike), [100, 110, 90])
  assert.ok(g.topStrikes[2].gex < 0, "the 90 put strike is short gamma")
})

test("ignores symbols that are not OSI-format", () => {
  assert.equal(computeGamma(chain, NOW).strikesCounted, 3)
})

test("validation rejects zero or non-finite spot price", () => {
  const zeroSpot = computeGamma(
    { data: { current_price: 0, options: [{ option: "SPX260918C00100000", open_interest: 100, iv: 0.2 }] } },
    NOW
  )
  assert.equal(isGammaSnapshotTrustworthy(zeroSpot, "SPX", NOW), "Cboe SPX chain returned no usable spot price")
})

test("validation rejects snapshot with no priced strikes", () => {
  const noStrikes = computeGamma(
    { data: { current_price: 100, options: [{ option: "SPX260918C00100000", open_interest: 0, iv: 0.2 }] } },
    NOW
  )
  assert.equal(isGammaSnapshotTrustworthy(noStrikes, "SPX", NOW), "Cboe SPX chain yielded no priced strikes within 45 DTE")
})

test("includes contracts at exactly 45 DTE", () => {
  // SPX261012 expires 2026-10-12, which is exactly 45 DTE from 2026-08-28
  const exactly45Dte: CboeChain = {
    data: {
      current_price: 100,
      options: [{ option: "SPX261012C00100000", open_interest: 500, iv: 0.2 }],
    },
  }
  const g = computeGamma(exactly45Dte, NOW)
  assert.equal(g.contractsCounted, 500, "45-DTE contract must be included")
  assert.equal(g.strikesCounted, 1)
})

test("time to expiry runs to the 16:00 ET close on expiry day", () => {
  // 2026-09-18 16:00 EDT is 20:00 UTC; from 2026-08-28 00:00 UTC that is 21 days 20 hours.
  near(yearsToExpiry(2026, 9, 18, NOW.getTime()), (21 + 20 / 24) / 365, 1e-9)
  assert.equal(yearsToExpiry(2026, 8, 27, NOW.getTime()), 0, "already expired floors at zero")
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
      options: [{ option: "SPX260918C00100000", open_interest: 100, iv: 0.2 }],
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

test("sums gamma at spot across chains and reports the base chain's spot", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  const ndxAlone = computeGamma(ndxChain, NOW).netGex
  const qqqAlone = computeGamma(qqqChain, NOW).netGex
  assert.ok(ndxAlone > 0 && qqqAlone > 0)
  near(g.netGex, ndxAlone + qqqAlone, 1e-3, "dollar gamma per 1% is additive across underlyings")
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
  const merged = g.topStrikes.find((s) => s.strike === 30400)!
  const ndxOnly = computeGamma(ndxChain, NOW).topStrikes.find((s) => s.strike === 30390)!
  assert.ok(merged.gex > ndxOnly.gex, "both chains' exposure lands in one bucket")
})

test("combined flip is reported in base-axis points", () => {
  // NDX calls at spot and QQQ puts 4% below it, scaled x40 onto 28800: the
  // crossing lands near NDX 29464, never near QQQ 720-750.
  const puts: CboeChain = {
    ...qqqChain,
    data: { ...qqqChain.data, options: [{ option: "QQQ260918P00720000", open_interest: 8000, iv: 0.2 }] },
  }
  const g = computeCombinedGamma([ndxChain, puts], NOW, { strikeBucket: 25 })
  assert.ok(g.flipStrike != null && g.flipStrike > 29000 && g.flipStrike < 30000, `flip ${g.flipStrike}`)
  assert.equal(g.regime, "mean-reversion", "spot 30000 is 1.8% above the flip")
})

test("counts open interest across every chain", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.equal(g.contractsCounted, 8200)
})

test("reports each chain's own contribution and strike ratio", () => {
  const g = computeCombinedGamma([ndxChain, qqqChain], NOW, { strikeBucket: 25 })
  assert.deepEqual(g.components.map((c) => [c.symbol, c.strikeRatio, c.contractsCounted]), [
    ["^NDX", 1, 200],
    ["QQQ", 40, 8000],
  ])
  near(g.components[0].netGex, computeGamma(ndxChain, NOW).netGex, 1e-3)
  near(g.components[1].netGex, computeGamma(qqqChain, NOW).netGex, 1e-3)
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
    isGammaSnapshotTrustworthy(noStrikes, "Nasdaq 100", NOW),
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
  assert.ok(g.netGex > 0)
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
  assert.ok((set.nq?.netGex ?? 0) > 0, "NQ still reports despite SPX being unavailable")
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
