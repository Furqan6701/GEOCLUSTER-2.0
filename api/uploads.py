"""Multipart upload helper: enforces the size cap while streaming."""

from __future__ import annotations

from fastapi import HTTPException, UploadFile

CHUNK_SIZE = 1 << 20


async def read_upload_capped(file: UploadFile, max_bytes: int, description: str = "upload") -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"The {description} exceeds the maximum allowed size of "
                    f"{max_bytes / (1024 * 1024):.0f} MB."
                ),
            )
        chunks.append(chunk)
    return b"".join(chunks)
