# Dealer Gamma Regime Redesign

Supersedes §5.4 and §7 of `2026-08-28-market-open-brief-design.md`.

## 1. Problem

For the week of 21–25 September 2026 the Open Brief classified both SPX and NQ as
*mean-reversion / range* every morning, and every session trended instead. The stored
briefs (`market_briefs.payload.gamma`) show why:

| Day | SPX net GEX | SPX spot | Flip reported | Spot vs flip |
|---|---|---|---|---|
| Mon 21 | +44 to +50bn | 7650–7697 | 7750–7760 | below |
| Tue 22 | +79 to +84bn | 7765 | 7790 | below |
| Wed 23 | +70bn | 7765 | 7790 | below |
| Thu 24 | +57bn | 7765 (stale, Wed chain) | 7800 | below |
| Fri 25 | +32 to +39bn | 7704–7727 | 7830–7850 | below |

The regime was taken from the **sign of net GEX**, which was positive all week. Spot sat
**below the flip** all week. The panel printed "Long gamma · Mean reversion" and, three
lines lower, "below flip". Those two statements contradict each other, and the second one
was right.

Three defects compound:

1. **Regime from the sign of the aggregate.** Every major platform (SpotGamma, MenthorQ,
   perfiliev, ZeroGEX) sets the regime by where spot sits relative to the zero-gamma level,
   not by the sign of total GEX. SqueezeMetrics' own published history since 2011 has
   aggregate GEX negative on only 9% of days; the sign carries almost no information
   outside bear markets. On the live 25 Sep chain, 0–45 DTE net GEX was +2bn out of
   ±140bn gross per side — a rounding error whose sign flipped with a 0.3% move in spot.
2. **Flip from a cumulative walk across strikes.** Walking strikes low to high and taking
   the first zero crossing accumulates all the put gamma first, so the crossing lands at the
   first big call wall. On 25 Sep it reported 8100 against spot 7703 (+5%); the re-priced
   profile puts the true crossing at ~7711–7723. ZeroGEX describes this exact artifact: the
   walk "sticks at a wall even when the true zero-gamma level is several percent away".
3. **Per-contract gamma copied from Cboe's field.** Cboe zeroes gamma on far-OTM contracts
   (24% of rows, 6M OI), which biases the sum positive, and that field cannot be re-priced
   at hypothetical spot levels, which is what a flip calculation needs.

Two data-quality issues surfaced alongside:

- On Thu 24 Sep every fetch between 09:20 and 10:02 ET returned the chain built Wed 00:56
  ET (identical `quoteTs`, identical spot). The brief used a 32-hour-old book with no
  warning.
- `cdn.cboe.com/api/global/delayed_quotes/options/*.json` now answers 307 to
  `cdn-api.cboe.com/...`. Node's fetch follows it, but the canonical host should be used.

## 2. Method (what the platforms do)

Sources: SqueezeMetrics whitepaper; perfiliev.com "How to calculate gamma exposure and zero
gamma level"; spotgamma.com (GEX, Zero Gamma, Volatility Trigger pages); menthorq.com HVL
guide; zerogex.io flip-calculation guide; jensolson/SPX-Gamma-Exposure; Emf2912147/GEX.

- **Per-contract dollar gamma per 1% move:** `sign × Γ × OI × 100 × S² × 0.01`, with
  `+` for calls and `−` for puts (dealers long calls, short puts). Unchanged.
- **Γ is re-priced with Black-Scholes** from each contract's own implied volatility and
  time to expiry, with rate and dividend set to zero, at whatever spot level `L` is being
  evaluated: `d1 = (ln(L/K) + ½σ²T) / (σ√T)`, `Γ = φ(d1) / (L σ √T)`. Checked on the live
  25 Sep chain: with `T` measured to 16:00 ET on expiry day, this reproduces Cboe's own
  gamma at current spot to a median ratio of 1.000 (1–7 DTE) and 1.005 (8–45 DTE).
- **Gamma profile:** evaluate the whole book's signed exposure at a grid of hypothetical
  spot levels. **Zero-gamma level** is where that curve crosses zero, taking the crossing
  nearest spot and interpolating linearly between grid points.
- **Regime:** spot above the zero-gamma level → dealers long gamma → mean reversion; spot
  below → dealers short gamma → trending. Within a narrow band of it, neither — SpotGamma:
  feedback loops "are not expected unless decently above or below it".
- **0DTE:** OI-based models weight same-day contracts down or out. Cboe's own
  participant-tagged data shows market-maker net 0DTE gamma is near zero (median +$173M),
  so counting 0DTE OI under the long-calls/short-puts convention massively overstates it.
  ZeroGEX weights each contract by `min(1, DTE/5)`.

## 3. New computation (`lib/gamma.ts`, `lib/gamma-model.ts`)

**Book.** Contracts with 0 ≤ DTE ≤ 45 (calendar days from today's UTC date, as now),
`open_interest > 0`, and `0.01 ≤ iv ≤ 2`. Cboe's `gamma` field is no longer read. Each
contract carries weight `w = min(1, DTE / 5)`, so 0DTE contributes nothing and 1–4 DTE is
tapered. Time to expiry `T` runs from `now` to 16:00 ET on the expiry date, in years of
365 days.

**Exposure at a level.** For a spot multiplier `m` (level `L = m × S_chain`):

```
gex_i(m) = sign_i × w_i × OI_i × 100 × Γ_BS(L, K_i, σ_i, T_i) × L² × 0.01
```

Multi-chain indices (NQ = NDX + QQQ) apply the same `m` to each chain's own spot, so the
profile is in relative terms and stays additive in dollars per 1%.

**Profile and flip.** `m` runs from 0.85 to 1.15 in steps of 0.001 (301 points). Every
sign change between neighbouring points is a candidate crossing, interpolated linearly. The
flip is the candidate nearest `m = 1`, provided `|m − 1| ≤ 0.08`; otherwise `flipStrike` is
null. `flipStrike = round(m* × S_base, 2 dp)`, on the base chain's axis.

**Net GEX** is the profile at `m = 1`: the same weighted, re-priced book evaluated at spot.
Per-strike `topStrikes` and per-chain `components[].netGex` are the same quantity
partitioned by strike and by chain. One gamma source everywhere, so sign of `netGex` and
side-of-flip can never disagree.

**Regime.**

```
neutral         if flipStrike != null and |spot − flipStrike| / spot < 0.0025
mean-reversion  else if netGex ≥ 0
trending        else
```

**Staleness.** `isGammaSnapshotTrustworthy` also rejects a snapshot whose `quoteTs` is
more than 20 hours before `now`, naming the build time and age. A midnight build read at
09:30 ET is 9 hours old and passes; yesterday's build read this morning is 33 hours old and
fails, so the panel shows the reason instead of a stale regime.

**Endpoint.** Chains are fetched from `https://cdn-api.cboe.com/api/global/delayed_quotes/options/<symbol>.json`.

## 4. Presentation

- Panel headline has three states: "Long gamma · Mean reversion / range" (emerald),
  "Short gamma · Trending / momentum" (amber), "At the flip · Regime undecided" (sky).
  The rationale line names the zero-gamma level as the reason, not the sign of net GEX.
- "Spot vs flip" shows distance in points and percent. When there is no flip: "No
  zero-gamma level within 8% of spot — the near-term book is one-sided."
- Footer: "1–45 DTE · 0DTE excluded, under 5 DTE down-weighted".
- The LLM tape line gives the regime, spot's distance and side relative to the zero-gamma
  level, and gamma at spot — in that order, so the model reasons from the level.

## 5. Out of scope

Intraday/volume-based positioning (SpotGamma HIRO, Unusual Whales directional volume),
SPY/ES folded into the S&P complex, separate 0DTE levels, call/put walls as named levels.
Each is a contained follow-up on the same profile.

## 6. Expected reading on the 25 Sep 2026 chain (prototype, 14:22 UTC)

| Index | Gamma at spot | Flip | Spot vs flip | Regime |
|---|---|---|---|---|
| SPX | −5.7bn | 7711 | 0.10% below | neutral |
| NQ (NDX axis) | +4.0bn | 30124 | 1.31% above | mean-reversion |

Runtime ~100 ms per index for the 301-point profile over ~8.7k SPX contracts.
