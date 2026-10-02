"""Stateless GCH2 text: compress an image, decompress a .gch file."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile

import settings
from dependencies import require_auth
from geocluster import huffman
from geocluster.errors import HuffmanError, ImageValidationError
from geocluster.images import decode_image
from uploads import read_upload_capped

router = APIRouter(prefix="/huffman", tags=["huffman"], dependencies=[Depends(require_auth)])


@router.post("/compress")
async def compress_image(
    file: UploadFile = File(..., description="Any supported image; output is a .gch (GCH2) file"),
) -> Response:
    max_bytes = int(settings.MAX_UPLOAD_MB * 1024 * 1024)
    data = await read_upload_capped(file, max_bytes, "image")
    try:
        image = decode_image(data)
    except ImageValidationError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    try:
        payload, _meta = huffman.compress(image)
    except HuffmanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="image.gch"'},
    )


@router.post("/decompress")
async def decompress_image(
    file: UploadFile = File(..., description="A .gch (GCH2) file produced by the desktop app or this API"),
) -> Response:
    max_bytes = int(settings.MAX_UPLOAD_MB * 1024 * 1024)
    data = await read_upload_capped(file, max_bytes, "file")
    try:
        image, _meta = huffman.decompress(data)
    except HuffmanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        from geocluster.images import encode_png

        payload = encode_png(image)
    except ImageValidationError as exc:  # pragma: no cover - encoding of decoded data
        raise HTTPException(status_code=500, detail="Failed to encode the decoded image.") from exc
    return Response(
        content=payload,
        media_type="image/png",
        headers={"Content-Disposition": 'attachment; filename="decompressed.png"'},
    )
