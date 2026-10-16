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
    "http://localhost:8000,"
    "http://127.0.0.1:3000,"
    "http://127.0.0.1:5173,"
    "http://127.0.0.1:8000"
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
