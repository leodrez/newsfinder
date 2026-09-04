import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useWebSocket, type HeadlineItem } from "@/hooks/use-websocket"
import { Header, type SortOrder, type TabValue } from "@/components/header"
import { FocusBar } from "@/components/focus-bar"
import { FilterBar } from "@/components/filter-bar"
import { HeadlineList } from "@/components/headline-list"
import { HeadlineTimeline } from "@/components/headline-timeline"
import { BriefPage } from "@/pages/brief-page"

type FilterValue = "all" | "high" | "medium" | "low"
type ViewMode = "list" | "timeline"

let audioCtx: AudioContext | null = null
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

function playAlert() {
  const ctx = getAudioCtx()
  if (ctx.state === "suspended") ctx.resume()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.frequency.value = 880
  osc.type = "sine"
  gain.gain.setValueAtTime(0.15, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.4)
}

function playDoubleAlert() {
  playAlert()
  setTimeout(playAlert, 200)
}

function filterHeadlines(items: HeadlineItem[], filters: FilterValue[]): HeadlineItem[] {
  if (filters.includes("all") || filters.length === 0) return items
  const active = new Set(filters)
  return items.filter((item) => active.has(item.impact as FilterValue))
}

export default function App() {
  const { headlines, wsStatus, llmStatus, marketFocus, setMarketFocus, newBatch, pollingEnabled, setPollingEnabled } =
    useWebSocket()
  const [filter, setFilter] = useState<FilterValue[]>(["all"])
  const [viewMode, setViewMode] = useState<ViewMode>("list")
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest-first")
  const [tab, setTab] = useState<TabValue>("live")
  const [showBrief, setShowBrief] = useState(true)
  const notifiedRef = useRef(false)

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission()
    }
  }, [])

  const handleNewBatch = useCallback((batch: HeadlineItem[]) => {
    const critical = batch.filter((h) => h.relevance >= 8)
    if (critical.length > 0) {
      playDoubleAlert()
      if (Notification.permission === "granted") {
        new Notification("NewsFinder Alert", {
          body: critical.map((h) => h.title).join("\n"),
        })
      }
    }
  }, [])

  useEffect(() => {
    if (newBatch.length > 0) {
      handleNewBatch(newBatch)
    }
  }, [newBatch, handleNewBatch])

  // Resume AudioContext on first click
  useEffect(() => {
    if (notifiedRef.current) return
    const handler = () => {
      notifiedRef.current = true
      if (audioCtx?.state === "suspended") audioCtx.resume()
    }
    document.addEventListener("click", handler, { once: true })
    return () => document.removeEventListener("click", handler)
  }, [])

  const filtered = useMemo(() => filterHeadlines(headlines, filter), [headlines, filter])

  const isEmpty = headlines.length === 0

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <Header
        wsStatus={wsStatus}
        llmStatus={llmStatus}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        sortOrder={sortOrder}
        onSortOrderChange={setSortOrder}
        pollingEnabled={pollingEnabled}
        onPollingToggle={setPollingEnabled}
        tab={tab}
        onTabChange={setTab}
        showBrief={showBrief}
        onShowBriefChange={setShowBrief}
      />
      {tab === "brief" ? (
        <BriefPage />
      ) : (
        <>
          <FocusBar marketFocus={marketFocus} onFocusChange={setMarketFocus} />
          <FilterBar filter={filter} onFilterChange={setFilter} totalCount={filtered.length} />
          {/* Side by side rather than a second tab: the brief stays visible while
              scanning live headlines, instead of losing one view to see the other. */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Live
              </div>
              {isEmpty ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-sm">
                    {wsStatus === "connecting" || wsStatus === "disconnected"
                      ? "Connecting to backend..."
                      : "Waiting for headlines..."}
                  </span>
                </div>
              ) : viewMode === "list" ? (
                <HeadlineList headlines={filtered} sortOrder={sortOrder} />
              ) : (
                <HeadlineTimeline headlines={filtered} sortOrder={sortOrder} />
              )}
            </div>
            {showBrief && (
              <div className="flex min-w-0 flex-1 flex-col border-l">
                <div className="border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Open Brief
                </div>
                <BriefPage />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
