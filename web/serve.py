#!/usr/bin/env python3
"""Static development server for the GeoCluster web frontend.

Usage (from the repository root or from web/):

    python web/serve.py                 # http://localhost:5173
    python web/serve.py --port 5174
    python web/serve.py --host 0.0.0.0  # allow other devices on your LAN

It serves this folder and forwards **/api/*** to the backend (default
http://127.0.0.1:8000), so the page works when the browser is not on the same
machine as the API — a hosted preview, another device on the LAN, or a reverse
proxy. Browsers must never be told to call localhost for a service that runs on
the server: from a page served at http://localhost:5173 the frontend talks to
the API directly (the API's CORS list allows that origin), and from any other
host it uses the same-origin /api path handled here.

    python web/serve.py --api http://127.0.0.1:9000   # proxy a different API
    python web/serve.py --no-proxy                    # static files only
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

WEB_ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_PORT = 5173
DEFAULT_API = "http://127.0.0.1:8000"
API_PREFIX = "/api"
PROXY_TIMEOUT = 300  # seconds; satellite fetches can be slow


class FrontendHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with dev-friendly MIME types, no caching and
    a same-origin /api reverse proxy."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".html": "text/html",
        ".map": "application/json",
    }

    # set by main()
    api_base = DEFAULT_API
    proxy_enabled = True

    def end_headers(self):  # noqa: N802 - stdlib naming
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib naming
        sys.stderr.write("[web] %s - %s\n" % (self.address_string(), fmt % args))

    # ----------------------------------------------------------------- proxy
    def is_proxy_path(self) -> bool:
        return self.proxy_enabled and (self.path == API_PREFIX or self.path.startswith(API_PREFIX + "/"))

    def do_GET(self):  # noqa: N802
        if self.is_proxy_path():
            return self.proxy("GET")
        return super().do_GET()

    def do_HEAD(self):  # noqa: N802
        if self.is_proxy_path():
            return self.proxy("HEAD")
        return super().do_HEAD()

    def do_POST(self):  # noqa: N802
        return self.proxy("POST") if self.is_proxy_path() else self.fail(405, "POST is only proxied to /api/*")

    def do_PUT(self):  # noqa: N802
        return self.proxy("PUT") if self.is_proxy_path() else self.fail(405, "PUT is only proxied to /api/*")

    def do_PATCH(self):  # noqa: N802
        return self.proxy("PATCH") if self.is_proxy_path() else self.fail(405, "PATCH is only proxied to /api/*")

    def do_DELETE(self):  # noqa: N802
        return self.proxy("DELETE") if self.is_proxy_path() else self.fail(405, "DELETE is only proxied to /api/*")

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        self.end_headers()

    def proxy(self, method: str) -> None:
        """Forward /api/<path> to the backend and stream the answer back."""
        target = self.api_base + self.path[len(API_PREFIX):]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        request = urllib.request.Request(target, data=body, method=method)
        for header in ("Content-Type", "Accept", "Content-Disposition"):
            value = self.headers.get(header)
            if value:
                request.add_header(header, value)

        try:
            with urllib.request.urlopen(request, timeout=PROXY_TIMEOUT) as response:
                self.relay(response.status, response.headers, response.read(), method)
        except urllib.error.HTTPError as error:
            self.relay(error.code, error.headers, error.read(), method)
        except Exception as error:  # noqa: BLE001 - any transport problem is a 502 for the browser
            payload = json.dumps(
                {
                    "detail": f"The web server could not reach the API at {self.api_base} ({error}). "
                    "Start it with: uvicorn main:app --port 8000 (from api/)."
                }
            ).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(payload)

    def relay(self, status: int, headers, payload: bytes, method: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(payload)))
        disposition = headers.get("Content-Disposition")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)

    def fail(self, status: int, detail: str) -> None:
        payload = json.dumps({"detail": detail}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Serve the GeoCluster web frontend.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEB_PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api", default=os.environ.get("GEOCLUSTER_API", DEFAULT_API),
                        help="backend base URL for the /api/* proxy")
    parser.add_argument("--no-proxy", action="store_true", help="serve static files only")
    args = parser.parse_args(argv)

    FrontendHandler.api_base = args.api.rstrip("/")
    FrontendHandler.proxy_enabled = not args.no_proxy

    handler = functools.partial(FrontendHandler, directory=str(WEB_ROOT))
    with http.server.ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        print(f"GeoCluster web frontend -> http://localhost:{args.port}")
        print(f"API expected at          -> {FrontendHandler.api_base}")
        print(f"  localhost pages call it directly; other hosts use /api/* (proxied here)")
        print(f"  override the address with ?api=... on the page URL")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
