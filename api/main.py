"""GeoCluster API — FastAPI application entry point (scaffold).

Local development:
    cd api
    uvicorn main:app --reload --port 8000

The API migration (geocluster/ package, routers/, sessions, tests) builds on
this file: /health is kept and extended there; CORS stays localhost-only by
default via the ALLOWED_ORIGINS environment variable.
"""

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

DEFAULT_ORIGINS = (
    "http://localhost:3000,"
    "http://localhost:5173,"
    "http://localhost:8000,"
    "http://127.0.0.1:3000,"
    "http://127.0.0.1:5173,"
    "http://127.0.0.1:8000"
)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if origin.strip()
]

app = FastAPI(
    title="GeoCluster API",
    version="0.1.0",
    description=(
        "Web backend for GeoCluster 2.0. "
        "Scaffold: health endpoint and localhost-only CORS."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    """Liveness probe.

    The API migration extends this response with the booleans
    ai_configured / satellite_configured and the configured
    MAX_IMAGE_MEGAPIXELS.
    """
    return {"status": "ok"}
