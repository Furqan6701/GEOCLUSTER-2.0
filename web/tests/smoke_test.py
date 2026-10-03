#!/usr/bin/env python3
"""Offline smoke test for the GeoCluster web frontend.

Checks, without needing a browser or the API:

  1. web/serve.py serves index.html, the stylesheet and the modules on
     http://localhost:5173 with sane content types (an already-running server
     for the same web root is reused);
  2. every file index.html references exists, and every ES-module import in
     web/js/** resolves (broken imports would blank the page);
  3. no key material is present anywhere under web/;
  4. no `.innerHTML` usage (chat replies must render through textContent);
  5. if the API is running on :8000, its CORS headers allow the frontend origin
     — reported as SKIP when the API is down.

Usage:
    python web/tests/smoke_test.py
Exit code 0 = all good.
"""

from __future__ import annotations

import contextlib
import functools
import http.server
import pathlib
import re
import socket
import threading
import json
import urllib.error
import urllib.request

WEB = pathlib.Path(__file__).resolve().parents[1]
PORT = 5173
API = "http://localhost:8000"
ORIGIN = f"http://localhost:{PORT}"

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


def port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    with contextlib.closing(socket.socket()) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def fetch(url: str, headers: dict | None = None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, response.headers.get("Content-Type", ""), response.read()


@contextlib.contextmanager
def serving(directory: pathlib.Path, port: int):
    """Serve `directory` on `port`; reuse an existing server for the same root."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    try:
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        try:
            _, _, body = fetch(f"http://127.0.0.1:{port}/")
            ours = body == (directory / "index.html").read_bytes()
        except Exception:  # noqa: BLE001
            ours = False
        if not ours:
            raise RuntimeError(f"port {port} is in use by a different server; free it and retry") from None
        print(f"note  port {port} already serves this web/ — reusing the running server")
        yield
        return

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(f"note  serving {directory} on http://localhost:{port}")
    try:
        yield
    finally:
        httpd.shutdown()
        httpd.server_close()


# --------------------------------------------------------------------- checks

def check_serving() -> None:
    try:
        with serving(WEB, PORT):
            for path, expect_type in [
                ("/", "text/html"),
                ("/css/styles.css", "text/css"),
                ("/js/app.js", "text/javascript"),
                ("/js/viewer.js", "text/javascript"),
                ("/js/panels/chat.js", "text/javascript"),
            ]:
                try:
                    status, content_type, body = fetch(f"{ORIGIN}{path}")
                    check(status == 200, f"GET {path} → 200", f"got {status}")
                    check(expect_type in content_type, f"GET {path} content-type contains {expect_type}", content_type)
                    check(len(body) > 0, f"GET {path} is not empty")
                except Exception as error:  # noqa: BLE001
                    check(False, f"GET {path}", str(error))

            try:
                fetch(f"{ORIGIN}/js/does-not-exist.js")
                check(False, "GET /js/does-not-exist.js → 404", "expected HTTPError")
            except urllib.error.HTTPError as error:
                check(error.code == 404, "GET /js/does-not-exist.js → 404", str(error.code))
    except RuntimeError as error:
        check(False, f"serve web/ on port {PORT}", str(error))


LOCAL_REF = re.compile(r'(?:href|src)\s*=\s*"([^"]+)"')
IMPORT_RE = re.compile(r'from\s+"(\.[^"]+)"')


def check_references() -> None:
    index = (WEB / "index.html").read_text(encoding="utf-8")
    referenced = [
        ref for ref in LOCAL_REF.findall(index)
        if not ref.startswith(("http://", "https://", "data:", "#"))
    ]
    check(bool(referenced), "index.html references local assets")
    for ref in referenced:
        check((WEB / ref.lstrip("/")).exists(), f"index.html reference exists: {ref}")

    broken = []
    checked = 0
    for module in list((WEB / "js").rglob("*.js")) + list((WEB / "tests").rglob("*.mjs")):
        text = module.read_text(encoding="utf-8")
        for target in IMPORT_RE.findall(text):
            checked += 1
            resolved = (module.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{module.relative_to(WEB)} → {target}")
    check(not broken, f"all {checked} relative ES-module imports resolve", "; ".join(broken))


def check_no_secrets() -> None:
    patterns = {
        "Fireworks-style key": re.compile(r"(?:sk|gsk)_[A-Za-z0-9]{10,}"),
        "assigned FIREWORKS_API_KEY": re.compile(r"FIREWORKS_API_KEY\s*=\s*['\"]?[A-Za-z0-9]"),
        "assigned COPERNICUS secret": re.compile(r"COPERNICUS_CLIENT_(?:ID|SECRET)\s*=\s*['\"]?[A-Za-z0-9]"),
        "bearer token literal": re.compile(r"Bearer\s+[A-Za-z0-9._-]{12,}"),
    }
    hits = []
    for path in WEB.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".js", ".mjs", ".html", ".css", ".py", ".json", ".md"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for label, pattern in patterns.items():
            if pattern.search(text):
                hits.append(f"{path.relative_to(WEB)}: {label}")
    check(not hits, "no key material anywhere under web/", "; ".join(hits))


def check_no_innerhtml() -> None:
    hits = []
    for path in list(WEB.rglob("*.js")) + list(WEB.rglob("*.html")) + list(WEB.rglob("*.mjs")):
        text = path.read_text(encoding="utf-8")
        if re.search(r"\.innerHTML|insertAdjacentHTML|document\.write\(", text):
            hits.append(str(path.relative_to(WEB)))
    check(not hits, "no innerHTML/insertAdjacentHTML/document.write usage", ", ".join(hits))


def check_cors() -> None:
    if not port_open("localhost", 8000):
        skip("API CORS for the frontend origin", "API not running on :8000")
        return
    try:
        request = urllib.request.Request(f"{API}/health", headers={"Origin": ORIGIN})
        with urllib.request.urlopen(request, timeout=5) as response:
            allowed = response.headers.get("Access-Control-Allow-Origin")
        check(allowed == ORIGIN, f"API allows Origin {ORIGIN}", f"got {allowed!r}")
    except Exception as error:  # noqa: BLE001
        check(False, f"API allows Origin {ORIGIN}", str(error))

    try:
        request = urllib.request.Request(
            f"{API}/sessions",
            method="OPTIONS",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            allowed = response.headers.get("Access-Control-Allow-Origin")
        check(allowed == ORIGIN, "API CORS preflight for POST+content-type", f"got {allowed!r}")
    except Exception as error:  # noqa: BLE001
        check(False, "API CORS preflight for POST+content-type", str(error))


def check_proxy(port: int = PORT) -> None:
    """serve.py forwards /api/* to the backend (used when the page is hosted)."""
    if not port_open("127.0.0.1", port):
        skip("serve.py /api proxy", f"nothing listening on :{port}")
        return
    origin = f"http://127.0.0.1:{port}"
    try:
        status, content_type, body = fetch(f"{origin}/api/health")
        payload = json.loads(body)
        check(status == 200 and "status" in payload, "GET /api/health proxied to the API",
              f"{status} {content_type} {body[:80]!r}")
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            detail = json.loads(payload).get("detail", "")
        except Exception:  # noqa: BLE001
            detail = payload[:80].decode("utf-8", "replace")
        check(error.code == 502, "GET /api/health proxied (API down → 502 JSON)", f"{error.code} {detail[:80]}")
    except Exception as error:  # noqa: BLE001
        check(False, "GET /api/health proxied to the API", str(error))

    try:
        status, _, body = fetch(f"{origin}/api/sessions/nope/images/nope?format=png", headers={"Origin": origin})
        check(False, "proxied 404 keeps the API's detail", f"unexpected {status}")
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read()).get("detail")
        except Exception:  # noqa: BLE001
            detail = None
        check(error.code == 404 and isinstance(detail, str) and "session" in detail.lower(),
              "proxied 404 keeps the API's detail", f"{error.code} {detail!r}")

    try:
        status, content_type, _ = fetch(f"{origin}/index.html", headers={"Origin": origin})
        check("text/html" in content_type, "static files are unaffected by the proxy", content_type)
    except Exception as error:  # noqa: BLE001
        check(False, "static files are unaffected by the proxy", str(error))


def main() -> int:
    print(f"web frontend smoke test — root: {WEB}\n")
    check_serving()
    print()
    check_references()
    print()
    check_no_secrets()
    check_no_innerhtml()
    print()
    check_cors()
    print()
    check_proxy()
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
