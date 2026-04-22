import { useEffect, useMemo, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
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

function formatBatchTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function scoreColor(relevance: number) {
  if (relevance >= 8) return "bg-red-500 text-white"
  if (relevance >= 4) return "bg-yellow-500 text-black"
  if (relevance >= 1) return "bg-emerald-500 text-white"
  return "bg-muted text-muted-foreground"
}

function impactBorder(impact: string) {
  if (impact === "high") return "border-l-red-500"
  if (impact === "medium") return "border-l-yellow-500"
  if (impact === "low") return "border-l-emerald-500"
  return "border-l-muted"
}

interface Batch {
  ts: number
  items: HeadlineItem[]
}

function groupIntoBatches(headlines: HeadlineItem[]): Batch[] {
  const batches: Batch[] = []
  for (const item of headlines) {
    const roundedTs = Math.floor(item.fetched_ts)
    const last = batches[batches.length - 1]
    if (last && Math.abs(last.ts - roundedTs) < 3) {
      last.items.push(item)
    } else {
      batches.push({ ts: roundedTs, items: [item] })
    }
  }
  return batches
}

interface HeadlineListProps {
  headlines: HeadlineItem[]
  sortOrder: SortOrder
}

export function HeadlineList({ headlines, sortOrder }: HeadlineListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const newestFirst = sortOrder === "newest-first"

  const batches = useMemo(() => {
    const grouped = groupIntoBatches(headlines)
    return newestFirst ? [...grouped].reverse() : grouped
  }, [headlines, newestFirst])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => {
      if (newestFirst) {
        autoScrollRef.current = el.scrollTop < 60
      } else {
        autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }
    }
    el.addEventListener("scroll", handler)
    return () => el.removeEventListener("scroll", handler)
  }, [newestFirst])

  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      if (newestFirst) {
        containerRef.current.scrollTop = 0
      } else {
        containerRef.current.scrollTop = containerRef.current.scrollHeight
      }
    }
  }, [headlines, newestFirst])

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-2 sm:px-4 py-2">
      {batches.map((batch) => (
        <div key={batch.ts}>
          <div className="flex items-center gap-3 my-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
              {formatBatchTime(batch.ts)} · {batch.items.length} headline{batch.items.length !== 1 ? "s" : ""}
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-1">
            {batch.items.map((item, i) => (
              <a
                key={`${item.source}-${item.fetched_ts}-${i}`}
                href={item.url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-start gap-3 p-2.5 rounded-md border-l-[3px] bg-card",
                  "hover:bg-accent/50 transition-colors cursor-pointer no-underline",
                  impactBorder(item.impact)
                )}
              >
                <div
                  className={cn(
                    "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold",
                    scoreColor(item.relevance)
                  )}
                >
                  {item.relevance}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-snug text-foreground break-words">
                    {item.title}
                  </p>
                  {item.summary && (
                    <p className="text-xs text-muted-foreground italic mt-0.5">
                      {item.summary}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {item.source}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {relativeTime(item.fetched_ts)}
                    </span>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
