import { formatQuoteChange } from "@shared/quote-format"
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
  const fallbacks = quotes.filter((q) => q.anchorFallback)

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
                    <span className="truncate text-muted-foreground">
                      {q.label}
                      {q.anchorFallback && (
                        <span
                          className="ml-0.5 text-muted-foreground"
                          title="Prior RTH close unavailable — previous close used as the anchor"
                        >
                          *
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">
                      <span className="mr-2">{q.last.toLocaleString()}</span>
                      {/*
                        Units come from ../../../lib/quote-format.ts, shared with the LLM
                        prompt tape in lib/summarize.ts: yields print in basis points,
                        everything else as a percent.
                      */}
                      <span className={up ? "text-emerald-500" : "text-destructive"}>
                        {formatQuoteChange(q)}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {fallbacks.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          <span className="mr-1">*</span>
          Prior RTH close unavailable for {fallbacks.map((q) => q.label).join(", ")}; the previous
          close was used as the anchor instead, so the move shown may differ in size and even in
          direction from the true overnight change.
        </p>
      )}

      {quotes.length === 0 && failures.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No instruments were returned for this brief.
        </p>
      )}

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
