import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getAuthUser } from "../lib/auth"
import { generateBrief, getLatestBrief } from "../lib/brief"

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
      const brief = await generateBrief()
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
