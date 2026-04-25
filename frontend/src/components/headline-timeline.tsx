import { useEffect, useRef } from "react"
import Timeline, {
  TimelineItem,
  TimelineItemDate,
  TimelineItemTitle,
  TimelineItemDescription,
} from "@/components/ui/timeline"
import { Badge } from "@/components/ui/badge"
import type { HeadlineItem } from "@/hooks/use-websocket"
import type { SortOrder } from "@/components/header"
import { cn } from "@/lib/utils"

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts)
  if (diff < 5) return "just now"
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function impactVariant(impact: string): "default" | "secondary" | "destructive" | "outline" {
  if (impact === "high") return "destructive"
  if (impact === "medium") return "default"
  if (impact === "low") return "secondary"
  return "outline"
}

function formatBatchTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function highImpactBorderByRelevance(relevance: number): string {
  if (relevance >= 9) return "border-destructive"
  if (relevance >= 7) return "border-destructive/70"
  if (relevance >= 5) return "border-destructive/50"
  return "border-destructive/35"
}

function mediumImpactBorderByRelevance(relevance: number): string {
  if (relevance >= 7) return "border-yellow-500"
  if (relevance >= 5) return "border-yellow-500/75"
  if (relevance >= 3) return "border-yellow-500/55"
  return "border-yellow-500/40"
}

interface BatchMarkerInfo {
  isBatchStart: boolean
  batchTs?: number
  batchSize?: number
}

type TimelineEntry =
  | { type: "divider"; key: string; batchTs: number; batchSize: number }
  | { type: "headline"; key: string; item: HeadlineItem }

function buildBatchMarkers(headlines: HeadlineItem[]): BatchMarkerInfo[] {
  const markers: BatchMarkerInfo[] = headlines.map(() => ({ isBatchStart: false }))
  let i = 0
  while (i < headlines.length) {
    const start = i
    const roundedTs = Math.floor(headlines[i].fetched_ts)
    i += 1
    while (i < headlines.length && Math.abs(Math.floor(headlines[i].fetched_ts) - roundedTs) < 3) {
      i += 1
    }
    const size = i - start
    markers[start] = { isBatchStart: true, batchTs: roundedTs, batchSize: size }
  }
  return markers
}

interface HeadlineTimelineProps {
  headlines: HeadlineItem[]
  sortOrder: SortOrder
}

export function HeadlineTimeline({ headlines, sortOrder }: HeadlineTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const newestFirst = sortOrder === "newest-first"

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => {
      if (newestFirst) {
        autoScrollRef.current = el.scrollLeft < 60
      } else {
        autoScrollRef.current = el.scrollWidth - el.scrollLeft - el.clientWidth < 60
      }
    }
    el.addEventListener("scroll", handler)
    return () => el.removeEventListener("scroll", handler)
  }, [newestFirst])

  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      if (newestFirst) {
        containerRef.current.scrollLeft = 0
      } else {
        containerRef.current.scrollLeft = containerRef.current.scrollWidth
      }
    }
  }, [headlines, newestFirst])

  const ordered = newestFirst ? [...headlines].reverse() : headlines
  const batchMarkers = buildBatchMarkers(ordered)
  const entries: TimelineEntry[] = ordered.flatMap((item, i) => {
    const out: TimelineEntry[] = []
    const marker = batchMarkers[i]
    if (marker?.isBatchStart) {
      out.push({
        type: "divider",
        key: `divider-${marker.batchTs ?? Math.floor(item.fetched_ts)}-${i}`,
        batchTs: marker.batchTs ?? Math.floor(item.fetched_ts),
        batchSize: marker.batchSize ?? 1,
      })
    }
    out.push({
      type: "headline",
      key: `${item.source}-${item.fetched_ts}-${i}`,
      item,
    })
    return out
  })

  return (
    <div ref={containerRef} className="flex-1 overflow-x-auto px-4 py-4">
      <Timeline
        orientation="horizontal"
        alternating={true}
        horizItemSpacing={150}
        horizItemWidth={220}
      >
        {entries.map((entry) =>
          entry.type === "divider" ? (
            <TimelineItem
              key={entry.key}
              variant="outline"
              hollow
              className="border border-border/70 bg-muted/20 py-2"
            >
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                  {formatBatchTime(entry.batchTs)} · {entry.batchSize} headline
                  {entry.batchSize !== 1 ? "s" : ""}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </TimelineItem>
          ) : (
            <TimelineItem
              key={entry.key}
              variant={impactVariant(entry.item.impact)}
              className={cn(
                "border",
                entry.item.impact === "high"
                  ? highImpactBorderByRelevance(entry.item.relevance)
                  : entry.item.impact === "medium"
                    ? cn(mediumImpactBorderByRelevance(entry.item.relevance), "bg-yellow-500/10")
                  : undefined
              )}
            >
              <TimelineItemDate>{relativeTime(entry.item.fetched_ts)}</TimelineItemDate>
              <TimelineItemTitle>
                <a
                  href={entry.item.url || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-foreground"
                >
                  {entry.item.title}
                </a>
              </TimelineItemTitle>
              <TimelineItemDescription>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {entry.item.source}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    Relevance: {entry.item.relevance}/10
                  </span>
                  {entry.item.summary && (
                    <span className="text-[10px] text-muted-foreground italic">
                      — {entry.item.summary}
                    </span>
                  )}
                </div>
              </TimelineItemDescription>
            </TimelineItem>
          )
        )}
      </Timeline>
    </div>
  )
}
