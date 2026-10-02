"""CommandRouter, command mapping, Fireworks wrapper (mocked) and the openai pin.

No test touches the network: the SDK smoke test uses an httpx MockTransport.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from geocluster.assistant import (
    AIAssistant,
    CommandRouter,
    build_commands,
    clean_response,
)
from geocluster.errors import AssistantProviderError, AssistantUnavailable

router = CommandRouter()


# --------------------------------------------------------------- router tests

@pytest.mark.parametrize(
    "message,intent,key,value",
    [
        ("show me F-8", "fetch_satellite", "location", "F-8"),
        ("fetch satellite imagery of NUST", "fetch_satellite", "location", "NUST"),
        ("kmeans", "process_image", "operation", "kmeans"),
        ("run k-means please", "process_image", "operation", "kmeans"),
        ("cluster the image", "process_image", "operation", "kmeans"),
        ("classify this", "process_image", "operation", "kmeans"),
        ("apply mean filter", "process_image", "operation", "meanfilter"),
        ("threshold it", "process_image", "operation", "threshold"),
        ("adjust brightness", "process_image", "operation", "brightness"),
        ("make it negative", "process_image", "operation", "negative"),
        ("histogram", "process_image", "operation", "histogram"),
        ("compress this image", "process_image", "operation", "compress"),
        ("compression please", "process_image", "operation", "compress"),
        ("measure distance", "process_image", "operation", "distance"),
        ("what is NDVI?", "ask_question", "question", "what is NDVI?"),
        ("", "ask_question", "question", ""),
    ],
)
def test_router_matches_desktop_behavior(message, intent, key, value):
    result = router.route(message)
    assert result["intent"] == intent
    assert result[key] == value


@pytest.mark.parametrize(
    "message,expected",
    [
        ("show me F-8", [{"action": "fetch_satellite", "location": "F-8"}]),
        ("kmeans", [{"action": "run_operation", "operation": "kmeans"}]),
        ("classify", [{"action": "run_operation", "operation": "kmeans"}]),
        ("mean filter", [{"action": "run_operation", "operation": "meanfilter"}]),
        ("threshold", [{"action": "run_operation", "operation": "threshold"}]),
        ("brightness", [{"action": "run_operation", "operation": "brightness"}]),
        ("negative", [{"action": "run_operation", "operation": "negative"}]),
        ("histogram", [{"action": "open_histogram"}]),
        ("compress", [{"action": "open_compress"}]),
        ("distance", [{"action": "open_distance"}]),
        ("what is GIS?", []),
    ],
)
def test_build_commands_covers_every_router_output(message, expected):
    assert build_commands(router.route(message)) == expected


def test_show_prefix_wins_over_operation_keywords():
    """Desktop quirk, ported as-is: satellite verbs are matched before the
    operation map, so 'show histogram' routes to fetch_satellite."""
    assert router.route("show histogram") == {"intent": "fetch_satellite", "location": "histogram"}


def test_clean_response_strips_reasoning():
    assert clean_response("Final answer: hello") == "hello"
    assert clean_response("<think>secret</think>visible") == "visible"
    assert clean_response("") == ""


# --------------------------------------------------------------- wrapper tests

def test_assistant_without_key_is_unavailable():
    assistant = AIAssistant(api_key=None)
    assert assistant.available is False
    with pytest.raises(AssistantUnavailable):
        assistant.ask("hello")


def test_assistant_cleans_provider_answer():
    assistant = AIAssistant(api_key="test-key")
    captured = {}

    def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Final answer: hi"))])

    assistant._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    assert assistant.ask("hi") == "hi"
    assert captured["model"] == "accounts/fireworks/models/qwen3p7-plus"
    assert captured["temperature"] == 0.3
    assert captured["max_tokens"] == 150
    assert captured["extra_body"] == {"reasoning_effort": "none"}
    assert captured["messages"][0]["role"] == "system"
    assert "GEOCLUSTER AI" in captured["messages"][0]["content"]


def test_assistant_provider_failure_raises_generic_error(caplog):
    assistant = AIAssistant(api_key="test-key")

    def create(**_kwargs):
        raise RuntimeError("Error code: 404 - model not found")

    assistant._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    with pytest.raises(AssistantProviderError) as info:
        assistant.ask("hi")
    assert "Error code" not in str(info.value)  # generic message for the client
    assert "Error code: 404" in caplog.text  # full detail logged server-side


# --------------------------------------------------------------- API contracts

def make_app_client(assistant, available=False):
    from fastapi.testclient import TestClient
    from main import create_app

    application = create_app()
    application.state.assistant = assistant
    return TestClient(application)


def test_chat_returns_503_when_not_configured():
    with make_app_client(AIAssistant(api_key=None)) as client:
        response = client.post("/ai/chat", json={"message": "what is GIS?"})
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_chat_returns_reply_with_stub():
    stub = SimpleNamespace(available=True, ask=lambda question: f"answer for {question}")
    with make_app_client(stub) as client:
        response = client.post("/ai/chat", json={"message": "what is NDVI?"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["intent"] == "ask_question"
    assert payload["reply"] == "answer for what is NDVI?"
    assert payload["commands"] == []


def test_chat_maps_provider_failure_to_502_without_raw_error():
    def ask(_question):
        raise AssistantProviderError("The AI provider is unavailable.")

    stub = SimpleNamespace(available=True, ask=ask)
    with make_app_client(stub) as client:
        response = client.post("/ai/chat", json={"message": "what is GIS?"})
    assert response.status_code == 502
    assert "Error code" not in response.text
    assert response.json()["detail"] == "The AI provider is unavailable."


def test_chat_command_intents_do_not_call_the_assistant():
    def explode(_question):  # pragma: no cover - must never run
        raise AssertionError("the assistant must not be called for command intents")

    stub = SimpleNamespace(available=True, ask=explode)
    with make_app_client(stub) as client:
        response = client.post("/ai/chat", json={"message": "show me F-8"})
        assert response.status_code == 200
        assert response.json()["commands"] == [{"action": "fetch_satellite", "location": "F-8"}]
        assert response.json()["reply"] is None

        response = client.post("/ai/chat", json={"message": "compress this image"})
        assert response.json()["commands"] == [{"action": "open_compress"}]

        response = client.post("/ai/chat", json={"message": "histogram"})
        assert response.json()["commands"] == [{"action": "open_histogram"}]


def test_chat_rate_limit_returns_429():
    from main import create_app
    from ratelimit import RateLimiter
    from fastapi.testclient import TestClient

    application = create_app()
    application.state.ai_limiter = RateLimiter(1)
    application.state.assistant = SimpleNamespace(available=True, ask=lambda question: "ok")
    with TestClient(application) as client:
        assert client.post("/ai/chat", json={"message": "what is GIS?"}).status_code == 200
        limited = client.post("/ai/chat", json={"message": "what is GIS?"})
        assert limited.status_code == 429
        assert limited.headers["retry-after"] == "60"


# ------------------------------------------------- openai 3.22.1 compatibility

def test_openai_chat_completions_call_works_with_the_pinned_sdk():
    """Exercises the real installed SDK against a mocked transport."""
    from openai import OpenAI

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 0,
                "model": "accounts/fireworks/models/qwen3p7-plus",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Final answer: hello"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    client = OpenAI(
        api_key="test-key",
        base_url="https://api.fireworks.ai/inference/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    response = client.chat.completions.create(
        model="accounts/fireworks/models/qwen3p7-plus",
        messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
        ],
        temperature=0.3,
        max_tokens=150,
        extra_body={"reasoning_effort": "none"},
    )
    assert response.choices[0].message.content == "Final answer: hello"
    assert captured["url"].endswith("/chat/completions")
    assert captured["body"]["reasoning_effort"] == "none"
    assert captured["body"]["max_tokens"] == 150
    assert captured["body"]["temperature"] == 0.3
    assert captured["authorization"] == "Bearer test-key"
