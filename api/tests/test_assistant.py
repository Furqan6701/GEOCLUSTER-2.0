"""CommandRouter, command mapping, the app-help glossary, the LLM wrapper (mocked).

No test touches the network: the SDK smoke test uses an httpx MockTransport.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from geocluster.assistant import (
    AIAssistant,
    APP_HELP,
    CommandRouter,
    build_commands,
    clean_response,
    help_answer,
    help_data_path,
    help_question,
    load_app_help,
    match_app_help,
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
    # the owner's provider settings, unchanged
    assert captured["model"] == "openai/gpt-oss-20b"
    assert captured["temperature"] == 0.3
    assert captured["max_tokens"] == 600
    assert captured["extra_body"] == {"reasoning_effort": "low"}
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


# ------------------------------------------------- item 15: the app help glossary

# The six filter descriptions are the exact texts the owner asked for; the rest
# are the app's own short descriptions. The frontend tooltips carry the same
# six sentences (asserted in web/tests/logic.test.mjs).
EXPECTED_FILTER_TEXTS = {
    "grayscale": "Converts the image to a single-band grayscale image using a luminance-weighted combination of the color channels.",
    "negative": "Inverts pixel values to produce a photographic negative.",
    "laplacian": "Edge detection filter that highlights areas of rapid intensity change, such as boundaries and fine detail.",
    "brightness": "Shifts all pixel values by a constant amount from -255 to 255; positive values brighten the image and negative values darken it; results are limited to the valid 0 to 255 range.",
    "threshold": "Each color value (red, green, blue) above the threshold is set to its maximum, and all others are set to zero.",
    "meanfilter": "Smooths the image by averaging neighboring pixels.",
    "clear-result": "Clears the result viewport. The original image and the undo history are not affected.",
}

EXPECTED_TOOLS = [
    "Grayscale", "Negative", "Laplacian", "Brightness", "Threshold", "Mean filter",
    "Clear result", "K-Means", "Classification ranges and Generate map", "Map composer",
    "Histogram", "Distance", "Satellite fetch", "Undo and Redo",
]


def test_help_glossary_ships_with_the_package():
    assert help_data_path().exists(), "app_help.json ships inside geocluster/data"
    assert [tool["name"] for tool in APP_HELP] == EXPECTED_TOOLS
    assert len({tool["id"] for tool in APP_HELP}) == len(APP_HELP), "ids are unique"


def test_every_help_entry_is_complete_and_plain_text():
    for tool in APP_HELP:
        assert tool["name"].strip() == tool["name"] and tool["name"]
        assert tool["description"].strip() == tool["description"]
        assert tool["description"].endswith("."), f"{tool['name']} reads as a sentence"
        assert tool["aliases"], f"{tool['name']} has aliases"
        assert all(alias == alias.lower() for alias in tool["aliases"]), tool["aliases"]
        assert all(alias.strip() == alias and alias for alias in tool["aliases"])
        # plain text only: no markup, no LaTeX, no developer wording
        text = f"{tool['name']} {tool['description']} {' '.join(tool['aliases'])}"
        for banned in ("\\[", "\\(", "**", "#", "`", "localhost", "127.0.0.1", "http://", "https://"):
            assert banned not in text, f"{tool['name']} must not contain {banned!r}"


def test_filter_descriptions_are_the_exact_requested_texts():
    by_id = {tool["id"]: tool["description"] for tool in APP_HELP}
    for tool_id, text in EXPECTED_FILTER_TEXTS.items():
        assert by_id[tool_id] == text, tool_id


def test_system_prompt_carries_the_glossary_and_the_answer_rules():
    from geocluster.assistant import SYSTEM_PROMPT

    assert "APP GLOSSARY" in SYSTEM_PROMPT
    for tool in APP_HELP:
        assert tool["name"] in SYSTEM_PROMPT
        assert tool["description"] in SYSTEM_PROMPT
    # the rules the owner asked for
    assert "PLAIN TEXT" in SYSTEM_PROMPT
    assert "LaTeX" in SYSTEM_PROMPT and "markdown" in SYSTEM_PROMPT
    assert "Never claim to see the user's image" in SYSTEM_PROMPT
    assert "Say so when you are not sure" in SYSTEM_PROMPT
    assert SYSTEM_PROMPT.index("APP GLOSSARY") > SYSTEM_PROMPT.index("GEOCLUSTER AI")


@pytest.mark.parametrize(
    "question,tool_id",
    [
        ("what is grayscale", "grayscale"),
        ("What does the Grayscale tool do?", "grayscale"),
        ("what is greyscale", "grayscale"),
        ("how do I use negative", "negative"),
        ("what is invert colors", "negative"),
        ("what is the laplacian filter", "laplacian"),
        ("how does edge detection work", "laplacian"),
        ("what is brightness", "brightness"),
        ("explain threshold", "threshold"),
        ("what is the mean filter", "meanfilter"),
        ("what is the kernel size", "meanfilter"),
        ("what does clear result do", "clear-result"),
        ("what is k-means", "kmeans"),
        ("what is clustering", "kmeans"),
        ("what is the classification editor", "classification"),
        ("how do I use generate map", "classification"),
        ("what is the map composer", "map-composer"),
        ("tell me about the legend", "map-composer"),
        ("what is a histogram", "histogram"),
        ("what is the distance tool", "distance"),
        ("what is satellite fetch", "satellite-fetch"),
        ("what is sentinel-2 imagery", "satellite-fetch"),
        ("what is undo", "undo-redo"),
    ],
)
def test_help_matching_covers_names_and_aliases(question, tool_id):
    assert help_question(question) is True
    match = match_app_help(question)
    assert match is not None and match["id"] == tool_id, question


@pytest.mark.parametrize(
    "message,intent,operation",
    [
        ("histogram", "process_image", "histogram"),
        ("run k-means", "process_image", "kmeans"),
        ("apply mean filter", "process_image", "meanfilter"),
        ("show me F-8", "fetch_satellite", "F-8"),
        ("show histogram", "fetch_satellite", "histogram"),
        ("what is NDVI?", "ask_question", "what is NDVI?"),
        ("what is GIS?", "ask_question", "what is GIS?"),
    ],
)
def test_commands_are_never_swallowed_by_the_help_router(message, intent, operation):
    """A bare command stays a command; a question about something else still
    reaches the model."""
    result = CommandRouter().route(message)
    assert result["intent"] == intent
    assert operation in (result.get("operation"), result.get("location"), result.get("question"))


def test_help_answer_is_the_glossary_text_and_needs_no_model():
    answer = help_answer("What does the mean filter do?")
    assert answer == "Mean filter - Smooths the image by averaging neighboring pixels."
    assert help_answer("what is NDVI?") is None, "unknown topics fall through to the model"
    assert help_answer("") is None


def test_help_router_returns_an_offline_answer():
    result = CommandRouter().route("what does the laplacian filter do?")
    assert result["intent"] == "help"
    assert result["tool"] == "laplacian"
    assert result["answer"].startswith("Laplacian - ")
    assert build_commands(result) == [], "a help answer carries no client commands"


def test_chat_answers_tool_questions_with_no_api_key():
    """The provider is mocked as unavailable: the answer still arrives (200)."""
    with make_app_client(AIAssistant(api_key=None)) as client:
        response = client.post("/ai/chat", json={"message": "what is the mean filter?"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["intent"] == "help"
    assert payload["reply"] == "Mean filter - Smooths the image by averaging neighboring pixels."
    assert payload["commands"] == []


def test_chat_answers_tool_questions_when_the_provider_is_down():
    def explode(_question):  # pragma: no cover - must never run
        raise AssistantProviderError("The AI provider is unavailable.")

    stub = SimpleNamespace(available=True, ask=explode)
    with make_app_client(stub) as client:
        response = client.post("/ai/chat", json={"message": "how do I use threshold?"})
        assert response.status_code == 200
        assert response.json()["reply"].startswith("Threshold - ")
        # …while a question the glossary cannot answer still fails as before
        failed = client.post("/ai/chat", json={"message": "what is NDVI?"})
    assert failed.status_code == 502


def test_glossary_loader_tolerates_a_broken_file(tmp_path):
    broken = tmp_path / "app_help.json"
    broken.write_text("{not json", encoding="utf-8")
    assert load_app_help(broken) == ()
    broken.write_text(json.dumps({"tools": [{"name": "", "description": "x"}]}), encoding="utf-8")
    assert load_app_help(broken) == (), "entries without a name or description are skipped"
    good = tmp_path / "good.json"
    good.write_text(json.dumps({"tools": [{"name": "T", "description": "D.", "aliases": ["t"]}]}), encoding="utf-8")
    assert load_app_help(good)[0]["name"] == "T"
