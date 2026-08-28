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

  // Trust the server's classification rather than recomputing it from netGex,
  // so the label can never diverge from what the backend actually decided.
  const isLong = gamma.regime === "mean-reversion"
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
