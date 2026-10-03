"""Rule-based command router and the Fireworks AI wrapper.

Both are ported AS IS from the desktop:
  * desktop/frontend/command_router.py  -> CommandRouter
  * desktop/frontend/ai_assistant.py    -> AIAssistant (model, provider base
    URL and prompts are unchanged; do not "fix" the known expired-credits
    issue here)

The only deliberate API-era changes:
  * constructing AIAssistant never raises - `available` reports whether a key
    is configured (the endpoint answers 503 when it is not)
  * provider failures raise AssistantProviderError (logged server-side) so the
    endpoint can answer 502 instead of returning "Error code: 404 ..." in a 200
  * `build_commands` turns router output into structured client commands for
    the operations the desktop never executed (histogram/compress/distance)
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI

from .errors import AssistantProviderError, AssistantUnavailable

load_dotenv()

logger = logging.getLogger("geocluster.assistant")

FIREWORKS_BASE_URL = "https://api.groq.com/openai/v1"
FIREWORKS_MODEL = "openai/gpt-oss-20b"

SYSTEM_PROMPT = """You are GEOCLUSTER AI, an expert in GIS, Remote Sensing, Photogrammetry, and Earth Observation.

CRITICAL RULES - YOU MUST FOLLOW:
- NEVER include any reasoning, thinking process, or step-by-step analysis in your response
- NEVER show internal thoughts or how you arrived at the answer
- Give ONLY the final, direct answer
- Keep answers concise (1-2 sentences for simple definitions)
- Use bullet points only when listing multiple items
- Provide practical, real-world GIS/Remote Sensing explanations

EXAMPLES:
GOOD: "NDVI measures vegetation health using near-infrared and red light reflectance. Values range from -1 to 1, with healthy vegetation above 0.3."

BAD: "Let me think about this. First, I need to consider what NDVI means. NDVI stands for... The formula is... Here's my answer..."

Remember: Direct answers only. No reasoning. No thinking process."""


def clean_response(text: str) -> str:
    """desktop ai_assistant.clean_response (unchanged)."""
    if not text:
        return ""

    # Remove <think> tags (common in some models)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)

    # Remove thinking process sections
    text = re.sub(
        r"(?is)^\s*(thinking process|reasoning|analysis|thought process)\s*:.*?(?=\n\s*(final answer|answer|response)\s*:|\Z)",
        "",
        text,
    )

    # Remove "final answer:" prefix
    text = re.sub(r"(?im)^\s*(final answer|answer|response)\s*:\s*", "", text)

    # Remove numbered steps
    text = re.sub(r"(?im)^\s*(step|stage)\s*\d+.*?(?=\n|$)", "", text)

    # Clean up extra whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


class CommandRouter:
    """desktop command_router.CommandRouter (unchanged logic)."""

    def route(self, prompt: str) -> dict[str, Any]:
        text = prompt.strip()

        if not text:
            return {"intent": "ask_question", "question": ""}

        lower = text.lower()

        # --------------------------------------------------- SATELLITE REQUESTS
        satellite_verbs = ["show me", "show", "load", "fetch", "display", "open", "view", "get"]

        if any(lower.startswith(verb) for verb in satellite_verbs):
            location = text
            for verb in satellite_verbs:
                if lower.startswith(verb):
                    location = text[len(verb):]
                    break
            location = re.sub(
                r"\b(satellite|imagery|image|sentinel|picture|of|for)\b",
                "",
                location,
                flags=re.IGNORECASE,
            )
            location = re.sub(r"\s+", " ", location).strip()
            return {"intent": "fetch_satellite", "location": location}

        # --------------------------------------------------- IMAGE PROCESSING
        operation_map = {
            "kmeans": "kmeans",
            "k-means": "kmeans",
            "mean filter": "meanfilter",
            "threshold": "threshold",
            "brightness": "brightness",
            "negative": "negative",
            "histogram": "histogram",
            "compress": "compress",
            "compression": "compress",
            "distance": "distance",
        }

        for key, value in operation_map.items():
            if key in lower:
                return {"intent": "process_image", "operation": value}

        if "cluster" in lower:
            return {"intent": "process_image", "operation": "kmeans"}

        if "classify" in lower:
            return {"intent": "process_image", "operation": "kmeans"}

        # --------------------------------------------------- EVERYTHING ELSE
        return {"intent": "ask_question", "question": text}


# Executable by the API today (the desktop ran these through the UI).
RUNNABLE_OPERATIONS = frozenset({"kmeans", "meanfilter", "threshold", "brightness", "negative"})

# The desktop router emitted these but never executed them; the API returns
# structured commands so the client (or a later frontend task) can act.
PANEL_COMMANDS = {
    "histogram": {"action": "open_histogram"},
    "compress": {"action": "open_compress"},
    "distance": {"action": "open_distance"},
}


def build_commands(route_result: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate router output into structured, client-executable commands."""
    intent = route_result.get("intent")
    if intent == "fetch_satellite":
        location = str(route_result.get("location", "")).strip()
        if not location:
            return []
        return [{"action": "fetch_satellite", "location": location}]
    if intent == "process_image":
        operation = str(route_result.get("operation", ""))
        if operation in RUNNABLE_OPERATIONS:
            return [{"action": "run_operation", "operation": operation}]
        if operation in PANEL_COMMANDS:
            return [dict(PANEL_COMMANDS[operation])]
    return []


class AIAssistant:
    """Fireworks wrapper; model/provider/prompt unchanged from the desktop."""

    def __init__(self, api_key: str | None = None) -> None:
        key = api_key if api_key is not None else os.getenv("FIREWORKS_API_KEY")
        self._api_key = key or None
        self._client: OpenAI | None = None

    @property
    def available(self) -> bool:
        return bool(self._api_key)

    def _ensure_client(self) -> OpenAI:
        if not self.available:
            raise AssistantUnavailable("FIREWORKS_API_KEY is not configured.")
        if self._client is None:
            self._client = OpenAI(api_key=self._api_key, base_url=FIREWORKS_BASE_URL)
        return self._client

    def ask(self, prompt: str) -> str:
        client = self._ensure_client()
        try:
            response = client.chat.completions.create(
                model=FIREWORKS_MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                max_tokens=600,
                extra_body={"reasoning_effort": "low"},
            )
            answer = response.choices[0].message.content
        except Exception as exc:  # noqa: BLE001 - provider errors are opaque here
            logger.error("Fireworks chat completion failed: %s: %s", exc.__class__.__name__, exc)
            raise AssistantProviderError("The AI provider is unavailable.") from exc
        return clean_response(answer) if answer else ""
