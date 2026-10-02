"""Session TTL, per-session LRU eviction and the global memory guard."""

from __future__ import annotations

import numpy as np
import pytest

from geocluster.errors import ImageNotFound, SessionLimitError, SessionNotFound
from sessions import SessionStore

from tests.test_api_flow import create_session, upload


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_store(**kwargs) -> tuple[SessionStore, FakeClock]:
    clock = FakeClock()
    defaults = dict(ttl_minutes=60.0, max_images_per_session=6, global_memory_bytes=512 * 1024 * 1024)
    defaults.update(kwargs)
    return SessionStore(clock=clock, **defaults), clock


def test_session_ids_are_opaque_and_unique():
    store, _ = make_store()
    ids = {store.create().session_id for _ in range(20)}
    assert len(ids) == 20
    assert all(len(session_id) >= 20 for session_id in ids)


def test_unknown_session_raises():
    store, _ = make_store()
    with pytest.raises(SessionNotFound):
        store.get("nope")


def test_ttl_expiry():
    store, clock = make_store(ttl_minutes=10)
    session = store.create()
    store.get(session.session_id)
    clock.advance(9 * 60)
    assert store.get(session.session_id) is session  # sliding window
    clock.advance(11 * 60)
    with pytest.raises(SessionNotFound):
        store.get(session.session_id)


def test_lru_eviction_per_session():
    store, clock = make_store(max_images_per_session=3)
    session = store.create()
    image = np.zeros((4, 4), dtype=np.uint8)
    stored = []
    for index in range(3):
        stored.append(store.add_image(session.session_id, image, f"img{index}"))
        clock.advance(1)
    store.get_image(session.session_id, stored[0].image_id)  # refresh the oldest
    clock.advance(1)
    newest = store.add_image(session.session_id, image, "img3")
    assert len(session.images) == 3
    with pytest.raises(ImageNotFound):
        store.get_image(session.session_id, stored[1].image_id)  # least recently used
    assert store.get_image(session.session_id, stored[0].image_id).name == "img0"
    assert store.get_image(session.session_id, newest.image_id).name == "img3"


def test_global_memory_guard_evicts_globally():
    # ~4 MB budget; each 1024x1024 uint8 image is ~1 MB
    store, _ = make_store(global_memory_bytes=4 * 1024 * 1024)
    first = store.create()
    second = store.create()
    image = np.zeros((1024, 1024), dtype=np.uint8)
    for index in range(3):
        store.add_image(first.session_id, image, f"a{index}")
    store.add_image(second.session_id, image, "b0")
    store.add_image(second.session_id, image, "b1")
    assert store.total_bytes() <= 4 * 1024 * 1024
    assert len(first.images) == 2  # oldest of the first session was evicted
    assert len(second.images) == 2


def test_global_memory_guard_rejects_impossible_image():
    store, _ = make_store(global_memory_bytes=1024)
    session = store.create()
    with pytest.raises(SessionLimitError):
        store.add_image(session.session_id, np.zeros((512, 512), dtype=np.uint8), "huge")


def test_api_session_ttl_returns_404(app, client):
    session_id = create_session(client)
    clock = FakeClock()
    app.state.sessions._clock = clock  # test-only clock injection
    clock.advance(61 * 60)
    assert client.get(f"/sessions/{session_id}/images/x/stats").status_code == 404


def test_api_image_eviction_keeps_latest(app, client, sample_bytes):
    app.state.sessions.max_images_per_session = 2
    session_id = create_session(client)
    first = upload(client, session_id, sample_bytes).json()["image_id"]
    second = upload(client, session_id, sample_bytes).json()["image_id"]
    assert client.get(f"/sessions/{session_id}/images/{first}").status_code == 200
    third = upload(client, session_id, sample_bytes).json()["image_id"]
    assert client.get(f"/sessions/{session_id}/images/{third}").status_code == 200
    assert client.get(f"/sessions/{session_id}/images/{second}").status_code == 404
