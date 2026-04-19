from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from contextlib import asynccontextmanager

import uvicorn
import yaml
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from collectors.rss import Headline, RSSPoller
from collectors.scraper import WebScraper
from processing.dedup import Deduplicator
from processing.llm_filter import LLMFilter, ScoredHeadline

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("newsfinder")

ROOT = Path(__file__).parent
with open(ROOT / "config.yaml") as f:
    CONFIG = yaml.safe_load(f)


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.append(ws)
        log.info("Client connected (%d total)", len(self._connections))

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.remove(ws)
        log.info("Client disconnected (%d total)", len(self._connections))

    async def broadcast(self, data: dict) -> None:
        payload = json.dumps(data)
        dead: list[WebSocket] = []
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections.remove(ws)


manager = ConnectionManager()
dedup = Deduplicator()
llm: LLMFilter | None = None

# Keep a rolling buffer of recent scored headlines for new clients
recent_headlines: list[dict] = []
MAX_RECENT = 200


def _scored_to_dict(sh: ScoredHeadline) -> dict:
    return {
        "title": sh.headline.title,
        "url": sh.headline.url,
        "source": sh.headline.source,
        "published_ts": sh.headline.published_ts,
        "fetched_ts": sh.headline.fetched_ts,
        "relevance": sh.relevance,
        "impact": sh.impact,
        "summary": sh.summary,
    }


async def _on_headlines(headlines: list[Headline]) -> None:
    new = dedup.filter_new(headlines)
    if not new:
        return
    log.info("Processing %d new headlines", len(new))

    if llm:
        scored = await llm.score(new)
    else:
        scored = [
            ScoredHeadline(headline=h, relevance=5, impact="medium", summary="")
            for h in new
        ]

    items = [_scored_to_dict(sh) for sh in scored]

    recent_headlines.extend(items)
    while len(recent_headlines) > MAX_RECENT:
        recent_headlines.pop(0)

    await manager.broadcast({"type": "headlines", "items": items})


@asynccontextmanager
async def lifespan(app: FastAPI):
    global llm
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    llm_cfg = CONFIG.get("llm", {})

    if api_key and api_key != "sk-ant-your-key-here":
        llm = LLMFilter(
            model=llm_cfg.get("model", "claude-haiku-4-5-20241022"),
            api_key=api_key,
            max_batch=llm_cfg.get("max_batch_size", 5),
        )
        if llm.verify():
            default_focus = llm_cfg.get("default_market_focus", "")
            if default_focus:
                llm.market_focus = default_focus
            log.info("LLM filtering enabled (model: %s)", llm._model)
        else:
            log.warning("LLM verification failed – continuing without LLM filtering")
            llm = None
    else:
        log.warning("No ANTHROPIC_API_KEY set – LLM filtering disabled, all headlines scored at 5")

    interval = CONFIG.get("polling_interval_seconds", 20)
    feeds = CONFIG.get("feeds", [])

    rss_poller = RSSPoller(feeds=feeds, interval=interval, on_headlines=_on_headlines)
    scraper = WebScraper(feeds=feeds, interval=interval * 2, on_headlines=_on_headlines)

    rss_task = asyncio.create_task(rss_poller.run())
    scrape_task = asyncio.create_task(scraper.run())

    log.info("NewsFinder running at http://localhost:8000")
    yield

    rss_task.cancel()
    scrape_task.cancel()


app = FastAPI(title="NewsFinder", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)

    # Send recent headlines buffer so the client isn't empty on connect
    if recent_headlines:
        await ws.send_text(json.dumps({"type": "headlines", "items": recent_headlines}))

    # Send LLM status and current market focus
    if llm:
        await ws.send_text(json.dumps({"type": "llm_status", "status": "connected", "model": llm._model}))
        await ws.send_text(json.dumps({"type": "focus", "value": llm.market_focus}))
    else:
        await ws.send_text(json.dumps({"type": "llm_status", "status": "disabled", "model": ""}))

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            if msg.get("type") == "set_focus" and llm:
                llm.market_focus = msg["value"]
                await manager.broadcast({"type": "focus", "value": llm.market_focus})
    except WebSocketDisconnect:
        manager.disconnect(ws)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, log_level="info")
