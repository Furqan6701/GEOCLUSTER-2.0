#!/usr/bin/env python3
"""Live contract check between the frontend's calls and the running API.

Runs the exact request sequence the browser makes (see web/js/api.js) against
http://localhost:8000 and validates the shapes the UI relies on. The API must
be running:

    cd api && uvicorn main:app --port 8000
    python web/tests/integration_check.py

Exit code 0 = every check passed.
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

API = "http://localhost:8000"
REPO = pathlib.Path(__file__).resolve().parents[2]
SAMPLE = REPO / "desktop" / "images" / "sample.jpg"

FAILURES: list[str] = []
SKIPS: list[str] = []


def check(condition: bool, label: str, detail: str = "") -> bool:
    if condition:
        print(f"PASS  {label}")
        return True
    FAILURES.append(label + (f" — {detail}" if detail else ""))
    print(f"FAIL  {label}{f' — {detail}' if detail else ''}")
    return False


def skip(label: str, why: str) -> None:
    SKIPS.append(label)
    print(f"SKIP  {label} — {why}")


def request(method: str, path: str, *, body=None, headers=None, raw=False):
    data = None
    request_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{API}{path}", data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read()
            return response.status, response.headers, (payload if raw else json.loads(payload or b"null"))
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload or b"null")
        except json.JSONDecodeError:
            parsed = payload
        return error.code, error.headers, parsed


def multipart(path: str, filename: str, payload: bytes, field: str = "file"):
    boundary = "----geocluster-smoke"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{API}{path}",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def main() -> int:
    print(f"frontend ↔ API contract check — {API}\n")

    status, _, health = request("GET", "/health")
    check(status == 200, "GET /health → 200", str(status))
    if isinstance(health, dict):
        check(health.get("status") == "ok", "health.status == ok", str(health))
        for key in ("ai_configured", "satellite_configured", "max_image_megapixels"):
            check(key in health, f"health exposes {key}")

    # ---------------------------------------------------------------- session
    status, _, session = request("POST", "/sessions")
    check(status == 201, "POST /sessions → 201", str(status))
    session_id = session.get("session_id") if isinstance(session, dict) else None
    check(bool(session_id), "session_id present")
    check(session.get("ttl_minutes") == 60, "ttl_minutes == 60", str(session.get("ttl_minutes")))
    check(session.get("max_images") == 6, "max_images == 6", str(session.get("max_images")))
    if not session_id:
        return finish()

    # ----------------------------------------------------------------- upload
    if not SAMPLE.exists():
        skip("upload desktop/images/sample.jpg", f"missing {SAMPLE}")
    else:
        status, _, payload = multipart(f"/sessions/{session_id}/images", "sample.jpg", SAMPLE.read_bytes())
        check(status == 201, "POST image → 201", str(payload)[:200])
        uploaded = json.loads(payload)
        image_id = uploaded.get("image_id")
        check(uploaded.get("width") == 1600 and uploaded.get("height") == 1066, "uploaded 1600×1066", str(uploaded)[:200])
        check(uploaded.get("downscaled") is False, "sample is not downscaled")
        for key in ("name", "source", "channels", "megapixels", "bytes", "original_width", "scale"):
            check(key in uploaded, f"image info exposes {key}")

        # ------------------------------------------------------------ filters
        for operation, body in [
            ("grayscale", None),
            ("negative", None),
            ("laplacian", None),
            ("brightness", {"value": 40}),
            ("threshold", {"value": 128}),
            ("meanfilter", {"window": 3}),
        ]:
            status, _, info = request("POST", f"/sessions/{session_id}/images/{image_id}/operations/{operation}", body=body)
            check(status == 201, f"operation {operation} → 201", f"{status} {str(info)[:160]}")
            if isinstance(info, dict):
                check(info.get("image_id") != image_id, f"{operation} returns a new image id")

        # invalid parameters must be a friendly 422 (list detail)
        status, _, detail = request("POST", f"/sessions/{session_id}/images/{image_id}/operations/meanfilter", body={"window": 4})
        check(status == 422, "meanfilter window=4 → 422", str(status))
        check(isinstance(detail.get("detail"), list), "422 detail is a list the UI flattens", str(detail)[:160])

        # download (the viewer's fetch→blob path)
        status, headers, blob = request("GET", f"/sessions/{session_id}/images/{image_id}?format=png", raw=True)
        check(status == 200, "GET image?format=png → 200", str(status))
        check(blob[:8] == b"\x89PNG\r\n\x1a\n", "downloaded bytes are a PNG")
        check("image/png" in headers.get("Content-Type", ""), "content-type is image/png")

        # ------------------------------------------------------------ k-means
        status, _, km = request("POST", f"/sessions/{session_id}/images/{image_id}/kmeans", body={"k": 5, "max_iter": 30})
        check(status == 200, "POST kmeans → 200", f"{status} {str(km)[:160]}")
        if isinstance(km, dict):
            ranges = [[entry["min"], entry["max"]] for entry in km.get("ranges", [])]
            check(ranges == [[0, 80], [81, 117], [118, 155], [156, 194], [195, 255]], "k=5 ranges match the verified desktop result", str(ranges))
            check(km.get("converged") is True, "kmeans converged", str(km.get("converged")))
            check(km.get("iterations", 0) > 0, "iterations reported", str(km.get("iterations")))
            check(len(km.get("centroids", [])) == 5, "five centroids")
            check(all(str(key) in km.get("assignments", {}) for key in range(5)), "assignments cover every cluster")
            check(bool(km.get("labels_image_id")) and bool(km.get("display_image_id")), "label/display image ids returned")
            first = km["assignments"]["0"]
            check("name" in first and len(first.get("color", [])) == 3, "assignments carry name + rgb colour")

            # --------------------------------------------------------- classify
            ranges_body = {str(entry["cluster"]): [entry["min"], entry["max"]] for entry in km["ranges"]}
            assignments_body = {
                key: {"name": value["name"], "color": value["color"]}
                for key, value in km["assignments"].items()
            }
            status, _, classified = request(
                "POST",
                f"/sessions/{session_id}/images/{image_id}/classify",
                body={"ranges": ranges_body, "assignments": assignments_body},
            )
            check(status == 200, "POST classify → 200", f"{status} {str(classified)[:160]}")
            if isinstance(classified, dict):
                legend = classified.get("legend", [])
                check(len(legend) == 5, "legend has five entries", str(len(legend)))
                check(all("percentage" in entry and "label" in entry for entry in legend), "legend entries carry percentage + label")
                check(all(len(entry.get("color", [])) == 3 for entry in legend), "legend entries carry colours")

        # ---------------------------------------------------- histogram/stats
        status, _, histogram = request("GET", f"/sessions/{session_id}/images/{image_id}/histogram")
        check(status == 200, "GET histogram → 200", str(status))
        check(len(histogram.get("bins", [])) == 256, "histogram has 256 bins")
        check(sum(histogram.get("bins", [])) == 1600 * 1066, "histogram totals every pixel")
        status, _, stats = request("GET", f"/sessions/{session_id}/images/{image_id}/stats")
        check(status == 200, "GET stats → 200", str(status))
        check(all(key in stats for key in ("min", "max", "mean", "std")), "stats expose min/max/mean/std", str(stats))

    # ---------------------------------------------------------------- huffman
    if SAMPLE.exists():
        status, _, gch = multipart("/huffman/compress", "sample.jpg", SAMPLE.read_bytes())
        check(status == 200, "POST /huffman/compress → 200", str(status))
        check(gch[:4] == b"GCH2", "compressed bytes start with GCH2", str(gch[:8]))
        status, _, png = multipart("/huffman/decompress", "sample.gch", gch)
        check(status == 200, "POST /huffman/decompress → 200", str(status))
        check(png[:8] == b"\x89PNG\r\n\x1a\n", "decompressed payload is a PNG")

    # -------------------------------------------------------------- satellite
    status, _, body = request("POST", "/satellite/fetch", body={"session_id": session_id, "location": "atlantis"})
    check(status == 404, "unknown location → 404", f"{status} {str(body)[:120]}")
    status, _, body = request(
        "POST",
        "/satellite/fetch",
        body={"session_id": session_id, "location": "F-8", "start": "not-a-date"},
    )
    check(status == 502 and "Invalid date" in json.dumps(body), "bad date → 502 with Invalid date", f"{status} {str(body)[:160]}")
    status, _, body = request("POST", "/satellite/fetch", body={"session_id": session_id, "location": "F-8"})
    if status == 200:
        check(body.get("source") == "satellite", "satellite fetch returns source=satellite", str(body)[:160])
        check(body.get("width") == 260 and body.get("height") == 260, "satellite tile is 260×260", f"{body.get('width')}×{body.get('height')}")
    else:
        check(status == 503, "satellite without credentials → 503", str(status))
        check("not configured" in json.dumps(body), "503 explains the missing credentials", str(body)[:160])

    # ------------------------------------------------------------------- chat
    for message, expected_intent, expected_action in [
        ("Show me F-8 imagery", "fetch_satellite", "fetch_satellite"),
        ("Run k-means on this", "process_image", "run_operation"),
        ("Measure the distance", "process_image", "open_distance"),
        ("Show histogram", "fetch_satellite", "fetch_satellite"),
    ]:
        status, _, reply = request("POST", "/ai/chat", body={"message": message})
        check(status in (200, 502, 503), f'chat "{message}" responds', str(status))
        if status == 200:
            check(reply.get("intent") == expected_intent, f'chat "{message}" intent', str(reply.get("intent")))
            commands = reply.get("commands", [])
            check(bool(commands) and commands[0].get("action") == expected_action, f'chat "{message}" command', str(commands))

    status, _, reply = request("POST", "/ai/chat", body={"message": "What is NDVI?"})
    if status == 200:
        check(bool(reply.get("reply")), "ask_question returns a text reply")
    else:
        check(status == 503, "ask_question without a key → 503 (friendly bubble)", str(status))

    # ------------------------------------------------------------ error paths
    status, _, body = request("GET", "/sessions/does-not-exist/images/x/stats")
    check(status == 404, "unknown session → 404", str(status))
    status, _, body = multipart(f"/sessions/{session_id}/images", "notes.txt", b"not an image")
    check(status == 415, "non-image upload → 415", str(status))

    return finish()


def finish() -> int:
    print()
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} failure(s)")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print(f"RESULT: all checks passed ({len(SKIPS)} skipped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
