"""Validation failures: status codes and messages, never data in a 200."""

from __future__ import annotations

import io

import cv2
import numpy as np

import settings
from tests.test_api_flow import create_session, upload


def test_unsupported_file_type_is_rejected(client, sample_bytes):
    session_id = create_session(client)
    response = client.post(f"/sessions/{session_id}/images", files={"file": ("notes.txt", b"hello world", "text/plain")})
    assert response.status_code == 415
    assert "detail" in response.json()


def test_gif_is_rejected_even_though_cv2_can_decode_it(client):
    # tiny valid GIF87a
    gif = (
        b"GIF87a\x01\x00\x01\x00\x80\x01\x00\x00\x00\x00ccc,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
    )
    session_id = create_session(client)
    response = client.post(f"/sessions/{session_id}/images", files={"file": ("x.gif", gif, "image/gif")})
    assert response.status_code == 415


def test_format_is_validated_by_content_not_by_extension(client, sample_bytes):
    session_id = create_session(client)
    response = upload(client, session_id, sample_bytes, name="actually_a_jpeg.txt")
    assert response.status_code == 201
    assert response.json()["width"] == 1600


def test_oversized_upload_is_rejected(client, sample_bytes, monkeypatch):
    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 0.05)  # 50 kB
    session_id = create_session(client)
    response = upload(client, session_id, sample_bytes)
    assert response.status_code == 413
    assert "maximum allowed size" in response.json()["detail"]


def test_empty_upload_is_rejected(client):
    session_id = create_session(client)
    response = client.post(f"/sessions/{session_id}/images", files={"file": ("empty.png", b"", "image/png")})
    assert response.status_code == 415


def test_undecodable_png_claim_is_rejected(client):
    session_id = create_session(client)
    bogus = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    response = client.post(f"/sessions/{session_id}/images", files={"file": ("bad.png", bogus, "image/png")})
    assert response.status_code == 415


def test_unknown_session_and_image_are_404(client, sample_bytes):
    assert client.get("/sessions/does-not-exist/images/x/stats").status_code == 404
    session_id = create_session(client)
    assert client.get(f"/sessions/{session_id}/images/missing/stats").status_code == 404
    assert upload(client, "missing-session", sample_bytes).status_code == 404
    assert client.post(f"/sessions/{session_id}/images/missing/kmeans", json={"k": 3}).status_code == 404


def test_unknown_operation_is_404(client, sample_bytes):
    session_id = create_session(client)
    image_id = upload(client, session_id, sample_bytes).json()["image_id"]
    response = client.post(f"/sessions/{session_id}/images/{image_id}/operations/sharpen")
    assert response.status_code == 404


def test_bad_filter_parameters_are_422(client, sample_bytes):
    session_id = create_session(client)
    image_id = upload(client, session_id, sample_bytes).json()["image_id"]
    base = f"/sessions/{session_id}/images/{image_id}/operations"
    assert client.post(f"{base}/brightness", json={"value": 999}).status_code == 422
    assert client.post(f"{base}/threshold", json={"value": 300}).status_code == 422
    assert client.post(f"{base}/meanfilter", json={"window": 4}).status_code == 422
    assert client.post(f"{base}/meanfilter", json={"window": 2}).status_code == 422
    assert client.post(f"{base}/meanfilter", json={"window": 33}).status_code == 422
    # missing required body
    assert client.post(f"{base}/brightness").status_code == 422
    # wrong body shape for the operation
    assert client.post(f"{base}/brightness", json={"window": 3}).status_code == 422
    # parameterless operation with a body
    assert client.post(f"{base}/grayscale", json={"value": 1}).status_code == 422


def test_bad_kmeans_parameters_are_422(client, sample_bytes):
    session_id = create_session(client)
    image_id = upload(client, session_id, sample_bytes).json()["image_id"]
    url = f"/sessions/{session_id}/images/{image_id}/kmeans"
    assert client.post(url, json={"k": 1}).status_code == 422
    assert client.post(url, json={"k": 21}).status_code == 422
    assert client.post(url, json={"k": 5, "max_iter": 0}).status_code == 422
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json={"k": 5, "maxIter": 10}).status_code == 200  # desktop spelling accepted


def test_bad_classify_body_is_422(client, sample_bytes):
    session_id = create_session(client)
    image_id = upload(client, session_id, sample_bytes).json()["image_id"]
    url = f"/sessions/{session_id}/images/{image_id}/classify"
    assert client.post(url, json={"ranges": {}, "assignments": {}}).status_code == 422
    assert client.post(url, json={"ranges": {"0": [10, 5]}, "assignments": {"0": {"name": "x", "color": [1, 2, 3]}}}).status_code == 422
    assert client.post(url, json={"ranges": {"0": [0, 10]}, "assignments": {"0": {"name": "x", "color": [999, 2, 3]}}}).status_code == 422
    assert client.post(url, json={"ranges": {"0": [0, 10]}}).status_code == 422


def test_bad_download_format_is_422(client, sample_bytes):
    session_id = create_session(client)
    image_id = upload(client, session_id, sample_bytes).json()["image_id"]
    assert client.get(f"/sessions/{session_id}/images/{image_id}?format=gif").status_code == 422


def test_huffman_validation(client, sample_bytes):
    session_id = create_session(client)
    response = client.post("/huffman/compress", files={"file": ("notes.txt", b"not an image", "text/plain")})
    assert response.status_code == 415
    response = client.post("/huffman/decompress", files={"file": ("bad.gch", b"GCH3" + b"\x00" * 2048)})
    assert response.status_code == 400
    # a .gch file claiming huge dimensions must not be trusted
    header = b"GCH2" + (2**32 - 1).to_bytes(4, "little") + (1).to_bytes(4, "little") + (1).to_bytes(4, "little") + (1).to_bytes(4, "little") + (1).to_bytes(4, "little")
    response = client.post("/huffman/decompress", files={"file": ("huge.gch", header + b"\x00" * 1024)})
    assert response.status_code == 400


def test_no_error_text_inside_200_responses(client, sample_bytes):
    session_id = create_session(client)
    response = upload(client, session_id, sample_bytes, name="x.jpg")
    assert response.status_code == 201
    assert "error" not in response.text.lower()
