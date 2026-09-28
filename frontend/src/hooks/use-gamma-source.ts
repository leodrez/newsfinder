import { useCallback, useEffect, useState } from "react"
import { API_BASE, authHeaders } from "@/hooks/use-brief"
import type { GammaSnapshot, GammaSourceChoice } from "@/hooks/use-brief"

const STORAGE_KEY = "newsfinder.gammaSource"
/** The Cboe book is cached server-side, so a refresh only re-reads the IB quote. */
const POLL_MS = 60_000

export interface IbAvailability {
  status: "checking" | "available" | "unavailable"
  reason?: string
}

export interface LiveGamma {
  gamma: GammaSnapshot | null
  gammaNq: GammaSnapshot | null
  errors: { gamma?: string; gammaNq?: string; gammaLive?: string }
  fetchedAt: number
}

function readPreference(): GammaSourceChoice {
  try {
    return localStorage.getItem(STORAGE_KEY) === "ib" ? "ib" : "cboe"
  } catch {
    return "cboe"
  }
}

function writePreference(choice: GammaSourceChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Private window or blocked storage: the choice just won't survive a reload.
  }
}

/**
 * The gamma panel's spot source. "ib" is only effective when the API reports
 * a reachable IB Gateway, which it only ever does when the app runs locally;
 * otherwise the panel stays on the brief's Cboe reading and says why.
 */
export function useGammaSource() {
  const [preferred, setPreferred] = useState<GammaSourceChoice>(readPreference)
  const [ib, setIb] = useState<IbAvailability>({ status: "checking" })
  const [live, setLive] = useState<LiveGamma | null>(null)
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function probe() {
      try {
        const res = await fetch(`${API_BASE}/api/gamma?probe=1`, { headers: await authHeaders() })
        if (!res.ok) throw new Error(`IB check failed (HTTP ${res.status})`)
        const data = (await res.json()) as { ib: { available: boolean; reason?: string } }
        if (!cancelled) {
          setIb(data.ib.available ? { status: "available" } : { status: "unavailable", reason: data.ib.reason })
        }
      } catch (err) {
        if (!cancelled) setIb({ status: "unavailable", reason: (err as Error).message })
      }
    }
    probe()
    return () => {
      cancelled = true
    }
  }, [])

  const source: GammaSourceChoice = preferred === "ib" && ib.status === "available" ? "ib" : "cboe"

  const refreshLive = useCallback(async () => {
    setLiveLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/gamma?source=ib`, { headers: await authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Live gamma failed (HTTP ${res.status})`)
      setLive(data as LiveGamma)
      setLiveError(null)
    } catch (err) {
      // Keep the last live reading on screen; its timestamp shows its age.
      setLiveError((err as Error).message)
    } finally {
      setLiveLoading(false)
    }
  }, [])

  useEffect(() => {
    if (source !== "ib") {
      setLive(null)
      setLiveError(null)
      return
    }
    refreshLive()
    const id = setInterval(refreshLive, POLL_MS)
    return () => clearInterval(id)
  }, [source, refreshLive])

  const setSource = useCallback((choice: GammaSourceChoice) => {
    setPreferred(choice)
    writePreference(choice)
  }, [])

  return { preferred, source, setSource, ib, live, liveLoading, liveError, refreshLive }
}
