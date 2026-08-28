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
          {Math.round(sentiment)}
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>

      <div className="relative h-2 overflow-hidden rounded-full bg-gradient-to-r from-destructive via-muted to-emerald-500">
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
