"""Satellite imagery fetch (Copernicus Sentinel-2), cached and rate limited.

The request comes in one of two shapes:

* ``mode="place"`` — a sector code (F-8), a known alias (NUST), or any place
  name. Only a *sector/alias* is resolved locally; anything else is looked up
  with Nominatim and reduced to its center point, around which the requested
  square is built. The assistant router never supplies coordinates — it only
  ever forwards the place text, and the lookup happens here.
* ``mode="bbox"`` — two opposite corners as pasted from Google Maps; they are
  sorted into min/max, so the corner order does not matter.

``SATELLITE_MAX_KM`` (default 5) caps the side of any crop; a larger request or
an out-of-range coordinate is answered with a 422 whose ``detail`` is a plain
sentence the frontend can show as-is. ``refresh=true`` skips the cache.

The request model lives here rather than in ``api/schemas.py`` so this change
stays inside the satellite router: it extends the shared
``SatelliteFetchRequest`` with the new optional fields, and the older
``{session_id, location, start, end}`` body keeps working unchanged.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field

import schemas
import settings as runtime_settings
from dependencies import get_store, require_auth
from geocluster.errors import SatelliteError, SatelliteUnavailable
from geocluster.images import decode_image, downscale_to_limit
from geocluster.locations import LocationNotFound
from geocluster.places import parse_coordinate_pair
from geocluster.satellite import RESOLUTION_M, sanitize_location
from ratelimit import client_key, rate_limit_dependency
from sessions import SessionStore

router = APIRouter(prefix="/satellite", tags=["satellite"], dependencies=[Depends(require_auth)])


class SatelliteFetchRequest(schemas.SatelliteFetchRequest):
    """`schemas.SatelliteFetchRequest` + place size, corner mode and refresh."""

    # place mode may also be a free-text place name, so the label is optional
    location: Optional[str] = Field(None, min_length=1, max_length=120)
    mode: Literal["place", "bbox"] = "place"
    size_km: Optional[float] = Field(
        None, description="Side of the square in km (place mode); capped by SATELLITE_MAX_KM"
    )
    corner1: Optional[str] = Field(None, max_length=64, description="'lat, lon' (bbox mode)")
    corner2: Optional[str] = Field(None, max_length=64, description="'lat, lon' (bbox mode)")
    refresh: bool = Field(False, description="Skip the cache and download a fresh crop")


def _rate_limit(request: Request) -> None:
    limiter = getattr(request.app.state, "satellite_limiter", None)
    if limiter is None:
        return
    dependency = rate_limit_dependency(limiter, "Too many satellite requests; try again shortly.")
    dependency(request)


@router.post("/fetch", response_model=schemas.ImageOut)
def fetch_satellite_image(
    request: SatelliteFetchRequest,
    http_request: Request,
    store: SessionStore = Depends(get_store),
) -> schemas.ImageOut:
    _rate_limit(http_request)
    store.get(request.session_id)  # 404 before touching the network
    client = http_request.app.state.satellite

    kwargs: dict[str, object] = {
        "mode": request.mode,
        "size_km": request.size_km,
        "refresh": request.refresh,
        "start": request.start,
        "end": request.end,
    }
    if request.mode == "bbox":
        try:
            kwargs["corner1"] = parse_coordinate_pair(request.corner1 or "", label="Corner 1")
            kwargs["corner2"] = parse_coordinate_pair(request.corner2 or "", label="Corner 2")
        except SatelliteError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        kwargs["location_name"] = request.location

    try:
        content, meta = client.fetch(**kwargs)  # type: ignore[arg-type]
    except SatelliteUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LocationNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SatelliteError as exc:
        # invalid size / corners / dates are the caller's mistake, not the provider's
        invalid = any(
            marker in str(exc)
            for marker in (
                "too large", "must be", "outside", "is empty", "same point",
                "greater than 0", "the limit is", "Move the corners", "is required",
            )
        )
        raise HTTPException(status_code=422 if invalid else 502, detail=str(exc)) from exc

    try:
        image = decode_image(content)
    except Exception as exc:  # noqa: BLE001 - upstream payload is untrusted
        raise HTTPException(status_code=502, detail="The satellite provider returned an unusable image.") from exc

    stored_image, scale = downscale_to_limit(image, runtime_settings.MAX_IMAGE_MEGAPIXELS)
    name = f"{sanitize_location(str(meta.get('label') or request.location or 'satellite'))}.png"
    # Ground scale: the provider's resolution is metres per pixel at the native
    # size; a downscale makes every stored pixel that much wider on the ground.
    native_meters_per_pixel = float(meta.get("resolution_m") or RESOLUTION_M)
    meters_per_pixel = native_meters_per_pixel / scale if scale > 0 else native_meters_per_pixel
    bbox = meta.get("bbox")
    stored = store.add_image(
        request.session_id,
        stored_image,
        name=name,
        original_size=(int(image.shape[1]), int(image.shape[0])),
        scale=scale,
        source="satellite",
        bbox=[float(value) for value in bbox] if bbox else None,
        meters_per_pixel=meters_per_pixel,
    )
    return schemas.ImageOut.from_stored(request.session_id, stored)
