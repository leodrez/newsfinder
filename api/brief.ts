import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getAuthUser } from "../lib/auth"
import { generateBrief, getLatestBrief } from "../lib/brief"
import { parseGammaSource } from "../lib/gamma-source"

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()

  const user = await getAuthUser(req)
  if (!user) return res.status(401).json({ error: "Unauthorized" })

  if (req.method === "GET") {
    const brief = await getLatestBrief()
    return res.status(200).json({ brief })
  }

  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? safeJson(req.body) : req.body
      const brief = await generateBrief({ gammaSource: parseGammaSource(body?.gammaSource) })
      return res.status(200).json({ brief })
    } catch (err) {
      // Only total news failure reaches here; partial failures ride in payload.errors.
      const message = err instanceof Error ? err.message : String(err)
      console.error("[brief] Generation failed:", message)
      return res.status(502).json({ error: message })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
