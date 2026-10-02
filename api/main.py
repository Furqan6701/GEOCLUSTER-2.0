"""GeoCluster API — FastAPI application entry point.

Local development:
    cd api
    uvicorn main:app --reload --port 8000

Everything is in-memory and synchronous by design: sessions expire on a TTL,
images live behind a per-session LRU cap, and the processing package
(`geocluster/`) contains no PyQt, no torch and no file-based IPC.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import schemas
import settings
from geocluster.errors import (
    AssistantProviderError,
    AssistantUnavailable,
    ClassificationError,
    FilterError,
    GeoclusterError,
    HuffmanError,
    ImageNotFound,
    ImageValidationError,
    KMeansError,
    SatelliteError,
    SatelliteUnavailable,
    SessionLimitError,
    SessionNotFound,
)
from geocluster.assistant import AIAssistant, CommandRouter
from geocluster.satellite import SatelliteClient
from ratelimit import RateLimiter
from routers import assistant as assistant_router
from routers import huffman, images, locations, operations, satellite
from routers import sessions as sessions_router
from sessions import SessionStore


def create_app() -> FastAPI:
    app = FastAPI(
        title="GeoCluster API",
        version="1.0.0",
        description=(
            "Web backend for GeoCluster 2.0: image operations, K-Means clustering, "
            "classification, GCH2 Huffman, satellite fetch and the AI assistant. "
            "Local-only; CORS is restricted to ALLOWED_ORIGINS."
        ),
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.sessions = SessionStore(
        ttl_minutes=settings.SESSION_TTL_MINUTES,
        max_images_per_session=settings.SESSION_MAX_IMAGES,
        global_memory_bytes=int(settings.GLOBAL_MEMORY_MB * 1024 * 1024),
    )
    app.state.assistant = AIAssistant()
    app.state.command_router = CommandRouter()
    app.state.satellite = SatelliteClient(cache_dir=settings.SATELLITE_CACHE_DIR)
    app.state.ai_limiter = RateLimiter(settings.AI_RATE_LIMIT_PER_MINUTE)
    app.state.satellite_limiter = RateLimiter(settings.SATELLITE_RATE_LIMIT_PER_MINUTE)

    # Single place that turns processing errors into HTTP status codes, so a
    # dependency-raised SessionNotFound can never become a 500.
    status_by_error: dict[type[GeoclusterError], int] = {
        ImageValidationError: 415,
        FilterError: 422,
        KMeansError: 400,
        ClassificationError: 422,
        HuffmanError: 400,
        SessionNotFound: 404,
        ImageNotFound: 404,
        SessionLimitError: 507,
        AssistantUnavailable: 503,
        AssistantProviderError: 502,
        SatelliteUnavailable: 503,
        SatelliteError: 502,
    }

    @app.exception_handler(GeoclusterError)
    async def geocluster_error_handler(_request: Request, exc: GeoclusterError) -> JSONResponse:
        status_code = 400
        for error_type, mapped in status_by_error.items():
            if isinstance(exc, error_type):
                status_code = mapped
                break
        return JSONResponse(status_code=status_code, content={"detail": str(exc)})

    app.include_router(sessions_router.router)
    app.include_router(images.router)
    app.include_router(operations.router)
    app.include_router(huffman.router)
    app.include_router(satellite.router)
    app.include_router(locations.router)
    app.include_router(assistant_router.router)

    @app.get("/health", response_model=schemas.HealthResponse, tags=["health"])
    def health(request: Request) -> schemas.HealthResponse:
        return schemas.HealthResponse(
            status="ok",
            ai_configured=bool(request.app.state.assistant.available),
            satellite_configured=bool(request.app.state.satellite.configured),
            max_image_megapixels=settings.MAX_IMAGE_MEGAPIXELS,
        )

    return app


app = create_app()
