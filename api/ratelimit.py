"""A tiny in-process sliding-window rate limiter.

Good enough for a single-process deployment (the free tier runs one worker);
swap for a shared store if the API is ever run with several workers.

Sensible free-tier limits guard the two endpoints that spend a third party's
quota or fetch from one: `/ai/chat` (10/min per client) and `/satellite/fetch`
(5/min per client). The key is the client's IP - see `client_key`.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Callable

from fastapi import HTTPException, Request

import settings


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


#: How much of a forwarding header is kept: enough for an IPv6 address.
FORWARDED_KEY_LIMIT = 64


def client_key(request: Request) -> str:
    """Who to charge a request to.

    Behind a proxy (`TRUST_FORWARDED_HEADERS=true`) the socket peer is the
    proxy, so every visitor would share one bucket; the real address arrives in
    `X-Forwarded-For`, and the **last** entry is the one the trusted proxy
    appended. Client-supplied entries sit to its left and are therefore
    ignored - trusting the first entry would let one visitor mint a new "IP"
    per request and walk past the limit.

    Locally the header is not trusted at all: `request.client.host` is used.
    """
    if settings.trust_forwarded_headers():
        header = request.headers.get("x-forwarded-for", "")
        hops = [hop.strip() for hop in header.split(",") if hop.strip()]
        if hops:
            return hops[-1][:FORWARDED_KEY_LIMIT]
    if request.client and request.client.host:
        return request.client.host
    return "anonymous"


def rate_limit_dependency(limiter: RateLimiter, message: str) -> Callable[[Request], None]:
    def dependency(request: Request) -> None:
        if not limiter.allow(client_key(request)):
            raise HTTPException(status_code=429, detail=message, headers={"Retry-After": str(int(limiter.window_seconds))})

    return dependency
