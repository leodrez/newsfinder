import Parser from "rss-parser"
const parser = new Parser({ timeout: 15000, headers: { "User-Agent": "NewsFinder/2.0" } })

const feeds = [
  ["Reuters Business", "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best"],
  ["CNBC Top News", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"],
  ["CNBC World News", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362"],
  ["MarketWatch Top Stories", "https://feeds.marketwatch.com/marketwatch/topstories/"],
  ["MarketWatch Market Pulse", "https://feeds.marketwatch.com/marketwatch/marketpulse/"],
  ["Yahoo Finance", "https://finance.yahoo.com/news/rssindex"],
  ["Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"],
]
const now = Date.now()
for (const [name, url] of feeds) {
  try {
    const feed = await parser.parseURL(url)
    const items = feed.items || []
    const dated = items.map(i => i.pubDate ? new Date(i.pubDate).getTime() : NaN).filter(Number.isFinite).sort((a,b)=>b-a)
    const newest = dated.length ? dated[0] : null
    const ageH = newest ? ((now - newest)/3600000).toFixed(1) : "n/a"
    console.log(`OK    ${name.padEnd(26)} items=${String(items.length).padStart(3)}  newest=${newest?new Date(newest).toISOString():"none"}  (${ageH}h ago)`)
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(26)} ${String(e.message||e).slice(0,80)}`)
  }
}
