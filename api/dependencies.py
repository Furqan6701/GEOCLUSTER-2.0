"""FastAPI dependencies.

`require_auth` is the deliberate hook for adding authentication later: it is
attached to every router today and does nothing; replacing its body with a
real check (API key, bearer token, ...) turns auth on everywhere at once.
"""

from __future__ import annotations

from fastapi import Depends, Request

from geocluster.errors import ImageNotFound, SessionNotFound
from sessions import Session, SessionStore, StoredImage


def get_store(request: Request) -> SessionStore:
    return request.app.state.sessions


async def require_auth() -> None:
    """No-op auth hook (see module docstring)."""
    return None


def get_session(session_id: str, store: SessionStore = Depends(get_store)) -> Session:
    return store.get(session_id)


def get_image(
    session_id: str,
    image_id: str,
    store: SessionStore = Depends(get_store),
) -> StoredImage:
    return store.get_image(session_id, image_id)


__all__ = [
    "get_store",
    "require_auth",
    "get_session",
    "get_image",
    "SessionNotFound",
    "ImageNotFound",
]
