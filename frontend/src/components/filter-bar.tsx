import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

type FilterValue = "all" | "high" | "medium" | "low"

interface FilterBarProps {
  filter: FilterValue
  onFilterChange: (value: FilterValue) => void
  totalCount: number
}

export function FilterBar({ filter, onFilterChange, totalCount }: FilterBarProps) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-1.5 bg-card">
      <ToggleGroup
        type="single"
        value={filter}
        onValueChange={(v) => {
          if (v) onFilterChange(v as FilterValue)
        }}
        size="sm"
        className="gap-1"
      >
        <ToggleGroupItem value="all" className="text-xs h-7 px-2.5">
          All
        </ToggleGroupItem>
        <ToggleGroupItem value="high" className="text-xs h-7 px-2.5">
          High Impact
        </ToggleGroupItem>
        <ToggleGroupItem value="medium" className="text-xs h-7 px-2.5">
          Medium
        </ToggleGroupItem>
        <ToggleGroupItem value="low" className="text-xs h-7 px-2.5">
          Low
        </ToggleGroupItem>
      </ToggleGroup>
      <span className="ml-auto text-xs text-muted-foreground">
        {totalCount} headline{totalCount !== 1 ? "s" : ""}
      </span>
    </div>
  )
}
