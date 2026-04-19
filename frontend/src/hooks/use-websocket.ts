import { useCallback, useEffect, useRef, useState } from "react"

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
}

const WS_URL = "ws://localhost:8000/ws"
const RECONNECT_DELAY = 2000

export function useWebSocket(): UseWebSocketReturn {
  const [headlines, setHeadlines] = useState<HeadlineItem[]>([])
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting")
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({ status: "unknown", model: "" })
  const [marketFocus, setMarketFocusState] = useState("")
  const [newBatch, setNewBatch] = useState<HeadlineItem[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstLoad = useRef(true)

  const connect = useCallback(() => {
    setWsStatus("connecting")

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setWsStatus("connected")
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)

      if (msg.type === "headlines") {
        const items: HeadlineItem[] = msg.items
        setHeadlines((prev) => {
          const updated = [...prev, ...items]
          return updated.slice(-200)
        })
        if (!isFirstLoad.current) {
          setNewBatch(items)
        }
        isFirstLoad.current = false
      } else if (msg.type === "llm_status") {
        setLlmStatus({ status: msg.status, model: msg.model })
      } else if (msg.type === "focus") {
        setMarketFocusState(msg.value)
      }
    }

    ws.onclose = () => {
      setWsStatus("disconnected")
      wsRef.current = null
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const setMarketFocus = useCallback((focus: string) => {
    setMarketFocusState(focus)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "set_focus", value: focus }))
    }
  }, [])

  return { headlines, wsStatus, llmStatus, marketFocus, setMarketFocus, newBatch }
}
