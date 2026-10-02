"""Satellite imagery fetch (Copernicus Sentinel-2), cached and rate limited."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

import schemas
import settings as runtime_settings
from dependencies import get_store, require_auth
from geocluster.errors import SatelliteError, SatelliteUnavailable
from geocluster.images import decode_image, downscale_to_limit
from geocluster.locations import LocationNotFound
from geocluster.satellite import sanitize_location
from ratelimit import client_key, rate_limit_dependency
from sessions import SessionStore

router = APIRouter(prefix="/satellite", tags=["satellite"], dependencies=[Depends(require_auth)])


def _rate_limit(request: Request) -> None:
    limiter = getattr(request.app.state, "satellite_limiter", None)
    if limiter is None:
        return
    dependency = rate_limit_dependency(limiter, "Too many satellite requests; try again shortly.")
    dependency(request)


@router.post("/fetch", response_model=schemas.ImageOut)
def fetch_satellite_image(
    request: schemas.SatelliteFetchRequest,
    http_request: Request,
    store: SessionStore = Depends(get_store),
) -> schemas.ImageOut:
    _rate_limit(http_request)
    store.get(request.session_id)  # 404 before touching the network
    client = http_request.app.state.satellite
    try:
        content, _meta = client.fetch(request.location, request.start, request.end)
    except SatelliteUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LocationNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SatelliteError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    try:
        image = decode_image(content)
    except Exception as exc:  # noqa: BLE001 - upstream payload is untrusted
        raise HTTPException(status_code=502, detail="The satellite provider returned an unusable image.") from exc

    stored_image, scale = downscale_to_limit(image, runtime_settings.MAX_IMAGE_MEGAPIXELS)
    stored = store.add_image(
        request.session_id,
        stored_image,
        name=f"{sanitize_location(request.location)}.png",
        original_size=(int(image.shape[1]), int(image.shape[0])),
        scale=scale,
        source="satellite",
    )
    return schemas.ImageOut.from_stored(request.session_id, stored)
