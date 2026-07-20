import Anthropic from "@anthropic-ai/sdk"
import { LLM_MODEL, LLM_MAX_BATCH } from "./config"
import type { Headline, ScoredHeadline } from "./types"

const SYSTEM_PROMPT =
  "You are a day-trading news assistant. The trader tells you their current " +
  "market focus. For each headline, assess relevance and potential market impact, " +
  "then call the `record_scores` tool exactly once with one entry per headline, " +
  "in the same order as the headlines were given.\n\n" +
  "Rules:\n" +
  "- relevance 8-10: directly moves the trader's market right now\n" +
  "- relevance 4-7: related sector/macro news, indirect impact\n" +
  "- relevance 0-3: unrelated or stale\n" +
  "- summary: only add if the headline is ambiguous and needs context (keep under 15 words), otherwise empty string"

const SCORING_TOOL = {
  name: "record_scores",
  description: "Record the relevance, impact, and summary for each headline, in order.",
  input_schema: {
    type: "object" as const,
    properties: {
      scores: {
        type: "array",
        description: "One entry per headline, in the same order the headlines were provided.",
        items: {
          type: "object",
          properties: {
            relevance: { type: "integer", description: "0-10 relevance to the trader's focus" },
            impact: { type: "string", enum: ["high", "medium", "low", "none"] },
            summary: { type: "string", description: "Brief context if ambiguous, else empty string" },
          },
          required: ["relevance", "impact", "summary"],
        },
      },
    },
    required: ["scores"],
  },
}

type RawScore = { relevance?: number; impact?: string; summary?: string }

function clampRelevance(value: number | undefined): number {
  if (!Number.isFinite(value)) return 5
  return Math.max(0, Math.min(10, Math.round(value as number)))
}

function fallback(headlines: Headline[]): ScoredHeadline[] {
  return headlines.map((h) => ({ ...h, relevance: 5, impact: "medium" as const, summary: "" }))
}

async function scoreBatch(
  client: Anthropic,
  batch: Headline[],
  marketFocus: string
): Promise<ScoredHeadline[]> {
  const numbered = batch.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join("\n")
  const userMsg = `Market focus: ${marketFocus}\n\nHeadlines:\n${numbered}`

  try {
    const resp = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [SCORING_TOOL],
      tool_choice: { type: "tool", name: "record_scores" },
      messages: [{ role: "user", content: userMsg }],
    })

    // Tool inputs are guaranteed valid JSON by the API — no text parsing needed.
    const toolUse = resp.content.find((b) => b.type === "tool_use")
    const scores = (toolUse?.input as { scores?: RawScore[] } | undefined)?.scores ?? []

    return batch.map((h, i) => ({
      ...h,
      relevance: clampRelevance(scores[i]?.relevance),
      impact: (scores[i]?.impact ?? "medium") as ScoredHeadline["impact"],
      summary: scores[i]?.summary ?? "",
    }))
  } catch (err) {
    console.warn("[llm] Batch scoring failed:", err)
    return fallback(batch)
  }
}

export async function scoreHeadlines(
  headlines: Headline[],
  marketFocus: string
): Promise<ScoredHeadline[]> {
  if (!headlines.length) return []

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === "sk-ant-your-key-here") {
    console.warn("[llm] No API key — using default scores")
    return fallback(headlines)
  }

  if (!marketFocus) {
    return fallback(headlines)
  }

  const client = new Anthropic({ apiKey })

  const batches: Headline[][] = []
  for (let i = 0; i < headlines.length; i += LLM_MAX_BATCH) {
    batches.push(headlines.slice(i, i + LLM_MAX_BATCH))
  }

  const results = await Promise.all(batches.map((batch) => scoreBatch(client, batch, marketFocus)))
  return results.flat()
}
