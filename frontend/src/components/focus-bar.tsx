import { useCallback, useEffect, useRef } from "react"
import { Input } from "@/components/ui/input"

interface FocusBarProps {
  marketFocus: string
  onFocusChange: (focus: string) => void
}

export function FocusBar({ marketFocus, onFocusChange }: FocusBarProps) {
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
    <div className="flex min-w-0 items-center gap-2 border-b px-4 py-2 bg-card">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
        Focus
      </span>
      <Input
        defaultValue={marketFocus}
        key={marketFocus}
        onChange={(e) => handleFocusInput(e.target.value)}
        placeholder="e.g. S&P 500 futures, NVDA, semiconductor stocks…"
        className="h-8 min-w-0 flex-1 text-sm"
        spellCheck={false}
      />
    </div>
  )
}
