"""Memory guardrails: a 20 MP upload is downscaled and K-Means stays bounded."""

from __future__ import annotations

import resource
import tracemalloc

import cv2
import numpy as np

from geocluster import kmeans
from geocluster.filters import to_grayscale
from tests.test_api_flow import create_session, upload
from tests.test_downscale import png_bytes, synthetic_image


def test_twenty_megapixel_upload_then_kmeans_stays_bounded(client):
    image = synthetic_image(5000, 4000)  # 20 MP
    session_id = create_session(client)
    payload = upload(client, session_id, png_bytes(image), name="big.png").json()
    assert payload["downscaled"] is True and payload["megapixels"] <= 4.0

    # measure the pure K-Means call on the stored (4 MP) pixels
    download = client.get(f"/sessions/{session_id}/images/{payload['image_id']}?format=png")
    stored = cv2.imdecode(np.frombuffer(download.content, np.uint8), cv2.IMREAD_UNCHANGED)
    gray = to_grayscale(stored)
    assert gray.size >= 3_900_000  # still a ~4 MP workload

    tracemalloc.start()
    baseline_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    outcome = kmeans.run_kmeans(gray, 5)
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    print(
        f"\n[memory] 4 MP K-Means: tracemalloc peak={peak / 1e6:.1f} MB "
        f"(current={current / 1e6:.1f} MB), peak RSS delta={(peak_rss - baseline_rss) / 1024:.1f} MB"
    )
    assert outcome.labels.shape == gray.shape
    # generous bound: the algorithm is O(pixels), not O(pixels^2)
    assert peak < 400 * 1024 * 1024


def test_api_kmeans_on_the_downscaled_image(client):
    image = synthetic_image(5000, 4000)
    session_id = create_session(client)
    payload = upload(client, session_id, png_bytes(image), name="big.png").json()
    response = client.post(f"/sessions/{session_id}/images/{payload['image_id']}/kmeans", json={"k": 5})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["k"] == 5
    assert sum(entry["count"] for entry in body["ranges"]) == payload["width"] * payload["height"]


def test_session_memory_budget_is_enforced(app, client):
    app.state.sessions.global_memory_bytes = 3 * 1024 * 1024  # 3 MB
    session_id = create_session(client)
    image = synthetic_image(1200, 1200)  # 1.44 MP -> ~4.3 MB in memory
    first = upload(client, session_id, png_bytes(image), name="one.png").json()
    # the second upload cannot fit; the first is evicted to make room
    second = upload(client, session_id, png_bytes(image), name="two.png")
    assert second.status_code in (201, 507)
    if second.status_code == 201:
        stored = app.state.sessions.total_bytes()
        assert stored <= 3 * 1024 * 1024
        assert client.get(f"/sessions/{session_id}/images/{first['image_id']}").status_code == 404
