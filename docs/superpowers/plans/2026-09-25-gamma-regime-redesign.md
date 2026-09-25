# Dealer Gamma Regime Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify the dealer gamma regime by where spot sits relative to a re-priced zero-gamma level, instead of by the sign of aggregate net GEX, and refuse stale chains.

**Architecture:** `lib/gamma.ts` gains the option math (Black-Scholes gamma, DTE weighting, the spot-multiplier profile, flip search, regime rule) as exported pure functions, and rebuilds `computeCombinedGamma` on them. The LLM tape line moves to a dependency-free `lib/gamma-format.ts` so it can be unit-tested, mirroring `lib/quote-format.ts`. The frontend panel learns the third regime value and the new wording.

**Tech Stack:** TypeScript on Node 26. Tests run as `node --test lib/*.test.ts` with native type stripping, which means **a module under test may only `import type` from siblings** (extensionless runtime imports do not resolve under the test runner; every currently tested module obeys this). Vite React frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-gamma-regime-redesign.md`

## Global Constraints

- Regime values are exactly `"mean-reversion" | "trending" | "neutral"`, defined once as `Regime` in `lib/types.ts`.
- Book: `0 ≤ DTE ≤ 45` calendar days from today's UTC date; `open_interest > 0`; `0.01 ≤ iv ≤ 2`; weight `min(1, DTE / 5)`; Cboe's `gamma` field is not read.
- Profile grid: multiplier 0.85 → 1.15 step 0.001; flip is the crossing nearest 1 with `|m − 1| ≤ 0.08`; `flipStrike` rounded to 2 dp on the base axis.
- Neutral band: `|spot − flip| / spot < 0.0025`.
- Stale chain: `now − quoteTs > 20 h` is a trust error.
- Chain URL host: `cdn-api.cboe.com`.
- `lib/gamma.ts` and `lib/gamma-format.ts` keep only `import type` statements from sibling modules.
- Tests: `npm test` (all) or `node --test lib/<file>.test.ts` (one). Typecheck: `npm run typecheck`. Frontend build: `cd frontend && npm run build` (its tsconfig has `noUnusedLocals`, so dead bindings fail the build).
- Commit messages are plain imperative sentences with no type prefix (match `git log`), ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Work happens on `main`; push after each task.

## Review Focus

1. A chain whose contracts all carry `iv: 0` (Cboe occasionally ships zeroed greeks) must yield "no priced strikes" rather than a regime — pinned in Task 2 ("rejects a chain with no usable implied volatility").
2. A brief generated after 16:00 ET on expiry day must not price a 0DTE contract with negative time — pinned in Task 2 (`yearsToExpiry` floors at 0; 0DTE weight is 0).
3. A one-sided book with no crossing within 8% must report `flipStrike: null` and still classify — pinned in Task 1 (`findFlipMultiplier`) and Task 2 ("a one-sided book…").
4. Spot exactly at the flip must be `neutral`, not flap between the other two on the sign of a tiny number — pinned in Task 1 (`classifyRegime`) and Task 2 (symmetric book).
5. The merged NQ snapshot must place the flip on the NDX axis, not the QQQ axis — pinned in Task 2 ("combined flip is reported in base-axis points").

---

### Task 1: Pure option math in `lib/gamma.ts`

**Files:**
- Modify: `lib/types.ts` (add `Regime`)
- Modify: `lib/gamma.ts` (append pure functions; nothing existing changes yet)
- Modify: `lib/gamma.test.ts` (append tests)

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `lib/gamma.ts` unless noted):
  - `type Regime = "mean-reversion" | "trending" | "neutral"` in `lib/types.ts`
  - `interface PricedContract { spot: number; strike: number; bucket: number; sign: 1 | -1; openInterest: number; iv: number; years: number; weight: number }` — `strike` is the contract's own strike, `bucket` is the strike on the base axis after scaling and snapping.
  - `bsGamma(spot: number, strike: number, years: number, iv: number): number`
  - `dteWeight(dte: number): number`
  - `contractGex(c: PricedContract, multiplier: number): number`
  - `profileValue(contracts: PricedContract[], multiplier: number): number`
  - `findFlipMultiplier(contracts: PricedContract[]): number | null`
  - `classifyRegime(netGex: number, spot: number, flipStrike: number | null): Regime`
  - Constants `DTE_WEIGHT_FULL = 5`, `NEUTRAL_BAND = 0.0025`, `MAX_FLIP_DISTANCE = 0.08`, `PROFILE_HALF_WIDTH = 0.15`, `PROFILE_STEP = 0.001`, `MIN_IV = 0.01`, `MAX_IV = 2` (and the existing `MAX_DTE = 45`).

- [ ] **Step 1: Add the `Regime` type**

In `lib/types.ts`, insert directly above `export interface GammaSnapshot`:

```ts
/** Side of the zero-gamma level spot sits on; "neutral" within 0.25% of it. */
export type Regime = "mean-reversion" | "trending" | "neutral"
```

Leave `GammaSnapshot.regime` as it is for now; Task 2 switches it.

- [ ] **Step 2: Write the failing tests**

Append to `lib/gamma.test.ts`, and extend its import block from `./gamma.ts` with `bsGamma, classifyRegime, contractGex, dteWeight, findFlipMultiplier, profileValue` and `import type { PricedContract } from "./gamma.ts"`:

```ts
const near = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `${actual} not within ${tol} of ${expected}`)

test("Black-Scholes gamma matches the closed form at and away from the money", () => {
  // phi(d1) / (S sigma sqrt(T)) with d1 = (ln(S/K) + 0.5 sigma^2 T) / (sigma sqrt(T))
  near(bsGamma(100, 100, 0.25, 0.2), 0.03984439, 1e-7)
  near(bsGamma(100, 120, 0.25, 0.2), 0.00828200, 1e-7)
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test lib/gamma.test.ts`
Expected: FAIL — `bsGamma` (etc.) is not exported from `./gamma.ts`. The pre-existing tests still pass.

- [ ] **Step 4: Append the math to `lib/gamma.ts`**

Change the first line to `import type { GammaComponent, GammaSnapshot, GammaStrike, Regime } from "./types"`, then append at the end of the file:

```ts
// ── Option math ──────────────────────────────────────────────────────────────
// Method follows what SpotGamma, MenthorQ, perfiliev and ZeroGEX publish: the
// book's gamma is re-priced at a range of hypothetical spot levels, the
// zero-gamma level is where that profile crosses zero, and the regime is which
// side of that level spot sits on. See
// docs/superpowers/specs/2026-09-25-gamma-regime-redesign.md.

/** Contracts inside this many days are tapered; 0DTE contributes nothing. */
export const DTE_WEIGHT_FULL = 5
/** Cboe reports junk IV (e.g. 5.54) on deep-ITM rows; treat outside this as unpriced. */
export const MIN_IV = 0.01
export const MAX_IV = 2
/** Profile runs spot × (1 ± HALF_WIDTH) in steps of STEP. */
export const PROFILE_HALF_WIDTH = 0.15
export const PROFILE_STEP = 0.001
/** A crossing further than this from spot is a far-tail artifact, not a level. */
export const MAX_FLIP_DISTANCE = 0.08
/** Within this fraction of spot from the flip, hedging flows are too small to set a regime. */
export const NEUTRAL_BAND = 0.0025

export interface PricedContract {
  /** Spot of the chain this contract belongs to. */
  spot: number
  /** The contract's own strike, in its own underlying's points. */
  strike: number
  /** Strike on the base axis after scaling and snapping; what topStrikes reports. */
  bucket: number
  /** +1 call (dealer long), -1 put (dealer short). */
  sign: 1 | -1
  openInterest: number
  /** Implied volatility as a decimal, e.g. 0.19. */
  iv: number
  /** Time to expiry in years of 365 days. */
  years: number
  /** DTE taper, 0..1. */
  weight: number
}

/** Standard normal density. */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Black-Scholes gamma per share with zero rate and dividend, which is how the
 * published profile methods price it. Same for calls and puts. Checked against
 * Cboe's own gamma field on a live chain: median ratio 1.000 for 1-7 DTE.
 */
export function bsGamma(spot: number, strike: number, years: number, iv: number): number {
  if (years <= 0 || iv <= 0 || spot <= 0 || strike <= 0) return 0
  const sigmaRootT = iv * Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * years) / sigmaRootT
  return phi(d1) / (spot * sigmaRootT)
}

/**
 * ZeroGEX's taper: a same-day contract's 1/sqrt(T) gamma spike must not set a
 * multi-day level, and Cboe's participant data shows market-maker net 0DTE
 * gamma is near zero anyway.
 */
export function dteWeight(dte: number): number {
  return Math.max(0, Math.min(1, dte / DTE_WEIGHT_FULL))
}

/** Signed dollar gamma per 1% move, with the contract re-priced at spot × multiplier. */
export function contractGex(c: PricedContract, multiplier: number): number {
  const level = c.spot * multiplier
  const gamma = bsGamma(level, c.strike, c.years, c.iv)
  return c.sign * c.weight * c.openInterest * 100 * gamma * level * level * 0.01
}

export function profileValue(contracts: PricedContract[], multiplier: number): number {
  let total = 0
  for (const c of contracts) total += contractGex(c, multiplier)
  return total
}

/**
 * Walks the profile across the grid and returns the multiplier of the zero
 * crossing nearest spot, or null when none lies within MAX_FLIP_DISTANCE.
 * Crossings in either direction count: the regime is the sign at spot, and the
 * nearest crossing is its boundary whichever way the curve runs.
 */
export function findFlipMultiplier(contracts: PricedContract[]): number | null {
  if (!contracts.length) return null
  const steps = Math.round((2 * PROFILE_HALF_WIDTH) / PROFILE_STEP)
  let best: number | null = null
  let prevM = 1 - PROFILE_HALF_WIDTH
  let prevV = profileValue(contracts, prevM)

  for (let i = 1; i <= steps; i++) {
    const m = 1 - PROFILE_HALF_WIDTH + i * PROFILE_STEP
    const v = profileValue(contracts, m)
    const crosses = (prevV < 0 && v >= 0) || (prevV > 0 && v <= 0)
    if (crosses) {
      const mStar = prevM + (m - prevM) * (prevV / (prevV - v))
      const distance = Math.abs(mStar - 1)
      if (distance <= MAX_FLIP_DISTANCE && (best === null || distance < Math.abs(best - 1))) {
        best = mStar
      }
    }
    prevM = m
    prevV = v
  }
  return best
}

export function classifyRegime(netGex: number, spot: number, flipStrike: number | null): Regime {
  if (flipStrike != null && spot > 0 && Math.abs(spot - flipStrike) / spot < NEUTRAL_BAND) {
    return "neutral"
  }
  return netGex >= 0 ? "mean-reversion" : "trending"
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/gamma.test.ts`
Expected: all passing (the 9 new tests plus every pre-existing one).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add lib/types.ts lib/gamma.ts lib/gamma.test.ts
git commit -m "Add the option math for a re-priced gamma profile and zero-gamma level

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

---

### Task 2: Rebuild the snapshot on the profile

**Files:**
- Modify: `lib/gamma.ts` (`CboeOption`, `tallyChain`, `computeCombinedGamma`, `isGammaSnapshotTrustworthy` signature; add `yearsToExpiry`)
- Modify: `lib/types.ts:29-47` (`GammaSnapshot`)
- Modify: `lib/fixtures/spx-chain.json`, `lib/fixtures/ndx-chain.json`, `lib/fixtures/qqq-chain.json`
- Modify: `lib/gamma.test.ts`
- Modify: `docs/superpowers/specs/2026-08-28-market-open-brief-design.md` (pointer notes at §5.4 and §7)

**Interfaces:**
- Consumes from Task 1: everything listed under Produces.
- Produces:
  - `GammaSnapshot.regime: Regime`.
  - `GammaSnapshot.netGex` now means the weighted, re-priced book evaluated at spot.
  - `GammaSnapshot.flipStrike` now means the profile's zero crossing nearest spot, 2 dp, base axis, or null.
  - `yearsToExpiry(year: number, month: number, day: number, nowMs: number): number` exported from `lib/gamma.ts`.
  - `isGammaSnapshotTrustworthy(snapshot: GammaSnapshot, label: string, now: Date): string | null` (the `now` argument is unused until Task 3).
  - `computeCombinedGamma` and `computeGamma` keep their signatures.

- [ ] **Step 1: Replace the fixtures**

`lib/fixtures/spx-chain.json` (spot 100; two new rows exercise the 0DTE and junk-IV exclusions; every row drops `gamma` for `iv`):

```json
{
  "timestamp": "2026-08-28 14:30:00",
  "data": {
    "symbol": "^SPX",
    "current_price": 100,
    "last_trade_time": "2026-08-28T10:15:00",
    "options": [
      { "option": "SPX260918C00100000", "open_interest": 1000, "iv": 0.2 },
      { "option": "SPX260918P00100000", "open_interest": 400, "iv": 0.2 },
      { "option": "SPX260918P00090000", "open_interest": 500, "iv": 0.25 },
      { "option": "SPX260918C00110000", "open_interest": 800, "iv": 0.18 },
      { "option": "SPX261012C00100000", "open_interest": 100, "iv": 0.2 },
      { "option": "SPX261218C00110000", "open_interest": 9999, "iv": 0.2 },
      { "option": "SPX260918C00105000", "open_interest": 900, "iv": 0 },
      { "option": "SPX260918C00095000", "open_interest": 0, "iv": 0.2 },
      { "option": "SPX260828C00100000", "open_interest": 5000, "iv": 0.3 },
      { "option": "SPX260918C00120000", "open_interest": 700, "iv": 5.5 },
      { "option": "NOT-AN-OSI-SYMBOL", "open_interest": 100, "iv": 0.2 }
    ]
  }
}
```

`lib/fixtures/ndx-chain.json`:

```json
{
  "timestamp": "2026-08-28 14:30:00",
  "data": {
    "symbol": "^NDX",
    "current_price": 30000,
    "last_trade_time": "2026-08-28T10:15:00",
    "options": [
      { "option": "NDX260918C30000000", "open_interest": 100, "iv": 0.2 },
      { "option": "NDX260918C30390000", "open_interest": 100, "iv": 0.2 }
    ]
  }
}
```

`lib/fixtures/qqq-chain.json`:

```json
{
  "timestamp": "2026-08-28 14:35:00",
  "data": {
    "symbol": "QQQ",
    "current_price": 750,
    "last_trade_time": "2026-08-28T10:05:00",
    "options": [
      { "option": "QQQ260918C00750000", "open_interest": 4000, "iv": 0.2 },
      { "option": "QQQ260918C00760000", "open_interest": 4000, "iv": 0.2 }
    ]
  }
}
```

- [ ] **Step 2: Rewrite the computation tests**

In `lib/gamma.test.ts`, add `yearsToExpiry` to the `./gamma.ts` import list, and replace every test from "nets calls positive and puts negative" through "includes contracts at exactly 45 DTE" (currently lines 20–98) with the block below. `near` is already defined at the bottom of the file from Task 1; move it up above this block so it is declared before use.

```ts
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
```

- [ ] **Step 3: Update the multi-chain and delay tests**

Still in `lib/gamma.test.ts`, replace the five tests "sums dollar gamma across chains…", "scales overlay strikes…", "buckets merged strikes…", "counts open interest across every chain", "reports each chain's own contribution and strike ratio" with:

```ts
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
```

Then, in the tests that remain from the original file:
- In "reports a null delay when either stamp is missing", change `gamma: 0.01` to `iv: 0.2`.
- In "names the index in trust errors…", pass `NOW` as the third argument to `isGammaSnapshotTrustworthy`.
- In "merges an index's chains into one snapshot", replace `assert.equal(g.netGex, 3.6e8)` with `assert.ok(g.netGex > 0)`.
- In "gathers every index…", replace the `3.6e8` assertion with `assert.ok((set.nq?.netGex ?? 0) > 0, "NQ still reports despite SPX being unavailable")`.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test lib/gamma.test.ts`
Expected: FAIL — `regime` is never `"neutral"`, `flipStrike` is 110, `yearsToExpiry` is not exported, `contractsCounted` includes the 0DTE row, `isGammaSnapshotTrustworthy` rejects a third argument at typecheck.

- [ ] **Step 5: Rewrite the computation in `lib/gamma.ts`**

Change `CboeOption` to:

```ts
export interface CboeOption {
  option: string
  open_interest?: number
  /** Implied volatility as a decimal. Cboe's own `gamma` field is not used: it
   *  is zeroed on far-OTM rows and cannot be re-priced away from spot. */
  iv?: number
}
```

Add after `parseChainStamp`:

```ts
const pad2 = (n: number) => String(n).padStart(2, "0")

/**
 * Years (of 365 days) from `nowMs` to the 16:00 ET close on the expiry date.
 * Measuring to the close rather than to midnight is what makes a Black-Scholes
 * re-price agree with Cboe's own gamma on short-dated rows.
 */
export function yearsToExpiry(year: number, month: number, day: number, nowMs: number): number {
  const close = parseEasternTimestamp(`${year}-${pad2(month)}-${pad2(day)}T16:00:00`)
  if (close == null) return 0
  return Math.max(close - nowMs, 0) / (365 * DAY_MS)
}
```

Replace `ChainTally`, `tallyChain` and `computeCombinedGamma` with:

```ts
/**
 * Turns one chain's rows into priced contracts on the base axis. Strikes are
 * scaled by `strikeRatio` and snapped to `strikeBucket`, so an ETF strike and
 * the index strike it corresponds to land on one level.
 */
function priceChain(
  chain: CboeChain,
  now: Date,
  strikeRatio: number,
  strikeBucket: number
): PricedContract[] {
  const spot = chain.data.current_price
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const contracts: PricedContract[] = []

  for (const option of chain.data.options) {
    const match = OSI_RE.exec(option.option)
    if (!match) continue

    const year = 2000 + Number(match[2])
    const month = Number(match[3])
    const day = Number(match[4])
    const dte = (Date.UTC(year, month - 1, day) - todayUtc) / DAY_MS
    if (dte < 0 || dte > MAX_DTE) continue

    const openInterest = option.open_interest ?? 0
    const iv = option.iv ?? 0
    if (!openInterest || iv < MIN_IV || iv > MAX_IV) continue

    const weight = dteWeight(dte)
    const years = yearsToExpiry(year, month, day, now.getTime())
    if (weight <= 0 || years <= 0) continue

    const strike = Number(match[6]) / 1000
    const scaled = strike * strikeRatio
    const bucket = strikeBucket > 0 ? Math.round(scaled / strikeBucket) * strikeBucket : scaled

    contracts.push({
      spot,
      strike,
      bucket,
      sign: match[5] === "C" ? 1 : -1,
      openInterest,
      iv,
      years,
      weight,
    })
  }
  return contracts
}

interface ChainTally {
  component: GammaComponent
  contracts: PricedContract[]
  quoteTs: number | null
  lastTradeTs: number | null
}

function tallyChain(chain: CboeChain, now: Date, strikeRatio: number, strikeBucket: number): ChainTally {
  const contracts = priceChain(chain, now, strikeRatio, strikeBucket)
  return {
    component: {
      symbol: chain.data.symbol ?? "unknown",
      strikeRatio,
      netGex: profileValue(contracts, 1),
      contractsCounted: contracts.reduce((total, c) => total + c.openInterest, 0),
    },
    contracts,
    quoteTs: parseChainStamp(chain.timestamp),
    lastTradeTs: parseEasternTimestamp(chain.data.last_trade_time),
  }
}

/**
 * Merges several option chains on the same underlying into one dealer-gamma
 * reading. `chains[0]` is the base: the snapshot's spot, and the strike axis
 * every other chain is scaled onto.
 *
 * Exposure is the weighted book re-priced with Black-Scholes. The same
 * evaluation gives gamma at spot (`netGex`), the per-strike split
 * (`topStrikes`) and, swept across a range of hypothetical spot levels, the
 * zero-gamma level (`flipStrike`), so the three can never disagree.
 *
 * Staleness is reported conservatively — the oldest build, the stalest tape
 * stamp, and the worst per-chain delay — so the merged reading is never
 * presented as fresher than its least fresh input.
 */
export function computeCombinedGamma(
  chains: CboeChain[],
  now: Date,
  options: { strikeBucket?: number } = {}
): GammaSnapshot {
  const strikeBucket = options.strikeBucket ?? 0
  const baseSpot = chains[0]?.data.current_price ?? 0

  const tallies = chains.map((chain) => {
    const spot = chain.data.current_price
    // A chain with no usable spot cannot be placed on the base axis; it still
    // contributes dollar gamma, so scale it by 1 rather than by NaN.
    const ratio = spot && baseSpot ? baseSpot / spot : 1
    return tallyChain(chain, now, ratio, strikeBucket)
  })
  const contracts = tallies.flatMap((t) => t.contracts)

  const byStrike = new Map<number, number>()
  for (const c of contracts) byStrike.set(c.bucket, (byStrike.get(c.bucket) ?? 0) + contractGex(c, 1))
  const strikes: GammaStrike[] = [...byStrike.entries()].map(([strike, gex]) => ({ strike, gex }))
  const topStrikes = [...strikes].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 5)

  const netGex = profileValue(contracts, 1)
  const flipMultiplier = findFlipMultiplier(contracts)
  const flipStrike = flipMultiplier == null ? null : Math.round(flipMultiplier * baseSpot * 100) / 100

  // Cboe's own two stamps are what let the UI state the delay as a measurement
  // rather than repeating a documented figure that could quietly stop being true.
  const oldest = (values: (number | null)[]): number | null => {
    const present = values.filter((v): v is number => v != null)
    return present.length ? Math.min(...present) : null
  }
  const quoteTs = oldest(tallies.map((t) => t.quoteTs))
  const lastTradeTs = oldest(tallies.map((t) => t.lastTradeTs))
  const delays = tallies
    .filter((t) => t.quoteTs != null && t.lastTradeTs != null)
    .map((t) => Math.round((t.quoteTs! - t.lastTradeTs!) / 1000))

  return {
    spot: baseSpot,
    netGex,
    flipStrike,
    topStrikes,
    regime: classifyRegime(netGex, baseSpot, flipStrike),
    contractsCounted: tallies.reduce((total, t) => total + t.component.contractsCounted, 0),
    strikesCounted: strikes.length,
    components: tallies.map((t) => t.component),
    quoteTs,
    lastTradeTs,
    quoteDelaySec: delays.length ? Math.max(...delays) : null,
  }
}
```

Replace the doc comment on `computeGamma` with `/** Single-chain convenience over computeCombinedGamma. */`. Change `isGammaSnapshotTrustworthy`'s signature to `(snapshot: GammaSnapshot, label: string, now: Date): string | null` — body unchanged in this task — and its call in `fetchIndexGamma` to `isGammaSnapshotTrustworthy(snapshot, index.label, now)`. Since the option-math block from Task 1 sits at the bottom of the file and `priceChain` above references it, hoisting is fine for `function` declarations but not for the `const` constants; move the `DTE_WEIGHT_FULL … NEUTRAL_BAND` constants up beside `MAX_DTE` near the top of the file.

- [ ] **Step 6: Update the shared type**

In `lib/types.ts`, replace the `GammaSnapshot` interface (lines 29–47) with:

```ts
export interface GammaSnapshot {
  spot: number
  /**
   * Dealer gamma at spot in dollars per 1% move: the 1-45 DTE book, DTE-weighted
   * and re-priced with Black-Scholes. Positive = dealers long gamma at this level.
   */
  netGex: number
  /**
   * Zero-gamma level: where the re-priced book's exposure crosses zero, taking
   * the crossing nearest spot within 8%. Base-axis points, 2 dp, or null.
   */
  flipStrike: number | null
  topStrikes: GammaStrike[]
  regime: Regime
  contractsCounted: number
  strikesCounted: number
  /** Per-chain contributions; one entry for a single-chain snapshot. */
  components: GammaComponent[]
  /** When Cboe built the chain (epoch ms), or null if it carried no stamp. */
  quoteTs: number | null
  /** Last trade in the underlying (epoch ms), or null if it carried no stamp. */
  lastTradeTs: number | null
  /** Seconds the quotes lag the tape. Null when either stamp is missing. */
  quoteDelaySec: number | null
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test lib/gamma.test.ts`
Expected: all passing. If "flip is the re-priced zero crossing…" reports a flip outside 92–96, the grid or `yearsToExpiry` is wrong; the prototype value is 93.80. The combined-flip prototype value is 29463.73.

- [ ] **Step 8: Mark the old spec sections superseded**

In `docs/superpowers/specs/2026-08-28-market-open-brief-design.md`, insert directly under the `### 5.4 Gamma` heading and again under `## 7. Regime classification`:

```markdown
> **Superseded 2026-09-25** by `2026-09-25-gamma-regime-redesign.md`. The formula below
> used Cboe's gamma field, a cumulative-strike flip, and the sign of net GEX for the
> regime; the redesign re-prices the book and classifies by spot versus the zero-gamma
> level. Kept for history.
```

- [ ] **Step 9: Typecheck, run everything, commit**

Run: `npm run typecheck && npm test`
Expected: no type errors; every test file passes (`brief-speech` only reads other fields, and nothing else constructs a `GammaSnapshot`).

```bash
git add lib/gamma.ts lib/types.ts lib/fixtures lib/gamma.test.ts docs/superpowers/specs/2026-08-28-market-open-brief-design.md
git commit -m "Classify the gamma regime by spot versus a re-priced zero-gamma level

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

---

### Task 3: Refuse stale chains and use the canonical Cboe host

**Files:**
- Modify: `lib/gamma.ts` (`isGammaSnapshotTrustworthy`, `chainUrl`)
- Modify: `lib/gamma.test.ts`

**Interfaces:**
- Consumes: `isGammaSnapshotTrustworthy(snapshot, label, now)` from Task 2.
- Produces: error string `Cboe <label> chain is stale: built <Ddd Mon D, HH:MM> ET, <N>h ago`; exported `MAX_CHAIN_AGE_MS`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/gamma.test.ts`:

```ts
test("rejects a chain built more than 20 hours before now", () => {
  // Thu 24 Sep 2026 every fetch returned Wed's 00:56 ET build; the brief used it silently.
  const g = computeGamma(chain, NOW) // built 2026-08-28 14:30 UTC = 10:30 EDT
  const nextMorning = new Date("2026-08-30T00:00:00Z") // 33.5 h later
  assert.equal(
    isGammaSnapshotTrustworthy(g, "SPX", nextMorning),
    "Cboe SPX chain is stale: built Fri Aug 28, 10:30 ET, 34h ago"
  )
})

test("accepts an overnight build read the next morning", () => {
  const g = computeGamma(chain, NOW)
  const sameDay = new Date("2026-08-28T20:00:00Z") // 5.5 h later
  assert.strictEqual(isGammaSnapshotTrustworthy(g, "SPX", sameDay), null)
})

test("fetches chains from the cdn-api host", async () => {
  const urls: string[] = []
  const spy = async (url: string): Promise<Response> => {
    urls.push(url)
    return { ok: true, status: 200, json: async () => chain } as Response
  }
  await fetchIndexGamma(GAMMA_INDICES.spx, NOW, spy)
  assert.deepEqual(urls, ["https://cdn-api.cboe.com/api/global/delayed_quotes/options/_SPX.json"])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/gamma.test.ts`
Expected: the three new tests fail (`null` instead of the stale error; URL is `cdn.cboe.com`).

- [ ] **Step 3: Implement**

In `lib/gamma.ts`, replace `isGammaSnapshotTrustworthy` with:

```ts
/** A midnight build read at 09:30 ET is ~9h old; yesterday's build read today is ~33h. */
export const MAX_CHAIN_AGE_MS = 20 * 3600 * 1000

const ET_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/**
 * Validates that a snapshot contains usable, current market data. Returns an
 * error message naming `label`'s chain if the snapshot is not trustworthy,
 * null if valid — with several indices in play, a bare failure would not say
 * which.
 */
export function isGammaSnapshotTrustworthy(
  snapshot: GammaSnapshot,
  label: string,
  now: Date
): string | null {
  if (!snapshot.spot || !isFinite(snapshot.spot)) {
    return `Cboe ${label} chain returned no usable spot price`
  }
  if (snapshot.strikesCounted === 0) {
    return `Cboe ${label} chain yielded no priced strikes within ${MAX_DTE} DTE`
  }
  if (snapshot.quoteTs != null && now.getTime() - snapshot.quoteTs > MAX_CHAIN_AGE_MS) {
    const hours = Math.round((now.getTime() - snapshot.quoteTs) / 3600000)
    // Intl gives "Fri, Aug 28, 10:30"; drop the first comma only.
    const built = ET_SHORT.format(new Date(snapshot.quoteTs)).replace(",", "")
    return `Cboe ${label} chain is stale: built ${built} ET, ${hours}h ago`
  }
  return null
}
```

Change `chainUrl`:

```ts
function chainUrl(symbol: string): string {
  // cdn.cboe.com now answers 307 to this host; go straight to it.
  return `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${symbol}.json`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/gamma.test.ts`
Expected: all passing (the stamp format was verified on Node 26: `"Fri, Aug 28, 10:30"` → `Fri Aug 28, 10:30`, 34h).

- [ ] **Step 5: Commit**

```bash
git add lib/gamma.ts lib/gamma.test.ts
git commit -m "Refuse gamma chains older than 20 hours and fetch from cdn-api.cboe.com

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

---

### Task 4: Teach the consumers the three-state regime

**Files:**
- Create: `lib/gamma-format.ts`
- Create: `lib/gamma-format.test.ts`
- Modify: `lib/summarize.ts:63-68` (delete the private `renderGamma`, import the new one)
- Modify: `frontend/src/hooks/use-brief.ts:33`
- Modify: `frontend/src/components/gamma-panel.tsx:65-135, 175-185`

**Interfaces:**
- Consumes: `GammaSnapshot` with `regime: Regime` from Task 2.
- Produces: `renderGamma(label: string, gamma: GammaSnapshot | null): string | null` exported from `lib/gamma-format.ts` (type-only imports, so it is testable).

- [ ] **Step 1: Write the failing test for the LLM tape line**

```ts
// lib/gamma-format.test.ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test lib/gamma-format.test.ts`
Expected: FAIL — `Cannot find module './gamma-format.ts'`.

- [ ] **Step 3: Write the renderer and wire it in**

```ts
// lib/gamma-format.ts
import type { GammaSnapshot } from "./types"

/**
 * One tape line per index for the summarizer. Leads with the regime and
 * spot's position against the zero-gamma level so the model reasons from the
 * level, then gives gamma at spot as supporting size. Lives apart from
 * summarize.ts so it can be unit-tested without the LLM client.
 */
export function renderGamma(label: string, gamma: GammaSnapshot | null): string | null {
  if (!gamma) return null
  const flip = gamma.flipStrike
  const position =
    flip == null
      ? "has no zero-gamma level within 8%"
      : `is ${Math.abs(gamma.spot - flip).toFixed(0)} pts ` +
        `(${(Math.abs(gamma.spot / flip - 1) * 100).toFixed(2)}%) ` +
        `${gamma.spot >= flip ? "above" : "below"} the zero-gamma level at ${flip}`
  return (
    `Dealer gamma ${label}: ${gamma.regime}; spot ${gamma.spot} ${position}; ` +
    `gamma at spot ${(gamma.netGex / 1e9).toFixed(1)}bn per 1%`
  )
}
```

In `lib/summarize.ts`: delete the private `renderGamma` (lines 63–68), add `import { renderGamma } from "./gamma-format"` next to the `./quote-format` import, and remove `GammaSnapshot` from the `./types` type import if it is now unused there (it is still used by `renderTape`'s and `summarizeOvernight`'s parameters, so it most likely stays).

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test lib/gamma-format.test.ts && npm run typecheck`
Expected: 3 passing; no type errors.

- [ ] **Step 5: Widen the frontend type**

In `frontend/src/hooks/use-brief.ts` line 33:

```ts
  /** Side of the zero-gamma level spot sits on; "neutral" within 0.25% of it. */
  regime: "mean-reversion" | "trending" | "neutral"
```

- [ ] **Step 6: Rewrite the panel's verdict block**

In `frontend/src/components/gamma-panel.tsx`, replace lines 65–77 (from `// Trust the server's classification` through the `flipSide` assignment) with:

```tsx
  // Trust the server's classification rather than recomputing it from netGex,
  // so the label can never diverge from what the backend actually decided.
  const REGIME_COPY = {
    "mean-reversion": {
      headline: "Long gamma · Mean reversion / range",
      tone: "text-emerald-500",
      rationale:
        "Spot is above the zero-gamma level — dealer hedging sells rallies and buys dips, suppressing volatility.",
    },
    trending: {
      headline: "Short gamma · Trending / momentum",
      tone: "text-amber-500",
      rationale:
        "Spot is below the zero-gamma level — dealer hedging chases direction, widening the expected range.",
    },
    neutral: {
      headline: "At the flip · Regime undecided",
      tone: "text-sky-500",
      rationale:
        "Spot sits within 0.25% of the zero-gamma level — hedging flows are small either way, and the regime is set by which side spot breaks.",
    },
  } as const
  const copy = REGIME_COPY[gamma.regime] ?? REGIME_COPY.neutral

  // Spec §4: report which side of the level spot sits on and how far, in points
  // and percent, rather than leaving the reader to subtract two bare numbers.
  const flipDistance = gamma.flipStrike == null ? null : gamma.spot - gamma.flipStrike
  const flipPct =
    gamma.flipStrike == null ? null : (Math.abs(gamma.spot / gamma.flipStrike - 1) * 100).toFixed(2)
  const flipSide =
    flipDistance == null ? null : flipDistance > 0 ? "above flip" : flipDistance < 0 ? "below flip" : "at flip"
```

Replace the headline `<div>` and rationale `<p>` (the two elements that currently use `isLong`, `verdict`, `rationale`) with:

```tsx
        <div className={`text-lg font-semibold ${copy.tone}`}>{copy.headline}</div>
        <p className="mt-1 text-xs text-muted-foreground">{copy.rationale}</p>
```

Change the "Net GEX / 1%" label text to `Gamma at spot / 1%` and the "Flip level" label to `Zero-gamma level`.

In the "Spot vs flip" block, replace the no-flip message and the distance markup:

```tsx
          {flipDistance == null ? (
            <span className="text-muted-foreground">
              No zero-gamma level within 8% of spot — the near-term book is one-sided.
            </span>
          ) : (
            <>
              <span className="font-medium">
                {Math.abs(flipDistance).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>{" "}
              <span>
                ({flipPct}%) {flipSide}
              </span>
            </>
          )}
```

In the footer, change `0–45 DTE ·` to `1–45 DTE, 0DTE excluded, under 5 DTE down-weighted ·`.

`isLong`, `verdict` and `rationale` must have no remaining references; the build's `noUnusedLocals` fails otherwise.

- [ ] **Step 7: Build the frontend and run all tests**

Run: `cd frontend && npm run build && cd .. && npm run typecheck && npm test`
Expected: build succeeds; all tests pass.

- [ ] **Step 8: Verify against the live chain**

Run `npx vercel dev`, open the Brief tab, generate a brief. Expected on a trading day: the SPX panel shows a zero-gamma level within a few percent of spot (not +5% like the old 8100-vs-7703 reading), a percent distance, and one of the three headlines. The LLM summary should reference the level rather than "net GEX positive".

- [ ] **Step 9: Commit**

```bash
git add lib/gamma-format.ts lib/gamma-format.test.ts lib/summarize.ts frontend/src/hooks/use-brief.ts frontend/src/components/gamma-panel.tsx
git commit -m "Show the three-state gamma regime and the zero-gamma level in the brief

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```
