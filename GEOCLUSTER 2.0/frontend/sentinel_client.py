import math
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

from frontend.location_database import get_sector_bbox

load_dotenv()

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

# NUST H-12 campus, Islamabad — bounding box derived from published
# GIS survey corner coordinates (west, south, east, north)
NUST_H12_BBOX = [72.977942, 33.633664, 73.005167, 33.662233]

# True-color evalscript: combines Red, Green, Blue bands (B04, B03, B02)
# into a normal-looking satellite photo, with brightness scaling since
# raw Sentinel-2 reflectance values are otherwise very dark.
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


def get_access_token() -> str:
    """
    Exchanges Client ID + Client Secret for a temporary access token.
    Tokens expire (usually ~10 min), so call this fresh before each
    Sentinel-2 request rather than caching it long-term.
    """
    client_id = os.environ.get("COPERNICUS_CLIENT_ID")
    client_secret = os.environ.get("COPERNICUS_CLIENT_SECRET")

    if not client_id or not client_secret:
        raise RuntimeError(
            "Missing COPERNICUS_CLIENT_ID or COPERNICUS_CLIENT_SECRET. "
            "Check your .env file."
        )

    response = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    response.raise_for_status()
    return response.json()["access_token"]


def calculate_native_dimensions(
    bbox: list[float],
    resolution_m: float = 10.0,
) -> tuple[int, int]:
    """
    Calculates the width/height in pixels that matches Sentinel-2's
    actual native resolution for the given bounding box.
    """
    west, south, east, north = bbox

    lat_mid = (south + north) / 2
    meters_per_deg_lon = 111_320 * math.cos(math.radians(lat_mid))
    meters_per_deg_lat = 111_320

    width_m = (east - west) * meters_per_deg_lon
    height_m = (north - south) * meters_per_deg_lat

    width_px = round(width_m / resolution_m)
    height_px = round(height_m / resolution_m)

    return width_px, height_px


def fetch_sentinel_image(
    bbox: list[float] = NUST_H12_BBOX,
    output_path: str = "data/nust_h12_sentinel.png",
    width: int | None = None,
    height: int | None = None,
    date_from: str = "2026-05-01T00:00:00Z",
    date_to: str = "2026-07-01T00:00:00Z",
) -> str:
    """
    Fetches a true-color Sentinel-2 image cropped to the given bounding
    box and saves it as a PNG.
    """

    token = get_access_token()

    if width is None or height is None:
        width, height = calculate_native_dimensions(bbox)
        print(f"Using native resolution: {width}x{height} px (10m/pixel)")

    request_payload = {
        "input": {
            "bounds": {
                "bbox": bbox,
            },
            "data": [
                {
                    "type": "sentinel-2-l2a",
                    "dataFilter": {
                        "timeRange": {
                            "from": date_from,
                            "to": date_to,
                        },
                        "mosaickingOrder": "leastCC",
                    },
                }
            ],
        },
        "output": {
            "width": width,
            "height": height,
            "responses": [
                {
                    "identifier": "default",
                    "format": {"type": "image/png"},
                }
            ],
        },
        "evalscript": TRUE_COLOR_EVALSCRIPT,
    }

    response = requests.post(
        PROCESS_URL,
        headers={"Authorization": f"Bearer {token}"},
        json=request_payload,
    )
    response.raise_for_status()

    # Save relative paths inside the GEOCLUSTER project root
    output_path = Path(output_path)

    if not output_path.is_absolute():
        project_root = Path(__file__).resolve().parent.parent
        output_path = project_root / output_path

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(response.content)

    return str(output_path)

def fetch_sector_image(
    location_name: str,
    output_folder: str = "data/cache",
) -> str:
    """
    Downloads Sentinel-2 imagery for an Islamabad sector or alias.

    Examples:
        F-8
        F-7
        H-12
        Centaurus
        NUST

    Returns
    -------
    str
        Absolute path to the downloaded PNG.
    """

    bbox = get_sector_bbox(location_name)

    filename = (
        location_name.strip()
        .upper()
        .replace(" ", "_")
        .replace("/", "_")
        + ".png"
    )

    output_path = Path(output_folder) / filename

    return fetch_sentinel_image(
        bbox=bbox,
        output_path=str(output_path),
    )

if __name__ == "__main__":
    token = get_access_token()

    print("Successfully obtained access token.")
    print("Token (first 30 chars):", token[:30], "...")

    print("\nFetching Sentinel-2 imagery for NUST H-12 campus...")

    saved_path = fetch_sentinel_image()

    print(f"Saved image to: {saved_path}")