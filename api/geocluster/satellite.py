"""Copernicus Data Space client with an on-disk cache.

Ported from desktop/frontend/sentinel_client.py with these API-era changes
(all documented in docs/migration-decisions.md):
  * ONE cache-key rule, and it names the whole request: bounding box, size, date
    window and output resolution — not just the location name, which used to
    make "F-8 in July" and "F-8 in October" the same file
  * cache directory configurable, defaulting to a folder under the OS temp dir
  * the default date window is rolling and ends today (the desktop hardcoded
    2026-05-01 .. 2026-07-01)
  * the OAuth token is cached for under 10 minutes (never printed anywhere)
  * credentials are read from the environment only; a missing pair raises
    SatelliteUnavailable (the endpoint answers 503) instead of crashing startup
  * the crop can come from a sector/alias (as before) or from a place name
    resolved by Nominatim, or from two pasted corners; every mode ends up as a
    bounding box + size that is validated against SATELLITE_MAX_KM
  * the Process API is always asked for 10 m per pixel (output width/height are
    computed from the box), which keeps even the 5 km maximum at 500×500 px,
    far below the upload megapixel rule — satellite crops are never downscaled
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
from .locations import get_sector
from .places import (
    EARTH_METRES_PER_DEGREE,
    PlaceLookup,
    bbox_from_corners,
    square_bbox,
    validate_size,
)

logger = logging.getLogger("geocluster.satellite")

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

# Mirrors the desktop hardcoded window length (2026-05-01 -> 2026-07-01) but
# rolls forward so the window always ends today.
DEFAULT_WINDOW_DAYS = 61
TOKEN_TTL_SECONDS = 540  # < 10 minutes
REQUEST_TIMEOUT_SECONDS = 60

#: The Process API is always asked for this ground sampling distance.
RESOLUTION_M = 10.0
#: Default side of a place-name square (km) — the UI's dropdown default.
DEFAULT_SIZE_KM = 2.0
#: Historical size of a sector/alias box when no size is requested (desktop parity).
SECTOR_SIZE_KM = 2.6

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
    """Desktop fetch_sector_image's slug rule (label/name sanitising only).

    Since the cache key rework this is *not* the cache key any more — it names
    the stored image. See ``cache_key`` for what identifies a cached download.
    """
    return (
        location_name.strip()
        .upper()
        .replace(" ", "_")
        .replace("/", "_")
    )


def format_size_km(size_km: float) -> str:
    """'2', '2.5', '0.75' — no trailing zeros, safe for a filename."""
    text = f"{float(size_km):.3f}".rstrip("0").rstrip(".")
    return text or "0"


def cache_key(
    label: str,
    bbox: list[float],
    size_km: float,
    date_from: str,
    date_to: str,
    width: int,
    height: int,
) -> str:
    """Filename for a cached download: label + box + size + dates + resolution.

    Every input that changes the pixels is in the key, so a fetch can never be
    served a crop of a different place, size, season or resolution.
    """
    box = "_".join(f"{float(value):.5f}" for value in bbox)
    window = f"{date_from[:10]}_{date_to[:10]}"
    return f"{sanitize_location(label)}_{format_size_km(size_km)}km_{box}_{window}_{int(width)}x{int(height)}.png"


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
        places: PlaceLookup | None = None,
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
        # place-name resolution (Nominatim) shares the satellite cache folder
        self.places = places if places is not None else PlaceLookup(cache_dir=self.cache_dir)

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

    def cache_path(self, key: str) -> Path:
        """Path of a cached download for a full cache key (see `cache_key`)."""
        return self.cache_dir / key

    # ------------------------------------------------------- request geometry
    def prepare_request(
        self,
        *,
        location_name: str | None = None,
        mode: str = "place",
        corner1: tuple[float, float] | None = None,
        corner2: tuple[float, float] | None = None,
        size_km: float | None = None,
    ) -> dict:
        """Everything that can be decided without touching the network.

        Returns the label/box for a sector or corner request, or marks the
        request as needing a place lookup. Invalid sizes, corners and modes
        raise here, so a bad request is a 422 before any lookup happens.
        """
        if mode not in {"place", "bbox"}:
            raise SatelliteError("The satellite request mode must be 'place' or 'bbox'.")

        if mode == "bbox":
            if corner1 is None or corner2 is None:
                raise SatelliteError("Two corners are required for a coordinate fetch.")
            # bbox_from_corners sorts min/max and rejects anything too large
            bbox = bbox_from_corners(corner1, corner2)
            south, west, north, east = bbox[1], bbox[0], bbox[3], bbox[2]
            side_km = max(
                (north - south) * EARTH_METRES_PER_DEGREE / 1000.0,
                (east - west) * EARTH_METRES_PER_DEGREE
                * max(math.cos(math.radians((north + south) / 2)), 1e-6) / 1000.0,
            )
            # the label doubles as the stored image's name; keep it readable
            return {"label": f"AREA_{south:.4f}_{west:.4f}", "bbox": bbox, "size_km": side_km,
                    "needs_lookup": False}

        name = (location_name or "").strip()
        if not name:
            raise SatelliteError("A place name, sector code or alias is required.")
        try:
            sector = get_sector(name)
        except Exception:  # LocationNotFound — resolve it as a place name instead
            sector = None
        if sector is not None:
            # Known sector/alias: keeps working exactly as before, and the size
            # box still means something — it centres the square on the sector.
            side_km = validate_size(size_km if size_km is not None else SECTOR_SIZE_KM)
            return {
                "label": sector.code,
                "bbox": square_bbox(sector.latitude, sector.longitude, side_km),
                "size_km": side_km,
                "needs_lookup": False,
            }
        side_km = validate_size(size_km if size_km is not None else DEFAULT_SIZE_KM)
        return {"label": name, "bbox": None, "size_km": side_km, "needs_lookup": True, "place": name}

    def complete_request(self, prepared: dict, *, refresh: bool = False) -> dict:
        """Resolve a prepared request into a box (the only network step is the
        place lookup, and only for a place name that is not a sector/alias)."""
        if not prepared.get("needs_lookup"):
            return prepared
        hit = self.places.resolve(prepared["place"], refresh=refresh)
        # only the center point is used — Nominatim's bounding box is ignored
        return {
            **prepared,
            "bbox": square_bbox(hit["lat"], hit["lon"], prepared["size_km"]),
            "place_hit": {"lat": hit["lat"], "lon": hit["lon"], "display_name": hit.get("display_name")},
        }

    def resolve_request(self, *, refresh: bool = False, **kwargs) -> dict:
        """Label + box + output size for one request shape (no credentials needed).

        * ``mode="place"`` — a sector/alias if the name is known, otherwise a
          Nominatim lookup; the square is built around the center point.
        * ``mode="bbox"``  — two opposite corners, any order.
        """
        prepared = self.prepare_request(**kwargs)
        geometry = self.complete_request(prepared, refresh=refresh)
        width, height = calculate_native_dimensions(geometry["bbox"], RESOLUTION_M)
        return {**geometry, "width": width, "height": height}

    def fetch(
        self,
        location_name: str | None = None,
        start: str | None = None,
        end: str | None = None,
        width: int | None = None,
        height: int | None = None,
        use_cache: bool = True,
        *,
        mode: str = "place",
        corner1: tuple[float, float] | None = None,
        corner2: tuple[float, float] | None = None,
        size_km: float | None = None,
        refresh: bool = False,
    ) -> tuple[bytes, dict[str, object]]:
        """Return (png_bytes, meta).

        The cache is keyed by the *whole* request — bounding box, size, date
        window and resolution — and is checked before the network unless
        ``refresh`` (or ``use_cache=False``) asks for a fresh download.
        """
        # 1) local validation (a bad size/corner is the caller's 422, whatever
        #    the credentials look like), 2) credentials, 3) only then any
        #    network step — so an unconfigured server never calls Nominatim
        prepared = self.prepare_request(
            location_name=location_name,
            mode=mode,
            corner1=corner1,
            corner2=corner2,
            size_km=size_km,
        )
        self._require_credentials()
        geometry = self.complete_request(prepared, refresh=refresh)
        geometry["width"], geometry["height"] = calculate_native_dimensions(geometry["bbox"], RESOLUTION_M)
        bbox = geometry["bbox"]
        if width is None or height is None:
            width, height = geometry["width"], geometry["height"]
        default_start, default_end = default_date_window()
        date_from = _normalize_date(start) if start else default_start
        date_to = _normalize_date(end, end_of_day=True) if end else default_end
        if date_from > date_to:
            raise SatelliteError("The start date must not be after the end date.")

        key = cache_key(geometry["label"], bbox, geometry["size_km"], date_from, date_to, int(width), int(height))
        cache_path = self.cache_path(key)
        if use_cache and not refresh and cache_path.is_file():
            return cache_path.read_bytes(), {
                "cached": True,
                "path": str(cache_path),
                "key": key,
                "bbox": bbox,
                "size_km": geometry["size_km"],
                "label": geometry["label"],
                "date_from": date_from,
                "date_to": date_to,
                "width": int(width),
                "height": int(height),
                "resolution_m": RESOLUTION_M,
            }
        if refresh:
            logger.info("Refreshing the satellite cache for %s", geometry["label"])

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
            "key": key,
            "bbox": bbox,
            "size_km": geometry["size_km"],
            "label": geometry["label"],
            "width": int(width),
            "height": int(height),
            "date_from": date_from,
            "date_to": date_to,
            "resolution_m": RESOLUTION_M,
        }
