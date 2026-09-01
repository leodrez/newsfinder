import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

const API_BASE = import.meta.env.VITE_API_URL ?? ""

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" }
}

export interface GammaStrike {
  strike: number
  gex: number
}

export interface GammaComponent {
  /** Cboe's symbol for the chain, e.g. "^NDX" or "QQQ". */
  symbol: string
  /** Factor this chain's strikes were scaled by to reach the base axis. */
  strikeRatio: number
  netGex: number
  contractsCounted: number
}

export interface GammaSnapshot {
  spot: number
  netGex: number
  flipStrike: number | null
  topStrikes: GammaStrike[]
  regime: "mean-reversion" | "trending"
  contractsCounted: number
  strikesCounted: number
  /** Per-chain contributions; one entry for a single-chain index like SPX. */
  components?: GammaComponent[]
  /** When Cboe built the chain (epoch ms), or null if it carried no stamp. */
  quoteTs?: number | null
  /** Last trade in the underlying (epoch ms), or null if it carried no stamp. */
  lastTradeTs?: number | null
  /** Seconds the quotes lag the tape. Null when either stamp is missing. */
  quoteDelaySec?: number | null
}

export interface OvernightQuote {
  symbol: string
  label: string
  group: "futures" | "rates" | "global" | "commods" | "vol"
  last: number
  anchor: number
  change: number
  changePct: number
  /**
   * Set by lib/market-data.ts when the prior RTH close was unavailable and
   * chartPreviousClose was substituted. That can flip the sign of the move, so
   * the board footnotes the row rather than showing it as a clean reading.
   */
  anchorFallback?: boolean
}

export interface MarketBrief {
  generated_ts: number
  window_start_ts: number
  window_end_ts: number
  summary: string
  sentiment: number
  payload: {
    quotes: OvernightQuote[]
    /** S&P 500 (SPX). */
    gamma: GammaSnapshot | null
    /** Nasdaq 100 (NDX + QQQ). Absent from briefs generated before it existed. */
    gammaNq?: GammaSnapshot | null
    keyDrivers: Array<{ headline: string; why: string }>
    riskEvents: string[]
    sentimentLabel: string
    headlineCount: number
    errors: {
      quotes?: Record<string, string>
      gamma?: string
      gammaNq?: string
      summary?: string
    }
  }
}

export type BriefStatus = "idle" | "loading" | "error"

export function useBrief() {
  const [brief, setBrief] = useState<MarketBrief | null>(null)
  const [status, setStatus] = useState<BriefStatus>("loading")
  const [error, setError] = useState<string | null>(null)

  // Serve the cached brief on mount so switching tabs is instant.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/brief`, { headers: await authHeaders() })
        if (!res.ok) throw new Error(`Could not load the cached brief (HTTP ${res.status})`)
        const data = await res.json()
        if (!cancelled) {
          setBrief(data.brief ?? null)
          setStatus("idle")
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
          setStatus("error")
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const refetch = useCallback(async () => {
    setStatus("loading")
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/brief`, {
        method: "POST",
        headers: await authHeaders(),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Generation failed (HTTP ${res.status})`)
      setBrief(data.brief)
      setStatus("idle")
    } catch (err) {
      // Keep the previous brief on screen; surface the reason alongside it.
      setError((err as Error).message)
      setStatus("error")
    }
  }, [])

  return { brief, status, error, refetch }
}
