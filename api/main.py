"""GeoCluster application entry point (API only, or API + frontend).

Two ways to run it, one file:

* **API only** (local development, `api/tests`, the integration scripts):

      cd api && uvicorn main:app --reload --port 8010

  Everything is at the root: `/health`, `/sessions`, `/ai/chat`, …

* **Unified** (one process serves the frontend *and* the API - this is what the
  Render deployment and `python -m uvicorn main:app --app-dir api` use):

      SERVE_WEB=true uvicorn main:app --host 0.0.0.0 --port 8010

  The frontend is served at `/` (index.html, js/, css/, assets/) and the API
  under `/api` - plus the same routes at the root, so a page opened on
  `http://localhost:8010/` keeps working with the frontend's local default
  (`API_ROOT_ALIASES=false` turns the root copies off in a deployment).

Placeholders are in `web/`; the API knows nothing about how the page is styled.

Everything is in-memory and synchronous by design: sessions expire on a TTL,
images live behind a per-session LRU cap, and the processing package
(`geocluster/`) contains no PyQt, no torch and no file-based IPC. The only thing
ever written to disk is the disposable satellite/place cache, whose failures are
non-fatal.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.staticfiles import StaticFiles

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

#: The frontend, one level up from `api/`.
WEB_ROOT = Path(__file__).resolve().parent.parent / "web"

#: The prefix the API lives under when the same process serves the frontend.
API_PREFIX = "/api"

#: Never served from the web folder: development-only material (the test suite
#: and the dev server) and, defensively, anything dot-prefixed or with a parent
#: segment - `/.env`, `/.git/config`, `/%2e%2e/api/.env`.
WEB_DENIED_SEGMENTS = {"tests", "serve.py", "__pycache__"}


def _path_is_denied(path: str) -> bool:
    """True for a request path the web folder must never answer."""
    from urllib.parse import unquote

    raw = unquote(path.split("?", 1)[0].split("#", 1)[0]).replace("\\", "/")
    segments = [segment for segment in raw.split("/") if segment not in ("", ".")]
    for segment in segments:
        if segment == ".." or segment.startswith("."):
            return True
        if segment in WEB_DENIED_SEGMENTS:
            return True
    return False


def create_app(serve_web: bool | None = None) -> FastAPI:
    """Build the application.

    `serve_web` defaults to the `SERVE_WEB` environment variable: unset (or
    false) is the historical API-only app with every route at the root, exactly
    as the tests and the documented dev loop expect. `True` adds the frontend at
    `/` and moves the API's canonical prefix to `/api` (root copies kept unless
    `API_ROOT_ALIASES=false`).
    """
    if serve_web is None:
        serve_web = settings.serve_web()
    # a key-shaped string must never reach a log handler, whatever raised it
    log_safety.install_secret_redaction()
    if serve_web:
        _require_web_root()
    # the interactive reference is a *local* convenience: a deployment sets
    # ENABLE_DOCS=false and gets 404 for /docs, /redoc and /openapi.json
    docs = settings.docs_enabled()
    # in unified mode the reference lives under the API prefix, so it cannot
    # collide with the frontend served at /
    docs_root = API_PREFIX if serve_web else ""
    app = FastAPI(
        title="GeoCluster API",
        version="1.0.0",
        description=(
            "Web backend for GeoCluster 2.0: image operations, K-Means clustering, "
            "classification, GCH2 Huffman, satellite fetch and the AI assistant. "
            "Secrets live in environment variables only; CORS is restricted to "
            "ALLOWED_ORIGINS."
        ),
        docs_url=f"{docs_root}/docs" if docs else None,
        redoc_url=f"{docs_root}/redoc" if docs else None,
        openapi_url=f"{docs_root}/openapi.json" if docs else None,
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

    def health(request: Request) -> schemas.HealthResponse:
        return schemas.HealthResponse(
            status="ok",
            ai_configured=bool(request.app.state.assistant.available),
            satellite_configured=bool(request.app.state.satellite.configured),
            max_image_megapixels=settings.MAX_IMAGE_MEGAPIXELS,
        )

    def register_api(prefix: str) -> None:
        """Every JSON route, once per prefix ("" and/or "/api")."""
        for module in (sessions_router, images, operations, huffman, satellite, locations, assistant_router):
            app.include_router(module.router, prefix=prefix)
        app.add_api_route(f"{prefix}/health", health, methods=["GET"],
                          response_model=schemas.HealthResponse, tags=["health"])

    if not serve_web:
        # the API alone: root paths, no static files, no prefix
        register_api("")
        return app

    # canonical prefix first, then the root aliases the local default expects
    register_api(API_PREFIX)
    if settings.api_root_aliases():
        register_api("")

    @app.middleware("http")
    async def deny_private_paths(request: Request, call_next):
        """404 for dot-files and parent segments *before* anything is served."""
        if _path_is_denied(request.url.path):
            return JSONResponse(status_code=404, content={"detail": "Not found."})
        return await call_next(request)

    # last: everything else is the frontend (index.html at /)
    app.mount("/", StaticFiles(directory=str(WEB_ROOT), html=True), name="web")
    logger.info("Serving the frontend from %s and the API under %s", WEB_ROOT, API_PREFIX)
    return app


def _require_web_root() -> None:
    if not (WEB_ROOT / "index.html").is_file():
        raise RuntimeError(
            f"The frontend was not found at {WEB_ROOT} (expected index.html). "
            "Run the server from a full checkout, or start it without SERVE_WEB."
        )


app = create_app()
