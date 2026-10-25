"""The unified app: one process serving the frontend *and* the API.

The API-only default is checked too, because every existing test, README and
script depends on `create_app()` keeping its root routes exactly where they
were.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from main import API_PREFIX, WEB_ROOT, create_app


@pytest.fixture()
def unified(monkeypatch):
    """The unified app with `SERVE_WEB=true` (root aliases on, docs on)."""
    monkeypatch.delenv("API_ROOT_ALIASES", raising=False)
    monkeypatch.delenv("ENABLE_DOCS", raising=False)
    with TestClient(create_app(serve_web=True)) as client:
        yield client


# --------------------------------------------------------------- API-only mode

def test_api_only_app_has_no_frontend(client):
    """`create_app()` stays the historical application: root routes, no files."""
    assert client.get("/health").status_code == 200
    assert client.get("/docs").status_code == 200
    for path in ("/", "/index.php", "/js/app.js", "/css/styles.css"):
        assert client.get(path).status_code == 404, path


def test_root_aliases_are_not_the_prefix_when_the_api_stands_alone(client):
    assert client.get("/api/health").status_code == 404


def test_serve_web_defaults_to_the_environment(monkeypatch):
    from fastapi.testclient import TestClient as Client

    monkeypatch.setenv("SERVE_WEB", "true")
    with Client(create_app()) as client:
        assert client.get("/").status_code == 200
    monkeypatch.setenv("SERVE_WEB", "false")
    with Client(create_app()) as client:
        assert client.get("/").status_code == 404
        assert client.get("/health").status_code == 200


# ---------------------------------------------------------------- files at /

def test_the_frontend_is_served_at_the_root(unified):
    response = unified.get("/")
    assert response.status_code == 200
    body = response.text
    assert "<!doctype html" in body.lower()
    assert "js/app.js" in body
    assert unified.get("/index.html").status_code == 200


def test_the_frontends_own_assets_are_served(unified):
    js = unified.get("/js/app.js")
    assert js.status_code == 200
    assert "javascript" in js.headers["content-type"]
    css = unified.get("/css/styles.css")
    assert css.status_code == 200
    assert "css" in css.headers["content-type"]
    module = unified.get("/js/panels/chat.js")
    assert module.status_code == 200


def test_a_missing_page_is_a_404(unified):
    assert unified.get("/no-such-page.html").status_code == 404


def test_static_files_only_answer_get_and_head(unified):
    assert unified.post("/js/app.js").status_code == 405
    assert unified.head("/js/app.js").status_code == 200


# --------------------------------------------------------------- API at /api

def test_the_api_answers_under_the_prefix(unified):
    assert unified.get(f"{API_PREFIX}/health").status_code == 200
    response = unified.post(f"{API_PREFIX}/sessions")
    assert response.status_code in (200, 201)
    assert response.json()["session_id"]


def test_the_root_alias_keeps_the_local_default_working(unified):
    """The page may call http://localhost:8010 directly (the frontend default)."""
    assert unified.get("/health").status_code == 200
    assert unified.post("/ai/chat", json={"message": "Show me F-8 imagery"}).status_code in (200, 502, 503)


def test_root_aliases_can_be_switched_off_for_a_deployment(monkeypatch):
    monkeypatch.setenv("API_ROOT_ALIASES", "false")
    with TestClient(create_app(serve_web=True)) as client:
        assert client.get(f"{API_PREFIX}/health").status_code == 200
        assert client.get("/health").status_code == 404
        assert client.get("/").status_code == 200, "the frontend is unaffected"


def test_the_interactive_reference_moves_under_the_prefix(unified):
    assert unified.get("/docs").status_code == 404
    assert unified.get(f"{API_PREFIX}/docs").status_code == 200
    assert unified.get(f"{API_PREFIX}/openapi.json").status_code == 200


def test_docs_can_be_closed_in_unified_mode(monkeypatch):
    monkeypatch.setenv("ENABLE_DOCS", "false")
    with TestClient(create_app(serve_web=True)) as client:
        for path in ("/docs", f"{API_PREFIX}/docs", f"{API_PREFIX}/openapi.json"):
            assert client.get(path).status_code == 404, path


# ------------------------------------------------ the private surface is not

#: Paths that must never be answered with content. Some are stopped by the
#: middleware's rule (see DENIED_BY_RULE), the rest simply have no file inside
#: `web/` - which is the point: only that folder is published, and `api/` is
#: not inside it.
PRIVATE_PATHS = (
    "/.env",
    "/.env.example",
    "/.git/config",
    "/.gitignore",
    "/%2e%2e/api/.env",
    "/../api/.env",
    "/js/../api/main.py",
    "/api/.env",
    "/api/main.py",
    "/api/requirements.txt",
    "/tests/smoke_test.py",
    "/serve.py",
    "/__pycache__/serve.cpython-311.pyc",
    "/%2eenv",
    "/.well-known/security.txt",
)

#: The ones the middleware refuses outright, i.e. the documented rule:
#: no dot-prefixed segment, no parent segment, no dev-only segment.
DENIED_BY_RULE = (
    "/.env",
    "/.env.example",
    "/.git/config",
    "/.gitignore",
    "/%2e%2e/api/.env",
    "/../api/.env",
    "/js/../api/main.py",
    "/api/.env",
    "/tests/smoke_test.py",
    "/serve.py",
    "/__pycache__/serve.cpython-311.pyc",
    "/%2eenv",
    "/.well-known/security.txt",
)


@pytest.mark.parametrize("path", PRIVATE_PATHS)
def test_private_paths_are_not_served(unified, path: str):
    response = unified.get(path)
    assert response.status_code == 404, f"{path} → {response.status_code}"


def test_private_paths_carry_no_key_material(unified, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "fake" * 8 + "_do_not_leak")
    for path in PRIVATE_PATHS:
        body = unified.get(path).text
        assert "gsk_" not in body and "do_not_leak" not in body, path


def test_the_deny_rule_matches_the_documented_segments():
    from main import _path_is_denied

    for path in DENIED_BY_RULE:
        assert _path_is_denied(path), path
    # the API prefix itself must keep working, and ordinary assets are public
    for path in ("/", "/index.html", "/js/app.js", "/css/styles.css", "/assets/sample.jpg", "/api/health", "/api/main.py"):
        assert not _path_is_denied(path), path


def test_the_api_prefix_cannot_shadow_the_rule():
    """`/api/...` is not denied as a prefix; it is safe because `web/api` does
    not exist - a folder the frontend never has. Anything private inside it
    (`.env`, `..`) is denied by the segment rule anyway."""
    from main import WEB_ROOT, _path_is_denied

    assert not (WEB_ROOT / "api").exists()
    assert _path_is_denied("/api/.env")
    assert _path_is_denied("/api/../.env")


def test_a_query_string_cannot_hide_a_private_path(unified):
    assert unified.get("/index.html?file=../api/main.py").status_code == 200
    assert unified.get("/.env?" + "a=1").status_code == 404


def test_the_mount_is_the_web_folder_and_the_folder_exists():
    assert (WEB_ROOT / "index.html").is_file()
    assert (WEB_ROOT / "js" / "app.js").is_file()
    assert not (WEB_ROOT / "serve.py").is_dir()


def test_missing_frontend_fails_loudly(monkeypatch):
    import main

    monkeypatch.setattr(main, "WEB_ROOT", main.WEB_ROOT / "definitely-not-here")
    with pytest.raises(RuntimeError):
        create_app(serve_web=True)


# ------------------------------------------------------------------- errors

def test_an_unknown_api_route_is_a_json_404(unified):
    response = unified.get(f"{API_PREFIX}/no-such-route")
    assert response.status_code == 404
    # the static mount's own 404 - still `{"detail": ...}`, which is the shape
    # the frontend already flattens into a friendly message
    assert isinstance(response.json().get("detail"), str)
    assert "Traceback" not in response.text


def test_an_upload_validation_error_still_answers_json(unified):
    response = unified.post(f"{API_PREFIX}/ai/chat", json={"message": "x" * 5000})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert set(detail[0]) == {"type", "loc", "msg"}


def test_a_router_command_runs_without_a_model_key(unified):
    response = unified.post(f"{API_PREFIX}/ai/chat", json={"message": "Run k-means on this"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["action"] is None
    assert body["commands"][0]["action"] == "run_kmeans"
    assert "location" not in json.dumps(body["commands"])


# ------------------------------------------------- local development port 8010

def test_default_origins_follow_the_local_port(monkeypatch):
    """The documented local page (localhost:8010) is allowed by default, the old port is not."""
    import settings

    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    origins = settings.allowed_origins()
    assert "http://localhost:8010" in origins
    assert "http://127.0.0.1:8010" in origins
    assert "http://localhost:5173" in origins
    assert not any(origin.endswith(":8000") for origin in origins)


def test_the_local_page_gets_cors_from_the_default_list(monkeypatch):
    """A preflight from the local page origin is answered with that origin, no env needed."""
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    with TestClient(create_app()) as client:
        response = client.options(
            "/health",
            headers={
                "Origin": "http://localhost:8010",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert response.headers.get("access-control-allow-origin") == "http://localhost:8010"


def test_the_frontend_default_and_the_dev_proxy_agree_on_the_port():
    """config.js (the browser default) and serve.py (the dev proxy) both target 8010."""
    config_js = (WEB_ROOT / "js" / "config.js").read_text(encoding="utf-8")
    serve_py = (WEB_ROOT / "serve.py").read_text(encoding="utf-8")
    assert 'DEFAULT_API_BASE = "http://localhost:8010"' in config_js
    assert 'DEFAULT_API = "http://127.0.0.1:8010"' in serve_py
