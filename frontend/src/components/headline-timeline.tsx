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

  return (
    <div ref={containerRef} className="flex-1 overflow-x-auto px-4 py-4">
      <Timeline
        orientation="horizontal"
        alternating={true}
        horizItemSpacing={150}
        horizItemWidth={220}
      >
        {ordered.map((item, i) => (
          <TimelineItem
            key={`${item.source}-${item.fetched_ts}-${i}`}
            variant={impactVariant(item.impact)}
          >
            <TimelineItemDate>{relativeTime(item.fetched_ts)}</TimelineItemDate>
            <TimelineItemTitle>
              <a
                href={item.url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline text-foreground"
              >
                {item.title}
              </a>
            </TimelineItemTitle>
            <TimelineItemDescription>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {item.source}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  Relevance: {item.relevance}/10
                </span>
                {item.summary && (
                  <span className="text-[10px] text-muted-foreground italic">
                    — {item.summary}
                  </span>
                )}
              </div>
            </TimelineItemDescription>
          </TimelineItem>
        ))}
      </Timeline>
    </div>
  )
}
