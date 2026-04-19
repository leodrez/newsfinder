from __future__ import annotations

import hashlib
from collections import OrderedDict

from collectors.rss import Headline

MAX_SEEN = 5000


class Deduplicator:
    """Filters out headlines we've already seen, using a title-based fuzzy hash."""

    def __init__(self) -> None:
        self._seen: OrderedDict[str, bool] = OrderedDict()

    def _normalise(self, title: str) -> str:
        return " ".join(title.lower().split())

    def _hash(self, title: str) -> str:
        return hashlib.md5(self._normalise(title).encode()).hexdigest()

    def filter_new(self, headlines: list[Headline]) -> list[Headline]:
        new: list[Headline] = []
        for h in headlines:
            key = self._hash(h.title)
            if key in self._seen:
                continue
            self._seen[key] = True
            new.append(h)

        while len(self._seen) > MAX_SEEN:
            self._seen.popitem(last=False)

        return new
