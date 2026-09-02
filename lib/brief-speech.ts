import type { BriefDriver } from "./types"

/**
 * Only the parts of a brief that are spoken. Narrower than MarketBrief on
 * purpose: the frontend's own brief type carries optional fields that make it
 * unassignable to the server's, and speech needs none of them.
 */
export interface SpeakableBrief {
  summary: string
  payload: {
    keyDrivers: BriefDriver[]
    riskEvents: string[]
    errors: { summary?: string }
  }
}

/**
 * Chrome silently truncates a single utterance after roughly fifteen seconds
 * of speech, so the brief is queued as many short utterances rather than one
 * long one. This cap is comfortably inside that limit at any speaking rate.
 */
export const MAX_UTTERANCE_CHARS = 180

/**
 * Sentence boundary: a terminator, whitespace, then a capital. The negative
 * lookbehind keeps "U.S. Stocks" from reading as two sentences, which is the
 * common failure in market prose.
 */
const SENTENCE_BOUNDARY = /(?<![A-Z]\.)(?<=[.!?])\s+(?=[A-Z"'])/

/**
 * A synthesizer reads market shorthand literally: "$1.2bn" becomes "bee enn"
 * and "-0.4%" becomes "dash". Expanding it first is what makes the brief sound
 * spoken rather than parsed.
 */
function speakable(text: string): string {
  return text
    .replace(/\$\s?([\d,.]+)\s?bn\b/gi, "$1 billion dollars")
    .replace(/\$\s?([\d,.]+)\s?tn\b/gi, "$1 trillion dollars")
    .replace(/\$\s?([\d,.]+)\s?m\b/gi, "$1 million dollars")
    .replace(/\$\s?([\d,.]+)\s?k\b/gi, "$1 thousand dollars")
    .replace(/([\d,.]+)\s?bps\b/gi, "$1 basis points")
    .replace(/-\s?([\d,.]+)\s?%/g, "down $1 percent")
    .replace(/\+\s?([\d,.]+)\s?%/g, "up $1 percent")
    .replace(/([\d,.]+)\s?%/g, "$1 percent")
    // An em dash is a visual pause; spoken, it is a stumble.
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Splits at the last space inside the cap, so no word is cut in half. */
function splitLongChunk(text: string): string[] {
  const chunks: string[] = []
  let rest = text

  while (rest.length > MAX_UTTERANCE_CHARS) {
    const window = rest.slice(0, MAX_UTTERANCE_CHARS)
    const breakAt = window.lastIndexOf(" ")
    const cut = breakAt > 0 ? breakAt : MAX_UTTERANCE_CHARS
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }

  if (rest) chunks.push(rest)
  return chunks
}

/** One utterance per sentence, further split if a sentence is itself too long. */
function toUtterances(text: string): string[] {
  const prepared = speakable(text)
  if (!prepared) return []
  return prepared
    .split(SENTENCE_BOUNDARY)
    .flatMap((sentence) => splitLongChunk(sentence.trim()))
    .filter(Boolean)
}

/** Adds terminal punctuation so the synthesizer falls rather than trails. */
function asSentence(text: string): string {
  const trimmed = speakable(text)
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Renders a brief as an ordered queue of utterances. A section with nothing
 * behind it is skipped entirely rather than announced and left silent, so a
 * failed summary or an empty calendar is never spoken as a header alone.
 */
export function briefToSpeech(brief: SpeakableBrief): string[] {
  const { keyDrivers, riskEvents, errors } = brief.payload
  const spoken: string[] = []

  const summary = errors.summary ? "" : brief.summary?.trim()
  if (summary) {
    spoken.push("Overnight summary.", ...toUtterances(summary))
  }

  if (keyDrivers.length) {
    spoken.push("Key drivers.")
    for (const driver of keyDrivers) {
      const line = driver.why ? `${driver.headline}, ${driver.why}` : driver.headline
      spoken.push(...splitLongChunk(asSentence(line)))
    }
  }

  if (riskEvents.length) {
    spoken.push("Still ahead today.")
    for (const event of riskEvents) {
      spoken.push(...splitLongChunk(asSentence(event)))
    }
  }

  return spoken
}
