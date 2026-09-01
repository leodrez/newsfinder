import type { GammaSnapshot } from "@/hooks/use-brief"

interface GammaPanelProps {
  label: string
  gamma: GammaSnapshot | null | undefined
  error?: string
}

function formatBn(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value / 1e9).toFixed(2)}bn`
}

/** Cboe reports both its build time and the underlying's last trade, so the
 *  lag is a measurement rather than a repeated claim. */
function formatDelay(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds < 0) return null
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)} min`
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
})

function formatEt(ms: number | null | undefined): string | null {
  return ms == null ? null : `${ET_TIME.format(new Date(ms))} ET`
}

function stripCaret(symbol: string): string {
  return symbol.replace(/^\^/, "")
}

export function GammaPanel({ label, gamma, error }: GammaPanelProps) {
  if (!gamma) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/5 p-3">
        <div className="text-xs font-medium text-destructive">
          {label} gamma regime unavailable
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {error ?? "The option chain was not returned."}
        </div>
      </div>
    )
  }

  // Trust the server's classification rather than recomputing it from netGex,
  // so the label can never diverge from what the backend actually decided.
  const isLong = gamma.regime === "mean-reversion"
  const verdict = isLong ? "Mean reversion / range" : "Trending / momentum"
  const rationale = isLong
    ? "Dealers are long gamma — hedging sells rallies and buys dips, suppressing volatility."
    : "Dealers are short gamma — hedging chases direction, widening the expected range."

  // Spec §7: report which side of the regime boundary spot sits on and how far,
  // rather than leaving the reader to subtract two bare numbers.
  const flipDistance = gamma.flipStrike == null ? null : gamma.spot - gamma.flipStrike
  const flipSide =
    flipDistance == null ? null : flipDistance > 0 ? "above flip" : flipDistance < 0 ? "below flip" : "at flip"

  // The first component is the base chain; the rest were scaled onto its axis.
  const components = gamma.components ?? []
  const axis = components.length > 1 ? stripCaret(components[0].symbol) : null
  const overlays = components.slice(1)

  const delay = formatDelay(gamma.quoteDelaySec)
  const capturedAt = formatEt(gamma.quoteTs)
  const tapeThrough = formatEt(gamma.lastTradeTs)

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
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
          <div className="tabular-nums">
            {gamma.spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Flip level</div>
          <div className="tabular-nums">
            {gamma.flipStrike?.toLocaleString() ?? "none"}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Spot vs flip</div>
        <div className="text-sm tabular-nums">
          {flipDistance == null ? (
            <span className="text-muted-foreground">
              No flip level in the chain — cumulative gamma never crosses zero.
            </span>
          ) : (
            <>
              <span className="font-medium">
                {Math.abs(flipDistance).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>{" "}
              <span>{flipSide}</span>
            </>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Largest gamma strikes{axis ? ` (${axis} points)` : ""}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Already ordered by absolute exposure, so the first is the magnet strike. */}
          {gamma.topStrikes.map((s, i) => (
            <span
              key={s.strike}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums"
              title={`${formatBn(s.gex)} per 1% move`}
            >
              {s.strike.toLocaleString()}
              {i === 0 && (
                <span className="ml-1 font-sans text-[9px] uppercase tracking-wide text-muted-foreground">
                  {/* Strikes are ranked by ABSOLUTE exposure, so the largest can be
                      negative — short gamma there accelerates moves rather than pinning
                      them, and calling it a magnet would invert the meaning. */}
                  {s.gex >= 0 ? "largest · magnet" : "largest · accelerant"}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Three different staleness clocks run here and they are not the same
          number, so each is stated rather than collapsed into "delayed". */}
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>
          Quotes{" "}
          {delay ? (
            <span className="font-medium text-foreground/70">{delay} behind the tape</span>
          ) : (
            "on Cboe's delayed feed"
          )}
          {capturedAt && tapeThrough
            ? ` — chain captured ${capturedAt}, reflecting trades through ${tapeThrough}`
            : capturedAt
              ? ` — chain captured ${capturedAt}`
              : ""}
          . Open interest is the prior session's close, so it lags a full session.
        </div>
        <div>
          0–45 DTE · {gamma.strikesCounted} strikes ·{" "}
          {gamma.contractsCounted.toLocaleString()} contracts
          {overlays.length
            ? ` · ${overlays
                .map((c) => `${stripCaret(c.symbol)} folded in at ${c.strikeRatio.toFixed(2)}×`)
                .join(", ")}`
            : ""}
        </div>
      </div>
    </div>
  )
}
