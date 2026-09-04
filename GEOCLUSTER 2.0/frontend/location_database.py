from dataclasses import dataclass
from pathlib import Path
import json
import math

# Size of the fetched area (meters)
SECTOR_WIDTH_METERS = 2600
SECTOR_HEIGHT_METERS = 2600

@dataclass(frozen=True)
class Sector:
    code: str
    latitude: float
    longitude: float


# GEOCLUSTER root folder
PROJECT_ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = PROJECT_ROOT / "data"

SECTORS_FILE = DATA_DIR / "islamabad_sectors.json"
ALIASES_FILE = DATA_DIR / "islamabad_aliases.json"


def load_sectors() -> dict[str, Sector]:
    with open(SECTORS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    sectors = {}

    for code, info in data.items():
        sectors[code.upper()] = Sector(
            code=code.upper(),
            latitude=info["lat"],
            longitude=info["lon"]
        )

    return sectors


def load_aliases() -> dict[str, str]:
    with open(ALIASES_FILE, "r", encoding="utf-8") as f:
        aliases = json.load(f)

    return {k.lower(): v.upper() for k, v in aliases.items()}


def get_sector(location_name: str) -> Sector:
    """
    Returns a Sector object from either:
    - official sector code (F-8)
    - alias (centaurus, nust, etc.)
    """

    sectors = load_sectors()
    aliases = load_aliases()

    name = location_name.strip()

    # Try official sector code first
    sector_code = name.upper()

    if sector_code in sectors:
        return sectors[sector_code]

    # Try alias
    alias = name.lower()

    if alias in aliases:
        return sectors[aliases[alias]]

    raise ValueError(f"Unknown location: {location_name}")

def get_sector_bbox(
    location_name: str,
    width_m: float = SECTOR_WIDTH_METERS,
    height_m: float = SECTOR_HEIGHT_METERS,
) -> list[float]:
    """
    Returns a Copernicus-compatible bounding box:
    [west, south, east, north]
    """

    sector = get_sector(location_name)

    lat = sector.latitude
    lon = sector.longitude

    # Convert metres to degrees
    half_lat = (height_m / 2) / 111320

    half_lon = (
        (width_m / 2)
        / (111320 * math.cos(math.radians(lat)))
    )

    west = lon - half_lon
    east = lon + half_lon
    south = lat - half_lat
    north = lat + half_lat

    return [west, south, east, north]