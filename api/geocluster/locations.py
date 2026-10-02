"""Sector and alias lookup (PyQt-free port of desktop location_database.py).

The two JSON data files are copied verbatim into geocluster/data/ so the API
package is self-contained.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from .errors import GeoclusterError

DATA_DIR = Path(__file__).resolve().parent / "data"
SECTORS_FILE = DATA_DIR / "islamabad_sectors.json"
ALIASES_FILE = DATA_DIR / "islamabad_aliases.json"

SECTOR_WIDTH_METERS = 2600
SECTOR_HEIGHT_METERS = 2600


class LocationNotFound(GeoclusterError):
    """The requested sector/alias is unknown."""


@dataclass(frozen=True)
class Sector:
    code: str
    latitude: float
    longitude: float


def load_sectors() -> dict[str, Sector]:
    with SECTORS_FILE.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return {
        code.upper(): Sector(code=code.upper(), latitude=info["lat"], longitude=info["lon"])
        for code, info in data.items()
    }


def load_aliases() -> dict[str, str]:
    with ALIASES_FILE.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return {key.lower(): value.upper() for key, value in data.items()}


def get_sector(location_name: str) -> Sector:
    """Resolve an official sector code or an alias to a Sector."""
    sectors = load_sectors()
    aliases = load_aliases()
    name = (location_name or "").strip()
    if not name:
        raise LocationNotFound("No location name given.")
    if name.upper() in sectors:
        return sectors[name.upper()]
    if name.lower() in aliases:
        return sectors[aliases[name.lower()]]
    raise LocationNotFound(f"Unknown location: {location_name}")


def get_sector_bbox(
    location_name: str,
    width_m: float = SECTOR_WIDTH_METERS,
    height_m: float = SECTOR_HEIGHT_METERS,
) -> list[float]:
    """Copernicus-compatible bounding box [west, south, east, north]."""
    sector = get_sector(location_name)
    half_lat = (height_m / 2) / 111320
    half_lon = (width_m / 2) / (111320 * math.cos(math.radians(sector.latitude)))
    return [
        sector.longitude - half_lon,
        sector.latitude - half_lat,
        sector.longitude + half_lon,
        sector.latitude + half_lat,
    ]


def catalog() -> dict[str, object]:
    """Sectors and aliases as plain JSON-serializable data."""
    sectors = load_sectors()
    aliases = load_aliases()
    return {
        "sectors": {
            code: {"latitude": sector.latitude, "longitude": sector.longitude}
            for code, sector in sectors.items()
        },
        "aliases": dict(sorted(aliases.items())),
    }
