"""GeoCluster API — FastAPI application entry point.

Local development:
    cd api
    uvicorn main:app --reload --port 8000

Everything is in-memory and synchronous by design: sessions expire on a TTL,
images live behind a per-session LRU cap, and the processing package
(`geocluster/`) contains no PyQt, no torch and no file-based IPC.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import log_safety
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


logger = logging.getLogger("geocluster.api")

#: What a client sees when something unexpected breaks. The real exception -
#: traceback, file paths, upstream provider text - is logged server-side only.
GENERIC_SERVER_ERROR = "The server hit an unexpected error. Try again."


def create_app() -> FastAPI:
    # a key-shaped string must never reach a log handler, whatever raised it
    log_safety.install_secret_redaction()
    # the interactive reference is a *local* convenience: a deployment sets
    # ENABLE_DOCS=false and gets 404 for /docs, /redoc and /openapi.json
    docs = settings.docs_enabled()
    app = FastAPI(
        title="GeoCluster API",
        version="1.0.0",
        description=(
            "Web backend for GeoCluster 2.0: image operations, K-Means clustering, "
            "classification, GCH2 Huffman, satellite fetch and the AI assistant. "
            "Secrets live in environment variables only; CORS is restricted to "
            "ALLOWED_ORIGINS."
        ),
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins(),
        # a wildcard origin and credentials must never travel together
        allow_credentials=settings.allow_credentials(),
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        """Two headers that cost nothing and cannot break the UI.

        Deliberately *not* X-Frame-Options/CSP: the app is also embedded in a
        preview iframe, and a frame-deny header would blank it there.
        """
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

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

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
        """Field-level 422s without the submitted value or a pydantic URL.

        The frontend flattens `{loc, msg}` into "field must be …"; echoing the
        raw input back (which may be anything a user pasted, including a
        credential) or an external documentation URL adds nothing but risk.
        """
        # only these three keys are copied, so the submitted value (`input`)
        # and the external pydantic URL never reach a client
        detail = [
            {
                "type": str(error.get("type", "value_error")),
                "loc": [str(part) for part in error.get("loc", ())],
                "msg": str(error.get("msg", "Invalid value.")),
            }
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": detail})

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        """Anything unforeseen: a generic sentence out, the detail to the log."""
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": GENERIC_SERVER_ERROR})

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
