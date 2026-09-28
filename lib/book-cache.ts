import { readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GammaBooks } from "./gamma"

/**
 * A file cache for the priced gamma books. `vercel dev` runs each request in a
 * fresh process, so an in-memory cache would never hit and every live refresh
 * would re-download ~25MB of Cboe chains. The priced books are small (a few
 * MB of plain numbers) and change only when Cboe rebuilds.
 */
export const DEFAULT_BOOK_CACHE_PATH = join(tmpdir(), "newsfinder-gamma-books.json")

interface CacheFile {
  at: number
  books: GammaBooks
}

export async function readBookCache(path: string, nowMs: number, ttlMs: number): Promise<GammaBooks | null> {
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as CacheFile
    if (typeof file?.at !== "number" || nowMs - file.at > ttlMs || nowMs < file.at) return null
    return file.books
  } catch {
    return null
  }
}

/** Writes via a temp file and rename, so a concurrent reader never sees half a file. */
export async function writeBookCache(path: string, books: GammaBooks, nowMs: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ at: nowMs, books } satisfies CacheFile))
  await rename(tmp, path)
}
