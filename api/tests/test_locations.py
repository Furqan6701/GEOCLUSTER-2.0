"""Sector/alias lookup matches the desktop data and bbox math."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from geocluster.locations import (
    ALIASES_FILE,
    SECTORS_FILE,
    LocationNotFound,
    catalog,
    get_sector,
    get_sector_bbox,
)


def test_data_files_copied_from_desktop():
    desktop = Path(__file__).resolve().parents[2] / "desktop" / "data"
    assert json.loads(SECTORS_FILE.read_text()) == json.loads((desktop / "islamabad_sectors.json").read_text())
    assert json.loads(ALIASES_FILE.read_text()) == json.loads((desktop / "islamabad_aliases.json").read_text())


def test_sector_and_alias_lookup():
    assert get_sector("F-8").code == "F-8"
    assert get_sector("f-8").code == "F-8"
    assert get_sector("nust").code == "H-12"
    assert get_sector("Centaurus").code == "F-8"
    with pytest.raises(LocationNotFound):
        get_sector("atlantis")


def test_bbox_is_about_2600_metres_square():
    west, south, east, north = get_sector_bbox("F-8")
    assert west < east and south < north
    lat = get_sector("F-8").latitude
    width_m = (east - west) * 111_320 * math.cos(math.radians(lat))
    height_m = (north - south) * 111_320
    assert abs(width_m - 2600) < 1
    assert abs(height_m - 2600) < 1


def test_catalog_shape():
    payload = catalog()
    assert len(payload["sectors"]) == 21
    assert len(payload["aliases"]) == 71
    assert payload["aliases"]["nust"] == "H-12"
    assert set(payload["sectors"]["F-8"]) == {"latitude", "longitude"}


def test_locations_endpoint(client):
    payload = client.get("/locations").json()
    assert payload["aliases"]["centaurus"] == "F-8"
