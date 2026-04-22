import Parser from "rss-parser"
import type { Headline } from "./types"

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "NewsFinder/2.0" },
  customFields: {
    item: [["media:content", "mediaContent"]],
  },
})

export async function fetchFeed(name: string, url: string): Promise<Headline[]> {
  try {
    const feed = await parser.parseURL(url)
    const now = Math.floor(Date.now() / 1000)
    return feed.items
      .map((item) => {
        const title = item.title?.trim() ?? ""
        if (!title) return null
        return {
          title,
          url: item.link ?? "",
          source: name,
          published_ts: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : now,
          fetched_ts: now,
        } satisfies Headline
      })
      .filter((h): h is Headline => h !== null)
  } catch (err) {
    console.warn(`[rss] Failed to fetch "${name}":`, err)
    return []
  }
}

export async function fetchAllFeeds(
  feeds: Array<{ name: string; url: string }>
): Promise<Headline[]> {
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f.name, f.url)))
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
}
