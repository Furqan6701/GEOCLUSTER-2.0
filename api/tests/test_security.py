"""The security contract of the API.

What this file pins down:
  * secrets come from environment variables only, and **no response ever
    contains one** (env values are planted and every parameterless endpoint is
    called with them set);
  * an unexpected exception returns a generic sentence - no traceback, no file
    path, no upstream error text - and the detail goes to the server log;
  * 422 bodies carry `{type, loc, msg}` and never echo the submitted value;
  * CORS answers only the configured origins, and a wildcard never travels with
    credentials;
  * `/docs`, `/redoc` and `/openapi.json` are switched off with
    `ENABLE_DOCS=false`;
  * config/path probing (`/.env`, `/.git/config`, `/api/.env`, `../`) is 404,
    and the `web/` sources are not served by the API;
  * the frontend contains no way to read a secret.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

WEB_DIR = Path(__file__).resolve().parents[2] / "web"


def _sentinel(prefix: str, filler: str = "fake", repeat: int = 8) -> str:
    """A key-shaped fake built at runtime, so the source holds no complete key-shaped literal."""
    return prefix + filler * repeat


GROQ_SAMPLE = _sentinel("gsk_")

SECRET_VALUES = {
    "GROQ_API_KEY": GROQ_SAMPLE,
    "COPERNICUS_CLIENT_ID": _sentinel("client-id-", repeat=4),
    "COPERNICUS_CLIENT_SECRET": _sentinel("client-secret-", repeat=4),
}


def build_app(**env: str):
    """A fresh app, with `env` applied to `os.environ` first (settings read it)."""
    import os

    from main import create_app

    previous = {key: os.environ.get(key) for key in env}
    os.environ.update({key: value for key, value in env.items() if value is not None})
    try:
        return create_app()
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


# --------------------------------------------------------------------- secrets

def test_health_reports_configured_not_the_secret(monkeypatch):
    app = build_app(**SECRET_VALUES)
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ai_configured"] is True
    assert payload["satellite_configured"] is True
    assert all(value not in response.text for value in SECRET_VALUES.values())


@pytest.mark.parametrize("plant", [True, False])
def test_no_endpoint_returns_an_environment_secret(monkeypatch, plant):
    """Every parameterless GET, with the secrets planted in the environment."""
    if plant:
        for key, value in SECRET_VALUES.items():
            monkeypatch.setenv(key, value)
    app = build_app(**SECRET_VALUES) if plant else build_app()
    with TestClient(app) as client:
        bodies = []
        for route in app.routes:
            methods = getattr(route, "methods", set()) or set()
            path = getattr(route, "path", "")
            if "GET" not in methods or "{" in path:
                continue
            response = client.get(path)
            bodies.append((path, response.text))
        # a few known-shaped calls too, so an error path is covered as well
        bodies.append(("/ai/chat", client.post("/ai/chat", json={"message": "what is NDVI?"}).text))
        bodies.append(("/sessions", client.get("/sessions/nope/images/nope?format=png").text))
    for path, body in bodies:
        for name, value in SECRET_VALUES.items():
            assert value not in body, f"{path} leaked {name}"
        assert "Traceback" not in body, f"{path} leaked a traceback"
        assert ".py" not in body or path == "/openapi.json", f"{path} leaked a file name"


def test_upload_and_processing_errors_never_contain_paths():
    from main import create_app

    with TestClient(create_app()) as client:
        bad_upload = client.post(
            "/sessions/nope/images",
            files={"file": ("notes.txt", b"not an image", "text/plain")},
        )
        missing = client.get("/sessions/nope/images/nope/stats")
    for response in (bad_upload, missing):
        text = response.text
        assert response.status_code in (404, 415)
        for banned in ("Traceback", "/home/", "site-packages", "geocluster/", ".py"):
            assert banned not in text, f"{banned} in {text[:120]}"


# ------------------------------------------------------- unexpected exceptions

def test_unhandled_exception_returns_a_generic_message(caplog):
    """A crash in the AI path: generic sentence out, full detail in the log."""
    from types import SimpleNamespace

    from main import create_app

    def explode(_question, _context):
        raise RuntimeError(f"boom while reading /srv/app/api/.env with {SECRET_VALUES['GROQ_API_KEY']}")

    app = create_app()
    app.state.assistant = SimpleNamespace(available=True, ask_with_action=explode)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/ai/chat", json={"message": "what is NDVI?"})
    assert response.status_code == 500
    payload = response.json()
    assert payload == {"detail": "The server hit an unexpected error. Try again."}
    text = response.text
    for banned in ("boom", "/srv/app", SECRET_VALUES["GROQ_API_KEY"], "Traceback", "RuntimeError"):
        assert banned not in text, f"{banned} leaked to the client"
    # …while the server log keeps everything needed to debug it
    assert "boom while reading" in caplog.text


def test_validation_errors_do_not_echo_the_submitted_value():
    from main import create_app

    with TestClient(create_app()) as client:
        response = client.post("/ai/chat", json={"message": "hi", "api_key": SECRET_VALUES["GROQ_API_KEY"]})
        long_message = client.post("/ai/chat", json={"message": "x" * 5000})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list) and detail, "422 detail stays the list the UI flattens"
    for entry in detail:
        assert set(entry) <= {"type", "loc", "msg"}, entry
    assert SECRET_VALUES["GROQ_API_KEY"] not in response.text, "the rejected value is not echoed"
    assert response.json()["detail"][0]["type"] == "extra_forbidden"
    assert long_message.status_code == 422, "the chat message length cap holds"
    assert "x" * 100 not in long_message.text


# ----------------------------------------------------------------------- CORS

def test_cors_allows_only_the_configured_origin():
    app = build_app(ALLOWED_ORIGINS="https://geocluster.example")
    with TestClient(app) as client:
        allowed = client.get("/health", headers={"Origin": "https://geocluster.example"})
        stranger = client.get("/health", headers={"Origin": "https://evil.example"})
        preflight = client.options(
            "/ai/chat",
            headers={
                "Origin": "https://geocluster.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        blocked_preflight = client.options(
            "/ai/chat",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    assert allowed.headers.get("access-control-allow-origin") == "https://geocluster.example"
    assert "access-control-allow-origin" not in stranger.headers
    assert preflight.status_code in (200, 204)
    assert preflight.headers.get("access-control-allow-origin") == "https://geocluster.example"
    assert "access-control-allow-origin" not in blocked_preflight.headers


def test_wildcard_origin_never_sends_credentials():
    app = build_app(ALLOWED_ORIGINS="*")
    with TestClient(app) as client:
        response = client.get("/health", headers={"Origin": "https://anywhere.example"})
    assert response.headers.get("access-control-allow-origin") == "*"
    assert "access-control-allow-credentials" not in response.headers


def test_blank_origin_list_falls_back_to_localhost_not_star():
    import settings as runtime_settings

    app = build_app(ALLOWED_ORIGINS="  ")
    assert "*" not in runtime_settings.allowed_origins()
    with TestClient(app) as client:
        response = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def test_origins_are_normalised(monkeypatch):
    import settings as runtime_settings
    from main import create_app

    monkeypatch.setenv("ALLOWED_ORIGINS", "https://a.example/, https://b.example ,https://a.example")
    app = create_app()
    assert runtime_settings.allowed_origins() == ["https://a.example", "https://b.example"]
    with TestClient(app) as client:
        response = client.get("/health", headers={"Origin": "https://a.example"})
    assert response.headers.get("access-control-allow-origin") == "https://a.example"


# ------------------------------------------------------------------ API surface

def test_docs_are_disabled_in_production():
    app = build_app(ENABLE_DOCS="false")
    with TestClient(app) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            response = client.get(path)
            assert response.status_code == 404, f"{path} must be closed when ENABLE_DOCS=false"
            assert "swagger" not in response.text.lower()


def test_docs_are_available_locally():
    app = build_app(ENABLE_DOCS="")
    with TestClient(app) as client:
        assert client.get("/docs").status_code == 200
        schema = client.get("/openapi.json")
    assert schema.status_code == 200
    assert schema.json()["info"]["title"] == "GeoCluster API"


@pytest.mark.parametrize(
    "path",
    [
        "/.env",
        "/api/.env",
        "/.env.example",
        "/.git/config",
        "/web/js/app.js",
        "/api/main.py",
        "/../api/.env",
        "/%2e%2e/api/.env",
        "/sessions/../.env",
        "/geocluster-satellite-cache/",
    ],
)
def test_config_and_source_paths_are_not_served(path):
    from main import create_app

    with TestClient(create_app()) as client:
        response = client.get(path)
    assert response.status_code in (404, 405, 422), f"{path} → {response.status_code}"
    assert "GROQ_API_KEY" not in response.text
    assert "COPERNICUS" not in response.text


def test_security_headers_are_set_without_blocking_frames():
    from main import create_app

    with TestClient(create_app()) as client:
        response = client.get("/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    # the app is also embedded in a preview iframe: no frame-deny headers
    assert "x-frame-options" not in response.headers
    assert "content-security-policy" not in response.headers


# ------------------------------------------------------------ log hygiene

def test_key_shaped_strings_are_redacted_from_log_text():
    from log_safety import redact

    samples = [
        GROQ_SAMPLE,
        _sentinel("fw-", repeat=4),
        _sentinel("sk-", repeat=6),
        _sentinel("ghp_"),
        "Authorization: Bearer " + _sentinel("", repeat=4),
        "client_secret=" + _sentinel("", repeat=2),
        "api_key = " + _sentinel("", repeat=2),
        "access_token: " + _sentinel("eyJ", repeat=4),
    ]
    for sample in samples:
        cleaned = redact(f"failed for {sample}")
        assert cleaned.endswith("***") or cleaned.endswith("***'") or "***" in cleaned, cleaned
        for fragment in (sample.split("=")[-1].strip(), sample.split(" ")[-1].strip()):
            if len(fragment) >= 8:
                assert fragment not in cleaned, f"{fragment!r} survived in {cleaned!r}"
    # the useful context is kept
    assert redact(f"failed for key {GROQ_SAMPLE}").startswith("failed for key ")
    assert redact("plain sentence, nothing to hide") == "plain sentence, nothing to hide"
    assert redact("") == ""


def test_redaction_filter_covers_a_formatter_and_a_traceback():
    import io
    import logging

    from log_safety import RedactingFormatter, SecretRedactionFilter, install_secret_redaction

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger = logging.getLogger("geocluster.tests.redaction")
    logger.handlers = [handler]
    logger.propagate = False
    install_secret_redaction("geocluster.tests.redaction")

    def fail():
        raise RuntimeError(f"provider rejected key {GROQ_SAMPLE}")

    try:
        fail()
    except RuntimeError:
        logger.exception("provider call failed")
    output = stream.getvalue()
    assert GROQ_SAMPLE not in output
    assert "***" in output
    assert "Traceback" in output, "the useful part of the log is kept"
    assert isinstance(handler.formatter, RedactingFormatter)
    assert any(isinstance(entry, SecretRedactionFilter) for entry in handler.filters)


def test_access_log_line_with_a_secret_fragment_still_formats():
    """uvicorn's access formatter reads five positional arguments. Redacting the
    fragment must keep them, so the line still formats and still shows status."""
    import logging

    from uvicorn.logging import AccessFormatter

    from log_safety import SecretRedactionFilter

    path = f"/api/sessions/abc123/images/x?token={GROQ_SAMPLE}"
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", path, "1.1", 201),
        None,
    )
    assert SecretRedactionFilter().filter(record) is True
    assert len(record.args) == 5, "the filter must not clear the arguments"
    assert record.args[4] == 201 and isinstance(record.args[4], int)

    line = AccessFormatter().format(record)
    assert GROQ_SAMPLE not in line
    assert "***" in line
    assert '"GET /api/sessions/abc123/images/x' in line
    assert line.endswith(" 201")


def test_installed_redaction_is_idempotent():
    from log_safety import SecretRedactionFilter, install_secret_redaction

    import logging

    install_secret_redaction("geocluster.tests.idempotent")
    install_secret_redaction("geocluster.tests.idempotent")
    logger = logging.getLogger("geocluster.tests.idempotent")
    assert sum(isinstance(entry, SecretRedactionFilter) for entry in logger.filters) == 1


# -------------------------------------------------------------- frontend side

def test_frontend_cannot_read_a_secret():
    """No env access, no secret names, no key-shaped literals under web/js."""
    assert WEB_DIR.is_dir()
    offenders = []
    for path in list((WEB_DIR / "js").rglob("*.js")) + list(WEB_DIR.glob("*.html")):
        text = path.read_text(encoding="utf-8")
        for needle in ("process.env", "os.getenv", "os.environ", "getenv(", "CLIENT_SECRET", "gsk_", "Bearer "):
            if needle in text:
                offenders.append(f"{path.relative_to(WEB_DIR)}: {needle}")
    assert not offenders, "; ".join(offenders)


def test_web_folder_holds_no_secret_file():
    for name in (".env", ".env.local", ".env.production"):
        assert not (WEB_DIR / name).exists(), f"{name} must never live under web/"
    assert not list(WEB_DIR.rglob("*.pem")) and not list(WEB_DIR.rglob("*.key"))


def test_docker_and_env_templates_only_carry_placeholders():
    env_example = Path(__file__).resolve().parents[1] / ".env.example"
    text = env_example.read_text(encoding="utf-8")
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        value = value.strip()
        if name in {"GROQ_API_KEY", "FIREWORKS_API_KEY", "COPERNICUS_CLIENT_ID", "COPERNICUS_CLIENT_SECRET"}:
            assert value == "", f"{name} must stay empty in the tracked template"
        assert "gsk_" not in value and "sk-" not in value
    assert "ENABLE_DOCS" in text and "ALLOWED_ORIGINS" in text


def test_gitignore_covers_env_and_key_material():
    ignore = (Path(__file__).resolve().parents[2] / ".gitignore").read_text(encoding="utf-8")
    for pattern in (".env", ".env.*", "!.env.example", "*.pem", "*.key"):
        assert pattern in ignore, f".gitignore must contain {pattern}"


# ------------------------------------------------------------- input size caps

def test_uploads_are_capped_while_streaming():
    import settings as runtime_settings
    from main import create_app

    with TestClient(create_app()) as client:
        oversized = b"\x89PNG\r\n\x1a\n" + b"\x00" * int(runtime_settings.MAX_UPLOAD_MB * 1024 * 1024 + 1024)
        session_id = client.post("/sessions", json={}).json()["session_id"]
        rejected = client.post(
            f"/sessions/{session_id}/images",
            files={"file": ("big.png", oversized, "image/png")},
        )
    assert rejected.status_code == 413
    assert "detail" in rejected.json()
    assert "MB" in json.dumps(rejected.json())
    assert len(rejected.text) < 400, "the rejection is a sentence, not a payload"
