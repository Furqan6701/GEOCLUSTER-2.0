"""Sector and alias catalogue."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from dependencies import require_auth
from geocluster.locations import catalog

router = APIRouter(tags=["locations"], dependencies=[Depends(require_auth)])


@router.get("/locations")
def list_locations() -> dict:
    return catalog()
