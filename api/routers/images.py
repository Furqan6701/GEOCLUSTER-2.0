"""Image upload and download."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile

import schemas
import settings
from dependencies import get_store, require_auth
from geocluster.errors import ImageValidationError
from geocluster.images import decode_image, downscale_to_limit, encode
from sessions import SessionStore
from uploads import read_upload_capped

router = APIRouter(prefix="/sessions", tags=["images"], dependencies=[Depends(require_auth)])


@router.post("/{session_id}/images", status_code=201, response_model=schemas.ImageOut)
async def upload_image(
    session_id: str,
    file: UploadFile = File(..., description="JPEG, PNG, BMP or TIFF image"),
    store: SessionStore = Depends(get_store),
) -> schemas.ImageOut:
    max_bytes = int(settings.MAX_UPLOAD_MB * 1024 * 1024)
    data = await read_upload_capped(file, max_bytes, "image")
    try:
        image = decode_image(data)
    except ImageValidationError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    original_width, original_height = int(image.shape[1]), int(image.shape[0])
    stored_image, scale = downscale_to_limit(image, settings.MAX_IMAGE_MEGAPIXELS)
    stored = store.add_image(
        session_id,
        stored_image,
        name=file.filename or "upload",
        original_size=(original_width, original_height),
        scale=scale,
        source="upload",
    )
    return schemas.ImageOut.from_stored(session_id, stored)


@router.get("/{session_id}/images/{image_id}")
def download_image(
    session_id: str,
    image_id: str,
    format: str = Query("png", pattern="^(png|jpeg|jpg)$"),
    store: SessionStore = Depends(get_store),
) -> Response:
    stored = store.get_image(session_id, image_id)
    try:
        data, media_type = encode(stored.image, format)
    except ImageValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    extension = "jpg" if format in ("jpeg", "jpg") else "png"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{image_id}.{extension}"'},
    )
