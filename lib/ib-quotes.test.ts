import test from "node:test"
import assert from "node:assert"
import { createServer } from "node:net"
import {
  IB_LIVE_INSTRUMENTS,
  fetchIbLiveSpots,
  ibConfigFromEnv,
  isDeployedRuntime,
  pickLivePrice,
  probeIb,
} from "./ib-quotes.ts"
import type { IbModule } from "./ib-quotes.ts"

test("prefers the last trade, falls back to the bid/ask midpoint", () => {
  assert.deepEqual(pickLivePrice({ last: 7678.62, bid: 0, ask: 0 }), { price: 7678.62, kind: "last" })
  assert.deepEqual(pickLivePrice({ bid: 734.62, ask: 734.64 }), { price: 734.63, kind: "mid" })
  assert.strictEqual(pickLivePrice({ bid: 0, ask: 0 }), null, "SPX index sends zero bid/ask")
  assert.strictEqual(pickLivePrice({ bid: 735, ask: 734 }), null, "a crossed quote is not a price")
  assert.strictEqual(pickLivePrice({}), null)
})

test("only a Vercel deployment counts as deployed", () => {
  assert.equal(isDeployedRuntime({ VERCEL_ENV: "production" }), true)
  assert.equal(isDeployedRuntime({ VERCEL_ENV: "preview" }), true)
  assert.equal(isDeployedRuntime({ VERCEL_ENV: "development" }), false, "vercel dev")
  assert.equal(isDeployedRuntime({}), false)
})

test("reads Gateway settings from the environment with local defaults", () => {
  const defaults = ibConfigFromEnv({})
  assert.equal(defaults.host, "127.0.0.1")
  assert.equal(defaults.port, 4001)
  assert.ok(defaults.clientId >= 900 && defaults.clientId < 1000, "random id avoids clashing sessions")
  const custom = ibConfigFromEnv({ IB_GATEWAY_HOST: "10.0.0.5", IB_GATEWAY_PORT: "4002", IB_CLIENT_ID: "42" })
  assert.deepEqual([custom.host, custom.port, custom.clientId], ["10.0.0.5", 4002, 42])
})

test("the live instruments price the SPX chain and the QQQ chain", () => {
  assert.equal(IB_LIVE_INSTRUMENTS.spx.chainSymbol, "^SPX")
  assert.equal(IB_LIVE_INSTRUMENTS.nq.chainSymbol, "QQQ")
})

// ── A stand-in for @stoqey/ib's IBApi, driven by a script of replies ─────────

type Handler = (...args: unknown[]) => void
interface Script {
  onConnect?: "connected" | { code: number; message: string }
  replies?: Record<string, Array<[number, number] | { code: number; message: string }>>
}

function fakeIb(script: Script, log: string[] = []): IbModule {
  class FakeApi {
    private handlers = new Map<string, Handler[]>()
    constructor(opts: { host: string; port: number; clientId: number }) {
      log.push(`new ${opts.host}:${opts.port}`)
    }
    on(event: string, fn: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    private emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args)
    }
    connect() {
      log.push("connect")
      setTimeout(() => {
        const c = script.onConnect ?? "connected"
        if (c === "connected") this.emit("connected")
        else this.emit("error", new Error(c.message), c.code, -1)
      }, 1)
      return this
    }
    reqMarketDataType(type: number) {
      log.push(`type ${type}`)
    }
    reqMktData(reqId: number, contract: { symbol: string }) {
      log.push(`req ${reqId} ${contract.symbol}`)
      // Informational farm message, as the real Gateway sends: must be ignored.
      setTimeout(() => this.emit("error", new Error("Market data farm connection is OK"), 2104, -1), 1)
      for (const reply of script.replies?.[contract.symbol] ?? []) {
        setTimeout(() => {
          if (Array.isArray(reply)) this.emit("tickPrice", reqId, reply[0], reply[1])
          else this.emit("error", new Error(reply.message), reply.code, reqId)
        }, 2)
      }
    }
    cancelMktData(reqId: number) {
      log.push(`cancel ${reqId}`)
    }
    disconnect() {
      log.push("disconnect")
    }
  }
  return {
    IBApi: FakeApi as unknown as IbModule["IBApi"],
    EventName: { connected: "connected", error: "error", tickPrice: "tickPrice" } as IbModule["EventName"],
  }
}

const CFG = { host: "127.0.0.1", port: 4001, clientId: 917, timeoutMs: 200 }
const LOCAL = {}

test("reads SPX from its last trade and QQQ from its midpoint, then disconnects", async () => {
  const log: string[] = []
  const ib = fakeIb({ replies: { SPX: [[1, 0], [4, 7678.62]], QQQ: [[1, 734.62], [2, 734.64]] } }, log)
  const { spots, errors } = await fetchIbLiveSpots(CFG, { load: async () => ib, env: LOCAL, now: () => 1000 })
  assert.deepEqual(errors, {})
  assert.deepEqual(spots.spx, { chainSymbol: "^SPX", price: 7678.62, ts: 1000, label: "SPX index last" })
  assert.deepEqual(spots.nq, { chainSymbol: "QQQ", price: 734.63, ts: 1000, label: "QQQ mid" })
  assert.ok(log.includes("type 1"), "asks for real-time, never delayed, data")
  assert.ok(log.includes("cancel 1") && log.includes("cancel 2") && log.at(-1) === "disconnect")
})

test("a missing subscription fails only that instrument", async () => {
  const ib = fakeIb({
    replies: {
      SPX: [[4, 7678.62]],
      QQQ: [{ code: 10168, message: "Requested market data is not subscribed." }],
    },
  })
  const { spots, errors } = await fetchIbLiveSpots(CFG, { load: async () => ib, env: LOCAL })
  assert.ok(spots.spx)
  assert.strictEqual(spots.nq, undefined)
  assert.match(errors.nq ?? "", /QQQ.*not subscribed.*10168/)
})

test("an instrument with no price before the timeout is reported, not guessed", async () => {
  const ib = fakeIb({ replies: { SPX: [[4, 7678.62]], QQQ: [[1, 0]] } })
  const { spots, errors } = await fetchIbLiveSpots(CFG, { load: async () => ib, env: LOCAL })
  assert.ok(spots.spx)
  assert.match(errors.nq ?? "", /no live QQQ price within 0\.2s/)
})

test("a refused connection fails every instrument with the Gateway address", async () => {
  const ib = fakeIb({ onConnect: { code: 502, message: "Couldn't connect to TWS." } })
  const { spots, errors } = await fetchIbLiveSpots(CFG, { load: async () => ib, env: LOCAL })
  assert.deepEqual(spots, {})
  assert.match(errors.spx ?? "", /127\.0\.0\.1:4001.*Couldn't connect/)
  assert.equal(errors.nq, errors.spx)
})

test("never loads the IB client on a Vercel deployment", async () => {
  let loaded = false
  const { errors } = await fetchIbLiveSpots(CFG, {
    load: async () => {
      loaded = true
      return fakeIb({})
    },
    env: { VERCEL_ENV: "production" },
  })
  assert.equal(loaded, false)
  assert.match(errors.spx ?? "", /only available when the app runs locally/)
})

test("probe reports a deployment as unavailable without touching the network", async () => {
  const probe = await probeIb(CFG, { VERCEL_ENV: "production" })
  assert.equal(probe.available, false)
  assert.match(probe.reason ?? "", /runs locally/)
})

test("probe distinguishes a listening Gateway from a closed port", async () => {
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  assert.deepEqual(await probeIb({ ...CFG, port }, LOCAL), { available: true })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const closed = await probeIb({ ...CFG, port }, LOCAL)
  assert.equal(closed.available, false)
  assert.match(closed.reason ?? "", new RegExp(`No IB Gateway at 127\\.0\\.0\\.1:${port}`))
})
