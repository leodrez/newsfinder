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
