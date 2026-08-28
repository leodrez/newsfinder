# Market Open Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Open Brief" tab that, on a button press, produces an overnight news summary with a sentiment meter, a 12-instrument overnight moves board, and a dealer-gamma regime read.

**Architecture:** Five new server modules under `lib/` (window, gamma, market-data, summarize, brief orchestrator) behind one auth-gated `api/brief.ts` endpoint that caches results in a new `market_briefs` table. The frontend gains a top-level tab strip and a brief page whose three panels fail independently, each surfacing a specific reason.

**Tech Stack:** TypeScript, Vercel serverless functions, Supabase (Postgres + RLS), Anthropic SDK (Haiku, forced tool use), React 19 + Tailwind 4 + shadcn, `node --test` with native TypeScript type-stripping.

**Spec:** `docs/superpowers/specs/2026-08-28-market-open-brief-design.md`

## Global Constraints

- **No new runtime dependencies and no new environment variables.** Yahoo and Cboe are keyless; the LLM reuses `ANTHROPIC_API_KEY` and `LLM_MODEL`.
- **No new test dependencies either.** Node v22.22.2 strips TypeScript natively. This was verified in this repo: a test importing a module with an explicit `.ts` extension passes under bare `node --test`, provided the module under test imports only *types* from its siblings (type-only imports are erased before resolution). Extensionless *value* imports do NOT resolve under `node --test`. Therefore: **`lib/window.ts`, `lib/gamma.ts`, and `lib/market-data.ts` must import from siblings using `import type` only.** Modules that need runtime imports (`lib/brief.ts`) are not unit-tested.
- **The brief must never write to `headlines` or `headline_dedup`.** It reads feeds and discards them. This preserves the `MAX_HEADLINE_AGE_SEC < DEDUP_TTL_SEC` invariant in `lib/config.ts`. Do not "helpfully" persist fetched items.
- **Do not modify the Play button, `api/polling.ts`, or auto-pause behavior.**
- **Error messages must state the actual cause.** A generic "unavailable" is a defect. Every failure path carries a specific human-readable reason to the UI.
- **Yahoo's `chartPreviousClose` is forbidden as the ES/NQ anchor.** It is unstable across range parameters (`ES=F` returned 7742.50 and 7669.75 in the same minute at different ranges). Futures anchor to the prior 15:00-16:00 ET hourly bar close.
- Follow existing repo style: two-space indent, no semicolons, double quotes, `console.warn` for recoverable failures.

---

### Task 1: Overnight window derivation and test harness

**Files:**
- Create: `lib/window.ts`
- Create: `lib/window.test.ts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing
- Produces: `briefWindow(now: number): { start: number; end: number }`, `priorRthCloseTs(now: number): number`, constants `MIN_WINDOW_SEC = 43200`, `MAX_WINDOW_SEC = 86400`. All timestamps are unix **seconds**.

- [ ] **Step 1: Write the failing test**

Create `lib/window.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/window.test.ts`
Expected: FAIL — cannot find module `./window.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/window.ts`:

```ts
const HOUR_SEC = 3600
const DAY_SEC = 86400
const RTH_CLOSE_HOUR_ET = 16

/** Shortest overnight window the brief will ever summarise. */
export const MIN_WINDOW_SEC = 12 * HOUR_SEC
/** Longest overnight window — keeps a Monday open at 24h, not 65h. */
export const MAX_WINDOW_SEC = 24 * HOUR_SEC

/**
 * Offset in seconds between America/New_York and UTC at `ts`, e.g. -14400 during EDT.
 * Derived from Intl so DST transitions are handled without a tz dependency.
 */
function etOffsetSec(ts: number): number {
  const d = new Date(ts * 1000)
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }))
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }))
  return Math.round((et.getTime() - utc.getTime()) / 1000)
}

/** Unix seconds of the most recent 16:00 America/New_York at or before `now`. */
export function priorRthCloseTs(now: number): number {
  const secondsIntoEtDay = (((now + etOffsetSec(now)) % DAY_SEC) + DAY_SEC) % DAY_SEC
  const close = now - (secondsIntoEtDay - RTH_CLOSE_HOUR_ET * HOUR_SEC)
  return close > now ? close - DAY_SEC : close
}

/**
 * The overnight window the brief summarises: back to the prior cash close,
 * clamped to [12h, 24h].
 */
export function briefWindow(now: number): { start: number; end: number } {
  const rawSpan = now - priorRthCloseTs(now)
  const span = Math.min(MAX_WINDOW_SEC, Math.max(MIN_WINDOW_SEC, rawSpan))
  return { start: now - span, end: now }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/window.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "node --test lib/*.test.ts"
```

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/window.ts lib/window.test.ts package.json
git commit -m "Add overnight window derivation with 12-24h clamp"
```

---

### Task 2: Gamma exposure from the Cboe SPX chain

**Files:**
- Modify: `lib/types.ts` (append brief types)
- Create: `lib/gamma.ts`
- Create: `lib/gamma.test.ts`
- Create: `lib/fixtures/spx-chain.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeGamma(chain: CboeChain, now: Date): GammaSnapshot` (pure), `fetchGamma(now?: Date): Promise<GammaSnapshot>` (throws `Error` with a specific message), types `GammaSnapshot`, `GammaStrike`, `CboeChain`, `CboeOption`, `MAX_DTE = 45`.

- [ ] **Step 1: Add the shared types**

Append to `lib/types.ts`:

```ts
export interface GammaStrike {
  strike: number
  gex: number
}

export interface GammaSnapshot {
  spot: number
  /** Net dealer gamma in dollars per 1% move. Positive = dealers long gamma. */
  netGex: number
  /** Strike where cumulative GEX crosses from negative to positive, or null. */
  flipStrike: number | null
  topStrikes: GammaStrike[]
  regime: "mean-reversion" | "trending"
  contractsCounted: number
  strikesCounted: number
}

export type QuoteGroup = "futures" | "rates" | "global" | "commods" | "vol"

export interface OvernightQuote {
  symbol: string
  label: string
  group: QuoteGroup
  last: number
  anchor: number
  change: number
  changePct: number
}

export interface BriefDriver {
  headline: string
  why: string
}

export interface BriefSummary {
  summary: string
  sentiment: number
  sentimentLabel: string
  keyDrivers: BriefDriver[]
  riskEvents: string[]
}

export interface BriefErrors {
  quotes?: Record<string, string>
  gamma?: string
  summary?: string
}

export interface BriefPayload {
  quotes: OvernightQuote[]
  gamma: GammaSnapshot | null
  keyDrivers: BriefDriver[]
  riskEvents: string[]
  sentimentLabel: string
  headlineCount: number
  errors: BriefErrors
}

export interface MarketBrief {
  generated_ts: number
  window_start_ts: number
  window_end_ts: number
  summary: string
  sentiment: number
  payload: BriefPayload
}
```

- [ ] **Step 2: Create the fixture**

Create `lib/fixtures/spx-chain.json`. Spot is 100 so `S^2 * 0.01` equals 100, making every expected figure checkable by hand. Contracts are chosen to exercise the call/put sign, the DTE filter, the zero-gamma and zero-OI filters, and flip detection:

```json
{
  "timestamp": "2026-08-28 09:30:00",
  "data": {
    "symbol": "^SPX",
    "current_price": 100,
    "options": [
      { "option": "SPX260918C00100000", "open_interest": 1000, "gamma": 0.01 },
      { "option": "SPX260918P00100000", "open_interest": 400, "gamma": 0.01 },
      { "option": "SPX260918P00090000", "open_interest": 500, "gamma": 0.02 },
      { "option": "SPX260918C00110000", "open_interest": 800, "gamma": 0.01 },
      { "option": "SPX261218C00110000", "open_interest": 9999, "gamma": 0.05 },
      { "option": "SPX260918C00105000", "open_interest": 900, "gamma": 0 },
      { "option": "SPX260918C00095000", "open_interest": 0, "gamma": 0.005 },
      { "option": "NOT-AN-OSI-SYMBOL", "open_interest": 100, "gamma": 0.1 }
    ]
  }
}
```

Expected aggregation with `now = 2026-08-28` (all September contracts are 21 DTE; the December one is 112 DTE and excluded):

| Strike | Contribution | Net |
|---|---|---|
| 90 | put: `0.02 * 500 * 100 * 100 * -1` | -100000 |
| 100 | call `0.01*1000*100*100` = +100000, put `0.01*400*100*100` = -40000 | +60000 |
| 110 | call: `0.01 * 800 * 100 * 100` | +80000 |

`netGex` = +40000 (mean-reversion). Cumulative from the low strike: -100000, then -40000, then +40000 — so `flipStrike` = 110. `contractsCounted` = 2700, `strikesCounted` = 3.

- [ ] **Step 3: Write the failing test**

Create `lib/gamma.test.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test lib/gamma.test.ts`
Expected: FAIL — cannot find module `./gamma.ts`.

- [ ] **Step 5: Write the implementation**

Create `lib/gamma.ts`. Note the `import type` — a value import from `./types` would break `node --test`:

```ts
import type { GammaSnapshot, GammaStrike } from "./types"

const CBOE_SPX_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"
const FETCH_TIMEOUT_MS = 15000
const DAY_MS = 86400000

/** Root, 2-digit YY MM DD, C or P, then strike * 1000 padded to 8 digits. */
const OSI_RE = /^([A-Z^]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/

/** Only near-dated contracts carry meaningful dealer hedging pressure. */
export const MAX_DTE = 45

export interface CboeOption {
  option: string
  open_interest?: number
  gamma?: number
}

export interface CboeChain {
  data: {
    current_price: number
    options: CboeOption[]
  }
}

/**
 * Aggregates dealer gamma exposure by strike under the standard
 * dealer-long-calls / dealer-short-puts convention. Result is dollars of
 * gamma per 1% move in spot.
 */
export function computeGamma(chain: CboeChain, now: Date): GammaSnapshot {
  const spot = chain.data.current_price
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const dollarGammaPerPct = spot * spot * 0.01

  const byStrike = new Map<number, number>()
  let contractsCounted = 0

  for (const option of chain.data.options) {
    const match = OSI_RE.exec(option.option)
    if (!match) continue

    const expiryUtc = Date.UTC(2000 + Number(match[2]), Number(match[3]) - 1, Number(match[4]))
    const dte = (expiryUtc - todayUtc) / DAY_MS
    if (dte < 0 || dte > MAX_DTE) continue

    const openInterest = option.open_interest ?? 0
    const gamma = option.gamma ?? 0
    if (!openInterest || !gamma) continue

    const strike = Number(match[6]) / 1000
    const sign = match[5] === "C" ? 1 : -1
    const gex = gamma * openInterest * 100 * dollarGammaPerPct * sign

    byStrike.set(strike, (byStrike.get(strike) ?? 0) + gex)
    contractsCounted += openInterest
  }

  const strikes: GammaStrike[] = [...byStrike.entries()].map(([strike, gex]) => ({ strike, gex }))
  const netGex = strikes.reduce((total, s) => total + s.gex, 0)

  // Walk strikes low to high; the flip is where cumulative exposure turns positive.
  let cumulative = 0
  let flipStrike: number | null = null
  for (const s of [...strikes].sort((a, b) => a.strike - b.strike)) {
    const previous = cumulative
    cumulative += s.gex
    if (previous < 0 && cumulative >= 0) flipStrike = s.strike
  }

  const topStrikes = [...strikes].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 5)

  return {
    spot,
    netGex,
    flipStrike,
    topStrikes,
    regime: netGex >= 0 ? "mean-reversion" : "trending",
    contractsCounted,
    strikesCounted: strikes.length,
  }
}

/**
 * Fetches the full SPX chain (~12.8MB), aggregates it, and discards the raw
 * payload. Throws with a specific, user-facing reason on every failure path.
 */
export async function fetchGamma(now: Date = new Date()): Promise<GammaSnapshot> {
  let response: Response
  try {
    response = await fetch(CBOE_SPX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    throw new Error(
      isTimeout
        ? `SPX option chain timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `SPX option chain request failed: ${(err as Error).message}`
    )
  }

  if (!response.ok) {
    throw new Error(`Cboe returned HTTP ${response.status} for the SPX option chain`)
  }

  const chain = (await response.json()) as CboeChain
  if (!chain?.data?.options?.length) {
    throw new Error("Cboe SPX chain response contained no option data")
  }

  return computeGamma(chain, now)
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 13 tests total (5 from Task 1, 8 here).

- [ ] **Step 7: Sanity-check against the live endpoint**

Run:

```bash
node -e 'const {fetchGamma}=await import("./lib/gamma.ts");const g=await fetchGamma();console.log(g.regime,(g.netGex/1e9).toFixed(2)+"bn","flip",g.flipStrike,"spot",g.spot)' --input-type=module
```

Expected: a regime, a net GEX in the tens of billions, a flip strike near spot. If this errors, the failure message must name the cause — that is the behaviour being verified.

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts lib/gamma.ts lib/gamma.test.ts lib/fixtures/spx-chain.json
git commit -m "Add SPX dealer gamma exposure and regime classification"
```

---

### Task 3: Overnight quote board

**Files:**
- Create: `lib/market-data.ts`
- Create: `lib/market-data.test.ts`

**Interfaces:**
- Consumes: `OvernightQuote`, `QuoteGroup` from `lib/types.ts` (Task 2).
- Produces: `BOARD: SymbolSpec[]`, `rthCloseAnchor(timestamps, closes, now): number | null`, `quoteFromChart(spec, result, now): OvernightQuote`, `fetchQuotes(now?): Promise<{ quotes: OvernightQuote[]; errors: Record<string, string> }>`, types `SymbolSpec`, `YahooChartResult`.

- [ ] **Step 1: Write the failing test**

Create `lib/market-data.test.ts`. The first test is the one that matters most — it pins the futures anchor rule from the spec:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/market-data.test.ts`
Expected: FAIL — cannot find module `./market-data.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/market-data.ts`:

```ts
import type { OvernightQuote, QuoteGroup } from "./types"

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
const FETCH_TIMEOUT_MS = 10000
const HOUR_SEC = 3600
/** Yahoo labels hourly bars by start time, so 15:00 ET closes at the 16:00 cash close. */
const RTH_CLOSE_BAR_HOUR_ET = 15

const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
})

export interface SymbolSpec {
  symbol: string
  label: string
  group: QuoteGroup
  /**
   * `rth-close` derives the anchor from hourly bars because Yahoo's
   * chartPreviousClose is unstable for futures across range parameters.
   */
  anchor: "rth-close" | "prev-close"
}

export interface YahooChartResult {
  meta: { symbol: string; regularMarketPrice: number; chartPreviousClose: number }
  timestamp: number[]
  indicators: { quote: Array<{ close: (number | null)[] }> }
}

export const BOARD: SymbolSpec[] = [
  { symbol: "ES=F", label: "S&P 500 (ES)", group: "futures", anchor: "rth-close" },
  { symbol: "NQ=F", label: "Nasdaq 100 (NQ)", group: "futures", anchor: "rth-close" },
  { symbol: "^TNX", label: "US 10Y Yield", group: "rates", anchor: "prev-close" },
  { symbol: "DX-Y.NYB", label: "Dollar Index", group: "rates", anchor: "prev-close" },
  { symbol: "^N225", label: "Nikkei 225", group: "global", anchor: "prev-close" },
  { symbol: "^HSI", label: "Hang Seng", group: "global", anchor: "prev-close" },
  { symbol: "^GDAXI", label: "DAX", group: "global", anchor: "prev-close" },
  { symbol: "^FTSE", label: "FTSE 100", group: "global", anchor: "prev-close" },
  { symbol: "CL=F", label: "Crude Oil", group: "commods", anchor: "prev-close" },
  { symbol: "GC=F", label: "Gold", group: "commods", anchor: "prev-close" },
  { symbol: "BTC-USD", label: "Bitcoin", group: "commods", anchor: "prev-close" },
  { symbol: "^VIX", label: "VIX", group: "vol", anchor: "prev-close" },
]

function etHour(ts: number): number {
  return Number(ET_HOUR.format(new Date(ts * 1000)))
}

/**
 * Close of the most recent completed 15:00-16:00 ET hourly bar — the prior RTH
 * cash close. Returns null if no such bar is present.
 */
export function rthCloseAnchor(
  timestamps: number[],
  closes: (number | null)[],
  now: number
): number | null {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const close = closes[i]
    if (close == null) continue
    const ts = timestamps[i]
    if (ts + HOUR_SEC > now) continue
    if (etHour(ts) !== RTH_CLOSE_BAR_HOUR_ET) continue
    return close
  }
  return null
}

export function quoteFromChart(
  spec: SymbolSpec,
  result: YahooChartResult,
  now: number
): OvernightQuote {
  const last = result.meta.regularMarketPrice
  const closes = result.indicators.quote[0]?.close ?? []

  let anchor: number | null = null
  if (spec.anchor === "rth-close") {
    anchor = rthCloseAnchor(result.timestamp ?? [], closes, now)
  }
  if (anchor == null) anchor = result.meta.chartPreviousClose

  if (!Number.isFinite(last) || !Number.isFinite(anchor) || anchor === 0) {
    throw new Error(`${spec.symbol} returned no usable price`)
  }

  const change = last - anchor
  return {
    symbol: spec.symbol,
    label: spec.label,
    group: spec.group,
    last,
    anchor,
    change,
    changePct: (change / anchor) * 100,
  }
}

async function fetchOne(spec: SymbolSpec, now: number): Promise<OvernightQuote> {
  const range = spec.anchor === "rth-close" ? "5d" : "2d"
  const interval = spec.anchor === "rth-close" ? "1h" : "1d"
  const url = `${CHART_BASE}/${encodeURIComponent(spec.symbol)}?range=${range}&interval=${interval}&includePrePost=true`

  let response: Response
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "NewsFinder/2.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    throw new Error(
      isTimeout
        ? `${spec.label} timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `${spec.label} request failed: ${(err as Error).message}`
    )
  }

  if (!response.ok) throw new Error(`${spec.label} returned HTTP ${response.status}`)

  const body = (await response.json()) as { chart?: { result?: YahooChartResult[] } }
  const result = body.chart?.result?.[0]
  if (!result) throw new Error(`${spec.label} returned no chart data`)

  return quoteFromChart(spec, result, now)
}

/** Fetches the whole board in parallel. One symbol failing never sinks the rest. */
export async function fetchQuotes(
  now: number = Math.floor(Date.now() / 1000)
): Promise<{ quotes: OvernightQuote[]; errors: Record<string, string> }> {
  const settled = await Promise.allSettled(BOARD.map((spec) => fetchOne(spec, now)))

  const quotes: OvernightQuote[] = []
  const errors: Record<string, string> = {}

  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      quotes.push(outcome.value)
    } else {
      const reason = outcome.reason
      errors[BOARD[i].symbol] = reason instanceof Error ? reason.message : String(reason)
      console.warn(`[market-data] ${BOARD[i].symbol}: ${errors[BOARD[i].symbol]}`)
    }
  })

  return { quotes, errors }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 20 tests total.

- [ ] **Step 5: Sanity-check against live data**

Run:

```bash
node -e 'const {fetchQuotes}=await import("./lib/market-data.ts");const r=await fetchQuotes();for(const q of r.quotes)console.log(q.label.padEnd(16),q.last,q.changePct.toFixed(2)+"%");console.log("errors",r.errors)' --input-type=module
```

Expected: 12 rows with plausible percentages, `errors` empty. Confirm ES and NQ percentages look like an overnight move (typically well under 2%), not a multi-day move.

- [ ] **Step 6: Commit**

```bash
git add lib/market-data.ts lib/market-data.test.ts
git commit -m "Add overnight quote board with RTH-close anchoring for futures"
```

---

### Task 4: LLM brief and sentiment

**Files:**
- Create: `lib/summarize.ts`

**Interfaces:**
- Consumes: `Headline` from `lib/types.ts`, `OvernightQuote`, `GammaSnapshot`, `BriefSummary`.
- Produces: `summarizeOvernight(headlines: Headline[], quotes: OvernightQuote[], gamma: GammaSnapshot | null): Promise<BriefSummary>` — throws with a specific message on failure.

There is no unit test here: the module's only logic is an API call, and this file imports runtime values from `./config`, which `node --test` cannot resolve. It is exercised by the live check in Step 3 and via the endpoint in Task 6.

- [ ] **Step 1: Write the implementation**

Create `lib/summarize.ts`, mirroring the forced-tool pattern already used in `lib/llm.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk"
import { LLM_MODEL } from "./config"
import type { Headline, OvernightQuote, GammaSnapshot, BriefSummary } from "./types"

const MAX_HEADLINES = 120

const SYSTEM_PROMPT =
  "You are writing a pre-market brief for a day trader who trades S&P 500 and " +
  "Nasdaq 100 index futures. They will read this at 09:25 ET, minutes before the " +
  "US cash open. You are given every headline published overnight plus the " +
  "overnight tape. Call the `record_brief` tool exactly once.\n\n" +
  "Rules:\n" +
  "- summary: ONE paragraph, 90-140 words. Lead with what actually moved markets " +
  "overnight and why. Reference the tape where it supports the narrative. Plain " +
  "declarative prose, no bullet points, no preamble, no hedging boilerplate.\n" +
  "- sentiment: -100 (maximally bearish) to +100 (maximally bullish), judged ONLY " +
  "from the news and its market reaction. Use the full range; 0 means genuinely balanced.\n" +
  "- sentiment_label: two or three words, e.g. 'Mildly risk-on', 'Sharply bearish'.\n" +
  "- key_drivers: the 2-4 headlines that actually matter, each with one clause on why.\n" +
  "- risk_events: scheduled catalysts still ahead TODAY (data releases, Fed speakers, " +
  "major earnings). Empty array if none are evident."

const BRIEF_TOOL = {
  name: "record_brief",
  description: "Record the overnight market brief, sentiment, drivers, and upcoming risk events.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "One paragraph, 90-140 words" },
      sentiment: { type: "integer", description: "-100 (bearish) to +100 (bullish)" },
      sentiment_label: { type: "string", description: "Two or three word label" },
      key_drivers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            headline: { type: "string" },
            why: { type: "string", description: "One clause on why it matters" },
          },
          required: ["headline", "why"],
        },
      },
      risk_events: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "sentiment", "sentiment_label", "key_drivers", "risk_events"],
  },
}

interface RawBrief {
  summary?: string
  sentiment?: number
  sentiment_label?: string
  key_drivers?: Array<{ headline?: string; why?: string }>
  risk_events?: string[]
}

function clampSentiment(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-100, Math.min(100, Math.round(value as number)))
}

function renderTape(quotes: OvernightQuote[], gamma: GammaSnapshot | null): string {
  const lines = quotes.map(
    (q) => `${q.label}: ${q.last} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)`
  )
  if (gamma) {
    lines.push(
      `Dealer gamma: net ${(gamma.netGex / 1e9).toFixed(1)}bn per 1% (${gamma.regime}), ` +
        `spot ${gamma.spot}, flip ${gamma.flipStrike ?? "n/a"}`
    )
  }
  return lines.join("\n")
}

export async function summarizeOvernight(
  headlines: Headline[],
  quotes: OvernightQuote[],
  gamma: GammaSnapshot | null
): Promise<BriefSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === "sk-ant-your-key-here") {
    throw new Error("Summary unavailable: ANTHROPIC_API_KEY is not configured")
  }
  if (!headlines.length) {
    throw new Error("Summary unavailable: no headlines were published in the overnight window")
  }

  // Newest first, so the cap drops the stalest items rather than the freshest.
  const ordered = [...headlines].sort((a, b) => b.published_ts - a.published_ts).slice(0, MAX_HEADLINES)
  const numbered = ordered.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join("\n")
  const userMsg = `Overnight tape:\n${renderTape(quotes, gamma)}\n\nOvernight headlines:\n${numbered}`

  const client = new Anthropic({ apiKey })

  let resp
  try {
    resp = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [BRIEF_TOOL],
      tool_choice: { type: "tool", name: "record_brief" },
      messages: [{ role: "user", content: userMsg }],
    })
  } catch (err) {
    throw new Error(`LLM summarization failed: ${(err as Error).message}`)
  }

  const toolUse = resp.content.find((b) => b.type === "tool_use")
  const raw = toolUse?.input as RawBrief | undefined
  if (!raw?.summary) {
    throw new Error("LLM summarization returned no summary")
  }

  return {
    summary: raw.summary,
    sentiment: clampSentiment(raw.sentiment),
    sentimentLabel: raw.sentiment_label ?? "Neutral",
    keyDrivers: (raw.key_drivers ?? [])
      .filter((d) => d.headline)
      .map((d) => ({ headline: d.headline as string, why: d.why ?? "" })),
    riskEvents: raw.risk_events ?? [],
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Live smoke test**

Run:

```bash
node --env-file=.env -e 'const {fetchAllFeeds}=await import("./lib/rss.ts");const {feeds}=await import("./lib/config.ts");const {summarizeOvernight}=await import("./lib/summarize.ts");const h=await fetchAllFeeds(feeds);const b=await summarizeOvernight(h,[],null);console.log(b.sentiment,b.sentimentLabel);console.log(b.summary);console.log("drivers",b.keyDrivers.length,"risks",b.riskEvents)' --input-type=module
```

Expected: a one-paragraph summary, a sentiment in [-100, 100], and 2-4 drivers. If `lib/config.ts` fails to resolve here, run this check through the endpoint in Task 6 instead and note it.

- [ ] **Step 4: Commit**

```bash
git add lib/summarize.ts
git commit -m "Add overnight LLM brief with structured sentiment output"
```

---

### Task 5: Schema and brief orchestrator

**Files:**
- Modify: `supabase/schema.sql` (append `market_briefs`)
- Modify: `lib/config.ts` (add `BRIEF_RETENTION_SEC`)
- Modify: `lib/cleanup.ts` (purge old briefs)
- Create: `lib/brief.ts`

**Interfaces:**
- Consumes: `briefWindow` (Task 1), `fetchGamma` (Task 2), `fetchQuotes` (Task 3), `summarizeOvernight` (Task 4), existing `fetchAllFeeds`, `feeds`, `getSupabase`.
- Produces: `generateBrief(): Promise<MarketBrief>`, `getLatestBrief(): Promise<MarketBrief | null>`.

- [ ] **Step 1: Apply the schema**

Append to `supabase/schema.sql` and run the same statements in the Supabase SQL editor:

```sql
-- ── 5. Market briefs ─────────────────────────────────────────────────────────
-- One row per generated Open Brief. Generation is user-initiated from the tab,
-- so this table is deliberately NOT added to the Realtime publication.
CREATE TABLE IF NOT EXISTS market_briefs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_ts    BIGINT      NOT NULL,
  window_start_ts BIGINT      NOT NULL,
  window_end_ts   BIGINT      NOT NULL,
  summary         TEXT        NOT NULL,
  sentiment       INTEGER     NOT NULL,
  payload         JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_briefs_generated_ts_idx ON market_briefs (generated_ts DESC);

ALTER TABLE market_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_select" ON market_briefs FOR SELECT TO authenticated USING (true);
-- INSERT / UPDATE / DELETE only via the service-role key
```

- [ ] **Step 2: Add the retention constant**

In `lib/config.ts`, directly after `HEADLINE_RETENTION_SEC`:

```ts
/** Generated briefs older than this are purged during cleanup. */
export const BRIEF_RETENTION_SEC = 30 * 24 * 60 * 60
```

- [ ] **Step 3: Extend cleanup**

In `lib/cleanup.ts`, add `BRIEF_RETENTION_SEC` to the import list from `./config`, then insert this block immediately before the closing `console.log`:

```ts
  const briefCutoff = now - BRIEF_RETENTION_SEC
  const { error: briefErr } = await supabase
    .from("market_briefs")
    .delete()
    .lt("generated_ts", briefCutoff)
  if (briefErr) console.warn("[cleanup] briefs purge error:", briefErr.message)
```

- [ ] **Step 4: Write the orchestrator**

Create `lib/brief.ts`:

```ts
import { getSupabase } from "./supabase"
import { fetchAllFeeds } from "./rss"
import { feeds } from "./config"
import { briefWindow } from "./window"
import { fetchQuotes } from "./market-data"
import { fetchGamma } from "./gamma"
import { summarizeOvernight } from "./summarize"
import type {
  BriefErrors,
  BriefPayload,
  GammaSnapshot,
  Headline,
  MarketBrief,
  OvernightQuote,
} from "./types"

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Builds a brief from three independent sources. Quotes and gamma degrade to a
 * recorded reason; only a total news failure is fatal, since the summary cannot
 * exist without headlines.
 *
 * Reads feeds but never writes to `headlines` or `headline_dedup` — see the
 * freshness invariant in lib/config.ts.
 */
export async function generateBrief(): Promise<MarketBrief> {
  const now = Math.floor(Date.now() / 1000)
  const { start, end } = briefWindow(now)

  const [newsOutcome, quoteOutcome, gammaOutcome] = await Promise.allSettled([
    fetchAllFeeds(feeds),
    fetchQuotes(now),
    fetchGamma(),
  ])

  const errors: BriefErrors = {}

  if (newsOutcome.status === "rejected") {
    throw new Error(`Could not fetch any news feeds: ${reasonOf(newsOutcome.reason)}`)
  }
  const headlines: Headline[] = newsOutcome.value.filter(
    (h) => h.published_ts >= start && h.published_ts <= end
  )
  if (!headlines.length) {
    throw new Error(
      `No headlines were published between ${new Date(start * 1000).toISOString()} and now`
    )
  }

  let quotes: OvernightQuote[] = []
  if (quoteOutcome.status === "fulfilled") {
    quotes = quoteOutcome.value.quotes
    if (Object.keys(quoteOutcome.value.errors).length) errors.quotes = quoteOutcome.value.errors
  } else {
    errors.quotes = { board: `Quote board failed: ${reasonOf(quoteOutcome.reason)}` }
  }

  let gamma: GammaSnapshot | null = null
  if (gammaOutcome.status === "fulfilled") {
    gamma = gammaOutcome.value
  } else {
    errors.gamma = reasonOf(gammaOutcome.reason)
  }

  let summary = ""
  let sentiment = 0
  let keyDrivers: BriefPayload["keyDrivers"] = []
  let riskEvents: string[] = []
  let sentimentLabel = ""

  try {
    const result = await summarizeOvernight(headlines, quotes, gamma)
    summary = result.summary
    sentiment = result.sentiment
    sentimentLabel = result.sentimentLabel
    keyDrivers = result.keyDrivers
    riskEvents = result.riskEvents
  } catch (err) {
    errors.summary = reasonOf(err)
  }

  const payload: BriefPayload = {
    quotes,
    gamma,
    keyDrivers,
    riskEvents,
    sentimentLabel,
    headlineCount: headlines.length,
    errors,
  }

  const brief: MarketBrief = {
    generated_ts: now,
    window_start_ts: start,
    window_end_ts: end,
    summary,
    sentiment,
    payload,
  }

  const { error } = await getSupabase().from("market_briefs").insert(brief)
  if (error) console.warn("[brief] Insert error:", error.message)

  console.log(
    `[brief] ${headlines.length} headlines, ${quotes.length} quotes, ` +
      `gamma ${gamma ? gamma.regime : "failed"}, errors ${Object.keys(errors).length}`
  )

  return brief
}

/** Most recently generated brief, or null if none exists yet. */
export async function getLatestBrief(): Promise<MarketBrief | null> {
  const { data, error } = await getSupabase()
    .from("market_briefs")
    .select("generated_ts, window_start_ts, window_end_ts, summary, sentiment, payload")
    .order("generated_ts", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn("[brief] Fetch error:", error.message)
    return null
  }
  return (data as MarketBrief | null) ?? null
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql lib/config.ts lib/cleanup.ts lib/brief.ts
git commit -m "Add market_briefs table and brief orchestrator with per-source error capture"
```

---

### Task 6: Brief API endpoint

**Files:**
- Create: `api/brief.ts`
- Modify: `vercel.json` (add `maxDuration`)

**Interfaces:**
- Consumes: `generateBrief`, `getLatestBrief` (Task 5), `getAuthUser` (existing).
- Produces: `GET /api/brief` → `{ brief: MarketBrief | null }`; `POST /api/brief` → `{ brief: MarketBrief }` or `{ error: string }` with status 502.

- [ ] **Step 1: Write the endpoint**

Create `api/brief.ts`, following the auth and CORS shape of `api/status.ts`:

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getAuthUser } from "../lib/auth"
import { generateBrief, getLatestBrief } from "../lib/brief"

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()

  const user = await getAuthUser(req)
  if (!user) return res.status(401).json({ error: "Unauthorized" })

  if (req.method === "GET") {
    const brief = await getLatestBrief()
    return res.status(200).json({ brief })
  }

  if (req.method === "POST") {
    try {
      const brief = await generateBrief()
      return res.status(200).json({ brief })
    } catch (err) {
      // Only total news failure reaches here; partial failures ride in payload.errors.
      const message = err instanceof Error ? err.message : String(err)
      console.error("[brief] Generation failed:", message)
      return res.status(502).json({ error: message })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}
```

- [ ] **Step 2: Raise the function timeout**

In `vercel.json`, add to `functions`:

```json
"api/brief.ts": {
  "maxDuration": 60
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Verify end to end**

Start `npx vercel dev`. Sign in through the UI, copy the access token from the browser console with
`(await window.__sb.auth.getSession()).data.session.access_token` if exposed, or grab the
`Authorization` header from any existing `/api/status` request in the Network tab. Then:

```bash
TOKEN=<paste>
curl -s -X POST localhost:3000/api/brief -H "Authorization: Bearer $TOKEN" | head -c 1200
curl -s localhost:3000/api/brief -H "Authorization: Bearer $TOKEN" | head -c 400
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/brief
```

Expected: the POST returns a brief with a non-empty `summary`, 12 `quotes`, and a `gamma` object;
the GET returns that same cached brief; the unauthenticated GET returns `401`.

- [ ] **Step 5: Commit**

```bash
git add api/brief.ts vercel.json
git commit -m "Add auth-gated brief endpoint with cached GET and generating POST"
```

---

### Task 7: Tab navigation and brief hook

**Files:**
- Create: `frontend/src/hooks/use-brief.ts`
- Modify: `frontend/src/components/header.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `MarketBrief` shape from the API.
- Produces: `useBrief(): { brief, status, error, refetch }` where `status` is `"idle" | "loading" | "error"`; `Header` gains `tab: TabValue` and `onTabChange` props; `TabValue = "live" | "brief"` is exported from `header.tsx`.

- [ ] **Step 1: Write the hook**

Create `frontend/src/hooks/use-brief.ts`. It mirrors the `authHeaders` helper already used in `use-websocket.ts`:

```ts
import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

const API_BASE = import.meta.env.VITE_API_URL ?? ""

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" }
}

export interface GammaStrike {
  strike: number
  gex: number
}

export interface GammaSnapshot {
  spot: number
  netGex: number
  flipStrike: number | null
  topStrikes: GammaStrike[]
  regime: "mean-reversion" | "trending"
  contractsCounted: number
  strikesCounted: number
}

export interface OvernightQuote {
  symbol: string
  label: string
  group: "futures" | "rates" | "global" | "commods" | "vol"
  last: number
  anchor: number
  change: number
  changePct: number
}

export interface MarketBrief {
  generated_ts: number
  window_start_ts: number
  window_end_ts: number
  summary: string
  sentiment: number
  payload: {
    quotes: OvernightQuote[]
    gamma: GammaSnapshot | null
    keyDrivers: Array<{ headline: string; why: string }>
    riskEvents: string[]
    sentimentLabel: string
    headlineCount: number
    errors: {
      quotes?: Record<string, string>
      gamma?: string
      summary?: string
    }
  }
}

export type BriefStatus = "idle" | "loading" | "error"

export function useBrief() {
  const [brief, setBrief] = useState<MarketBrief | null>(null)
  const [status, setStatus] = useState<BriefStatus>("loading")
  const [error, setError] = useState<string | null>(null)

  // Serve the cached brief on mount so switching tabs is instant.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/brief`, { headers: await authHeaders() })
        if (!res.ok) throw new Error(`Could not load the cached brief (HTTP ${res.status})`)
        const data = await res.json()
        if (!cancelled) {
          setBrief(data.brief ?? null)
          setStatus("idle")
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
          setStatus("error")
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const refetch = useCallback(async () => {
    setStatus("loading")
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/brief`, {
        method: "POST",
        headers: await authHeaders(),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Generation failed (HTTP ${res.status})`)
      setBrief(data.brief)
      setStatus("idle")
    } catch (err) {
      // Keep the previous brief on screen; surface the reason alongside it.
      setError((err as Error).message)
      setStatus("error")
    }
  }, [])

  return { brief, status, error, refetch }
}
```

- [ ] **Step 2: Add the tab strip to the header**

In `frontend/src/components/header.tsx`:

1. Export the tab type and extend the props interface:

```ts
export type TabValue = "live" | "brief"
```

Add to `HeaderProps`:

```ts
  tab: TabValue
  onTabChange: (tab: TabValue) => void
```

2. Add `tab, onTabChange` to the destructured parameters.

3. Immediately after the `<h1>` element, insert the tab strip:

```tsx
        <div className="flex items-center gap-1 ml-3">
          <Button
            variant={tab === "live" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => onTabChange("live")}
          >
            Live
          </Button>
          <Button
            variant={tab === "brief" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => onTabChange("brief")}
          >
            Open Brief
          </Button>
        </div>
```

4. The list/timeline toggle and sort control belong to the Live tab only. Wrap those three
   `<Button>` elements (list, timeline, sort) in `{tab === "live" && (<> ... </>)}`.

- [ ] **Step 3: Wire the tab into App**

In `frontend/src/App.tsx`:

1. Add the import: `import { BriefPage } from "@/pages/brief-page"` and extend the header import to `import { Header, type SortOrder, type TabValue } from "@/components/header"`.
2. Add state: `const [tab, setTab] = useState<TabValue>("live")`.
3. Pass `tab={tab}` and `onTabChange={setTab}` to `<Header>`.
4. Render the brief tab by replacing the `FocusBar`/`FilterBar`/content block with:

```tsx
      {tab === "brief" ? (
        <BriefPage />
      ) : (
        <>
          <FocusBar marketFocus={marketFocus} onFocusChange={setMarketFocus} />
          <FilterBar filter={filter} onFilterChange={setFilter} totalCount={filtered.length} />
          {isEmpty ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">
                {wsStatus === "connecting" || wsStatus === "disconnected"
                  ? "Connecting to backend..."
                  : "Waiting for headlines..."}
              </span>
            </div>
          ) : viewMode === "list" ? (
            <HeadlineList headlines={filtered} sortOrder={sortOrder} />
          ) : (
            <HeadlineTimeline headlines={filtered} sortOrder={sortOrder} />
          )}
        </>
      )}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd frontend && npx tsc -b`
Expected: fails only on the missing `@/pages/brief-page`, which Task 8 creates. Create a temporary stub to confirm nothing else is broken:

```bash
mkdir -p frontend/src/pages && printf 'export function BriefPage() {\n  return <div className="flex-1" />\n}\n' > frontend/src/pages/brief-page.tsx
cd frontend && npx tsc -b
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/use-brief.ts frontend/src/components/header.tsx frontend/src/App.tsx frontend/src/pages/brief-page.tsx
git commit -m "Add Live/Open Brief tab navigation and brief data hook"
```

---

### Task 8: Brief page and panels

**Files:**
- Create: `frontend/src/components/sentiment-meter.tsx`
- Create: `frontend/src/components/overnight-board.tsx`
- Create: `frontend/src/components/gamma-panel.tsx`
- Modify: `frontend/src/pages/brief-page.tsx` (replace the Task 7 stub)

**Interfaces:**
- Consumes: `useBrief`, `MarketBrief`, `OvernightQuote`, `GammaSnapshot` from `@/hooks/use-brief` (Task 7); `Card`/`CardHeader`/`CardTitle`/`CardContent` from `@/components/ui/card`; `Button`; `Skeleton`.
- Produces: `BriefPage`, `SentimentMeter`, `OvernightBoard`, `GammaPanel`.

- [ ] **Step 1: Build the sentiment meter**

Create `frontend/src/components/sentiment-meter.tsx`:

```tsx
interface SentimentMeterProps {
  sentiment: number
  label: string
  error?: string
}

export function SentimentMeter({ sentiment, label, error }: SentimentMeterProps) {
  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/5 p-3">
        <div className="text-xs font-medium text-destructive">Sentiment unavailable</div>
        <div className="mt-1 text-xs text-muted-foreground">{error}</div>
      </div>
    )
  }

  // Map -100..100 onto 0..100% of the track width.
  const position = ((sentiment + 100) / 200) * 100
  const tone =
    sentiment > 15 ? "text-emerald-500" : sentiment < -15 ? "text-destructive" : "text-muted-foreground"

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className={`text-2xl font-semibold tabular-nums ${tone}`}>
          {sentiment > 0 ? "+" : ""}
          {sentiment}
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>

      <div className="relative h-2 rounded-full bg-gradient-to-r from-destructive via-muted to-emerald-500">
        <div
          className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-background"
          style={{ left: `calc(${position}% - 2px)` }}
        />
      </div>

      <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Bearish</span>
        <span>Neutral</span>
        <span>Bullish</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build the overnight board**

Create `frontend/src/components/overnight-board.tsx`:

```tsx
import type { OvernightQuote } from "@/hooks/use-brief"

const GROUP_LABELS: Record<OvernightQuote["group"], string> = {
  futures: "Index Futures",
  rates: "Rates & Dollar",
  global: "Global Equities",
  commods: "Commodities & Crypto",
  vol: "Volatility",
}

const GROUP_ORDER: Array<OvernightQuote["group"]> = ["futures", "rates", "global", "commods", "vol"]

interface OvernightBoardProps {
  quotes: OvernightQuote[]
  errors?: Record<string, string>
}

export function OvernightBoard({ quotes, errors }: OvernightBoardProps) {
  const failures = Object.entries(errors ?? {})

  return (
    <div className="space-y-4">
      {GROUP_ORDER.map((group) => {
        const rows = quotes.filter((q) => q.group === group)
        if (!rows.length) return null
        return (
          <div key={group}>
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {GROUP_LABELS[group]}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              {rows.map((q) => {
                const up = q.change >= 0
                return (
                  <div key={q.symbol} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate text-muted-foreground">{q.label}</span>
                    <span className="tabular-nums">
                      <span className="mr-2">{q.last.toLocaleString()}</span>
                      <span className={up ? "text-emerald-500" : "text-destructive"}>
                        {up ? "+" : ""}
                        {q.changePct.toFixed(2)}%
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {failures.length > 0 && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
          <div className="font-medium text-destructive">
            {failures.length} instrument{failures.length === 1 ? "" : "s"} could not be loaded
          </div>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {failures.map(([symbol, reason]) => (
              <li key={symbol}>
                <span className="font-mono">{symbol}</span> — {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Build the gamma panel**

Create `frontend/src/components/gamma-panel.tsx`:

```tsx
import type { GammaSnapshot } from "@/hooks/use-brief"

interface GammaPanelProps {
  gamma: GammaSnapshot | null
  error?: string
}

function formatBn(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value / 1e9).toFixed(2)}bn`
}

export function GammaPanel({ gamma, error }: GammaPanelProps) {
  if (!gamma) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/5 p-3">
        <div className="text-xs font-medium text-destructive">Gamma regime unavailable</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {error ?? "The SPX option chain was not returned."}
        </div>
      </div>
    )
  }

  const isLong = gamma.netGex >= 0
  const verdict = isLong ? "Mean reversion / range" : "Trending / momentum"
  const rationale = isLong
    ? "Dealers are long gamma — hedging sells rallies and buys dips, suppressing volatility."
    : "Dealers are short gamma — hedging chases direction, widening the expected range."

  return (
    <div className="space-y-3">
      <div>
        <div className={`text-lg font-semibold ${isLong ? "text-emerald-500" : "text-amber-500"}`}>
          {isLong ? "Long gamma" : "Short gamma"} · {verdict}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{rationale}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Net GEX / 1%</div>
          <div className="tabular-nums">{formatBn(gamma.netGex)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Spot</div>
          <div className="tabular-nums">{gamma.spot.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Flip level</div>
          <div className="tabular-nums">
            {gamma.flipStrike?.toLocaleString() ?? "none"}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Largest gamma strikes
        </div>
        <div className="flex flex-wrap gap-1.5">
          {gamma.topStrikes.map((s) => (
            <span
              key={s.strike}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums"
              title={`${formatBn(s.gex)} per 1% move`}
            >
              {s.strike.toLocaleString()}
            </span>
          ))}
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Cboe delayed quotes; open interest reflects the prior session close. 0–45 DTE,{" "}
        {gamma.strikesCounted} strikes.
      </p>
    </div>
  )
}
```

- [ ] **Step 4: Build the page**

Replace `frontend/src/pages/brief-page.tsx`:

```tsx
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useBrief } from "@/hooks/use-brief"
import { SentimentMeter } from "@/components/sentiment-meter"
import { OvernightBoard } from "@/components/overnight-board"
import { GammaPanel } from "@/components/gamma-panel"

function formatEt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function BriefPage() {
  const { brief, status, error, refetch } = useBrief()
  const loading = status === "loading"
  const windowHours = brief
    ? Math.round((brief.window_end_ts - brief.window_start_ts) / 3600)
    : 0

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {brief
              ? `Generated ${formatEt(brief.generated_ts)} ET · ${windowHours}h window · ${brief.payload.headlineCount} headlines`
              : "No brief generated yet"}
          </div>
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={refetch} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Fetching…" : "Fetch"}
          </Button>
        </div>

        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-3">
            <div className="text-xs font-medium text-destructive">Could not generate the brief</div>
            <div className="mt-1 text-xs text-muted-foreground">{error}</div>
          </div>
        )}

        {loading && !brief && (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {!loading && !brief && !error && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Press Fetch to generate the overnight brief.
          </div>
        )}

        {brief && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Overnight Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {brief.payload.errors.summary ? (
                  <div className="rounded border border-destructive/40 bg-destructive/5 p-3">
                    <div className="text-xs font-medium text-destructive">Summary unavailable</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {brief.payload.errors.summary}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed">{brief.summary}</p>
                )}

                <SentimentMeter
                  sentiment={brief.sentiment}
                  label={brief.payload.sentimentLabel}
                  error={brief.payload.errors.summary}
                />

                {brief.payload.keyDrivers.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Key drivers
                    </div>
                    <ul className="space-y-1 text-sm">
                      {brief.payload.keyDrivers.map((d, i) => (
                        <li key={i} className="leading-snug">
                          <span>{d.headline}</span>
                          {d.why && <span className="text-muted-foreground"> — {d.why}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {brief.payload.riskEvents.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Still ahead today
                    </div>
                    <ul className="space-y-0.5 text-sm text-muted-foreground">
                      {brief.payload.riskEvents.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Overnight Moves</CardTitle>
              </CardHeader>
              <CardContent>
                <OvernightBoard quotes={brief.payload.quotes} errors={brief.payload.errors.quotes} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Dealer Gamma Regime</CardTitle>
              </CardHeader>
              <CardContent>
                <GammaPanel gamma={brief.payload.gamma} error={brief.payload.errors.gamma} />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Build and lint**

Run:

```bash
cd frontend && npx tsc -b && npm run lint && npm run build
```

Expected: no type errors, no lint errors, a successful build.

- [ ] **Step 6: Verify in the running app**

With `npx vercel dev` running and signed in:

1. Click **Open Brief** — the tab renders; the cached brief appears if one exists, otherwise the empty state.
2. Click **Fetch** — the button shows a spinner and is disabled; a brief appears within ~20s.
3. Confirm the summary is one paragraph, the meter needle position matches the number, all twelve instruments show, and the gamma panel shows a regime, net GEX, flip level, and pin strikes.
4. Confirm the list/timeline toggle and sort control are hidden on this tab and return on **Live**.
5. Force a partial failure: temporarily change `CBOE_SPX_URL` in `lib/gamma.ts` to an invalid host, click **Fetch**, and confirm the summary and quote board still render while the gamma panel shows a specific reason (not a generic "unavailable"). Revert the URL.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/brief-page.tsx frontend/src/components/sentiment-meter.tsx frontend/src/components/overnight-board.tsx frontend/src/components/gamma-panel.tsx
git commit -m "Add Open Brief page with sentiment meter, overnight board, and gamma panel"
```

---

## Final Verification

- [ ] `npm test` — 20 tests pass
- [ ] `npx tsc --noEmit -p tsconfig.json` — clean
- [ ] `cd frontend && npx tsc -b && npm run lint && npm run build` — clean
- [ ] `git log --oneline` shows eight implementation commits on `feat/market-open-brief`
- [ ] `grep -rn "headline_dedup\|from(\"headlines\")" lib/brief.ts` returns nothing — the freshness invariant is untouched
- [ ] `git diff main --stat -- api/polling.ts lib/config.ts` shows no change to polling or auto-pause behaviour (`lib/config.ts` gains only `BRIEF_RETENTION_SEC`)
