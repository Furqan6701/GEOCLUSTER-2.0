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

# CORS (localhost-only by default)
DEFAULT_ORIGINS = (
    "http://localhost:3000,"
    "http://localhost:5173,"
    "http://localhost:8000,"
    "http://127.0.0.1:3000,"
    "http://127.0.0.1:5173,"
    "http://127.0.0.1:8000"
)


def allowed_origins() -> list[str]:
    raw = os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]
