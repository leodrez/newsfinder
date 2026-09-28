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
const MARKET_DATA_REALTIME = 1

/** Gateway status notices (2100-2199), e.g. "market data farm connection is OK". */
const isNotice = (code: number) => code >= 2100 && code < 2200

async function loadStoqey(): Promise<IbModule> {
  return (await import("@stoqey/ib")) as unknown as IbModule
}

/**
 * Opens one short API session, streams the live instruments until each has a
 * price or the timeout passes, then cancels and disconnects. Asks for
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

  const api = new ib.IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId })
  const reqIds = new Map<number, GammaKey>(keys.map((k, i) => [i + 1, k]))
  const ticks = new Map<GammaKey, PriceTicks>(keys.map((k) => [k, {}]))
  const result: IbLiveSpots = { spots: {}, errors: {} }

  return new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const key of keys) {
        if (result.spots[key] || result.errors[key]) continue
        result.errors[key] = `no live ${IB_LIVE_INSTRUMENTS[key].name} price within ${cfg.timeoutMs / 1000}s`
      }
      try {
        for (const reqId of reqIds.keys()) api.cancelMktData(reqId)
        api.disconnect()
      } catch {
        // Already disconnected; nothing to release.
      }
      resolve(result)
    }
    const settled = () => keys.every((k) => result.spots[k] || result.errors[k])
    const timer = setTimeout(finish, cfg.timeoutMs)

    api.on(ib.EventName.error, ((err: Error | string, code: number, reqId: number) => {
      if (isNotice(code)) return
      const message = typeof err === "string" ? err : err?.message ?? String(err)
      const key = reqIds.get(reqId)
      if (key) {
        if (!result.spots[key]) {
          result.errors[key] = `IB ${IB_LIVE_INSTRUMENTS[key].name}: ${message} (code ${code})`
        }
      } else {
        // Session-level failure (refused connection, lost Gateway): every instrument fails.
        const reason = `IB Gateway at ${cfg.host}:${cfg.port}: ${message} (code ${code})`
        for (const k of keys) if (!result.spots[k]) result.errors[k] = reason
      }
      if (settled()) finish()
    }) as never)

    api.on(ib.EventName.tickPrice, ((reqId: number, field: number, price: number) => {
      const key = reqIds.get(reqId)
      if (!key || result.spots[key]) return
      const t = ticks.get(key)!
      if (field === TICK_LAST) t.last = price
      else if (field === TICK_BID) t.bid = price
      else if (field === TICK_ASK) t.ask = price
      else return
      const picked = pickLivePrice(t)
      if (!picked) return
      const inst = IB_LIVE_INSTRUMENTS[key]
      result.spots[key] = { chainSymbol: inst.chainSymbol, price: picked.price, ts: now(), label: `${inst.name} ${picked.kind}` }
      delete result.errors[key]
      if (settled()) finish()
    }) as never)

    api.on(ib.EventName.connected, (() => {
      api.reqMarketDataType(MARKET_DATA_REALTIME)
      for (const [reqId, key] of reqIds) {
        api.reqMktData(reqId, IB_LIVE_INSTRUMENTS[key].contract, "", false, false)
      }
    }) as never)

    try {
      api.connect()
    } catch (err) {
      const reason = `IB Gateway at ${cfg.host}:${cfg.port}: ${(err as Error).message}`
      for (const k of keys) result.errors[k] = reason
      finish()
    }
  })
}
