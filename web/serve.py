#!/usr/bin/env python3
"""Static development server for the GeoCluster web frontend.

Usage (from the repository root or from web/):

    python web/serve.py                 # http://localhost:5173
    python web/serve.py --port 5174
    python web/serve.py --host 0.0.0.0  # allow other devices on your LAN

The API's CORS list allows http://localhost:5173 (and 127.0.0.1:5173) by
default, so serving the frontend on port 5173 needs no configuration.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import pathlib
import sys

WEB_ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_PORT = 5173


class FrontendHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with dev-friendly MIME types and no caching."""

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

    def end_headers(self):  # noqa: N802 - stdlib naming
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib naming
        sys.stderr.write("[web] %s - %s\n" % (self.address_string(), fmt % args))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Serve the GeoCluster web frontend.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEB_PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    handler = functools.partial(FrontendHandler, directory=str(WEB_ROOT))
    with http.server.ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        print(f"GeoCluster web frontend -> http://localhost:{args.port}")
        print(f"API expected at          -> http://localhost:8000 (override with ?api=...)")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
