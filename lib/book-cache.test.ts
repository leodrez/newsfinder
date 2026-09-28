import test from "node:test"
import assert from "node:assert"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBookCache, writeBookCache } from "./book-cache.ts"
import type { GammaBooks } from "./gamma.ts"

const BOOKS: GammaBooks = {
  spx: { baseSpot: 100, contracts: [], tallies: [] },
  nq: null,
  errors: { nq: "Cboe returned HTTP 503" },
}

test("a written book is read back while it is fresh", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "books-")), "books.json")
  await writeBookCache(path, BOOKS, 1_000)
  assert.deepEqual(await readBookCache(path, 1_000 + 60_000, 300_000), BOOKS)
})

test("a book older than the TTL is not reused", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "books-")), "books.json")
  await writeBookCache(path, BOOKS, 1_000)
  assert.strictEqual(await readBookCache(path, 1_000 + 300_001, 300_000), null)
})

test("a missing or corrupt cache file reads as a miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "books-"))
  assert.strictEqual(await readBookCache(join(dir, "absent.json"), 1_000, 300_000), null)
  writeFileSync(join(dir, "bad.json"), "{not json")
  assert.strictEqual(await readBookCache(join(dir, "bad.json"), 1_000, 300_000), null)
})
