"""Runtime configuration for the API layer (env-driven, no secrets in code)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # reads api/.env when present


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, float(default)))


# Upload / storage policy
MAX_IMAGE_MEGAPIXELS: float = _env_float("MAX_IMAGE_MEGAPIXELS", 4.0)
MAX_UPLOAD_MB: float = _env_float("MAX_UPLOAD_MB", 15.0)

# Session policy
SESSION_TTL_MINUTES: float = _env_float("SESSION_TTL_MINUTES", 60.0)
SESSION_MAX_IMAGES: int = _env_int("SESSION_MAX_IMAGES", 6)
GLOBAL_MEMORY_MB: float = _env_float("GLOBAL_MEMORY_MB", 512.0)

# Satellite cache (defaults to a folder under the OS temp directory)
SATELLITE_CACHE_DIR: str = os.getenv("SATELLITE_CACHE_DIR") or str(
    Path(tempfile.gettempdir()) / "geocluster-satellite-cache"
)

# Simple in-process rate limits (requests per minute)
AI_RATE_LIMIT_PER_MINUTE: int = _env_int("AI_RATE_LIMIT_PER_MINUTE", 10)
SATELLITE_RATE_LIMIT_PER_MINUTE: int = _env_int("SATELLITE_RATE_LIMIT_PER_MINUTE", 5)

# CORS (localhost-only by default; a deployment sets its own single origin)
DEFAULT_ORIGINS = (
    "http://localhost:3000,"
    "http://localhost:5173,"
    "http://localhost:8010,"
    "http://127.0.0.1:3000,"
    "http://127.0.0.1:5173,"
    "http://127.0.0.1:8010"
)


def allowed_origins() -> list[str]:
    """The CORS allow-list, read from `ALLOWED_ORIGINS` on every call.

    Trailing slashes are stripped (browsers never send them) and duplicates are
    removed, so a typo cannot silently drop an origin. An empty value falls back
    to the localhost default rather than allowing everything.
    """
    raw = os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    origins: list[str] = []
    for origin in raw.split(","):
        candidate = origin.strip().rstrip("/")
        if candidate and candidate not in origins:
            origins.append(candidate)
    return origins or [origin.strip() for origin in DEFAULT_ORIGINS.split(",")]


def allow_credentials() -> bool:
    """Whether the CORS middleware may send `Access-Control-Allow-Credentials`.

    Only true for an explicit allow-list: with `*` the browser would refuse the
    combination anyway, and echoing a wildcard origin back with credentials is a
    classic misconfiguration.
    """
    return "*" not in allowed_origins()


def _flag(name: str, default: bool) -> bool:
    """A boolean environment switch: unset/blank keeps `default`."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def serve_web() -> bool:
    """Whether this process also serves the frontend folder (Task 3).

    Default **false**: unset means the historical API-only application with
    every route at the root, which is what `api/tests` and the documented
    `cd api && uvicorn main:app` loop expect. The Render start command sets
    `SERVE_WEB=true`, which serves `web/` at `/` and moves the API to `/api`.
    """
    return _flag("SERVE_WEB", False)


def api_root_aliases() -> bool:
    """Whether the API routes are *also* registered at the root next to `/api`.

    Only meaningful with `SERVE_WEB=true`. Default true so that a page opened on
    `http://localhost:8010/` works with the frontend's local default API base
    (`http://localhost:8010`), unchanged. A deployment sets
    `API_ROOT_ALIASES=false` so exactly one API URL is published; the hosted
    frontend uses same-origin `/api` anyway.
    """
    return _flag("API_ROOT_ALIASES", True)


def trust_forwarded_headers() -> bool:
    """Whether `X-Forwarded-For` may name the client for rate limiting.

    Only a reverse proxy that *overwrites* the header may be trusted: a header
    set by the client would otherwise let one visitor mint unlimited "IPs" and
    walk straight past the limits. The Render deployment sets this to true
    (Render appends the real address and holds the client port); locally the
    default false means `request.client.host` is used, which is the truth.
    """
    return _flag("TRUST_FORWARDED_HEADERS", False)


def docs_enabled() -> bool:
    """Whether FastAPI's `/docs`, `/redoc` and `/openapi.json` are served.

    Enabled locally (they are the API's own reference) and switched off in a
    deployment with `ENABLE_DOCS=false`, so a public URL never publishes the
    full route/parameter map.
    """
    raw = os.getenv("ENABLE_DOCS")
    if raw is None or raw.strip() == "":
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off"}
