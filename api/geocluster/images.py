"""Image decoding, encoding, validation and the downscale policy.

Decoding mirrors the desktop (cv2.IMREAD_UNCHANGED, see ui.load_image) so
grayscale and alpha images keep their channels. Non-uint8 data (16-bit TIFFs,
float HDR files) is normalized to uint8 before processing; the policy is
documented in docs/migration-decisions.md.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from .errors import ImageValidationError

Array = np.ndarray

SUPPORTED_FORMATS = ("jpeg", "png", "bmp", "tiff")

_MAGIC_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"BM", "bmp"),
    (b"II*\x00", "tiff"),
    (b"MM\x00*", "tiff"),
)


def sniff_format(data: bytes) -> str | None:
    """Identify the container format from magic bytes (never the extension)."""
    for signature, name in _MAGIC_SIGNATURES:
        if data.startswith(signature):
            return name
    return None


def normalize_dtype(array: Array) -> Array:
    """Convert decoded pixel data to uint8 (documented normalization policy)."""
    if array.dtype == np.uint8:
        return array
    if array.dtype == np.uint16:
        return (array // 257).astype(np.uint8)  # 0..65535 -> 0..255 exactly
    if array.dtype == np.int16:
        return np.clip(array, 0, 255).astype(np.uint8)
    if array.dtype in (np.float32, np.float64):
        peak = float(np.nanmax(array)) if array.size else 0.0
        scaled = array * 255.0 if peak <= 1.0000001 else array
        return np.clip(np.nan_to_num(scaled), 0, 255).astype(np.uint8)
    return np.clip(array, 0, 255).astype(np.uint8)


def decode_image(data: bytes) -> Array:
    """Validate and decode upload bytes into a uint8 NumPy image."""
    if not data:
        raise ImageValidationError("The uploaded file is empty.")
    declared = sniff_format(data)
    if declared is None:
        raise ImageValidationError(
            "Unsupported file format. Only JPEG, PNG, BMP and TIFF images are accepted."
        )
    buffer = np.frombuffer(data, dtype=np.uint8)
    decoded = cv2.imdecode(buffer, cv2.IMREAD_UNCHANGED)
    if decoded is None:
        raise ImageValidationError("The uploaded file could not be decoded as an image.")
    if decoded.ndim not in (2, 3) or (decoded.ndim == 3 and decoded.shape[2] not in (1, 3, 4)):
        raise ImageValidationError("Unsupported channel layout; expected grayscale, BGR or BGRA.")
    if decoded.ndim == 3 and decoded.shape[2] == 1:
        decoded = decoded[:, :, 0]
    return normalize_dtype(np.ascontiguousarray(decoded))


def megapixels(image: Array) -> float:
    return (int(image.shape[0]) * int(image.shape[1])) / 1_000_000.0


def downscale_to_limit(image: Array, max_megapixels: float) -> tuple[Array, float]:
    """Downscale with cv2.INTER_AREA when the image exceeds the megapixel cap."""
    if max_megapixels <= 0:
        return image, 1.0
    current = megapixels(image)
    if current <= max_megapixels:
        return image, 1.0
    scale = math.sqrt(max_megapixels / current)
    # floor (not round) so the result can never exceed the configured cap
    new_width = max(1, int(image.shape[1] * scale))
    new_height = max(1, int(image.shape[0] * scale))
    resized = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_AREA)
    return resized, new_width / float(image.shape[1])


def encode_png(image: Array) -> bytes:
    ok, buffer = cv2.imencode(".png", np.ascontiguousarray(image))
    if not ok:
        raise ImageValidationError("Failed to encode PNG.")
    return buffer.tobytes()


def encode_jpeg(image: Array, quality: int = 90) -> bytes:
    contiguous = np.ascontiguousarray(image)
    if contiguous.ndim == 3 and contiguous.shape[2] == 4:
        contiguous = contiguous[:, :, :3]
    ok, buffer = cv2.imencode(".jpeg", contiguous, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise ImageValidationError("Failed to encode JPEG.")
    return buffer.tobytes()


def encode(image: Array, fmt: str) -> tuple[bytes, str]:
    """Encode for download; returns (bytes, media_type)."""
    fmt = fmt.lower()
    if fmt == "png":
        return encode_png(image), "image/png"
    if fmt in ("jpeg", "jpg"):
        return encode_jpeg(image), "image/jpeg"
    raise ImageValidationError(f"Unsupported output format: {fmt}")
