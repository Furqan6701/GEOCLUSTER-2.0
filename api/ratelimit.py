"""A tiny in-process sliding-window rate limiter.

Good enough for a single-process localhost deployment; swap for a shared
store if the API is ever run with multiple workers.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Callable

from fastapi import HTTPException, Request


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = int(limit)
        self.window_seconds = float(window_seconds)
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        if self.limit <= 0:
            return True
        now = self._clock()
        bucket = self._hits.setdefault(key, deque())
        while bucket and now - bucket[0] > self.window_seconds:
            bucket.popleft()
        if len(bucket) >= self.limit:
            return False
        bucket.append(now)
        return True

    def reset(self) -> None:
        self._hits.clear()


def client_key(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "anonymous"


def rate_limit_dependency(limiter: RateLimiter, message: str) -> Callable[[Request], None]:
    def dependency(request: Request) -> None:
        if not limiter.allow(client_key(request)):
            raise HTTPException(status_code=429, detail=message, headers={"Retry-After": str(int(limiter.window_seconds))})

    return dependency
