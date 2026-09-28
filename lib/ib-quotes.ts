import { connect } from "node:net"
import type { GammaKey, LiveSpot } from "./gamma"

/**
 * Live spot prices from a locally running IB Gateway or TWS.
 *
 * Only the price the regime is read at comes from IB. Open interest is set
 * once a day and the zero-gamma level barely moves intraday, so the Cboe book
 * stays the source for both; a live price is what removes the 15-minute lag
 * from "which side of the level is spot on".
 *
 * Deliberately local-only: a Vercel deployment cannot reach a Gateway on the
 * user's machine, and the Gateway's socket can place orders, so it must never
 * be exposed to the internet to make that work.
 */

type Env = Record<string, string | undefined>

export interface IbConfig {
  host: string
  port: number
  clientId: number
  /** How long to wait for every instrument to print a price. */
  timeoutMs: number
}

/**
 * Defaults to IB Gateway's live-account port. The client id is random per
 * connection so a brief and a panel refresh running at once cannot collide
 * (the Gateway rejects a second session with the same id).
 */
export function ibConfigFromEnv(env: Env = process.env): IbConfig {
  const fixedId = Number(env.IB_CLIENT_ID)
  return {
    host: env.IB_GATEWAY_HOST || "127.0.0.1",
    port: Number(env.IB_GATEWAY_PORT) || 4001,
    clientId: Number.isInteger(fixedId) && fixedId > 0 ? fixedId : 900 + Math.floor(Math.random() * 99),
    timeoutMs: Number(env.IB_TIMEOUT_MS) || 4000,
  }
}

/** `vercel dev` sets VERCEL_ENV=development; deployments set production or preview. */
export function isDeployedRuntime(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview"
}

const DEPLOYED_REASON = "IB live data is only available when the app runs locally next to IB Gateway"

interface IbInstrument {
  /** The Cboe chain this price moves; see LiveSpot. */
  chainSymbol: string
  name: string
  contract: { symbol: string; secType: string; exchange: string; currency: string }
}

/**
 * SPX is priced by the index itself. The Nasdaq book is priced through QQQ,
 * one of its own two chains, which needs no futures basis or roll and works
 * without an NDX index subscription.
 */
export const IB_LIVE_INSTRUMENTS: Record<GammaKey, IbInstrument> = {
  spx: {
    chainSymbol: "^SPX",
    name: "SPX index",
    contract: { symbol: "SPX", secType: "IND", exchange: "CBOE", currency: "USD" },
  },
  nq: {
    chainSymbol: "QQQ",
    name: "QQQ",
    contract: { symbol: "QQQ", secType: "STK", exchange: "SMART", currency: "USD" },
  },
}

export interface PriceTicks {
  last?: number
  bid?: number
  ask?: number
}

/** Last trade when there is one; otherwise the midpoint of a sane two-sided quote. */
export function pickLivePrice(t: PriceTicks): { price: number; kind: "last" | "mid" } | null {
  if (t.last != null && t.last > 0) return { price: t.last, kind: "last" }
  if (t.bid != null && t.ask != null && t.bid > 0 && t.ask >= t.bid) {
    return { price: Math.round(((t.bid + t.ask) / 2) * 10000) / 10000, kind: "mid" }
  }
  return null
}

export interface IbProbe {
  available: boolean
  reason?: string
}

/** Whether a Gateway is listening, without opening an API session. */
export async function probeIb(cfg: IbConfig = ibConfigFromEnv(), env: Env = process.env): Promise<IbProbe> {
  if (isDeployedRuntime(env)) return { available: false, reason: DEPLOYED_REASON }
  return new Promise((resolve) => {
    const socket = connect({ host: cfg.host, port: cfg.port })
    const done = (probe: IbProbe) => {
      socket.destroy()
      resolve(probe)
    }
    socket.setTimeout(1000, () => done({ available: false, reason: `No IB Gateway at ${cfg.host}:${cfg.port} (timed out)` }))
    socket.once("connect", () => done({ available: true }))
    socket.once("error", (err) =>
      done({ available: false, reason: `No IB Gateway at ${cfg.host}:${cfg.port} (${(err as Error).message})` })
    )
  })
}

// The slice of @stoqey/ib this module uses; lets tests drive it with a fake.
interface IbApiLike {
  on(event: string, fn: (...args: never[]) => void): unknown
  connect(): unknown
  reqMarketDataType(type: number): void
  reqMktData(reqId: number, contract: unknown, genericTicks: string, snapshot: boolean, regulatory: boolean): void
  cancelMktData(reqId: number): void
  disconnect(): void
}
export interface IbModule {
  IBApi: new (opts: { host: string; port: number; clientId: number }) => IbApiLike
  EventName: { connected: string; error: string; tickPrice: string }
}

export interface IbLiveSpots {
  spots: Partial<Record<GammaKey, LiveSpot>>
  errors: Partial<Record<GammaKey, string>>
}

const TICK_BID = 1
const TICK_ASK = 2
const TICK_LAST = 4
const TICK_CLOSE = 9
const MARKET_DATA_REALTIME = 1

/** Gateway status notices (2100-2199), e.g. "market data farm connection is OK". */
const isNotice = (code: number) => code >= 2100 && code < 2200

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/**
 * Weekdays 09:30-16:00 ET, when the SPX index actually prints. Outside it IB
 * re-sends the last calculated value as "last", which would pass for live.
 * Exchange holidays are not modelled.
 */
export function isRegularSession(ms: number): boolean {
  const parts = new Map(ET_PARTS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  if (parts.get("weekday") === "Sat" || parts.get("weekday") === "Sun") return false
  const minutes = Number(parts.get("hour")) * 60 + Number(parts.get("minute"))
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}

/**
 * The ES quarterly contract month (YYYYMM) that carries the volume: March,
 * June, September, December, rolling eight days before the third-Friday
 * expiry, which is when CME\x27s roll moves liquidity to the next quarter.
 */
export function frontQuarterlyMonth(ms: number): string {
  const d = new Date(ms)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  let year = d.getUTCFullYear()
  let month = Math.ceil((d.getUTCMonth() + 1) / 3) * 3
  for (;;) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    const thirdFriday = 1 + ((5 - firstDow + 7) % 7) + 14
    const roll = Date.UTC(year, month - 1, thirdFriday - 8)
    if (today < roll) return `${year}${String(month).padStart(2, "0")}`
    month += 3
    if (month > 12) {
      month -= 12
      year += 1
    }
  }
}

type RequestName = "spx" | "es" | "qqq"

interface TickState extends PriceTicks {
  close?: number
}

async function loadStoqey(): Promise<IbModule> {
  return (await import("@stoqey/ib")) as unknown as IbModule
}

/**
 * Turns whatever has arrived into live spots. SPX uses the index during the
 * session; outside it, the ES move since its prior settlement, applied to the
 * chain (whose spot then is the index\x27s prior close).
 */
function deriveSpots(ticks: Map<RequestName, TickState>, inSession: boolean, ts: number): IbLiveSpots["spots"] {
  const spots: IbLiveSpots["spots"] = {}
  const spx = ticks.get("spx")!
  const es = ticks.get("es")!
  if (inSession && spx.last != null && spx.last > 0) {
    spots.spx = { chainSymbol: IB_LIVE_INSTRUMENTS.spx.chainSymbol, price: spx.last, ts, label: "SPX index last" }
  } else if (!inSession && es.last != null && es.last > 0 && es.close != null && es.close > 0) {
    spots.spx = {
      chainSymbol: IB_LIVE_INSTRUMENTS.spx.chainSymbol,
      price: 0,
      ratio: es.last / es.close,
      ts,
      label: "ES move since settle",
    }
  }
  const qqq = pickLivePrice(ticks.get("qqq")!)
  if (qqq) {
    spots.nq = { chainSymbol: IB_LIVE_INSTRUMENTS.nq.chainSymbol, price: qqq.price, ts, label: `QQQ ${qqq.kind}` }
  }
  return spots
}

/**
 * Opens one short API session, streams the live instruments until each index
 * has a price or the timeout passes, then cancels and disconnects. Asks for
 * real-time data only: delayed IB data would reintroduce the lag this exists
 * to remove, so a missing subscription is reported rather than papered over.
 */
export async function fetchIbLiveSpots(
  cfg: IbConfig = ibConfigFromEnv(),
  deps: { load?: () => Promise<IbModule>; env?: Env; now?: () => number } = {}
): Promise<IbLiveSpots> {
  const keys = Object.keys(IB_LIVE_INSTRUMENTS) as GammaKey[]
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  if (isDeployedRuntime(env)) {
    return { spots: {}, errors: Object.fromEntries(keys.map((k) => [k, DEPLOYED_REASON])) }
  }

  let ib: IbModule
  try {
    ib = await (deps.load ?? loadStoqey)()
  } catch (err) {
    const reason = `IB client failed to load: ${(err as Error).message}`
    return { spots: {}, errors: Object.fromEntries(keys.map((k) => [k, reason])) }
  }

  const startedAt = now()
  const inSession = isRegularSession(startedAt)
  const requests: Array<{ reqId: number; name: RequestName; label: string; contract: unknown }> = [
    { reqId: 1, name: "spx", label: IB_LIVE_INSTRUMENTS.spx.name, contract: IB_LIVE_INSTRUMENTS.spx.contract },
    {
      reqId: 2,
      name: "es",
      label: "ES",
      contract: {
        symbol: "ES",
        secType: "FUT",
        exchange: "CME",
        currency: "USD",
        lastTradeDateOrContractMonth: frontQuarterlyMonth(startedAt),
      },
    },
    { reqId: 3, name: "qqq", label: IB_LIVE_INSTRUMENTS.nq.name, contract: IB_LIVE_INSTRUMENTS.nq.contract },
  ]
  const byReqId = new Map(requests.map((r) => [r.reqId, r]))
  const ticks = new Map<RequestName, TickState>(requests.map((r) => [r.name, {}]))
  const requestErrors = new Map<RequestName, string>()
  let sessionError: string | null = null

  const api = new ib.IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId })

  return new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try {
        for (const r of requests) api.cancelMktData(r.reqId)
        api.disconnect()
      } catch {
        // Already disconnected; nothing to release.
      }

      const spots = sessionError ? {} : deriveSpots(ticks, inSession, now())
      const errors: IbLiveSpots["errors"] = {}
      const waited = `${cfg.timeoutMs / 1000}s`
      if (!spots.spx) {
        errors.spx =
          sessionError ??
          (inSession
            ? requestErrors.get("spx") ?? `no live SPX index price within ${waited}`
            : `SPX index is not live outside 09:30-16:00 ET and ${
                requestErrors.get("es") ?? `ES had no price and settlement within ${waited}`
              }`)
      }
      if (!spots.nq) errors.nq = sessionError ?? requestErrors.get("qqq") ?? `no live QQQ price within ${waited}`
      resolve({ spots, errors })
    }
    const timer = setTimeout(finish, cfg.timeoutMs)
    const settled = () => {
      const spots = deriveSpots(ticks, inSession, 0)
      const spxDone = spots.spx || requestErrors.has(inSession ? "spx" : "es")
      const nqDone = spots.nq || requestErrors.has("qqq")
      return Boolean(spxDone && nqDone)
    }

    api.on(ib.EventName.error, ((err: Error | string, code: number, reqId: number) => {
      if (finished || isNotice(code)) return
      const message = typeof err === "string" ? err : err?.message ?? String(err)
      const request = byReqId.get(reqId)
      if (request) {
        requestErrors.set(request.name, `IB ${request.label}: ${message} (code ${code})`)
      } else {
        // Session-level failure (refused connection, lost Gateway): nothing is priced.
        sessionError = `IB Gateway at ${cfg.host}:${cfg.port}: ${message} (code ${code})`
        finish()
        return
      }
      if (settled()) finish()
    }) as never)

    api.on(ib.EventName.tickPrice, ((reqId: number, field: number, price: number) => {
      if (finished) return
      const request = byReqId.get(reqId)
      if (!request) return
      const t = ticks.get(request.name)!
      if (field === TICK_LAST) t.last = price
      else if (field === TICK_BID) t.bid = price
      else if (field === TICK_ASK) t.ask = price
      else if (field === TICK_CLOSE) t.close = price
      else return
      if (settled()) finish()
    }) as never)

    api.on(ib.EventName.connected, (() => {
      api.reqMarketDataType(MARKET_DATA_REALTIME)
      for (const r of requests) api.reqMktData(r.reqId, r.contract, "", false, false)
    }) as never)

    try {
      api.connect()
    } catch (err) {
      sessionError = `IB Gateway at ${cfg.host}:${cfg.port}: ${(err as Error).message}`
      finish()
    }
  })
}
