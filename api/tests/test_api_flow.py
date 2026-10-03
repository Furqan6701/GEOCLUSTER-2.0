"""End-to-end API flow over TestClient (no network, no keys)."""

from __future__ import annotations

import cv2
import numpy as np


def create_session(client) -> str:
    response = client.post("/sessions")
    assert response.status_code == 201
    return response.json()["session_id"]


def upload(client, session_id: str, data: bytes, name: str = "sample.jpg"):
    return client.post(f"/sessions/{session_id}/images", files={"file": (name, data, "image/jpeg")})


def decode(response) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_UNCHANGED)


def test_health(client):
    payload = client.get("/health").json()
    assert payload["status"] == "ok"
    assert payload["ai_configured"] is False
    assert payload["satellite_configured"] is False
    assert payload["max_image_megapixels"] == 4.0


def test_full_pipeline(client, sample_bytes, fixtures_dir, expected, sample, gray_sample):
    session_id = create_session(client)

    # --- upload -----------------------------------------------------------
    response = upload(client, session_id, sample_bytes)
    assert response.status_code == 201, response.text
    uploaded = response.json()
    assert (uploaded["width"], uploaded["height"]) == (1600, 1066)
    assert uploaded["scale"] == 1.0 and uploaded["downscaled"] is False
    assert uploaded["channels"] == 3
    image_id = uploaded["image_id"]

    # --- download round trip ---------------------------------------------
    download = client.get(f"/sessions/{session_id}/images/{image_id}?format=png")
    assert download.status_code == 200
    assert download.headers["content-type"] == "image/png"
    assert np.array_equal(decode(download), sample)
    jpeg = client.get(f"/sessions/{session_id}/images/{image_id}?format=jpeg")
    assert jpeg.status_code == 200 and jpeg.headers["content-type"] == "image/jpeg"

    # --- filters through the API, compared with desktop fixtures ---------
    cases = [
        ("grayscale", None, "gray_sample.png"),
        ("negative", None, "negative_sample.png"),
        ("brightness", {"value": 40}, "brightness_p40_sample.png"),
        ("brightness", {"value": -40}, "brightness_m40_sample.png"),
        ("threshold", {"value": 128}, "threshold128_sample.png"),
        ("meanfilter", {"window": 3}, "mean3_sample.png"),
        ("meanfilter", {"window": 5}, "mean5_sample.png"),
        ("laplacian", None, "laplacian_sample.png"),
    ]
    for operation, body, fixture in cases:
        response = post_operation(client, session_id, image_id, operation, body)
        assert response.status_code == 201, f"{operation}: {response.text}"
        produced = decode(client.get(f"/sessions/{session_id}/images/{response.json()['image_id']}?format=png"))
        golden = cv2.imread(str(fixtures_dir / fixture), cv2.IMREAD_UNCHANGED)
        assert np.array_equal(produced, golden), f"{operation} differs from {fixture}"
        assert response.json()["image_id"] != image_id  # originals are never overwritten

    # --- statistics / histogram ------------------------------------------
    stats = client.get(f"/sessions/{session_id}/images/{image_id}/stats")
    assert stats.status_code == 200
    assert stats.json()["min"] == expected["stats_sample"]["min"]
    assert abs(stats.json()["mean"] - expected["stats_sample"]["mean"]) < 1e-9

    histogram = client.get(f"/sessions/{session_id}/images/{image_id}/histogram").json()
    assert len(histogram["bins"]) == 256
    assert sum(histogram["bins"]) == gray_sample.size

    # --- k-means ----------------------------------------------------------
    response = client.post(f"/sessions/{session_id}/images/{image_id}/kmeans", json={"k": 5})
    assert response.status_code == 200, response.text
    clustering = response.json()
    assert clustering["k"] == 5 and clustering["converged"] is True
    assert [entry["min"] for entry in clustering["ranges"]] == [r[0] for r in expected["kmeans_k5"]["ranges"]]
    labels = decode(client.get(f"/sessions/{session_id}/images/{clustering['labels_image_id']}?format=png"))
    assert np.array_equal(labels, np.load(fixtures_dir / "kmeans_k5_labels.npy"))
    display = decode(client.get(f"/sessions/{session_id}/images/{clustering['display_image_id']}?format=png"))
    assert np.array_equal(display, cv2.imread(str(fixtures_dir / "kmeans_k5_display.png"), cv2.IMREAD_UNCHANGED))

    # --- classify on the grayscale image with the fixture inputs ---------
    classify_body = {
        "ranges": {key: value for key, value in expected["classify"]["ranges"].items()},
        "assignments": {
            key: {"name": entry["name"], "color": entry["color"]}
            for key, entry in expected["classify"]["assignments"].items()
        },
    }
    gray_response = post_operation(client, session_id, image_id, "grayscale", None)
    gray_id = gray_response.json()["image_id"]
    response = client.post(f"/sessions/{session_id}/images/{gray_id}/classify", json=classify_body)
    assert response.status_code == 200, response.text
    classified = response.json()
    assert classified["legend"] == expected["classify"]["legend"]
    colored = decode(client.get(f"/sessions/{session_id}/images/{classified['image_id']}?format=png"))
    assert np.array_equal(colored, cv2.imread(str(fixtures_dir / "classify_display.png"), cv2.IMREAD_UNCHANGED))

    # --- the original is untouched ---------------------------------------
    original = decode(client.get(f"/sessions/{session_id}/images/{image_id}?format=png"))
    assert np.array_equal(original, sample)


def post_operation(client, session_id: str, image_id: str, operation: str, body):
    url = f"/sessions/{session_id}/images/{image_id}/operations/{operation}"
    if body is None:
        return client.post(url)
    return client.post(url, json=body)


def test_huffman_endpoints_round_trip(client, sample_bytes, sample, fixtures_dir):
    compress = client.post("/huffman/compress", files={"file": ("sample.jpg", sample_bytes, "image/jpeg")})
    assert compress.status_code == 200
    assert compress.headers["content-type"] == "application/octet-stream"
    assert compress.content == (fixtures_dir / "sample_color.gch").read_bytes()

    decompress = client.post("/huffman/decompress", files={"file": ("sample.gch", compress.content)})
    assert decompress.status_code == 200
    assert decompress.headers["content-type"] == "image/png"
    assert np.array_equal(decode(decompress), sample)

    desktop_file = (fixtures_dir / "sample_color.gch").read_bytes()
    from_desktop = client.post("/huffman/decompress", files={"file": ("desktop.gch", desktop_file)})
    assert from_desktop.status_code == 200
    assert np.array_equal(decode(from_desktop), sample)


def test_locations_endpoint(client):
    payload = client.get("/locations").json()
    assert len(payload["sectors"]) == 21
    assert len(payload["aliases"]) == 71
    assert payload["aliases"]["nust"] == "H-12"


def test_ground_scale_flows_through_every_derived_image(client):
    """item 5: operations, K-Means and classify carry bbox + meters_per_pixel.

    The image is fetched through the satellite route with a stub provider (the
    only way an image gets ground metadata), so the whole chain is exercised
    without touching the network.
    """
    import cv2
    import numpy as np

    BBOX = [67.0, 24.8, 67.1, 24.9]

    class StubSatellite:
        configured = True

        def fetch(self, location_name=None, start=None, end=None, **kwargs):
            image = np.zeros((120, 160, 3), dtype=np.uint8)
            image[:, :, 1] = 90
            ok, buffer = cv2.imencode(".png", image)
            assert ok
            return buffer.tobytes(), {
                "cached": False, "label": location_name, "bbox": BBOX, "resolution_m": 10.0,
            }

    client.app.state.satellite = StubSatellite()
    session_id = create_session(client)
    fetched = client.post(
        "/satellite/fetch",
        json={"session_id": session_id, "location": "F-8"},
    ).json()
    image_id = fetched["image_id"]
    assert fetched["bbox"] == BBOX and fetched["meters_per_pixel"] == 10.0

    # --- a point operation keeps the box and the pixel size -----------------
    gray = client.post(f"/sessions/{session_id}/images/{image_id}/operations/grayscale").json()
    assert gray["bbox"] == BBOX
    assert gray["meters_per_pixel"] == 10.0
    # ...and so does a filter that only looks at neighbours
    mean = client.post(
        f"/sessions/{session_id}/images/{gray['image_id']}/operations/meanfilter",
        json={"window": 3},
    ).json()
    assert mean["bbox"] == BBOX
    assert mean["meters_per_pixel"] == 10.0

    # --- K-Means: both derived images carry it -----------------------------
    import schemas

    store = client.app.state.sessions

    def info_of(image_id):
        """Exactly what the API serialises for an image (ImageOut)."""
        return schemas.ImageOut.from_stored(session_id, store.get_image(session_id, image_id)).model_dump()

    kmeans = client.post(
        f"/sessions/{session_id}/images/{gray['image_id']}/kmeans",
        json={"k": 3, "max_iter": 100},
    ).json()
    for key in ("labels_image_id", "display_image_id"):
        info = info_of(kmeans[key])
        assert info["bbox"] == BBOX
        assert info["meters_per_pixel"] == 10.0
        assert info["width"] == gray["width"], "K-Means keeps the source size"

    # --- classify ----------------------------------------------------------
    classify = client.post(
        f"/sessions/{session_id}/images/{gray['image_id']}/classify",
        json={
            "ranges": {"0": [0, 127], "1": [128, 255]},
            "assignments": {
                "0": {"name": "Dark", "color": [10, 20, 30]},
                "1": {"name": "Bright", "color": [200, 210, 220]},
            },
        },
    ).json()
    classified = info_of(classify["image_id"])
    assert classified["bbox"] == BBOX
    assert classified["meters_per_pixel"] == 10.0


def test_derived_pixel_size_is_adjusted_when_the_result_is_resized():
    """derive_ground_metadata: fewer pixels over the same box = wider pixels."""
    from sessions import derive_ground_metadata

    class Source:
        bbox = [1.0, 2.0, 3.0, 4.0]
        meters_per_pixel = 10.0
        width = 1000

    same = derive_ground_metadata(Source(), 1000)
    assert same == {"bbox": [1.0, 2.0, 3.0, 4.0], "meters_per_pixel": 10.0}
    half = derive_ground_metadata(Source(), 500)
    assert half["meters_per_pixel"] == 20.0, "half the pixels means twice the metres each"
    assert half["bbox"] == [1.0, 2.0, 3.0, 4.0], "the box does not change"

    class Plain:
        bbox = None
        meters_per_pixel = None
        width = 1000

    assert derive_ground_metadata(Plain(), 400) == {"bbox": None, "meters_per_pixel": None}, \
        "an image without ground metadata must not gain invented values"
