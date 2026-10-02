"""Satellite client: caching, token caching, defaults and 503/502/404 paths.

Everything is mocked: no test touches the network.
"""

from __future__ import annotations

from datetime import date

import cv2
import numpy as np
import pytest

from geocluster.errors import SatelliteError, SatelliteUnavailable
from geocluster.locations import LocationNotFound
from geocluster.satellite import SatelliteClient, default_date_window, sanitize_location


class FakeResponse:
    def __init__(self, *, json_payload=None, content=b"", status=200):
        self._json = json_payload
        self.content = content
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    def __init__(self, png_bytes: bytes):
        self.png = png_bytes
        self.posts: list[tuple[str, dict]] = []

    def post(self, url, headers=None, data=None, json=None, timeout=None):
        self.posts.append((url, {"headers": headers, "data": data, "json": json}))
        if "token" in url:
            return FakeResponse(json_payload={"access_token": "SECRET-TOKEN", "expires_in": 600})
        return FakeResponse(content=self.png)


def make_png() -> bytes:
    image = np.zeros((40, 60, 3), dtype=np.uint8)
    image[:, :, 1] = 120
    ok, buffer = cv2.imencode(".png", image)
    assert ok
    return buffer.tobytes()


def test_sanitize_rule_is_the_single_cache_key_rule():
    # desktop fetch_sector_image rule, verbatim: strip -> upper -> spaces -> slashes
    assert sanitize_location(" F-8 ") == "F-8"
    assert sanitize_location("nust h12") == "NUST_H12"
    assert sanitize_location("a/b") == "A_B"


def test_default_window_is_rolling_and_ends_today():
    start, end = default_date_window(date(2026, 10, 2))
    assert end == "2026-10-02T00:00:00Z"
    assert start == "2026-08-03T00:00:00Z"
    # not the old hardcoded desktop window
    assert start != "2026-05-01T00:00:00Z"


def test_missing_credentials_raise_unavailable(monkeypatch):
    monkeypatch.delenv("COPERNICUS_CLIENT_ID", raising=False)
    monkeypatch.delenv("COPERNICUS_CLIENT_SECRET", raising=False)
    client = SatelliteClient()
    assert client.configured is False
    with pytest.raises(SatelliteUnavailable):
        client.fetch("F-8")


def test_fetch_uses_the_cache_and_caches_the_token(tmp_path):
    session = FakeSession(make_png())
    client = SatelliteClient(client_id="id", client_secret="secret", cache_dir=tmp_path, session=session)

    first, meta = client.fetch("F-8")
    assert meta["cached"] is False
    assert first == session.png
    assert (tmp_path / "F-8.png").is_file()

    second, meta2 = client.fetch("F-8")
    assert meta2["cached"] is True
    assert second == first
    assert len(session.posts) == 2  # one token + one process; the cache avoided a second process

    # another location must reuse the cached token (not fetch a new one)
    client.fetch("H-12")
    token_calls = [url for url, _ in session.posts if "token" in url]
    assert len(token_calls) == 1
    process_calls = [url for url, _ in session.posts if "process" in url]
    assert len(process_calls) == 2
    assert "SECRET-TOKEN" not in repr(meta)  # no token material in metadata


def test_fetch_rejects_a_reversed_date_range(tmp_path):
    session = FakeSession(make_png())
    client = SatelliteClient(client_id="id", client_secret="secret", cache_dir=tmp_path, session=session)
    with pytest.raises(SatelliteError):
        client.fetch("F-8", start="2026-10-01", end="2026-09-01")


def test_unknown_location_raises_before_any_network(tmp_path):
    session = FakeSession(make_png())
    client = SatelliteClient(client_id="id", client_secret="secret", cache_dir=tmp_path, session=session)
    with pytest.raises(LocationNotFound):
        client.fetch("atlantis")
    assert session.posts == []


def test_client_reports_no_token_on_error(tmp_path, caplog):
    class FailingSession(FakeSession):
        def post(self, url, headers=None, data=None, json=None, timeout=None):
            if "token" in url:
                return FakeResponse(status=401)
            return super().post(url, headers=headers, data=data, json=json, timeout=timeout)

    client = SatelliteClient(client_id="id", client_secret="secret", cache_dir=tmp_path, session=FailingSession(make_png()))
    with pytest.raises(SatelliteError):
        client.fetch("F-8")
    assert "secret" not in caplog.text.lower()


# ----------------------------------------------------------------- API paths

def test_api_returns_503_without_credentials(app, client, monkeypatch):
    monkeypatch.delenv("COPERNICUS_CLIENT_ID", raising=False)
    monkeypatch.delenv("COPERNICUS_CLIENT_SECRET", raising=False)
    app.state.satellite = SatelliteClient()
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"})
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_api_returns_404_for_unknown_location(app, client, monkeypatch):
    monkeypatch.delenv("COPERNICUS_CLIENT_ID", raising=False)
    app.state.satellite = SatelliteClient(client_id="id", client_secret="secret", cache_dir="/tmp/does-not-matter")
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "atlantis"})
    assert response.status_code == 404


def test_api_returns_404_for_unknown_session(app, client):
    app.state.satellite = SatelliteClient(client_id="id", client_secret="secret")
    response = client.post("/satellite/fetch", json={"session_id": "nope", "location": "F-8"})
    assert response.status_code == 404


def test_api_stores_the_fetched_image(app, client):
    class StubSatellite:
        configured = True

        def fetch(self, location, start=None, end=None, **kwargs):
            return make_png(), {"cached": False}

    app.state.satellite = StubSatellite()
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source"] == "satellite"
    assert payload["name"] == "F-8.png"
    download = client.get(f"/sessions/{session_id}/images/{payload['image_id']}?format=png")
    decoded = cv2.imdecode(np.frombuffer(download.content, np.uint8), cv2.IMREAD_UNCHANGED)
    assert decoded.shape[:2] == (40, 60)


def test_api_returns_502_for_provider_errors(app, client):
    class FailingSatellite:
        configured = True

        def fetch(self, location, start=None, end=None, **kwargs):
            raise SatelliteError("The satellite imagery request failed.")

    app.state.satellite = FailingSatellite()
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"})
    assert response.status_code == 502
    assert response.json()["detail"] == "The satellite imagery request failed."


def test_api_rate_limits_satellite(app, client):
    from ratelimit import RateLimiter

    class StubSatellite:
        configured = True

        def fetch(self, location, start=None, end=None, **kwargs):
            return make_png(), {"cached": False}

    app.state.satellite = StubSatellite()
    app.state.satellite_limiter = RateLimiter(1)
    session_id = client.post("/sessions").json()["session_id"]
    body = {"session_id": session_id, "location": "F-8"}
    assert client.post("/satellite/fetch", json=body).status_code == 200
    limited = client.post("/satellite/fetch", json=body)
    assert limited.status_code == 429


def test_api_validates_dates(app, client):
    class StubSatellite:
        configured = True

        def fetch(self, location, start=None, end=None, **kwargs):
            if start and end and start > end:
                raise SatelliteError("The start date must not be after the end date.")
            return make_png(), {"cached": False}

    app.state.satellite = StubSatellite()
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post(
        "/satellite/fetch",
        json={"session_id": session_id, "location": "F-8", "start": "2026-10-01", "end": "2026-09-01"},
    )
    assert response.status_code == 502
