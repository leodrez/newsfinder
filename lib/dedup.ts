import { createHash } from "crypto"
import { getSupabase } from "./supabase"
import type { Headline } from "./types"

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[a-z0-9 ._-]{2,24}:\s+/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function hashTitle(title: string): string {
  const normalized = normalizeTitle(title)
  return createHash("md5").update(normalized).digest("hex")
}

/**
 * Returns only headlines whose title hash has not been seen within the dedup
 * TTL window.
 *
 * Uses Supabase upsert with ignoreDuplicates — only newly inserted rows are
 * returned, which tells us exactly which headlines are new.
 *
 * Stale hashes are purged separately by `runCleanupIfDue` (see lib/cleanup.ts).
 */
export async function filterNew(headlines: Headline[]): Promise<Headline[]> {
  if (!headlines.length) return []

  const supabase = getSupabase()
  const headlineHashes = headlines.map((headline) => ({ headline, hash: hashTitle(headline.title) }))
  const entries = Array.from(new Set(headlineHashes.map((h) => h.hash))).map((hash) => ({ hash }))

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
  const returnedHashes = new Set<string>()

  return headlineHashes
    .filter(({ hash }) => {
      if (!newHashes.has(hash) || returnedHashes.has(hash)) return false
      returnedHashes.add(hash)
      return true
    })
    .map(({ headline }) => headline)
}
