import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import type { RealtimeChannel } from "@supabase/supabase-js"

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" }
}

export interface HeadlineItem {
  title: string
  url: string
  source: string
  published_ts: number
  fetched_ts: number
  relevance: number
  impact: "high" | "medium" | "low" | "none"
  summary: string
}

export interface LlmStatus {
  status: "connected" | "disabled" | "unknown"
  model: string
}

type WsStatus = "connecting" | "connected" | "disconnected"

interface UseWebSocketReturn {
  headlines: HeadlineItem[]
  wsStatus: WsStatus
  llmStatus: LlmStatus
  marketFocus: string
  setMarketFocus: (focus: string) => void
  newBatch: HeadlineItem[]
  pollingEnabled: boolean
  setPollingEnabled: (enabled: boolean) => void
}

const API_BASE = import.meta.env.VITE_API_URL ?? ""

export function useWebSocket(): UseWebSocketReturn {
  const [headlines, setHeadlines] = useState<HeadlineItem[]>([])
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting")
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({ status: "unknown", model: "" })
  const [marketFocus, setMarketFocusState] = useState("")
  const [newBatch, setNewBatch] = useState<HeadlineItem[]>([])

  const [pollingEnabled, setPollingEnabledState] = useState(true)

  const channelRef = useRef<RealtimeChannel | null>(null)
  const isFirstLoad = useRef(true)

  // ── Initial bootstrap ──────────────────────────────────────────────────────

  useEffect(() => {
    async function bootstrap() {
      try {
        // Load last 200 headlines directly from Supabase as the signed-in user.
        // Newest first in SQL, then reverse so state matches realtime: oldest → newest, slice(-200) keeps latest.
        const { data: rows, error } = await supabase
          .from("headlines")
          .select("title, url, source, published_ts, fetched_ts, relevance, impact, summary")
          .order("fetched_ts", { ascending: false })
          .limit(200)

        if (error) throw error
        if (rows?.length) {
          setHeadlines([...(rows as HeadlineItem[])].reverse())
        }
        isFirstLoad.current = false

        // Load LLM status, market focus, and polling state from API routes
        const headers = await authHeaders()
        const [statusRes, focusRes, pollingRes] = await Promise.all([
          fetch(`${API_BASE}/api/status`, { headers }),
          fetch(`${API_BASE}/api/focus`, { headers }),
          fetch(`${API_BASE}/api/polling`, { headers }),
        ])
        if (statusRes.ok) {
          const data = await statusRes.json()
          setLlmStatus(data.llm ?? { status: "unknown", model: "" })
        }
        if (focusRes.ok) {
          const data = await focusRes.json()
          setMarketFocusState(data.value ?? "")
        }
        if (pollingRes.ok) {
          const data = await pollingRes.json()
          setPollingEnabledState(data.enabled ?? true)
        }

        setWsStatus("connected")
      } catch (err) {
        console.warn("[bootstrap] Error:", err)
        setWsStatus("disconnected")
      }
    }

    bootstrap()
  }, [])

  // ── Supabase Realtime subscription ─────────────────────────────────────────

  useEffect(() => {
    const channel = supabase
      .channel("headlines-inserts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "headlines" },
        (payload) => {
          const item = payload.new as HeadlineItem
          setHeadlines((prev) => [...prev, item].slice(-200))
          if (!isFirstLoad.current) {
            setNewBatch([item])
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setWsStatus("connected")
        if (status === "TIMED_OUT" || status === "CLOSED" || status === "CHANNEL_ERROR") {
          setWsStatus("disconnected")
        }
      })

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // ── Market focus ────────────────────────────────────────────────────────────

  const setMarketFocus = useCallback((focus: string) => {
    setMarketFocusState(focus)
    authHeaders().then((headers) =>
      fetch(`${API_BASE}/api/focus`, {
        method: "POST",
        headers,
        body: JSON.stringify({ value: focus }),
      }).catch(console.warn)
    )
  }, [])

  // ── Polling toggle ──────────────────────────────────────────────────────────

  const setPollingEnabled = useCallback((enabled: boolean) => {
    const previous = pollingEnabled
    setPollingEnabledState(enabled) // optimistic
    authHeaders()
      .then((headers) =>
        fetch(`${API_BASE}/api/polling`, {
          method: "POST",
          headers,
          body: JSON.stringify({ enabled }),
        })
      )
      .then(async (res) => {
        if (!res.ok) {
          const message = await res.text()
          throw new Error(`Polling update failed (${res.status}): ${message}`)
        }
        const data = await res.json()
        setPollingEnabledState(data.enabled ?? enabled)
      })
      .catch((err) => {
        console.warn("[polling] Failed to update polling state:", err)
        setPollingEnabledState((current) => (current === enabled ? previous : current))
      })
  }, [pollingEnabled])

  return { headlines, wsStatus, llmStatus, marketFocus, setMarketFocus, newBatch, pollingEnabled, setPollingEnabled }
}
