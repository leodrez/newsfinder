# Market Open Brief — Design

**Date:** 2026-08-28
**Status:** Approved, ready for implementation planning

## 1. Problem

The dashboard streams headlines in real time but has nothing to offer at 09:25 ET, when
the only question that matters is "what happened while I was asleep, and what kind of
market am I walking into?"

Three facts, all measured against live data rather than assumed, define the shape of the
solution:

**The database is empty overnight.** Headlines from the last 72 hours, bucketed by hour (ET):

```
08/26 09:00  70    08/28 02:00   8
08/26 10:00  10    08/28 09:00  23
08/27 09:00  45    08/28 10:00  48
08/27 10:00  19    08/28 11:00  10
```

Nothing lands between 11:00 and 09:00. `POLLING_AUTO_PAUSE_SEC` (1h, `lib/config.ts`)
stops polling an hour after each manual resume, and `MAX_HEADLINE_AGE_SEC` (6h) discards
older items at ingest. A brief assembled from stored rows would be empty at exactly the
moment it is needed.

**The feeds themselves do cover the window.** Measured live: 114 items published in the
prior 18 hours across the existing feeds (Yahoo 46, CNBC Top 26, CNBC World 20, NYT 12,
MarketWatch 10). The gap is collection cadence, not source coverage. No news vendor is
required.

**VIX cannot answer the gamma question, but Cboe can.** Long versus short gamma is dealer
positioning derived from the option chain; no transform of an implied-volatility level
yields it. Cboe's public delayed-quote endpoint returns the full SPX chain with per-strike
`gamma` and `open_interest`, keyless. Verified live:

```
Spot 7761.76 | 6.26M contracts OI (0-45 DTE) across 414 strikes
NET GEX  +$67.25bn per 1% move  ->  LONG GAMMA (mean-reversion / pinning)
Zero-gamma flip ~7780 | Top pins  7800: 8.96bn  7900: 6.41bn  7770: 5.33bn
```

## 2. Goals

Add one tab, "Open Brief", that on demand produces:

1. A one-paragraph summary of global trading news from the overnight window
2. A bull/bear sentiment meter derived from that summary
3. Overnight moves for ES and NQ plus rates, dollar, global equity sessions, commodities and crypto
4. A dealer-gamma regime read: net GEX, zero-gamma flip level, pin strikes, and a
   mean-reversion versus trending verdict

## 3. Non-goals

- No third-party news API vendor. The existing feeds cover the window.
- No VIX-proxy regime signal. Real GEX supersedes it.
- No blended sentiment score. See §6.
- No change to polling, auto-pause, or the Play button.
- No new environment variables and no new npm dependencies.

## 4. Architecture

| File | Responsibility |
|---|---|
| `lib/market-data.ts` | Symbol list to overnight moves via the Yahoo chart endpoint |
| `lib/gamma.ts` | Cboe SPX chain to net GEX, flip level, pin strikes, regime |
| `lib/summarize.ts` | Headlines plus market context to LLM brief and sentiment |
| `lib/brief.ts` | Orchestrator: gather, summarize, persist |
| `api/brief.ts` | `GET` latest cached brief, `POST` generate; both auth-gated |

Frontend:

```
pages/brief-page.tsx             layout, loading and empty states
components/sentiment-meter.tsx   gauge, -100..+100
components/overnight-board.tsx   12-symbol grid, grouped by class
components/gamma-panel.tsx       net GEX, flip, pins, regime verdict
hooks/use-brief.ts               { brief, status, error, refetch }
```

`api/brief.ts` gets `maxDuration: 60` in `vercel.json`.

## 5. Data acquisition

### 5.1 The overnight window

`window_start` is the prior RTH cash close (16:00 ET), clamped to between 12 and 24 hours
before `window_end` (generation time). The clamp keeps a Monday open at 24 hours rather
than reaching back 65 hours to Friday's close.

### 5.2 News

`fetchAllFeeds(feeds)` is called fresh at generation time and filtered to the window by
`published_ts`.

**Invariant:** the brief reads feeds but never writes to `headlines` and never touches
`headline_dedup`. The `MAX_HEADLINE_AGE_SEC < DEDUP_TTL_SEC` invariant enforced in
`lib/config.ts` is therefore unaffected, and the daily-repeat bug cannot recur through
this path. Implementations must not "helpfully" persist fetched items into `headlines`.

### 5.3 Quotes

`https://query1.finance.yahoo.com/v8/finance/chart/{symbol}`, twelve symbols in parallel,
all verified to resolve:

| Group | Symbols |
|---|---|
| Index futures | `ES=F`, `NQ=F` |
| Rates and dollar | `^TNX`, `DX-Y.NYB` |
| Global equities | `^N225`, `^HSI`, `^GDAXI`, `^FTSE` |
| Commodities and crypto | `CL=F`, `GC=F`, `BTC-USD` |
| Volatility | `^VIX` |

**The anchor rule matters and is the most likely source of a shipped bug.** Yahoo's
`chartPreviousClose` for futures is not stable across range parameters: `ES=F` returned
`7742.50` at `range=2d&interval=1d` and `7669.75` at `range=5d&interval=1h` in the same
minute. Therefore:

- `ES=F` and `NQ=F`: anchor to the close of the prior 16:00 ET hourly bar, derived from
  `range=5d&interval=1h` with `includePrePost=true`. Do not use `chartPreviousClose`.
- All other symbols: `chartPreviousClose` is correct, since each reflects that
  instrument's own prior session close.

Each quote yields absolute change and percent change against its anchor.

### 5.4 Gamma

`https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json` (~12.8MB, keyless).
Contract symbols are OSI-format and parse as `/^([A-Z^]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/`,
yielding root, expiry, right, and strike times 1000.

Filter to 0-45 DTE and to contracts with non-zero `open_interest` and `gamma`. Per contract,
under the dealer-long-calls / dealer-short-puts convention:

```
gex = gamma * open_interest * 100 * S^2 * 0.01 * (isCall ? +1 : -1)
```

where `S` is `data.current_price`. This expresses dollar gamma per 1% move. Aggregate by
strike, then derive:

- `net_gex` — sum across all strikes
- `flip_strike` — the strike at which cumulative GEX, accumulated from the lowest strike
  upward, crosses from negative to positive
- `top_strikes` — the five strikes with the largest absolute GEX

The 12.8MB payload is fetched, aggregated, and discarded server-side. Only the derived
figures reach the browser.

## 6. LLM brief and sentiment

A single `messages.create` call using a forced tool, matching the existing `record_scores`
pattern in `lib/llm.ts` so that output is typed and needs no text parsing.

Tool `record_brief`:

```
{ summary: string,          // one paragraph, the thing read at 09:25
  sentiment: integer,       // -100 (max bearish) .. +100 (max bullish)
  sentiment_label: string,
  key_drivers: [{ headline: string, why: string }],
  risk_events: string[] }   // scheduled catalysts still ahead today
```

The model receives the windowed headlines plus the quote board as context, so the
narrative can reference the actual overnight tape.

**The meter reflects news sentiment only.** It is deliberately not blended with price
action or the gamma regime. Divergence is the signal with the most trading value —
bullish news into short gamma is a different setup from bullish news into long gamma —
and a composite number destroys exactly that information. Three honest readings shown
side by side beat one muddy one.

Reuses `LLM_MODEL` and the existing `ANTHROPIC_API_KEY`. Roughly one Haiku call per
morning.

## 7. Regime classification

A pure function over the gamma output. No LLM involvement, so it is deterministic and
unit-testable.

- **Net GEX > 0** — dealers are long gamma, hedging sells rallies and buys dips, volatility
  is suppressed. Verdict: *mean-reversion / range*, with the largest pin strike as magnet.
- **Net GEX < 0** — dealers are short gamma, hedging chases direction. Verdict:
  *trending / momentum*, with a wider expected range.
- **Spot versus flip** — reports which side of the regime boundary spot sits on and the
  distance to it.

VIX is displayed on the board as a level and change but is excluded from the regime
computation. Mixing a proxy into a directly computed quantity would only dilute it.

## 8. Trigger, caching, and error handling

The Play button and `/api/polling` are untouched. There is no coupling between resuming
polling and generating a brief.

- Tab mounts, `GET /api/brief` returns the most recent cached brief immediately, or an
  empty state on first use.
- The **Fetch** button issues `POST /api/brief`. The button becomes a disabled spinner and
  the panels show skeletons until the response arrives.
- The brief header always displays `Generated HH:MM ET · Nh window` so a stale brief is
  never mistaken for a fresh one.

### Partial failure

The three data sources fail independently. A failure in one does not discard the others.

- **Cboe unreachable or malformed** — news summary and quote board still render; the gamma
  panel shows its own error.
- **Individual quote fails** — that row shows an error; the rest of the board renders.
- **Total feed failure** — hard error, since the summary cannot exist without headlines.
- **LLM failure** — quote board and gamma panel still render; the summary and meter show
  their own error.

**Error messages must state the actual reason.** A generic "unavailable" is not acceptable.
Each failure carries a specific, human-readable cause through to the panel, for example
"SPX option chain timed out after 15s", "Cboe returned HTTP 503", or "LLM summarization
failed: rate limit". `lib/brief.ts` captures the reason per source and stores it in the
payload so a cached brief shows why a panel is empty, not merely that it is.

On a failed `POST`, the previously cached brief remains on screen with an inline error and
a retry affordance; it is not blown away.

## 9. Schema

```sql
CREATE TABLE IF NOT EXISTS market_briefs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_ts    BIGINT      NOT NULL,
  window_start_ts BIGINT      NOT NULL,
  window_end_ts   BIGINT      NOT NULL,
  summary         TEXT        NOT NULL,
  sentiment       INTEGER     NOT NULL,
  payload         JSONB       NOT NULL,   -- quotes, gamma, drivers, risk events, per-source errors
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_briefs_generated_ts_idx ON market_briefs (generated_ts DESC);

ALTER TABLE market_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_select" ON market_briefs FOR SELECT TO authenticated USING (true);
```

Writes go through the service-role key, matching `headlines`. The table is **not** added to
the Realtime publication: generation is user-initiated from the tab, so the response to
`POST` is sufficient and a subscription would be dead weight.

Retention folds into the existing throttled sweep in `lib/cleanup.ts`, keeping 30 days of
briefs.

## 10. Testing

The repo has no test runner today; this adds `node --test`.

- `lib/gamma.ts` against a saved Cboe fixture: GEX sign, flip-level detection, the 0-45 DTE
  filter, and correct OSI parsing including the `^SPX` root.
- `lib/market-data.ts`: asserts the ES anchor is the prior 16:00 ET bar close and **not**
  `chartPreviousClose`. This is the single most likely defect to ship.
- Window derivation: the 12-24h clamp, including the Monday-open case.
- Partial-failure paths: each source failing in isolation still yields a brief, with a
  specific reason recorded for the failed source.

## 11. Risks

- **Unofficial endpoints.** Yahoo and Cboe are undocumented and may change or rate-limit.
  Both are isolated behind a single module each, so a replacement is a contained change,
  and both already degrade to a panel-level error rather than breaking the tab.
- **Cboe payload size.** 12.8MB per generation. Acceptable at roughly one call per morning;
  it would not be acceptable on a poll loop, which is a further reason generation stays
  manual.
- **Delayed data.** Cboe quotes are delayed and open interest reflects the prior close.
  This is the correct convention for a pre-open gamma read and should be labeled in the UI.
