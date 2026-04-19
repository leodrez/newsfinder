from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Awaitable

import httpx
from bs4 import BeautifulSoup

from collectors.rss import Headline

log = logging.getLogger(__name__)


async def _scrape_finviz(client: httpx.AsyncClient) -> list[Headline]:
    url = "https://finviz.com/news.ashx"
    try:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("Failed to scrape Finviz: %s", exc)
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    now = time.time()
    headlines: list[Headline] = []

    for table in soup.find_all("table", class_="styled-table-new"):
        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            link_tag = cells[1].find("a") if len(cells) > 1 else cells[0].find("a")
            if not link_tag:
                continue
            title = link_tag.get_text(strip=True)
            href = link_tag.get("href", "")
            if title:
                headlines.append(
                    Headline(
                        title=title,
                        url=href,
                        source="Finviz",
                        published_ts=now,
                        fetched_ts=now,
                    )
                )

    return headlines


SCRAPERS = {
    "Finviz News": _scrape_finviz,
}


class WebScraper:
    """Scrapes non-RSS news sources on a fixed interval."""

    def __init__(
        self,
        feeds: list[dict],
        interval: float,
        on_headlines: Callable[[list[Headline]], Awaitable[None]],
    ):
        self._active = [f["name"] for f in feeds if f.get("type") == "scrape" and f["name"] in SCRAPERS]
        self._interval = interval
        self._on_headlines = on_headlines
        self._client = httpx.AsyncClient(
            timeout=15,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        )

    async def run(self) -> None:
        if not self._active:
            log.info("No scrape sources configured, web scraper idle")
            return
        log.info("Web scraper started – tracking %d sources", len(self._active))
        while True:
            headlines: list[Headline] = []
            for name in self._active:
                scraper_fn = SCRAPERS[name]
                try:
                    result = await scraper_fn(self._client)
                    headlines.extend(result)
                except Exception as exc:
                    log.warning("Scraper %s error: %s", name, exc)

            if headlines:
                await self._on_headlines(headlines)

            await asyncio.sleep(self._interval)
