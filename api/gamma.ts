import type { VercelRequest, VercelResponse } from "@vercel/node"
import { getAuthUser } from "../lib/auth"
import { getGammaSet, parseGammaSource, probeIb } from "../lib/gamma-source"

/**
 * GET /api/gamma?probe=1        → { ib: { available, reason? } }
 * GET /api/gamma?source=cboe|ib → a fresh gamma reading for both indices
 *
 * The live panel polls the second form; it reuses the priced Cboe book for a
 * few minutes and only the spot is re-read.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end()

  const user = await getAuthUser(req)
  if (!user) return res.status(401).json({ error: "Unauthorized" })
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" })

  if (req.query.probe) {
    return res.status(200).json({ ib: await probeIb() })
  }

  const source = parseGammaSource(req.query.source)
  try {
    const set = await getGammaSet(source, { useCache: true })
    return res.status(200).json({
      source: set.source,
      gamma: set.spx,
      gammaNq: set.nq,
      errors: { gamma: set.errors.spx, gammaNq: set.errors.nq, gammaLive: set.liveError },
      fetchedAt: Date.now(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[gamma] Fetch failed:", message)
    return res.status(502).json({ error: message })
  }
}
