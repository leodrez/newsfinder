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
