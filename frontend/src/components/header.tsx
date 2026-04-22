import { useCallback, useEffect, useRef } from "react"
import { Moon, Sun, List, Clock, Wifi, WifiOff, Brain, ArrowDownUp, Pause, Play } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"
import type { LlmStatus } from "@/hooks/use-websocket"

export type SortOrder = "newest-first" | "oldest-first"

interface HeaderProps {
  wsStatus: "connecting" | "connected" | "disconnected"
  llmStatus: LlmStatus
  marketFocus: string
  onFocusChange: (focus: string) => void
  viewMode: "list" | "timeline"
  onViewModeChange: (mode: "list" | "timeline") => void
  sortOrder: SortOrder
  onSortOrderChange: (order: SortOrder) => void
  pollingEnabled: boolean
  onPollingToggle: (enabled: boolean) => void
}

export function Header({
  wsStatus,
  llmStatus,
  marketFocus,
  onFocusChange,
  viewMode,
  onViewModeChange,
  sortOrder,
  onSortOrderChange,
  pollingEnabled,
  onPollingToggle,
}: HeaderProps) {
  const { setTheme } = useTheme()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleFocusInput = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        onFocusChange(value)
      }, 600)
    },
    [onFocusChange]
  )

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <header className="flex items-center gap-3 border-b px-4 py-2.5 bg-card">
      <h1 className="text-sm font-semibold tracking-tight whitespace-nowrap text-primary">
        NewsFinder
      </h1>

      <div className="flex items-center gap-2 flex-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap">
          Focus
        </span>
        <Input
          defaultValue={marketFocus}
          key={marketFocus}
          onChange={(e) => handleFocusInput(e.target.value)}
          placeholder="e.g. S&P 500 futures, NVDA, semiconductor stocks…"
          className="h-8 text-sm"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center gap-1.5">
        {/* View mode toggle */}
        <Button
          variant={viewMode === "list" ? "secondary" : "ghost"}
          size="icon"
          className="h-7 w-7"
          onClick={() => onViewModeChange("list")}
          title="List view"
        >
          <List className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant={viewMode === "timeline" ? "secondary" : "ghost"}
          size="icon"
          className="h-7 w-7"
          onClick={() => onViewModeChange("timeline")}
          title="Timeline view"
        >
          <Clock className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() =>
            onSortOrderChange(sortOrder === "newest-first" ? "oldest-first" : "newest-first")
          }
          title={sortOrder === "newest-first"
            ? "Newest first (click to reverse)"
            : "Oldest first (click to reverse)"
          }
        >
          <ArrowDownUp className={`h-3.5 w-3.5 transition-transform ${sortOrder === "oldest-first" ? "rotate-180" : ""}`} />
        </Button>

        {/* Polling pause/resume */}
        <Button
          variant={pollingEnabled ? "ghost" : "secondary"}
          size="icon"
          className="h-7 w-7"
          onClick={() => onPollingToggle(!pollingEnabled)}
          title={pollingEnabled ? "Pause polling (stop fetching news)" : "Resume polling"}
        >
          {pollingEnabled ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5 text-emerald-500" />
          )}
        </Button>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Status indicators */}
        <div className="flex items-center gap-1 px-2 py-1 rounded bg-background border text-[10px] text-muted-foreground">
          {wsStatus === "connected" ? (
            <Wifi className="h-3 w-3 text-emerald-500" />
          ) : wsStatus === "connecting" ? (
            <Wifi className="h-3 w-3 text-yellow-500 animate-pulse" />
          ) : (
            <WifiOff className="h-3 w-3 text-destructive" />
          )}
          <span>{wsStatus === "connected" ? "Live" : wsStatus === "connecting" ? "..." : "Off"}</span>
        </div>

        <div
          className="flex items-center gap-1 px-2 py-1 rounded bg-background border text-[10px] text-muted-foreground"
          title={llmStatus.status === "connected" ? llmStatus.model : "LLM not connected"}
        >
          <Brain
            className={`h-3 w-3 ${
              llmStatus.status === "connected"
                ? "text-emerald-500"
                : llmStatus.status === "disabled"
                  ? "text-yellow-500"
                  : "text-muted-foreground"
            }`}
          />
          <span>LLM {llmStatus.status === "connected" ? "" : "off"}</span>
        </div>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Theme toggle */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <Sun className="h-3.5 w-3.5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-3.5 w-3.5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>Light</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>Dark</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>System</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
