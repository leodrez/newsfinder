/**
 * The fields of a SpeechSynthesisVoice this ranking needs. Declared here rather
 * than importing the DOM type so the logic stays testable outside a browser.
 */
export interface VoiceDescriptor {
  name: string
  lang: string
  localService: boolean
  default: boolean
}

/**
 * macOS ships these alongside its real voices. They are sound effects — a
 * market brief read by Zarvox is not a feature — and the set is fixed, so
 * naming them is safer than guessing at a pattern.
 */
const NOVELTY_VOICES = new Set([
  "albert",
  "bad news",
  "bahh",
  "bells",
  "boing",
  "bubbles",
  "cellos",
  "deranged",
  "good news",
  "hysterical",
  "jester",
  "organ",
  "pipe organ",
  "superstar",
  "trinoids",
  "whisper",
  "wobble",
  "zarvox",
])

/** Apple's downloadable tiers and the neural voices other platforms expose. */
const PREMIUM = /\b(premium|enhanced|neural|siri)\b/i

/** Strips the "(English (United States))" suffix macOS appends to some names. */
function baseName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase()
}

function isNovelty(voice: VoiceDescriptor): boolean {
  return NOVELTY_VOICES.has(baseName(voice.name))
}

/** Lower sorts first. */
function rank(voice: VoiceDescriptor): number {
  if (PREMIUM.test(voice.name)) return 0
  // Chrome's remote Google voices are a clear step up from the older local ones.
  if (/^google\b/i.test(voice.name)) return 1
  if (voice.default) return 2
  if (voice.lang === "en-US") return 3
  return 4
}

/**
 * English voices worth offering, best first. Everything the picker and the
 * default both use flows through here, so the list and the automatic choice can
 * never disagree.
 */
export function rankVoices(voices: VoiceDescriptor[]): VoiceDescriptor[] {
  return voices
    .filter((v) => v.lang.startsWith("en") && !isNovelty(v))
    .sort((a, b) => {
      const byRank = rank(a) - rank(b)
      if (byRank !== 0) return byRank
      const byLocale = Number(a.lang !== "en-US") - Number(b.lang !== "en-US")
      if (byLocale !== 0) return byLocale
      return a.name.localeCompare(b.name)
    })
}

/** Name of the best available voice, or null when none is usable. */
export function pickDefaultVoice(voices: VoiceDescriptor[]): string | null {
  return rankVoices(voices)[0]?.name ?? null
}

/**
 * The voice to actually speak with. A stored choice that has since been
 * uninstalled falls back to the ranked default rather than leaving the button
 * silent.
 */
export function resolveVoice(
  voices: VoiceDescriptor[],
  storedName: string | null
): string | null {
  const usable = rankVoices(voices)
  const stored = storedName ? usable.find((v) => v.name === storedName) : undefined
  return stored?.name ?? usable[0]?.name ?? null
}
