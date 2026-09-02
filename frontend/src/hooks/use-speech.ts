import { useCallback, useEffect, useRef, useState } from "react"

const SUPPORTED = typeof window !== "undefined" && "speechSynthesis" in window

/** Chrome stalls a long queue; resume() is a no-op when nothing is paused. */
const KEEPALIVE_MS = 8000

export interface Speech {
  /** False when the browser has no synthesizer, so the caller can hide the control. */
  supported: boolean
  speaking: boolean
  /** Speaks the utterances in order, replacing anything already playing. */
  speak: (utterances: string[]) => void
  stop: () => void
}

/**
 * Drives the Web Speech API one utterance at a time rather than handing the
 * browser the whole queue, which keeps stopping unambiguous: a cancel can never
 * be confused with an utterance ending naturally.
 */
export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false)
  // Bumped on every new request and on stop, so a cancelled chain's callbacks
  // cannot restart the queue that replaced it.
  const generationRef = useRef(0)

  useEffect(() => {
    if (!SUPPORTED) return
    // Chrome populates voices asynchronously and a speak() issued before they
    // load can silently do nothing — the classic "first click is dead" bug.
    // Touching getVoices() now, and again when they arrive, warms that cache.
    const warm = () => window.speechSynthesis.getVoices()
    warm()
    window.speechSynthesis.addEventListener("voiceschanged", warm)
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", warm)
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

  const stop = useCallback(() => {
    if (!SUPPORTED) return
    generationRef.current += 1
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [])

  const speak = useCallback((utterances: string[]) => {
    if (!SUPPORTED || !utterances.length) return

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
      utterance.onend = next
      // Fires as "interrupted" on cancel too; either way this queue is done.
      utterance.onerror = () => {
        if (generationRef.current === generation) setSpeaking(false)
      }
      window.speechSynthesis.speak(utterance)
    }
    next()
  }, [])

  return { supported: SUPPORTED, speaking, speak, stop }
}
