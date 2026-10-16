"""The in-process sliding-window limiter."""

from __future__ import annotations

from ratelimit import RateLimiter


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_limiter_allows_up_to_the_limit_then_blocks():
    clock = Clock()
    limiter = RateLimiter(2, window_seconds=60, clock=clock)
    assert limiter.allow("a") is True
    assert limiter.allow("a") is True
    assert limiter.allow("a") is False
    clock.now = 61.0
    assert limiter.allow("a") is True


def test_limiter_is_per_key():
    limiter = RateLimiter(1)
    assert limiter.allow("a") is True
    assert limiter.allow("b") is True
    assert limiter.allow("a") is False


def test_zero_limit_means_unlimited():
    limiter = RateLimiter(0)
    for _ in range(100):
        assert limiter.allow("a") is True


class _Client:
    def __init__(self, host):
        self.host = host


class _Request:
    """The two attributes `client_key` reads."""

    def __init__(self, host="203.0.113.7", headers=None):
        self.client = _Client(host) if host else None
        self.headers = headers or {}


def test_client_key_ignores_forwarded_headers_by_default(monkeypatch):
    from ratelimit import client_key

    monkeypatch.delenv("TRUST_FORWARDED_HEADERS", raising=False)
    request = _Request(host="10.0.0.1", headers={"x-forwarded-for": "1.2.3.4, 5.6.7.8"})
    assert client_key(request) == "10.0.0.1"


def test_client_key_uses_the_last_hop_when_the_proxy_is_trusted(monkeypatch):
    from ratelimit import client_key

    monkeypatch.setenv("TRUST_FORWARDED_HEADERS", "true")
    # a client-supplied entry sits to the left; the trusted proxy appended the
    # real address last, so that is the only one worth believing
    request = _Request(host="10.0.0.1", headers={"x-forwarded-for": "9.9.9.9, 198.51.100.4"})
    assert client_key(request) == "198.51.100.4"


def test_client_key_falls_back_when_the_header_is_missing_or_blank(monkeypatch):
    from ratelimit import client_key

    monkeypatch.setenv("TRUST_FORWARDED_HEADERS", "1")
    assert client_key(_Request(host="10.0.0.1", headers={})) == "10.0.0.1"
    assert client_key(_Request(host="10.0.0.1", headers={"x-forwarded-for": " , "})) == "10.0.0.1"
    assert client_key(_Request(host="10.0.0.1", headers={"x-forwarded-for": "198.51.100.9"})) == "198.51.100.9"
    # no socket peer either (an in-process test client)
    assert client_key(_Request(host=None, headers={})) == "anonymous"


def test_forwarded_identity_is_truncated(monkeypatch):
    from ratelimit import FORWARDED_KEY_LIMIT, client_key

    monkeypatch.setenv("TRUST_FORWARDED_HEADERS", "true")
    long_hop = "2001:0db8:" + "0" * 200 + "1"
    key = client_key(_Request(headers={"x-forwarded-for": long_hop}))
    assert len(key) <= FORWARDED_KEY_LIMIT
    assert key.startswith("2001:0db8:")


def test_reset_clears_state():
    limiter = RateLimiter(1)
    assert limiter.allow("a") is True
    assert limiter.allow("a") is False
    limiter.reset()
    assert limiter.allow("a") is True
