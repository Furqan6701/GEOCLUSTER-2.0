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


def test_reset_clears_state():
    limiter = RateLimiter(1)
    assert limiter.allow("a") is True
    assert limiter.allow("a") is False
    limiter.reset()
    assert limiter.allow("a") is True
