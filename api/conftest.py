"""Pytest configuration: put `api/` on sys.path and share fixtures.

Golden fixtures under tests/fixtures/ are static files generated from the
desktop code (see tests/fixtures/generate_fixtures.py). No test imports
anything from desktop/.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

API_DIR = Path(__file__).resolve().parent
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

FIXTURES_DIR = API_DIR / "tests" / "fixtures"


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture(scope="session")
def expected() -> dict:
    return json.loads((FIXTURES_DIR / "expected_values.json").read_text(encoding="utf-8"))


def _load(name: str) -> np.ndarray:
    image = cv2.imread(str(FIXTURES_DIR / name), cv2.IMREAD_UNCHANGED)
    assert image is not None, f"missing fixture {name}"
    return image


@pytest.fixture(scope="session")
def sample() -> np.ndarray:
    return _load("sample.jpg")


@pytest.fixture(scope="session")
def sample_bytes() -> bytes:
    return (FIXTURES_DIR / "sample.jpg").read_bytes()


@pytest.fixture(scope="session")
def gray_sample() -> np.ndarray:
    return _load("gray_sample.png")


@pytest.fixture(scope="session")
def alpha_sample() -> np.ndarray:
    return _load("alpha_synthetic.png")


@pytest.fixture()
def app():
    from main import create_app

    application = create_app()
    yield application
    application.state.sessions.purge_expired()


@pytest.fixture()
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        yield test_client
