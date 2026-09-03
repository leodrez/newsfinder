import { useEffect, useMemo, useState } from "react"
import { RefreshCw, Square, Volume2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useBrief } from "@/hooks/use-brief"
import { SentimentMeter } from "@/components/sentiment-meter"
import { OvernightBoard } from "@/components/overnight-board"
import { GammaPanel } from "@/components/gamma-panel"
import { useSpeech } from "@/hooks/use-speech"
import { SpeechControls } from "@/components/speech-controls"
import { briefToSpeech } from "@shared/brief-speech"

// Threshold past which a brief's age is called out in a warning colour.
const STALE_AGE_SEC = 4 * 60 * 60

function formatEt(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function formatAge(ageSec: number): string {
  if (ageSec < 60) return "just now"
  const minutes = Math.floor(ageSec / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function BriefPage() {
  const { brief, status, error, refetch } = useBrief()
  // Ticking clock so the relative age stays truthful without an impure Date.now()
  // call during render. Minute resolution is plenty for an hours-scale staleness cue.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])
  const loading = status === "loading"

  const speech = useSpeech()
  const utterances = useMemo(() => (brief ? briefToSpeech(brief) : []), [brief])
  // A new brief invalidates whatever is being read aloud.
  useEffect(() => speech.stop(), [brief?.generated_ts, speech.stop])

  const windowHours = brief
    ? Math.round((brief.window_end_ts - brief.window_start_ts) / 3600)
    : 0
  const ageSec = brief ? Math.max(0, nowSec - brief.generated_ts) : 0
  const isStale = brief ? ageSec > STALE_AGE_SEC : false

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {brief ? (
              <>
                <span>Generated {formatEt(brief.generated_ts)} ET</span>
                <span className={isStale ? "text-destructive font-medium" : "text-muted-foreground"}>
                  {" · "}
                  {formatAge(ageSec)}
                </span>
                <span>
                  {" · "}
                  {windowHours}h window · {brief.payload.headlineCount} headlines
                </span>
              </>
            ) : (
              "No brief generated yet"
            )}
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
                {speech.supported && utterances.length > 0 && (
                  <CardAction className="flex items-center gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-my-1 h-7 gap-1.5 text-xs"
                      onClick={() => (speech.speaking ? speech.stop() : speech.speak(utterances))}
                      aria-label={
                        speech.speaking ? "Stop reading the brief" : "Read the brief aloud"
                      }
                    >
                      {speech.speaking ? (
                        <Square className="h-3.5 w-3.5 fill-current" />
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
                      {speech.speaking ? "Stop" : "Listen"}
                    </Button>
                    <SpeechControls speech={speech} />
                  </CardAction>
                )}
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
              <CardContent className="space-y-5">
                <GammaPanel
                  label="S&P 500 (SPX)"
                  gamma={brief.payload.gamma}
                  error={brief.payload.errors.gamma}
                  sentiment={brief.sentiment}
                  sentimentLabel={brief.payload.sentimentLabel}
                  sentimentError={brief.payload.errors.summary}
                />
                <div className="border-t pt-4">
                  <GammaPanel
                    label="Nasdaq 100 (NDX + QQQ) — NQ"
                    gamma={brief.payload.gammaNq}
                    error={
                      brief.payload.errors.gammaNq ??
                      "This brief predates the Nasdaq gamma panel."
                    }
                    sentiment={brief.sentiment}
                    sentimentLabel={brief.payload.sentimentLabel}
                    sentimentError={brief.payload.errors.summary}
                  />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
