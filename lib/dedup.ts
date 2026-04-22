import { createHash } from "crypto"
import { getSupabase } from "./supabase"
import type { Headline } from "./types"

function hashTitle(title: string): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim()
  return createHash("md5").update(normalized).digest("hex")
}

/**
 * Returns only headlines whose title hash has not been seen in the last 24h.
 *
 * Uses Supabase upsert with ignoreDuplicates — only newly inserted rows are
 * returned, which tells us exactly which headlines are new.
 *
 * Also purges hashes older than 24h each run (replaces Redis TTL).
 */
export async function filterNew(headlines: Headline[]): Promise<Headline[]> {
  if (!headlines.length) return []

  const supabase = getSupabase()
  const entries = headlines.map((h) => ({ hash: hashTitle(h.title) }))

  // Insert all hashes. ignoreDuplicates means existing ones are silently skipped.
  // .select() returns only the rows that were actually inserted (i.e. new ones).
  const { data, error } = await supabase
    .from("headline_dedup")
    .upsert(entries, { onConflict: "hash", ignoreDuplicates: true })
    .select("hash")

  if (error) {
    console.warn("[dedup] Supabase error:", error.message)
    return headlines // fail open — better to process duplicates than drop everything
  }

  const newHashes = new Set((data ?? []).map((r: { hash: string }) => r.hash))

  // Purge stale entries (replaces the 24h Redis TTL)
  await supabase
    .from("headline_dedup")
    .delete()
    .lt("created_at", new Date(Date.now() - 86400_000).toISOString())

  return headlines.filter((h) => newHashes.has(hashTitle(h.title)))
}
