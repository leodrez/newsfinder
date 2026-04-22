import Anthropic from "@anthropic-ai/sdk"
import { LLM_MODEL, LLM_MAX_BATCH } from "./config"
import type { Headline, ScoredHeadline } from "./types"

const SYSTEM_PROMPT =
  "You are a day-trading news assistant. The trader tells you their current " +
  "market focus. For each headline, assess relevance and potential market impact.\n\n" +
  "Respond with a JSON array (one object per headline) in this exact format:\n" +
  '[{"relevance": <0-10>, "impact": "<high|medium|low|none>", "summary": "<brief context or empty string>"}]\n\n' +
  "Rules:\n" +
  "- relevance 8-10: directly moves the trader's market right now\n" +
  "- relevance 4-7: related sector/macro news, indirect impact\n" +
  "- relevance 0-3: unrelated or stale\n" +
  "- summary: only add if the headline is ambiguous and needs context (keep under 15 words), otherwise empty string\n" +
  "- Return ONLY the JSON array, no markdown fences or explanation"

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
      messages: [{ role: "user", content: userMsg }],
    })

    let text = (resp.content[0] as { type: "text"; text: string }).text.trim()
    // Strip markdown fences if the model adds them despite instructions
    if (text.startsWith("```")) {
      text = text.split("\n").slice(1).join("\n")
      if (text.endsWith("```")) text = text.slice(0, text.lastIndexOf("```"))
    }

    const scores = JSON.parse(text) as Array<{
      relevance: number
      impact: string
      summary: string
    }>

    return batch.map((h, i) => ({
      ...h,
      relevance: Math.round(scores[i]?.relevance ?? 5),
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
