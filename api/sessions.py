"""In-memory session and image store.

Design (all limits configurable through settings):
  * sessions are keyed by an opaque id (secrets.token_urlsafe) and expire after
    a sliding TTL (default 60 minutes)
  * each session keeps at most SESSION_MAX_IMAGES images (default 6); the
    least-recently-used image is evicted when the cap is exceeded
  * a global memory guard evicts the globally least-recently-used images when
    the store would exceed GLOBAL_MEMORY_MB
  * nothing is written to disk; everything is in-memory NumPy data
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from geocluster.errors import ImageNotFound, SessionLimitError, SessionNotFound

Array = np.ndarray


@dataclass
class StoredImage:
    image_id: str
    name: str
    image: Array
    original_size: tuple[int, int]  # (width, height) as uploaded
    stored_size: tuple[int, int]  # (width, height) after the downscale policy
    scale: float
    source: str = "upload"
    # ground-scale metadata for satellite imagery: the stored pixels cover this
    # box, so one pixel is `meters_per_pixel` wide on the ground. Both are None
    # for uploads, where the scale is unknown (and must stay unknown).
    bbox: list[float] | None = None
    meters_per_pixel: float | None = None
    created_at: float = 0.0
    last_used: float = 0.0

    @property
    def nbytes(self) -> int:
        return int(self.image.nbytes)

    @property
    def channels(self) -> int:
        return 1 if self.image.ndim == 2 else int(self.image.shape[2])

    @property
    def width(self) -> int:
        return int(self.image.shape[1])

    @property
    def height(self) -> int:
        return int(self.image.shape[0])

    @property
    def megapixels(self) -> float:
        return (self.width * self.height) / 1_000_000.0


@dataclass
class Session:
    session_id: str
    created_at: float
    last_used: float
    images: dict[str, StoredImage] = field(default_factory=dict)

    def touch(self, now: float) -> None:
        self.last_used = now


def derive_ground_metadata(source: StoredImage, width: int) -> dict[str, Any]:
    """Ground metadata for an image derived from ``source`` at ``width`` pixels.

    Filters, K-Means and classify keep the source's box, but a result that is
    narrower than its source (a downscale) covers the same ground with fewer
    pixels, so every pixel is wider by exactly that factor. Nothing is invented:
    an image without ground metadata stays without it.
    """
    bbox = list(source.bbox) if source.bbox else None
    meters_per_pixel = source.meters_per_pixel
    if meters_per_pixel is not None:
        new_width = max(1, int(width))
        meters_per_pixel = float(meters_per_pixel) * (source.width / new_width)
    return {"bbox": bbox, "meters_per_pixel": meters_per_pixel}


class SessionStore:
    def __init__(
        self,
        ttl_minutes: float = 60.0,
        max_images_per_session: int = 6,
        global_memory_bytes: int = 512 * 1024 * 1024,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ttl_seconds = float(ttl_minutes) * 60.0
        self.max_images_per_session = int(max_images_per_session)
        self.global_memory_bytes = int(global_memory_bytes)
        self._clock = clock
        self._sessions: dict[str, Session] = {}

    # ------------------------------------------------------------------ basics
    def create(self) -> Session:
        now = self._clock()
        session = Session(session_id=secrets.token_urlsafe(16), created_at=now, last_used=now)
        self._sessions[session.session_id] = session
        return session

    def purge_expired(self) -> list[str]:
        now = self._clock()
        expired = [
            sid
            for sid, session in self._sessions.items()
            if now - session.last_used > self.ttl_seconds
        ]
        for sid in expired:
            del self._sessions[sid]
        return expired

    def get(self, session_id: str) -> Session:
        self.purge_expired()
        session = self._sessions.get(session_id)
        if session is None:
            raise SessionNotFound(f"Unknown or expired session: {session_id}")
        session.touch(self._clock())
        return session

    # ------------------------------------------------------------------ memory
    def total_bytes(self) -> int:
        return sum(image.nbytes for session in self._sessions.values() for image in session.images.values())

    def _evict_global_lru(self, needed: int, protect: str | None = None) -> None:
        """Evict the globally least-recently-used images until `needed` fits."""
        while self.total_bytes() + needed > self.global_memory_bytes:
            candidates = [
                (image.last_used, session.session_id, image_id)
                for session in self._sessions.values()
                for image_id, image in session.images.items()
                if not (protect is not None and session.session_id == protect and len(session.images) <= 1)
            ]
            if not candidates:
                raise SessionLimitError("The server image-memory budget is full; try again later.")
            _, session_id, image_id = min(candidates, key=lambda item: item[0])
            del self._sessions[session_id].images[image_id]

    def _evict_session_lru(self, session: Session) -> None:
        while len(session.images) > self.max_images_per_session:
            oldest = min(session.images.values(), key=lambda image: image.last_used)
            del session.images[oldest.image_id]

    # ------------------------------------------------------------------ images
    def add_image(
        self,
        session_id: str,
        image: Array,
        name: str,
        original_size: tuple[int, int] | None = None,
        scale: float = 1.0,
        source: str = "upload",
        bbox: list[float] | None = None,
        meters_per_pixel: float | None = None,
    ) -> StoredImage:
        session = self.get(session_id)
        now = self._clock()
        stored = StoredImage(
            image_id=secrets.token_urlsafe(9),
            name=name,
            image=image,
            original_size=original_size or (int(image.shape[1]), int(image.shape[0])),
            stored_size=(int(image.shape[1]), int(image.shape[0])),
            scale=float(scale),
            source=source,
            bbox=list(bbox) if bbox is not None else None,
            meters_per_pixel=float(meters_per_pixel) if meters_per_pixel is not None else None,
            created_at=now,
            last_used=now,
        )
        self._evict_global_lru(stored.nbytes, protect=session_id)
        session.images[stored.image_id] = stored
        self._evict_session_lru(session)
        if stored.image_id not in session.images:
            # the session cap is smaller than 1 - should not happen with sane config
            raise SessionLimitError("The session image limit prevented storing the image.")
        return stored

    def get_image(self, session_id: str, image_id: str) -> StoredImage:
        session = self.get(session_id)
        stored = session.images.get(image_id)
        if stored is None:
            raise ImageNotFound(f"Unknown image: {image_id}")
        stored.last_used = self._clock()
        return stored

    # ------------------------------------------------------------------ debug
    def stats(self) -> dict[str, Any]:
        self.purge_expired()
        return {
            "sessions": len(self._sessions),
            "images": sum(len(session.images) for session in self._sessions.values()),
            "bytes": self.total_bytes(),
        }
