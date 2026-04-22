import * as cheerio from "cheerio"
import type { Headline } from "./types"

const FINVIZ_URL = "https://finviz.com/news.ashx"

async function scrapeFinviz(): Promise<Headline[]> {
  const now = Math.floor(Date.now() / 1000)
  let html: string

  try {
    const res = await fetch(FINVIZ_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } catch (err) {
    console.warn("[scraper] Failed to scrape Finviz:", err)
    return []
  }

  const $ = cheerio.load(html)
  const headlines: Headline[] = []

  $("table.styled-table-new tr").each((_, row) => {
    const cells = $(row).find("td")
    if (cells.length < 2) return
    const link = cells.eq(1).find("a").first()
    const title = link.text().trim()
    const href = link.attr("href") ?? ""
    if (title) {
      headlines.push({ title, url: href, source: "Finviz", published_ts: now, fetched_ts: now })
    }
  })

  return headlines
}

export async function scrapeAll(
  feeds: Array<{ name: string; type: string }>
): Promise<Headline[]> {
  const scrapers: Record<string, () => Promise<Headline[]>> = {
    "Finviz News": scrapeFinviz,
  }

  const active = feeds.filter((f) => f.type === "scrape" && f.name in scrapers)
  if (!active.length) return []

  const results = await Promise.allSettled(active.map((f) => scrapers[f.name]()))
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
}
