import type { SupabaseClient } from "@supabase/supabase-js"
import {
  CONFIG_KEYS,
  CLEANUP_INTERVAL_SEC,
  DEDUP_TTL_SEC,
  HEADLINE_RETENTION_SEC,
} from "./config"

/**
 * Runs housekeeping at most once per CLEANUP_INTERVAL_SEC, regardless of how
 * often polling fires:
 *   - purges `headlines` older than HEADLINE_RETENTION_SEC (by fetched_ts)
 *   - purges `headline_dedup` hashes older than DEDUP_TTL_SEC
 *
 * Throttled via the `last_cleanup_ts` config key so it's near-free on most
 * polls. No pg_cron / paid plan required.
 */
export async function runCleanupIfDue(supabase: SupabaseClient): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  const { data: row } = await supabase
    .from("config")
    .select("value")
    .eq("key", CONFIG_KEYS.lastCleanupTs)
    .single()

  const lastRaw = row?.value
  const lastCleanup = lastRaw ? parseInt(lastRaw, 10) : NaN
  const hasRun = Number.isFinite(lastCleanup) && lastCleanup > 0
  if (hasRun && now - lastCleanup < CLEANUP_INTERVAL_SEC) return

  // Stamp first so overlapping invocations don't both run the deletes.
  await supabase
    .from("config")
    .upsert({ key: CONFIG_KEYS.lastCleanupTs, value: String(now) })

  const retentionCutoff = now - HEADLINE_RETENTION_SEC
  const { error: headlineErr } = await supabase
    .from("headlines")
    .delete()
    .lt("fetched_ts", retentionCutoff)
  if (headlineErr) console.warn("[cleanup] headlines purge error:", headlineErr.message)

  const dedupCutoff = new Date((now - DEDUP_TTL_SEC) * 1000).toISOString()
  const { error: dedupErr } = await supabase
    .from("headline_dedup")
    .delete()
    .lt("created_at", dedupCutoff)
  if (dedupErr) console.warn("[cleanup] dedup purge error:", dedupErr.message)

  console.log(`[cleanup] ran: retention<${retentionCutoff}, dedup<${dedupCutoff}`)
}
