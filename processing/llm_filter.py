from __future__ import annotations

import json
import logging
from dataclasses import dataclass

import anthropic

from collectors.rss import Headline

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a day-trading news assistant. The trader tells you their current "
    "market focus. For each headline, assess relevance and potential market impact.\n\n"
    "Respond with a JSON array (one object per headline) in this exact format:\n"
    '[{"relevance": <0-10>, "impact": "<high|medium|low|none>", "summary": "<brief context or empty string>"}]\n\n'
    "Rules:\n"
    "- relevance 8-10: directly moves the trader's market right now\n"
    "- relevance 4-7: related sector/macro news, indirect impact\n"
    "- relevance 0-3: unrelated or stale\n"
    "- summary: only add if the headline is ambiguous and needs context (keep under 15 words), otherwise empty string\n"
    "- Return ONLY the JSON array, no markdown fences or explanation"
)


@dataclass
class ScoredHeadline:
    headline: Headline
    relevance: int
    impact: str
    summary: str


class LLMFilter:
    def __init__(self, model: str, api_key: str, max_batch: int = 5):
        self._model = model
        self._client = anthropic.Anthropic(api_key=api_key)
        self._max_batch = max_batch
        self._market_focus = ""

    def verify(self) -> bool:
        """Send a tiny request to confirm the API key and model work."""
        try:
            resp = self._client.messages.create(
                model=self._model,
                max_tokens=16,
                messages=[{"role": "user", "content": "Reply with the word OK."}],
            )
            text = resp.content[0].text.strip()
            log.info("Anthropic connection verified (response: %s)", text)
            return True
        except anthropic.AuthenticationError:
            log.error("Anthropic API key is invalid – check your .env file")
            return False
        except anthropic.NotFoundError:
            log.error("Model '%s' not found – check config.yaml", self._model)
            return False
        except Exception as exc:
            log.error("Anthropic connection failed: %s", exc)
            return False

    @property
    def market_focus(self) -> str:
        return self._market_focus

    @market_focus.setter
    def market_focus(self, value: str) -> None:
        self._market_focus = value
        log.info("Market focus updated: %s", value)

    async def score(self, headlines: list[Headline]) -> list[ScoredHeadline]:
        if not self._market_focus:
            return [
                ScoredHeadline(headline=h, relevance=5, impact="medium", summary="")
                for h in headlines
            ]

        scored: list[ScoredHeadline] = []
        for i in range(0, len(headlines), self._max_batch):
            batch = headlines[i : i + self._max_batch]
            batch_scored = await self._score_batch(batch)
            scored.extend(batch_scored)
        return scored

    async def _score_batch(self, batch: list[Headline]) -> list[ScoredHeadline]:
        numbered = "\n".join(f"{i+1}. [{h.source}] {h.title}" for i, h in enumerate(batch))
        user_msg = f"Market focus: {self._market_focus}\n\nHeadlines:\n{numbered}"

        try:
            resp = self._client.messages.create(
                model=self._model,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_msg}],
            )
            text = resp.content[0].text.strip()
            # Strip markdown fences if the model adds them despite instructions
            if text.startswith("```"):
                text = text.split("\n", 1)[1]
                if text.endswith("```"):
                    text = text[: text.rfind("```")]
            scores = json.loads(text)
        except Exception as exc:
            log.warning("LLM scoring failed: %s", exc)
            return [
                ScoredHeadline(headline=h, relevance=5, impact="medium", summary="")
                for h in batch
            ]

        results: list[ScoredHeadline] = []
        for h, s in zip(batch, scores):
            results.append(
                ScoredHeadline(
                    headline=h,
                    relevance=int(s.get("relevance", 5)),
                    impact=s.get("impact", "medium"),
                    summary=s.get("summary", ""),
                )
            )
        return results
