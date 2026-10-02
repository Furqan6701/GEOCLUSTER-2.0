"""Session creation."""

from __future__ import annotations

from fastapi import APIRouter, Depends

import schemas
from dependencies import get_store, require_auth
from sessions import SessionStore

router = APIRouter(prefix="/sessions", tags=["sessions"], dependencies=[Depends(require_auth)])


@router.post("", status_code=201, response_model=schemas.SessionOut)
def create_session(store: SessionStore = Depends(get_store)) -> schemas.SessionOut:
    session = store.create()
    return schemas.SessionOut(
        session_id=session.session_id,
        ttl_minutes=store.ttl_seconds / 60.0,
        max_images=store.max_images_per_session,
    )
