const HOUR_SEC = 3600
const DAY_SEC = 86400
const RTH_CLOSE_HOUR_ET = 16

/** Shortest overnight window the brief will ever summarise. */
export const MIN_WINDOW_SEC = 12 * HOUR_SEC
/** Longest overnight window — keeps a Monday open at 24h, not 65h. */
export const MAX_WINDOW_SEC = 24 * HOUR_SEC

/**
 * Offset in seconds between America/New_York and UTC at `ts`, e.g. -14400 during EDT.
 * Derived from Intl so DST transitions are handled without a tz dependency.
 */
function etOffsetSec(ts: number): number {
  const d = new Date(ts * 1000)
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }))
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }))
  return Math.round((et.getTime() - utc.getTime()) / 1000)
}

/** True if `ts` falls on a Saturday or Sunday in America/New_York. */
function isEtWeekend(ts: number): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date(ts * 1000))
  return weekday === "Sat" || weekday === "Sun"
}

/**
 * Unix seconds of the most recent 16:00 America/New_York at or before `now`,
 * skipping back over Saturday and Sunday to land on the last weekday close.
 */
export function priorRthCloseTs(now: number): number {
  const secondsIntoEtDay = (((now + etOffsetSec(now)) % DAY_SEC) + DAY_SEC) % DAY_SEC
  let close = now - (secondsIntoEtDay - RTH_CLOSE_HOUR_ET * HOUR_SEC)
  if (close > now) close -= DAY_SEC
  while (isEtWeekend(close)) close -= DAY_SEC
  return close
}

/**
 * The overnight window the brief summarises: back to the prior weekday cash
 * close, clamped to [12h, 24h].
 */
export function briefWindow(now: number): { start: number; end: number } {
  const rawSpan = now - priorRthCloseTs(now)
  const span = Math.min(MAX_WINDOW_SEC, Math.max(MIN_WINDOW_SEC, rawSpan))
  return { start: now - span, end: now }
}
