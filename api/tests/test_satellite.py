"""Satellite client: caching, token caching, defaults and 503/502/404 paths.

Everything is mocked: no test touches the network.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import cv2
import numpy as np
import pytest

from geocluster.errors import SatelliteError, SatelliteUnavailable
from geocluster.locations import LocationNotFound
from geocluster.places import NominatimThrottle, PlaceLookup
from geocluster.satellite import (
    RESOLUTION_M,
    SatelliteClient,
    cache_key,
    default_date_window,
    format_size_km,
    sanitize_location,
)


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


class FakeNominatimSession:
    """Stands in for requests.Session during place lookups (never networked)."""

    def __init__(self, results=None, *, error=None):
        self.results = results if results is not None else []
        self.error = error
        self.gets: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.gets.append({"url": url, "params": params, "headers": headers})
        if self.error is not None:
            import requests

            raise requests.RequestException(self.error)
        return FakeResponse(json_payload=self.results)


def fake_places(results=None, tmp_path=None, *, error=None, throttle=None):
    """A PlaceLookup wired to a fake Nominatim session (no network, no waiting)."""
    session = FakeNominatimSession(results, error=error)
    lookup = PlaceLookup(
        cache_dir=tmp_path or "/tmp/geocluster-test-places",
        session=session,
        throttle=throttle or NominatimThrottle(min_interval=0, clock=lambda: 0.0, sleep=lambda _s: None),
    )
    return lookup, session


def client_with(tmp_path, session=None, *, places=None, **kwargs) -> SatelliteClient:
    if places is None:
        places = fake_places(tmp_path=tmp_path)[0]
    return SatelliteClient(
        client_id="id",
        client_secret="secret",
        cache_dir=tmp_path,
        session=session or FakeSession(make_png()),
        places=places,
        **kwargs,
    )


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

    # an unknown place name must not paper over the missing credentials with a
    # network lookup: the sector path is local, so the credentials error wins
    with pytest.raises(SatelliteUnavailable):
        client.fetch("F-8", size_km=2)


def test_fetch_uses_the_cache_and_caches_the_token(tmp_path):
    session = FakeSession(make_png())
    client = client_with(tmp_path, session)

    first, meta = client.fetch("F-8")
    assert meta["cached"] is False
    assert first == session.png
    assert meta["key"].endswith(".png") and Path(meta["path"]).is_file()
    # the key names the whole request, not just the location
    assert "F-8" in meta["key"] and "2.6km" in meta["key"] and "260x260" in meta["key"]

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


def test_cache_key_covers_box_size_dates_and_resolution(tmp_path):
    """The old key was the location name alone: two different requests collided."""
    base = dict(label="F-8", bbox=[73.0, 33.6, 73.1, 33.7], size_km=2.0,
                date_from="2026-08-03T00:00:00Z", date_to="2026-10-02T00:00:00Z", width=200, height=200)
    key = cache_key(**base)
    assert key != cache_key(**{**base, "bbox": [74.0, 33.6, 74.1, 33.7]}), "bbox must change the key"
    assert key != cache_key(**{**base, "size_km": 5.0}), "size must change the key"
    assert key != cache_key(**{**base, "date_from": "2026-01-01T00:00:00Z"}), "date window must change the key"
    assert key != cache_key(**{**base, "date_to": "2026-12-02T00:00:00Z"}), "date window must change the key"
    assert key != cache_key(**{**base, "width": 500, "height": 500}), "resolution must change the key"
    assert key == cache_key(**base), "the same request is a stable key"
    assert "2km" in key and "200x200" in key and "2026-08-03_2026-10-02" in key
    assert format_size_km(2.0) == "2" and format_size_km(2.6) == "2.6" and format_size_km(0.75) == "0.75"


def test_two_date_windows_do_not_share_a_cache_entry(tmp_path):
    """Exactly the old bug: the second window reused the first window's pixels."""
    session = FakeSession(make_png())
    client = client_with(tmp_path, session)
    _, first = client.fetch("F-8", start="2026-01-01", end="2026-02-01")
    _, second = client.fetch("F-8", start="2026-07-01", end="2026-08-01")
    assert first["cached"] is False and second["cached"] is False
    assert first["path"] != second["path"]
    _, again = client.fetch("F-8", start="2026-01-01", end="2026-02-01")
    assert again["cached"] is True and again["path"] == first["path"]


def test_refresh_skips_the_cache_and_overwrites_the_entry(tmp_path):
    session = FakeSession(make_png())
    client = client_with(tmp_path, session)
    _, meta = client.fetch("F-8")
    process_calls = lambda: len([url for url, _ in session.posts if "process" in url])  # noqa: E731
    assert process_calls() == 1

    _, cached = client.fetch("F-8")
    assert cached["cached"] is True and process_calls() == 1

    content, refreshed = client.fetch("F-8", refresh=True)
    assert refreshed["cached"] is False, "refresh must not be answered from the cache"
    assert process_calls() == 2
    assert content == session.png
    assert refreshed["path"] == meta["path"], "refresh overwrites the same cache entry"

    _, cached_again = client.fetch("F-8")
    assert cached_again["cached"] is True and process_calls() == 2


def test_fetch_rejects_a_reversed_date_range(tmp_path):
    session = FakeSession(make_png())
    client = SatelliteClient(client_id="id", client_secret="secret", cache_dir=tmp_path, session=session)
    with pytest.raises(SatelliteError):
        client.fetch("F-8", start="2026-10-01", end="2026-09-01")


def test_unknown_location_raises_before_any_network(tmp_path):
    session = FakeSession(make_png())
    places, nominatim = fake_places(results=[], tmp_path=tmp_path / "places")
    client = client_with(tmp_path, session, places=places)
    with pytest.raises(LocationNotFound):
        client.fetch("atlantis")
    assert session.posts == [], "no Copernicus traffic for a place that does not exist"
    assert len(nominatim.gets) == 1, "the place was looked up exactly once"


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


def test_api_returns_404_for_unknown_location(app, client, monkeypatch, tmp_path):
    monkeypatch.delenv("COPERNICUS_CLIENT_ID", raising=False)
    app.state.satellite = SatelliteClient(
        client_id="id",
        client_secret="secret",
        cache_dir=tmp_path,
        session=FakeSession(make_png()),
        places=fake_places(results=[], tmp_path=tmp_path / "places")[0],
    )
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post("/satellite/fetch", json={"session_id": session_id, "location": "atlantis"})
    assert response.status_code == 404
    assert "atlantis" in response.json()["detail"]


def test_api_returns_404_for_unknown_session(app, client):
    app.state.satellite = SatelliteClient(client_id="id", client_secret="secret")
    response = client.post("/satellite/fetch", json={"session_id": "nope", "location": "F-8"})
    assert response.status_code == 404


def test_api_stores_the_fetched_image(app, client):
    class StubSatellite:
        configured = True

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
            assert kwargs.get("mode") == "place"
            return make_png(), {"cached": False, "label": location_name}

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


def test_api_reports_ground_scale_for_the_stored_image(app, client):
    """item 5: the fetch response carries bbox + meters_per_pixel, adjusted for
    the downscale the store applied."""
    BBOX = [-73.6, 45.4, -73.5, 45.5]

    class StubSatellite:
        configured = True

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
            return make_png(), {
                "cached": True, "label": location_name, "bbox": BBOX,
                "resolution_m": RESOLUTION_M, "width": 60, "height": 40,
            }

    app.state.satellite = StubSatellite()
    session_id = client.post("/sessions").json()["session_id"]
    payload = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"}).json()
    assert payload["bbox"] == BBOX
    assert payload["meters_per_pixel"] == RESOLUTION_M / payload["scale"]
    assert payload["meters_per_pixel"] == 10.0  # 60x40 px is far below the cap, so no downscale


def test_api_ground_scale_survives_a_downscale(app, client, monkeypatch):
    """A downscaled fetch stores wider pixels: metres/pixel scales with 1/scale."""
    import settings as runtime_settings
    monkeypatch.setattr(runtime_settings, "MAX_IMAGE_MEGAPIXELS", 0.001)  # forces a resize

    class StubSatellite:
        configured = True

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
            import cv2
            image = np.zeros((300, 300, 3), dtype=np.uint8)
            ok, buffer = cv2.imencode(".png", image)
            assert ok
            return buffer.tobytes(), {
                "cached": False, "label": location_name,
                "bbox": [-73.6, 45.4, -73.5, 45.5], "resolution_m": RESOLUTION_M,
            }

    app.state.satellite = StubSatellite()
    session_id = client.post("/sessions").json()["session_id"]
    payload = client.post("/satellite/fetch", json={"session_id": session_id, "location": "F-8"}).json()
    assert payload["downscaled"] is True
    assert payload["scale"] < 1.0
    # the response rounds to 6 decimals, so compare with a relative tolerance
    assert payload["meters_per_pixel"] == pytest.approx(RESOLUTION_M / payload["scale"], rel=1e-4)


def test_an_upload_has_no_ground_scale(client, sample_bytes):
    session_id = client.post("/sessions").json()["session_id"]
    payload = client.post(
        f"/sessions/{session_id}/images",
        files={"file": ("sample.jpg", sample_bytes, "image/jpeg")},
    ).json()
    assert payload["bbox"] is None
    assert payload["meters_per_pixel"] is None


def test_api_returns_502_for_provider_errors(app, client):
    class FailingSatellite:
        configured = True

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
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

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
            assert kwargs.get("mode") == "place"
            return make_png(), {"cached": False, "label": location_name}

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

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
            if start and end and start > end:
                raise SatelliteError("The start date must not be after the end date.")
            return make_png(), {"cached": False, "label": location_name}

    app.state.satellite = StubSatellite()
    session_id = client.post("/sessions").json()["session_id"]
    response = client.post(
        "/satellite/fetch",
        json={"session_id": session_id, "location": "F-8", "start": "2026-10-01", "end": "2026-09-01"},
    )
    assert response.status_code == 502
