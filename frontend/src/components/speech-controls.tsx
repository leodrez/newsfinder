import { Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Speech } from "@/hooks/use-speech"

/** Short enough to audition a voice without waiting, long enough to judge it. */
const PREVIEW = "Dealers are short gamma, so hedging chases direction."

const SPEEDS = [0.75, 0.9, 1, 1.15, 1.35]

interface SpeechControlsProps {
  speech: Speech
}

export function SpeechControls({ speech }: SpeechControlsProps) {
  if (!speech.voices.length) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="-my-1 h-7 w-7 p-0"
          aria-label="Voice and speed settings"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Voice
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={speech.voice ?? ""}
          // Preview immediately: comparing two voices is the point of the list,
          // and the override speaks the new choice before state has settled.
          onValueChange={(name) => {
            speech.setVoice(name)
            speech.speak([PREVIEW], { voice: name })
          }}
        >
          {speech.voices.map((v) => (
            <DropdownMenuRadioItem key={v.name} value={v.name} className="text-xs">
              <span className="truncate">{v.name}</span>
              {!v.localService && (
                <span className="ml-auto pl-2 text-[9px] uppercase text-muted-foreground">
                  online
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Speed
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(speech.rate)}
          onValueChange={(value) => {
            const next = Number(value)
            speech.setRate(next)
            speech.speak([PREVIEW], { rate: next })
          }}
        >
          {SPEEDS.map((speed) => (
            <DropdownMenuRadioItem key={speed} value={String(speed)} className="text-xs">
              {speed}×{speed === 1 ? " (normal)" : ""}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
