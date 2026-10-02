"""The megapixel downscale policy (cv2.INTER_AREA) and the 20 MP path."""

from __future__ import annotations

import cv2
import numpy as np

import settings
from geocluster.images import downscale_to_limit, megapixels
from tests.test_api_flow import create_session, upload


def synthetic_image(width: int, height: int) -> np.ndarray:
    """Smooth gradient so PNG compression keeps the upload small."""
    xx = np.linspace(0, 255, width, dtype=np.float32)[None, :]
    yy = np.linspace(0, 255, height, dtype=np.float32)[:, None]
    blue = ((xx + yy) / 2).astype(np.uint8)  # broadcasts to (height, width)
    green = np.broadcast_to(yy, blue.shape).astype(np.uint8)
    red = np.broadcast_to(xx, blue.shape).astype(np.uint8)
    return np.dstack([blue, green, red])


def png_bytes(image: np.ndarray) -> bytes:
    ok, buffer = cv2.imencode(".png", image)
    assert ok
    return buffer.tobytes()


def test_downscale_is_exact_inter_area():
    image = synthetic_image(4000, 3000)  # 12 MP
    resized, scale = downscale_to_limit(image, 4.0)
    assert megapixels(resized) <= 4.0
    expected_scale = (4.0 / 12.0) ** 0.5
    expected_width = max(1, int(4000 * expected_scale))
    expected_height = max(1, int(3000 * expected_scale))
    assert resized.shape[:2] == (expected_height, expected_width)
    reference = cv2.resize(image, (expected_width, expected_height), interpolation=cv2.INTER_AREA)
    assert np.array_equal(resized, reference)
    assert abs(scale - expected_width / 4000) < 1e-12


def test_small_images_are_not_resized():
    image = synthetic_image(400, 400)
    resized, scale = downscale_to_limit(image, 4.0)
    assert resized is image
    assert scale == 1.0


def test_api_downscales_a_20_megapixel_upload(client):
    image = synthetic_image(5000, 4000)  # 20 MP
    assert megapixels(image) == 20.0
    session_id = create_session(client)
    response = upload(client, session_id, png_bytes(image), name="big.png")
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["original_width"] == 5000 and payload["original_height"] == 4000
    assert payload["original_megapixels"] == 20.0
    assert payload["downscaled"] is True
    assert payload["megapixels"] <= 4.0
    # aspect ratio is preserved (within a pixel of rounding)
    assert abs(payload["width"] / payload["height"] - 5000 / 4000) < 0.002
    assert 0.44 < payload["scale"] < 0.45

    # the stored image downloads and has the stored dimensions
    download = client.get(f"/sessions/{session_id}/images/{payload['image_id']}?format=png")
    stored = cv2.imdecode(np.frombuffer(download.content, np.uint8), cv2.IMREAD_UNCHANGED)
    assert (stored.shape[1], stored.shape[0]) == (payload["width"], payload["height"])


def test_configured_cap_is_respected(client, monkeypatch):
    monkeypatch.setattr(settings, "MAX_IMAGE_MEGAPIXELS", 1.0)
    session_id = create_session(client)
    response = upload(client, session_id, png_bytes(synthetic_image(2000, 2000)), name="2mp.png")
    assert response.status_code == 201
    assert response.json()["megapixels"] <= 1.0


def test_downscale_disabled_when_cap_is_zero():
    image = synthetic_image(1000, 1000)
    resized, scale = downscale_to_limit(image, 0)
    assert resized is image and scale == 1.0
