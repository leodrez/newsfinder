import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { pickDefaultVoice, rankVoices, resolveVoice } from "@shared/speech-voices"
import type { VoiceDescriptor } from "@shared/speech-voices"

const SUPPORTED = typeof window !== "undefined" && "speechSynthesis" in window

/** Chrome stalls a long queue; resume() is a no-op when nothing is paused. */
const KEEPALIVE_MS = 8000

const VOICE_KEY = "brief.speech.voice"
const RATE_KEY = "brief.speech.rate"

/** Slower than the default 1, which reads market prose too briskly to follow. */
export const DEFAULT_RATE = 0.9
const MIN_RATE = 0.5
const MAX_RATE = 2

/** Reading and writing storage throws outright in some privacy modes. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A preference that cannot be remembered is not worth failing over.
  }
}

export interface SpeechOverride {
  voice?: string
  rate?: number
}

export interface Speech {
  /** False when the browser has no synthesizer, so the caller can hide the control. */
  supported: boolean
  speaking: boolean
  /** Speaks the utterances in order, replacing anything already playing. */
  speak: (utterances: string[], override?: SpeechOverride) => void
  stop: () => void
  /** English voices worth offering, best first. */
  voices: VoiceDescriptor[]
  voice: string | null
  setVoice: (name: string) => void
  rate: number
  setRate: (rate: number) => void
}

function describe(voice: SpeechSynthesisVoice): VoiceDescriptor {
  return {
    name: voice.name,
    lang: voice.lang,
    localService: voice.localService,
    default: voice.default,
  }
}

/**
 * Drives the Web Speech API one utterance at a time rather than handing the
 * browser the whole queue, which keeps stopping unambiguous: a cancel can never
 * be confused with an utterance ending naturally.
 */
export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false)
  const [available, setAvailable] = useState<VoiceDescriptor[]>([])
  const [storedVoice, setStoredVoice] = useState<string | null>(() =>
    SUPPORTED ? readStored(VOICE_KEY) : null
  )
  const [rate, setRateState] = useState<number>(() => {
    const stored = SUPPORTED ? Number(readStored(RATE_KEY)) : NaN
    return stored >= MIN_RATE && stored <= MAX_RATE ? stored : DEFAULT_RATE
  })

  // Bumped on every new request and on stop, so a cancelled chain's callbacks
  // cannot restart the queue that replaced it.
  const generationRef = useRef(0)

  useEffect(() => {
    if (!SUPPORTED) return
    // Chrome populates voices asynchronously and a speak() issued before they
    // load can silently do nothing — the classic "first click is dead" bug.
    // Reading them now, and again when they arrive, both warms that cache and
    // fills the picker.
    const sync = () => setAvailable(window.speechSynthesis.getVoices().map(describe))
    sync()
    window.speechSynthesis.addEventListener("voiceschanged", sync)
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", sync)
      // Leaving the page must not leave the narration running.
      window.speechSynthesis.cancel()
    }
  }, [])

  useEffect(() => {
    if (!SUPPORTED || !speaking) return
    const id = setInterval(() => {
      if (window.speechSynthesis.speaking) window.speechSynthesis.resume()
    }, KEEPALIVE_MS)
    return () => clearInterval(id)
  }, [speaking])

  const voices = useMemo(() => rankVoices(available), [available])
  // A stored voice that has since been uninstalled resolves back to the best
  // available one rather than leaving the button silent.
  const voice = useMemo(() => resolveVoice(available, storedVoice), [available, storedVoice])

  const stop = useCallback(() => {
    if (!SUPPORTED) return
    generationRef.current += 1
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [])

  const speak = useCallback(
    (utterances: string[], override?: SpeechOverride) => {
      if (!SUPPORTED || !utterances.length) return

      // The picker previews a voice in the same tick it selects one, before
      // state has settled, so the chosen values can be passed in directly.
      const wantedVoice = override?.voice ?? voice ?? pickDefaultVoice(available)
      const wantedRate = override?.rate ?? rate
      const match = wantedVoice
        ? window.speechSynthesis.getVoices().find((v) => v.name === wantedVoice)
        : undefined

      window.speechSynthesis.cancel()
      const generation = ++generationRef.current
      setSpeaking(true)

      let index = 0
      const next = () => {
        if (generationRef.current !== generation) return
        if (index >= utterances.length) {
          setSpeaking(false)
          return
        }
        const utterance = new SpeechSynthesisUtterance(utterances[index++])
        if (match) utterance.voice = match
        utterance.rate = wantedRate
        utterance.onend = next
        // Fires as "interrupted" on cancel too; either way this queue is done.
        utterance.onerror = () => {
          if (generationRef.current === generation) setSpeaking(false)
        }
        window.speechSynthesis.speak(utterance)
      }
      next()
    },
    [available, rate, voice]
  )

  const setVoice = useCallback((name: string) => {
    setStoredVoice(name)
    writeStored(VOICE_KEY, name)
  }, [])

  const setRate = useCallback((next: number) => {
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, next))
    setRateState(clamped)
    writeStored(RATE_KEY, String(clamped))
  }, [])

  return { supported: SUPPORTED, speaking, speak, stop, voices, voice, setVoice, rate, setRate }
}
