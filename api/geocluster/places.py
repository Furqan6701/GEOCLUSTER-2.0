"""Place-name lookup for satellite fetches (Nominatim / OpenStreetMap).

Only the **center point** of a place is ever used. The square that is actually
downloaded is built around that point from the requested size, so a "2 km"
request always means a 2 km square, whatever the place is. Nominatim's own
bounding box is deliberately ignored: it is a text-match envelope that ranges
from a single building to a whole country, which would make the downloaded crop
unpredictable (and could request an area far beyond any sane limit).

Two operational rules come from Nominatim's usage policy and are enforced here:

* a real ``User-Agent`` identifying the application (never a browser string);
* at most **one request per second**, applied per process and shared by every
  caller, with results cached on disk so a repeated lookup costs nothing.

Nothing in this module is reachable from the chat model: the assistant router
only ever forwards the place *text*, and the coordinates are resolved here.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from pathlib import Path

import requests

from .errors import SatelliteError
from .locations import LocationNotFound

logger = logging.getLogger("geocluster.places")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = os.getenv(
    "NOMINATIM_USER_AGENT",
    "GeoCluster/2.0 (Sentinel-2 crop fetch; +https://github.com/Furqan6701/GEOCLUSTER-2.0)",
)
MIN_INTERVAL_SECONDS = 1.0
REQUEST_TIMEOUT_SECONDS = 20

# A place lookup is a text query, never a coordinate source for the model.
DEFAULT_SIZE_KM = 2.0
EARTH_METRES_PER_DEGREE = 111_320.0


def max_size_km() -> float:
    """Hard per-side limit for a satellite crop (env ``SATELLITE_MAX_KM``)."""
    raw = os.getenv("SATELLITE_MAX_KM")
    if raw is None or str(raw).strip() == "":
        return 5.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        logger.warning("SATELLITE_MAX_KM is not a number; using the default of 5 km.")
        return 5.0
    return value if value > 0 else 5.0


def validate_size(size_km: float | None, *, limit: float | None = None) -> float:
    """Return a usable size in km or raise SatelliteError with a 422-worthy text."""
    ceiling = max_size_km() if limit is None else limit
    if size_km is None:
        size_km = DEFAULT_SIZE_KM
    try:
        value = float(size_km)
    except (TypeError, ValueError) as exc:
        raise SatelliteError("The area size must be a number of kilometres.") from exc
    if not math.isfinite(value):
        raise SatelliteError("The area size must be a number of kilometres.")
    if value <= 0:
        raise SatelliteError("The area size must be greater than 0 km.")
    if value > ceiling + 1e-9:
        raise SatelliteError(
            f"The area is too large: {value:g} km per side, but the limit is "
            f"{ceiling:g} km (SATELLITE_MAX_KM)."
        )
    return value


def validate_coordinates(lat: float, lon: float, *, label: str = "Coordinate") -> tuple[float, float]:
    """Range-check a latitude/longitude pair."""
    try:
        lat_value = float(lat)
        lon_value = float(lon)
    except (TypeError, ValueError) as exc:
        raise SatelliteError(f"{label} must be a latitude and a longitude number.") from exc
    if not (math.isfinite(lat_value) and math.isfinite(lon_value)):
        raise SatelliteError(f"{label} must be a latitude and a longitude number.")
    if not -90.0 <= lat_value <= 90.0:
        raise SatelliteError(f"{label}: latitude {lat_value:g} is outside -90…90.")
    if not -180.0 <= lon_value <= 180.0:
        raise SatelliteError(f"{label}: longitude {lon_value:g} is outside -180…180.")
    return lat_value, lon_value


def parse_coordinate_pair(text: str, *, label: str = "Coordinate") -> tuple[float, float]:
    """Parse 'lat, lon' (what Google Maps copies) or 'lat lon'.

    Google Maps' "copy coordinates" gives e.g. ``33.6844, 73.0479`` and a
    placemark URL gives ``33.6844° N, 73.0479° E`` — the degree signs and the
    hemisphere letters are tolerated, anything else is a clear error.
    """
    raw = (text or "").strip()
    if not raw:
        raise SatelliteError(f"{label} is empty — paste 'lat, lon'.")
    cleaned = (
        raw.replace("°", " ")
        .replace(",", " ")
        .replace(";", " ")
        .replace("(", " ")
        .replace(")", " ")
    )
    cleaned = cleaned.replace("N", " ").replace("S", " ").replace("E", " ").replace("W", " ")
    parts = [piece for piece in cleaned.split() if piece]
    if len(parts) != 2:
        raise SatelliteError(
            f"{label} must look like 'lat, lon' (for example 33.6844, 73.0479) — got '{raw}'."
        )
    try:
        lat = float(parts[0])
        lon = float(parts[1])
    except ValueError as exc:
        raise SatelliteError(
            f"{label} must be two numbers, 'lat, lon' — got '{raw}'."
        ) from exc
    return validate_coordinates(lat, lon, label=label)


def square_bbox(lat: float, lon: float, size_km: float) -> list[float]:
    """A square of ``size_km`` per side centred on (lat, lon): [W, S, E, N]."""
    half_m = (size_km * 1000.0) / 2.0
    half_lat = half_m / EARTH_METRES_PER_DEGREE
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    half_lon = half_m / (EARTH_METRES_PER_DEGREE * cos_lat)
    west, east = lon - half_lon, lon + half_lon
    south, north = lat - half_lat, lat + half_lat
    if west < -180 or east > 180 or south < -90 or north > 90:
        raise SatelliteError("That square would leave the valid latitude/longitude range.")
    return [west, south, east, north]


def bbox_from_corners(
    corner1: tuple[float, float],
    corner2: tuple[float, float],
    *,
    limit: float | None = None,
) -> list[float]:
    """Envelope of two opposite corners, min/max sorted (any corner order works)."""
    corner1 = validate_coordinates(*corner1, label="Corner 1")
    corner2 = validate_coordinates(*corner2, label="Corner 2")
    west = min(corner1[1], corner2[1])
    east = max(corner1[1], corner2[1])
    south = min(corner1[0], corner2[0])
    north = max(corner1[0], corner2[0])
    if east - west <= 0 and north - south <= 0:
        raise SatelliteError("The two corners are the same point — the area would be empty.")
    ceiling = max_size_km() if limit is None else limit
    side_km = max(
        (north - south) * EARTH_METRES_PER_DEGREE / 1000.0,
        (east - west) * EARTH_METRES_PER_DEGREE * max(math.cos(math.radians((north + south) / 2)), 1e-6) / 1000.0,
    )
    if side_km > ceiling + 1e-9:
        raise SatelliteError(
            f"That area is {side_km:.1f} km per side, but the limit is {ceiling:g} km "
            "(SATELLITE_MAX_KM). Move the corners closer together."
        )
    return [west, south, east, north]


class NominatimThrottle:
    """At most one Nominatim request per second, shared by every caller."""

    def __init__(self, min_interval: float = MIN_INTERVAL_SECONDS, clock=time.monotonic, sleep=time.sleep) -> None:
        self.min_interval = float(min_interval)
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._last_request_at: float | None = None

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            if self._last_request_at is not None:
                remaining = self.min_interval - (now - self._last_request_at)
                if remaining > 0:
                    self._sleep(remaining)
                    now = self._clock()
            self._last_request_at = now


class PlaceLookup:
    """Nominatim lookups with an on-disk cache and the 1 req/s throttle."""

    def __init__(
        self,
        cache_dir: str | Path | None = None,
        session: requests.Session | None = None,
        throttle: NominatimThrottle | None = None,
        url: str = NOMINATIM_URL,
        user_agent: str = USER_AGENT,
    ) -> None:
        if cache_dir is None:
            configured = os.getenv("SATELLITE_CACHE_DIR")
            base = Path(configured) if configured else Path(__import__("tempfile").gettempdir()) / "geocluster-satellite-cache"
            cache_dir = base
        self.cache_dir = Path(cache_dir) / "places"
        self._session = session or requests.Session()
        self._throttle = throttle or NominatimThrottle()
        self._url = url
        self._user_agent = user_agent
        self._memory: dict[str, dict] = {}

    # -------------------------------------------------------------- cache
    @staticmethod
    def normalize(place: str) -> str:
        return " ".join((place or "").split()).lower()

    def _cache_file(self, query: str) -> Path:
        import hashlib

        digest = hashlib.sha256(self.normalize(query).encode("utf-8")).hexdigest()[:20]
        return self.cache_dir / f"{digest}.json"

    def cached(self, place: str) -> dict | None:
        query = self.normalize(place)
        if query in self._memory:
            return self._memory[query]
        path = self._cache_file(place)
        try:
            if path.is_file():
                payload = json.loads(path.read_text(encoding="utf-8"))
                if payload.get("query") == query and "lat" in payload and "lon" in payload:
                    self._memory[query] = payload
                    return payload
        except (OSError, ValueError):
            logger.warning("Ignoring an unreadable place cache entry.")
        return None

    def _store(self, query: str, payload: dict) -> None:
        self._memory[query] = payload
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._cache_file(query).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:  # a cache that cannot be written must not fail the fetch
            logger.warning("Could not write the place cache: %s", exc.__class__.__name__)

    # ------------------------------------------------------------- lookup
    def resolve(self, place: str, *, refresh: bool = False) -> dict:
        """Resolve a place name to its center point.

        Returns ``{"query", "lat", "lon", "display_name", "cached"}``. Only the
        center is used downstream — never Nominatim's bounding box.
        """
        name = (place or "").strip()
        if not name:
            raise LocationNotFound("No place name given.")
        query = self.normalize(name)
        if not refresh:
            hit = self.cached(name)
            if hit is not None:
                return {**hit, "cached": True}

        self._throttle.wait()
        try:
            response = self._session.get(
                self._url,
                params={"q": name, "format": "jsonv2", "limit": 1, "addressdetails": 0},
                headers={"User-Agent": self._user_agent, "Accept": "application/json"},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            results = response.json()
        except requests.RequestException as exc:
            raise SatelliteError("Could not reach the place lookup service (Nominatim).") from exc
        except ValueError as exc:
            raise SatelliteError("The place lookup service returned an unusable answer.") from exc

        if not isinstance(results, list) or not results:
            raise LocationNotFound(
                f"No place called '{name}' was found. Use a sector code (F-8, H-12 …), "
                "a known alias, or paste coordinates instead."
            )
        best = results[0]
        try:
            lat = float(best["lat"])
            lon = float(best["lon"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SatelliteError("The place lookup service returned an unusable answer.") from exc
        payload = {
            "query": query,
            "lat": lat,
            "lon": lon,
            "display_name": str(best.get("display_name") or name),
        }
        self._store(query, payload)
        return {**payload, "cached": False}
