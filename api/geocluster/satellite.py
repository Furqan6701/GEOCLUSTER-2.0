"""Copernicus Data Space client with an on-disk cache.

Ported from desktop/frontend/sentinel_client.py with these API-era changes
(all documented in docs/migration-decisions.md):
  * exactly ONE cache-key rule (the desktop's fetch_sector_image rule)
  * cache directory configurable, defaulting to a folder under the OS temp dir
  * the default date window is rolling and ends today (the desktop hardcoded
    2026-05-01 .. 2026-07-01)
  * the OAuth token is cached for under 10 minutes (never printed anywhere)
  * credentials are read from the environment only; a missing pair raises
    SatelliteUnavailable (the endpoint answers 503) instead of crashing startup
"""

from __future__ import annotations

import logging
import math
import os
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

from .errors import SatelliteError, SatelliteUnavailable
from .locations import get_sector_bbox

logger = logging.getLogger("geocluster.satellite")

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

# Mirrors the desktop hardcoded window length (2026-05-01 -> 2026-07-01) but
# rolls forward so the window always ends today.
DEFAULT_WINDOW_DAYS = 61
TOKEN_TTL_SECONDS = 540  # < 10 minutes
REQUEST_TIMEOUT_SECONDS = 60

# True-color evalscript, copied verbatim from the desktop.
TRUE_COLOR_EVALSCRIPT = """
//VERSION=3
function setup() {
  return {
    input: ["B02", "B04", "B03"],
    output: { bands: 3 }
  };
}
function evaluatePixel(sample) {
  return [sample.B04 * 2.5, sample.B03 * 2.5, sample.B02 * 2.5];
}
"""


def sanitize_location(location_name: str) -> str:
    """The single cache-key rule (desktop fetch_sector_image)."""
    return (
        location_name.strip()
        .upper()
        .replace(" ", "_")
        .replace("/", "_")
    )


def default_date_window(today: date | None = None) -> tuple[str, str]:
    """Rolling window ending today, formatted like the desktop's ISO strings."""
    end = today or datetime.now(timezone.utc).date()
    start = end - timedelta(days=DEFAULT_WINDOW_DAYS - 1)
    return f"{start.isoformat()}T00:00:00Z", f"{end.isoformat()}T00:00:00Z"


def calculate_native_dimensions(bbox: list[float], resolution_m: float = 10.0) -> tuple[int, int]:
    """Desktop sentinel_client.calculate_native_dimensions (unchanged)."""
    west, south, east, north = bbox
    lat_mid = (south + north) / 2
    meters_per_deg_lon = 111_320 * math.cos(math.radians(lat_mid))
    meters_per_deg_lat = 111_320
    width_m = (east - west) * meters_per_deg_lon
    height_m = (north - south) * meters_per_deg_lat
    return round(width_m / resolution_m), round(height_m / resolution_m)


def _normalize_date(value: str, end_of_day: bool = False) -> str:
    """Accept 'YYYY-MM-DD' or a full ISO timestamp; return a Copernicus string."""
    text = (value or "").strip()
    if not text:
        raise SatelliteError("Empty date value.")
    try:
        if len(text) == 10:
            parsed = date.fromisoformat(text)
            suffix = "T23:59:59Z" if end_of_day else "T00:00:00Z"
            return f"{parsed.isoformat()}{suffix}"
        parsed_dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise SatelliteError(f"Invalid date '{value}'; expected YYYY-MM-DD or ISO-8601.") from exc


class SatelliteClient:
    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        cache_dir: str | Path | None = None,
        token_ttl_seconds: int = TOKEN_TTL_SECONDS,
        session: requests.Session | None = None,
    ) -> None:
        self._client_id = client_id if client_id is not None else os.getenv("COPERNICUS_CLIENT_ID")
        self._client_secret = (
            client_secret if client_secret is not None else os.getenv("COPERNICUS_CLIENT_SECRET")
        )
        if cache_dir is None:
            configured = os.getenv("SATELLITE_CACHE_DIR")
            cache_dir = configured if configured else Path(tempfile.gettempdir()) / "geocluster-satellite-cache"
        self.cache_dir = Path(cache_dir)
        self._token_ttl = int(token_ttl_seconds)
        self._session = session or requests.Session()
        self._token: str | None = None
        self._token_expires_at = 0.0

    @property
    def configured(self) -> bool:
        return bool(self._client_id and self._client_secret)

    def _require_credentials(self) -> tuple[str, str]:
        if not self.configured:
            raise SatelliteUnavailable(
                "Satellite imagery is not configured: COPERNICUS_CLIENT_ID / "
                "COPERNICUS_CLIENT_SECRET are missing."
            )
        return str(self._client_id), str(self._client_secret)

    def get_access_token(self) -> str:
        """Exchange credentials for a token, cached for under 10 minutes."""
        now = time.monotonic()
        if self._token and now < self._token_expires_at:
            return self._token
        client_id, client_secret = self._require_credentials()
        try:
            response = self._session.post(
                TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            payload = response.json()
        except requests.RequestException as exc:
            # Never include the response body here: it may echo credentials.
            logger.error("Copernicus token request failed: %s", exc.__class__.__name__)
            raise SatelliteError("Could not authenticate with Copernicus.") from exc
        except ValueError as exc:
            logger.error("Copernicus token response was not JSON.")
            raise SatelliteError("Could not authenticate with Copernicus.") from exc
        token = payload.get("access_token")
        if not token:
            logger.error("Copernicus token response contained no access_token.")
            raise SatelliteError("Could not authenticate with Copernicus.")
        expires_in = payload.get("expires_in", self._token_ttl)
        try:
            lifetime = float(expires_in)
        except (TypeError, ValueError):
            lifetime = float(self._token_ttl)
        self._token = str(token)
        self._token_expires_at = now + max(30.0, min(lifetime - 30.0, float(self._token_ttl)))
        return self._token

    def cache_path(self, location_name: str) -> Path:
        return self.cache_dir / f"{sanitize_location(location_name)}.png"

    def fetch(
        self,
        location_name: str,
        start: str | None = None,
        end: str | None = None,
        width: int | None = None,
        height: int | None = None,
        use_cache: bool = True,
    ) -> tuple[bytes, dict[str, object]]:
        """Return (png_bytes, meta). The cache is checked before the network."""
        cache_path = self.cache_path(location_name)
        if use_cache and cache_path.is_file():
            return cache_path.read_bytes(), {"cached": True, "path": str(cache_path)}

        bbox = get_sector_bbox(location_name)
        if width is None or height is None:
            width, height = calculate_native_dimensions(bbox)
        default_start, default_end = default_date_window()
        date_from = _normalize_date(start) if start else default_start
        date_to = _normalize_date(end, end_of_day=True) if end else default_end
        if date_from > date_to:
            raise SatelliteError("The start date must not be after the end date.")

        token = self.get_access_token()
        payload = {
            "input": {
                "bounds": {"bbox": bbox},
                "data": [
                    {
                        "type": "sentinel-2-l2a",
                        "dataFilter": {
                            "timeRange": {"from": date_from, "to": date_to},
                            "mosaickingOrder": "leastCC",
                        },
                    }
                ],
            },
            "output": {
                "width": int(width),
                "height": int(height),
                "responses": [{"identifier": "default", "format": {"type": "image/png"}}],
            },
            "evalscript": TRUE_COLOR_EVALSCRIPT,
        }
        try:
            response = self._session.post(
                PROCESS_URL,
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            logger.error("Copernicus process request failed: %s", exc.__class__.__name__)
            raise SatelliteError("The satellite imagery request failed.") from exc

        content = response.content
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(content)
        except OSError as exc:  # cache failures must not fail the request
            logger.warning("Could not write satellite cache file: %s", exc.__class__.__name__)
        return content, {
            "cached": False,
            "path": str(cache_path),
            "bbox": bbox,
            "width": int(width),
            "height": int(height),
            "date_from": date_from,
            "date_to": date_to,
        }
