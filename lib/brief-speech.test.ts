import test from "node:test"
import assert from "node:assert"
import { MAX_UTTERANCE_CHARS, briefToSpeech } from "./brief-speech.ts"
import type { MarketBrief } from "./types.ts"

function makeBrief(overrides: Partial<MarketBrief["payload"]> & { summary?: string } = {}): MarketBrief {
  const { summary, ...payload } = overrides
  return {
    generated_ts: 1787927400,
    window_start_ts: 1787900000,
    window_end_ts: 1787927400,
    summary: summary ?? "Stocks fell overnight.",
    sentiment: -20,
    payload: {
      quotes: [],
      gamma: null,
      gammaNq: null,
      keyDrivers: [],
      riskEvents: [],
      sentimentLabel: "risk-off",
      headlineCount: 3,
      errors: {},
      ...payload,
    },
  }
}

test("reads the summary under a spoken section header", () => {
  const spoken = briefToSpeech(makeBrief({ summary: "Stocks fell overnight." }))
  assert.deepEqual(spoken, ["Overnight summary.", "Stocks fell overnight."])
})

test("stays silent about a summary that failed to generate", () => {
  const spoken = briefToSpeech(
    makeBrief({ summary: "", errors: { summary: "Summary unavailable: no key" } })
  )
  assert.deepEqual(spoken, [], "no header for a section with nothing behind it")
})

test("speaks a driver's reasoning as a pause rather than a dash", () => {
  const spoken = briefToSpeech(
    makeBrief({
      summary: "",
      keyDrivers: [{ headline: "Fed holds rates", why: "no cut signalled" }],
    })
  )
  assert.deepEqual(spoken, ["Key drivers.", "Fed holds rates, no cut signalled."])
})

test("speaks a driver with no reasoning as just the headline", () => {
  const spoken = briefToSpeech(
    makeBrief({ summary: "", keyDrivers: [{ headline: "Fed holds rates", why: "" }] })
  )
  assert.deepEqual(spoken, ["Key drivers.", "Fed holds rates."])
})

test("announces the events still ahead", () => {
  const spoken = briefToSpeech(
    makeBrief({ summary: "", riskEvents: ["CPI at 08:30 ET", "Powell speaks at 14:00 ET"] })
  )
  assert.deepEqual(spoken, [
    "Still ahead today.",
    "CPI at 08:30 ET.",
    "Powell speaks at 14:00 ET.",
  ])
})

test("orders the brief as summary, then drivers, then what is ahead", () => {
  const spoken = briefToSpeech(
    makeBrief({
      summary: "Stocks fell.",
      keyDrivers: [{ headline: "Fed holds", why: "" }],
      riskEvents: ["CPI at 08:30 ET"],
    })
  )
  assert.deepEqual(spoken, [
    "Overnight summary.",
    "Stocks fell.",
    "Key drivers.",
    "Fed holds.",
    "Still ahead today.",
    "CPI at 08:30 ET.",
  ])
})

test("says nothing at all for a brief with no content", () => {
  assert.deepEqual(briefToSpeech(makeBrief({ summary: "" })), [])
})

test("expands money abbreviations that would otherwise be spelled out", () => {
  const spoken = briefToSpeech(makeBrief({ summary: "Dealers hold $1.23bn of gamma." }))
  assert.deepEqual(spoken, ["Overnight summary.", "Dealers hold 1.23 billion dollars of gamma."])
})

test("speaks a signed percentage as a direction", () => {
  const spoken = briefToSpeech(makeBrief({ summary: "ES -0.4% and NQ +1.2% overnight." }))
  assert.deepEqual(spoken, ["Overnight summary.", "ES down 0.4 percent and NQ up 1.2 percent overnight."])
})

test("expands basis points", () => {
  const spoken = briefToSpeech(makeBrief({ summary: "Yields rose 5bps." }))
  assert.deepEqual(spoken, ["Overnight summary.", "Yields rose 5 basis points."])
})

test("splits long text into utterances Chrome will not truncate", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about the market.`).join(" ")
  const spoken = briefToSpeech(makeBrief({ summary: long }))
  assert.ok(spoken.length > 2, "a long summary must be chunked, not sent as one utterance")
  for (const chunk of spoken) {
    assert.ok(
      chunk.length <= MAX_UTTERANCE_CHARS,
      `"${chunk.slice(0, 40)}…" is ${chunk.length} chars, over the ${MAX_UTTERANCE_CHARS} cap`
    )
  }
})

test("does not mistake an abbreviation for the end of a sentence", () => {
  const spoken = briefToSpeech(makeBrief({ summary: "U.S. Stocks fell. Europe held." }))
  assert.deepEqual(spoken, ["Overnight summary.", "U.S. Stocks fell.", "Europe held."])
})
