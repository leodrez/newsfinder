from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Awaitable

import feedparser
import httpx

log = logging.getLogger(__name__)


@dataclass
class Headline:
    title: str
    url: str
    source: str
    published_ts: float  # unix timestamp
    fetched_ts: float = field(default_factory=time.time)

    @property
    def id(self) -> str:
        return f"{self.source}:{self.url}"


async def _fetch_feed(
    client: httpx.AsyncClient,
    name: str,
    url: str,
) -> list[Headline]:
    try:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("Failed to fetch %s: %s", name, exc)
        return []

    feed = feedparser.parse(resp.text)
    now = time.time()
    headlines: list[Headline] = []

    for entry in feed.entries:
        published = entry.get("published_parsed") or entry.get("updated_parsed")
        ts = time.mktime(published) if published else now
        link = entry.get("link", "")
        title = entry.get("title", "").strip()
        if not title:
            continue
        headlines.append(Headline(title=title, url=link, source=name, published_ts=ts, fetched_ts=now))

    return headlines


class RSSPoller:
    """Polls a list of RSS feeds on a fixed interval."""

    def __init__(
        self,
        feeds: list[dict],
        interval: float,
        on_headlines: Callable[[list[Headline]], Awaitable[None]],
    ):
        self._feeds = [(f["name"], f["url"]) for f in feeds if f.get("type") == "rss"]
        self._interval = interval
        self._on_headlines = on_headlines
        self._client = httpx.AsyncClient(
            timeout=15,
            headers={"User-Agent": "NewsFinder/1.0"},
        )

    async def run(self) -> None:
        log.info("RSS poller started – tracking %d feeds", len(self._feeds))
        while True:
            headlines: list[Headline] = []
            tasks = [_fetch_feed(self._client, name, url) for name, url in self._feeds]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, list):
                    headlines.extend(result)
                elif isinstance(result, Exception):
                    log.warning("Feed fetch error: %s", result)

            if headlines:
                await self._on_headlines(headlines)

            await asyncio.sleep(self._interval)
