import Anthropic from "@anthropic-ai/sdk"
import { LLM_MODEL } from "./config"
import type { Headline, OvernightQuote, GammaSnapshot, BriefSummary } from "./types"

const MAX_HEADLINES = 120

const SYSTEM_PROMPT =
  "You are writing a pre-market brief for a day trader who trades S&P 500 and " +
  "Nasdaq 100 index futures. They will read this at 09:25 ET, minutes before the " +
  "US cash open. You are given every headline published overnight plus the " +
  "overnight tape. Call the `record_brief` tool exactly once.\n\n" +
  "Rules:\n" +
  "- summary: ONE paragraph, 90-140 words. Lead with what actually moved markets " +
  "overnight and why. Reference the tape where it supports the narrative. Plain " +
  "declarative prose, no bullet points, no preamble, no hedging boilerplate.\n" +
  "- sentiment: -100 (maximally bearish) to +100 (maximally bullish), judged ONLY " +
  "from the news and its market reaction. Use the full range; 0 means genuinely balanced.\n" +
  "- sentiment_label: two or three words, e.g. 'Mildly risk-on', 'Sharply bearish'.\n" +
  "- key_drivers: the 2-4 headlines that actually matter, each with one clause on why.\n" +
  "- risk_events: scheduled catalysts still ahead TODAY (data releases, Fed speakers, " +
  "major earnings). Empty array if none are evident."

const BRIEF_TOOL = {
  name: "record_brief",
  description: "Record the overnight market brief, sentiment, drivers, and upcoming risk events.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "One paragraph, 90-140 words" },
      sentiment: { type: "integer", description: "-100 (bearish) to +100 (bullish)" },
      sentiment_label: { type: "string", description: "Two or three word label" },
      key_drivers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            headline: { type: "string" },
            why: { type: "string", description: "One clause on why it matters" },
          },
          required: ["headline", "why"],
        },
      },
      risk_events: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "sentiment", "sentiment_label", "key_drivers", "risk_events"],
  },
}

interface RawBrief {
  summary?: string
  sentiment?: number
  sentiment_label?: string
  key_drivers?: Array<{ headline?: string; why?: string }>
  risk_events?: string[]
}

function clampSentiment(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-100, Math.min(100, Math.round(value as number)))
}

function renderTape(quotes: OvernightQuote[], gamma: GammaSnapshot | null): string {
  const lines = quotes.map(
    (q) => `${q.label}: ${q.last} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)`
  )
  if (gamma) {
    lines.push(
      `Dealer gamma: net ${(gamma.netGex / 1e9).toFixed(1)}bn per 1% (${gamma.regime}), ` +
        `spot ${gamma.spot}, flip ${gamma.flipStrike ?? "n/a"}`
    )
  }
  return lines.join("\n")
}

export async function summarizeOvernight(
  headlines: Headline[],
  quotes: OvernightQuote[],
  gamma: GammaSnapshot | null
): Promise<BriefSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === "sk-ant-your-key-here") {
    throw new Error("Summary unavailable: ANTHROPIC_API_KEY is not configured")
  }
  if (!headlines.length) {
    throw new Error("Summary unavailable: no headlines were published in the overnight window")
  }

  // Newest first, so the cap drops the stalest items rather than the freshest.
  const ordered = [...headlines].sort((a, b) => b.published_ts - a.published_ts).slice(0, MAX_HEADLINES)
  const numbered = ordered.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join("\n")
  const userMsg = `Overnight tape:\n${renderTape(quotes, gamma)}\n\nOvernight headlines:\n${numbered}`

  const client = new Anthropic({ apiKey })

  let resp
  try {
    resp = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [BRIEF_TOOL],
      tool_choice: { type: "tool", name: "record_brief" },
      messages: [{ role: "user", content: userMsg }],
    })
  } catch (err) {
    throw new Error(`LLM summarization failed: ${(err as Error).message}`)
  }

  const toolUse = resp.content.find((b) => b.type === "tool_use")
  const raw = toolUse?.input as RawBrief | undefined
  if (!raw?.summary) {
    throw new Error("LLM summarization returned no summary")
  }

  return {
    summary: raw.summary,
    sentiment: clampSentiment(raw.sentiment),
    sentimentLabel: raw.sentiment_label ?? "Neutral",
    keyDrivers: (raw.key_drivers ?? [])
      .filter((d) => d.headline)
      .map((d) => ({ headline: d.headline as string, why: d.why ?? "" })),
    riskEvents: raw.risk_events ?? [],
  }
}
