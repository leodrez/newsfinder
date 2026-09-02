import test from "node:test"
import assert from "node:assert"
import { pickDefaultVoice, rankVoices, resolveVoice } from "./speech-voices.ts"
import type { VoiceDescriptor } from "./speech-voices.ts"

function voice(name: string, extra: Partial<VoiceDescriptor> = {}): VoiceDescriptor {
  return { name, lang: "en-US", localService: true, default: false, ...extra }
}

const names = (list: VoiceDescriptor[]) => list.map((v) => v.name)

test("ranks a premium system voice above every other option", () => {
  const ranked = rankVoices([
    voice("Samantha", { default: true }),
    voice("Google US English", { localService: false }),
    voice("Ava (Premium)"),
  ])
  assert.equal(names(ranked)[0], "Ava (Premium)")
})

test("prefers Google US English when no premium voice is installed", () => {
  const ranked = rankVoices([
    voice("Samantha", { default: true }),
    voice("Google US English", { localService: false }),
    voice("Nicky"),
  ])
  assert.equal(names(ranked)[0], "Google US English")
})

test("falls back to the system default when nothing better exists", () => {
  const ranked = rankVoices([voice("Nicky"), voice("Samantha", { default: true })])
  assert.equal(names(ranked)[0], "Samantha")
})

test("drops the macOS novelty voices", () => {
  const ranked = rankVoices([
    voice("Samantha", { default: true }),
    voice("Zarvox"),
    voice("Bad News"),
    voice("Trinoids"),
    voice("Bubbles"),
    voice("Bahh"),
    voice("Wobble"),
    voice("Organ"),
    voice("Jester"),
    voice("Superstar"),
    voice("Whisper"),
    voice("Cellos"),
    voice("Bells"),
    voice("Boing"),
    voice("Good News"),
  ])
  // A market brief read by Zarvox is not a feature.
  assert.deepEqual(names(ranked), ["Samantha"])
})

test("keeps the ordinary character voices that are merely not premium", () => {
  const ranked = rankVoices([voice("Samantha", { default: true }), voice("Rocko"), voice("Flo")])
  assert.deepEqual(names(ranked).sort(), ["Flo", "Rocko", "Samantha"])
})

test("excludes voices that are not English", () => {
  const ranked = rankVoices([
    voice("Samantha", { default: true }),
    voice("Google Nederlands", { lang: "nl-NL", localService: false }),
    voice("Google 日本語", { lang: "ja-JP", localService: false }),
  ])
  assert.deepEqual(names(ranked), ["Samantha"])
})

test("puts en-US ahead of other English locales at the same rank", () => {
  const ranked = rankVoices([voice("Daniel", { lang: "en-GB" }), voice("Nicky", { lang: "en-US" })])
  assert.deepEqual(names(ranked), ["Nicky", "Daniel"])
})

test("picks the top-ranked voice by name", () => {
  assert.equal(
    pickDefaultVoice([voice("Samantha", { default: true }), voice("Ava (Enhanced)")]),
    "Ava (Enhanced)"
  )
})

test("picks nothing when the browser offers no usable voice", () => {
  assert.strictEqual(pickDefaultVoice([]), null)
  assert.strictEqual(pickDefaultVoice([voice("Zarvox")]), null)
})

test("keeps a stored voice that is still installed", () => {
  const available = [voice("Samantha", { default: true }), voice("Nicky")]
  assert.equal(resolveVoice(available, "Nicky"), "Nicky")
})

test("replaces a stored voice that has since disappeared", () => {
  // An uninstalled voice must not leave the button silent.
  const available = [voice("Samantha", { default: true })]
  assert.equal(resolveVoice(available, "Ava (Premium)"), "Samantha")
})

test("falls back to the ranked default when nothing is stored", () => {
  const available = [voice("Nicky"), voice("Samantha", { default: true })]
  assert.equal(resolveVoice(available, null), "Samantha")
})
