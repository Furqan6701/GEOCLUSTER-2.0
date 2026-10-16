"""Rule-based command router, the app-help glossary, the action whitelist and
the LLM wrapper.

Which part answers a message:
  * the OFFLINE glossary (item 15) answers "what is / what does / how do I use
    <tool>" from `data/app_help.json`, with no model call at all;
  * the RULE-BASED router answers the explicit one-line commands the desktop
    used ("show me F-8 imagery", "run k-means", "compress this image") - also
    with no model call, so they keep working with no key, no network and when
    the provider is down;
  * everything else reaches the MODEL, which may answer in text AND choose at
    most ONE action from the fixed whitelist in this module.

The router is unchanged from the desktop
(`desktop/frontend/command_router.py`) on purpose, quirks included; the wrapper
is not:

  * constructing AIAssistant never raises - `available` reports whether a key
    is configured (the endpoint answers 503 when it is not)
  * provider failures raise AssistantProviderError (logged server-side) so the
    endpoint can answer 502 instead of returning "Error code: 404 ..." in a 200
  * `build_commands` turns router output into structured client commands
  * `ask_with_action` (Task 1) asks the model for a JSON object with the reply
    text AND an optional action. The action is validated here against
    AI_ACTIONS: an unknown action name, a parameter outside the range the UI
    accepts, or an action that needs state the app does not have (no image, no
    K-Means result, no history) is DROPPED - never forwarded to the client.
    The model can never pick satellite locations or coordinates: no satellite
    action exists in the whitelist, and the reply text never carries any.
  * the model may not choose a satellite fetch - the user's explicit
    "show me <place> imagery" is handled by the router before the model is
    consulted, and the location is resolved server-side by name only.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI

from .errors import AssistantProviderError, AssistantUnavailable

load_dotenv()

logger = logging.getLogger("geocluster.assistant")

# Groq (OpenAI-compatible). The key is read server-side only and is never sent
# to the browser; GROQ_API_KEY is the current name, the older FIREWORKS_API_KEY
# variable is still accepted so an existing api/.env keeps working.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_MODEL = "llama-3.3-70b-versatile"
GROQ_API_KEY_ENV = "GROQ_API_KEY"
LEGACY_API_KEY_ENV = "FIREWORKS_API_KEY"

#: JSON mode keeps the answer machine-readable; the reply is short by design.
LLM_TEMPERATURE = 0.2
LLM_MAX_TOKENS = 600
#: An over-long reply is truncated rather than shown whole (defensive cap).
MAX_REPLY_CHARS = 1200

SYSTEM_PROMPT_BASE = """You are GEOCLUSTER AI, an expert in GIS, Remote Sensing, Photogrammetry, and Earth Observation.

CRITICAL RULES - YOU MUST FOLLOW:
- NEVER include any reasoning, thinking process, or step-by-step analysis in your response
- NEVER show internal thoughts or how you arrived at the answer
- Give ONLY the final, direct answer
- Keep answers concise (1-2 sentences for simple definitions)
- Use bullet points only when listing multiple items
- Provide practical, real-world GIS/Remote Sensing explanations
- Answer in PLAIN TEXT only: no LaTeX, no math markup, no markdown (no **bold**, no #, no backticks, no links)
- Never claim to see the user's image: you cannot look at it, so never describe what is in it
- Say so when you are not sure instead of guessing

EXAMPLES:
GOOD: "NDVI measures vegetation health using near-infrared and red light reflectance. Values range from -1 to 1, with healthy vegetation above 0.3."

BAD: "Let me think about this. First, I need to consider what NDVI means. NDVI stands for... The formula is... Here's my answer..."

Remember: Direct answers only. No reasoning. No thinking process."""


def help_data_path() -> Path:
    """The glossary that ships with the package (one entry per app tool)."""
    return Path(__file__).resolve().parent / "data" / "app_help.json"


def load_app_help(path: Path | None = None) -> tuple[dict[str, Any], ...]:
    """The glossary entries, in file order. A broken/missing file yields none."""
    try:
        with (path or help_data_path()).open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):  # pragma: no cover - the file ships with the package
        logger.warning("app help glossary could not be read")
        return ()
    tools = data.get("tools") if isinstance(data, dict) else None
    if not isinstance(tools, list):
        return ()
    entries: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "").strip()
        description = str(tool.get("description") or "").strip()
        if not name or not description:
            continue
        aliases = [str(alias).strip().lower() for alias in (tool.get("aliases") or []) if str(alias).strip()]
        entries.append({
            "id": str(tool.get("id") or name).strip().lower().replace(" ", "-"),
            "name": name,
            "aliases": aliases,
            "description": description,
        })
    return tuple(entries)


APP_HELP = load_app_help()


def glossary_prompt_section(tools: tuple[dict[str, Any], ...] = APP_HELP) -> str:
    """The glossary as the model sees it: one line per tool."""
    if not tools:
        return ""
    lines = ["APP GLOSSARY - the tools this application offers:"]
    lines.extend(f"- {tool['name']}: {tool['description']}" for tool in tools)
    lines.append(
        "When the user asks what a tool does or how to use one of them, answer with that "
        "description in your own words; do not invent tools or settings that are not listed."
    )
    return "\n".join(lines)


def _build_system_prompt(base: str = SYSTEM_PROMPT_BASE, tools: tuple[dict[str, Any], ...] = APP_HELP) -> str:
    glossary = glossary_prompt_section(tools)
    return f"{base}\n\n{glossary}" if glossary else base


SYSTEM_PROMPT = _build_system_prompt()


# ---------------------------------------------------------- offline app help

# How a question about a tool starts. Deliberately narrow: a bare "histogram"
# or "run k-means" is a COMMAND, while "what is a histogram" is a question.
HELP_QUESTION_TRIGGERS = (
    "what is", "what's", "whats", "what are", "what does", "what do", "what can",
    "how do i use", "how do i", "how to use", "how can i use", "how does",
    "explain", "tell me about", "describe", "define", "meaning of",
)


def help_question(text: str) -> bool:
    """True when the text is shaped like a question about a tool."""
    lower = str(text or "").strip().lower()
    if not lower:
        return False
    return any(lower.startswith(trigger) for trigger in HELP_QUESTION_TRIGGERS) or any(
        f" {trigger} " in f" {lower} " for trigger in ("what is", "what does", "explain", "meaning of")
    )


def match_app_help(text: str, tools: tuple[dict[str, Any], ...] = APP_HELP) -> dict[str, Any] | None:
    """
    The glossary entry a question is about, or None.

    The longest alias wins, so "mean filter window" beats "mean" and
    "satellite imagery" beats "satellite"; aliases are matched on word
    boundaries so "classify" does not fire inside "classified".
    """
    lower = str(text or "").strip().lower()
    if not lower:
        return None
    best: dict[str, Any] | None = None
    best_length = 0
    for tool in tools:
        for alias in (tool["name"].lower(), *tool["aliases"]):
            if len(alias) <= best_length:
                continue
            pattern = rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])"
            if re.search(pattern, lower):
                best = tool
                best_length = len(alias)
    return best


def help_answer(text: str, tools: tuple[dict[str, Any], ...] = APP_HELP) -> str | None:
    """
    The offline answer for a tool question, or None when the question is not
    about one of the app's tools. No model call happens on this path.
    """
    if not help_question(text):
        return None
    tool = match_app_help(text, tools)
    if tool is None:
        return None
    return f"{tool['name']} - {tool['description']}"



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

        # --------------------------------------------------- APP HELP (offline)
        # "What is / what does / how do I use <tool>" is answered from the
        # shipped glossary, so it works with no model, no key and no network.
        # This runs FIRST: a question about a tool must never be executed as a
        # command (the word "threshold" appears in both kinds of message).
        answer = help_answer(text)
        if answer is not None:
            topic = match_app_help(text)
            return {"intent": "help", "tool": (topic or {}).get("id", ""), "answer": answer}

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


# Executable by the API today (the desktop ran these through the UI). K-Means
# is NOT an operation endpoint: it has its own route, and the client runs it
# through the Clusters panel action, exactly like the "Run K-Means" button.
RUNNABLE_OPERATIONS = frozenset({"meanfilter", "threshold", "brightness", "negative", "grayscale", "laplacian"})

# The desktop router emitted these but never executed them; the API returns
# structured commands so the client can act through the matching UI control.
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
        if operation == "kmeans":
            # no parameters: the client runs it through the Clusters panel, so
            # the K on screen is used - exactly like clicking "Run K-Means"
            return [{"action": "run_kmeans"}]
        if operation in RUNNABLE_OPERATIONS:
            return [{"action": "run_operation", "operation": operation}]
        if operation in PANEL_COMMANDS:
            return [dict(PANEL_COMMANDS[operation])]
    return []


# --------------------------------------------------------------- AI whitelist
#
# THE whitelist: what the model may ask the app to do. Nothing outside this
# table is executable, and every parameter is range-checked here before it is
# forwarded to the browser.

@dataclass(frozen=True)
class ParamSpec:
    """One integer parameter the UI accepts (same bounds as the panel/API)."""

    minimum: int
    maximum: int
    default: int
    description: str
    odd: bool = False
    required: bool = False
    #: Plain-text question asked when the parameter is required and missing.
    question: str = ""

    def normalize(self, value: Any) -> int | None:
        """The value as the UI would accept it, or None when out of range.

        Booleans are rejected on purpose (`True` is not `1` here), floats are
        rounded only when they are whole numbers, and odd-only parameters snap
        to the next valid value exactly like the panel's slider does.
        """
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, str) and value.strip().lstrip("+-").isdigit():
            value = int(value.strip())
        if isinstance(value, float):
            if not value.is_integer():
                return None
            value = int(value)
        if not isinstance(value, int):
            return None
        if value < self.minimum or value > self.maximum:
            return None
        if self.odd and value % 2 == 0:
            value = value + 1 if value + 1 <= self.maximum else value - 1
        return value

    @property
    def range_text(self) -> str:
        bounds = f"{self.minimum} to {self.maximum}"
        return f"{self.description}, odd numbers only, {bounds}" if self.odd else f"{self.description}, {bounds}"


@dataclass(frozen=True)
class ActionSpec:
    """One selectable action: what the model says, what the client executes."""

    name: str
    summary: str
    #: client command name ("run_operation", "open_histogram", ...)
    command: str
    #: the operation for `run_operation` commands
    operation: str | None = None
    params: tuple[tuple[str, ParamSpec], ...] = ()
    #: app state the action needs: "image", "clusters", "history"
    requires: tuple[str, ...] = ("image",)

    def command_for(self, values: dict[str, int] | None = None) -> dict[str, Any]:
        command: dict[str, Any] = {"action": self.command}
        if self.operation:
            command["operation"] = self.operation
        if values:
            command["params"] = dict(values)
        return command


AI_ACTIONS: tuple[ActionSpec, ...] = (
    ActionSpec("grayscale", "Convert the current image to grayscale.", "run_operation", operation="grayscale"),
    ActionSpec("negative", "Invert the current image (photographic negative).", "run_operation", operation="negative"),
    ActionSpec("laplacian", "Edge detection with the Laplacian filter.", "run_operation", operation="laplacian"),
    ActionSpec(
        "brightness",
        "Shift every pixel value by a constant (positive = brighter, negative = darker).",
        "run_operation",
        operation="brightness",
        params=(("value", ParamSpec(
            -255, 255, 0, "brightness shift", required=True,
            question="How much should the brightness change? Give a value from -255 to 255, for example 40.",
        )),),
    ),
    ActionSpec(
        "threshold",
        "Binarise the image: colour values above the threshold become maximum, the rest zero.",
        "run_operation",
        operation="threshold",
        params=(("value", ParamSpec(0, 255, 128, "threshold value")),),
    ),
    ActionSpec(
        "mean_filter",
        "Smooth the image by averaging neighbouring pixels.",
        "run_operation",
        operation="meanfilter",
        params=(("window", ParamSpec(3, 31, 3, "kernel size", odd=True)),),
    ),
    ActionSpec(
        "run_kmeans",
        "Run K-Means clustering over the image intensities.",
        "run_kmeans",
        params=(("k", ParamSpec(2, 10, 5, "number of clusters")),),
    ),
    ActionSpec(
        "classify_clusters",
        "Apply the classified ranges and generate the classified map in the Map composer.",
        "classify_clusters",
        requires=("image", "clusters"),
    ),
    ActionSpec("open_map_composer", "Open the Map composer to build a map from the result.", "open_map_composer"),
    ActionSpec("open_histogram", "Open the histogram window for the current image.", "open_histogram"),
    ActionSpec("open_compress", "Compress the current image losslessly to a .gch file (GCH2).", "open_compress"),
    ActionSpec("open_distance", "Turn on the distance measurement tool.", "open_distance"),
    ActionSpec("export_png", "Export the current image as a PNG download.", "export_png"),
    ActionSpec(
        "export_label_map",
        "Export the raw K-Means label map as a PNG download.",
        "export_label_map",
        requires=("image", "clusters"),
    ),
    ActionSpec("undo", "Undo the last processing step.", "undo", requires=("history",)),
    ActionSpec("redo", "Redo the step that was undone.", "redo", requires=("history",)),
    ActionSpec("clear_result", "Clear the result viewport (the working image is kept).", "clear_result"),
    ActionSpec("fit_view", "Fit the image to the active viewport.", "fit_view"),
    ActionSpec("actual_size", "Show the active viewport at 100% (actual pixel size).", "actual_size"),
    ActionSpec("zoom_in", "Zoom the active viewport in.", "zoom_in"),
    ActionSpec("zoom_out", "Zoom the active viewport out.", "zoom_out"),
)

AI_ACTIONS_BY_NAME: dict[str, ActionSpec] = {spec.name: spec for spec in AI_ACTIONS}

#: What the app currently holds, as sent by the browser with each message.
CONTEXT_KEYS = ("has_image", "has_clusters", "has_history", "can_undo", "can_redo")


def app_context(raw: Any = None) -> dict[str, bool]:
    """Normalise the client's app-state flags (missing/odd input -> all False)."""
    context = {key: False for key in CONTEXT_KEYS}
    if isinstance(raw, dict):
        for key in CONTEXT_KEYS:
            context[key] = bool(raw.get(key))
    return context


def context_satisfied(spec: ActionSpec, context: dict[str, bool]) -> bool:
    """Whether the app can actually run `spec` right now."""
    if "image" in spec.requires and not context.get("has_image"):
        return False
    if "clusters" in spec.requires and not context.get("has_clusters"):
        return False
    if "history" in spec.requires:
        if not context.get("has_history"):
            return False
        if spec.name == "undo" and not context.get("can_undo"):
            return False
        if spec.name == "redo" and not context.get("can_redo"):
            return False
    return True


def _split_action(raw: Any) -> tuple[str, dict[str, Any]]:
    """The (name, params) the model asked for, tolerating the usual shapes.

    Accepted: {"action": "mean_filter", "params": {"window": 5}},
    {"action": "mean_filter", "window": 5}, {"action": {"name": ..., ...}} and
    the bare string "mean_filter".
    """
    if isinstance(raw, str):
        return raw.strip().lower(), {}
    if not isinstance(raw, dict):
        return "", {}
    name = raw.get("action") or raw.get("name") or raw.get("operation") or ""
    if isinstance(name, dict):  # {"action": {"name": "...", "params": {...}}}
        inner = name
        name = inner.get("action") or inner.get("name") or ""
        params = inner.get("params") if isinstance(inner.get("params"), dict) else {}
        return str(name).strip().lower(), dict(params)
    params = raw.get("params") if isinstance(raw.get("params"), dict) else {}
    # flat form: the parameter sits next to the action name
    for key, value in raw.items():
        if key not in ("action", "name", "operation", "params"):
            params.setdefault(str(key), value)
    return str(name).strip().lower(), dict(params)


def validate_ai_action(raw: Any, context: dict[str, bool] | None = None) -> tuple[dict[str, Any] | None, str | None]:
    """The command to execute for the model's action, or (None, reason).

    Rejections are total: one bad parameter discards the whole action instead of
    trusting part of it.
    """
    state = app_context(context)
    if raw in (None, "", {}, []):
        return None, None
    name, params = _split_action(raw)
    if not name:
        return None, "malformed-action"
    spec = AI_ACTIONS_BY_NAME.get(name)
    if spec is None:
        return None, f"unknown-action:{name}"
    if not context_satisfied(spec, state):
        return None, f"unavailable:{name}"
    values: dict[str, int] = {}
    for param_name, param in spec.params:
        if param_name not in params:
            if param.required:
                return None, f"missing-parameter:{name}.{param_name}"
            values[param_name] = param.default
            continue
        normalized = param.normalize(params[param_name])
        if normalized is None:
            return None, f"out-of-range:{name}.{param_name}"
        values[param_name] = normalized
    unknown = set(params) - {param_name for param_name, _ in spec.params}
    if unknown:
        return None, f"unknown-parameter:{name}.{sorted(unknown)[0]}"
    return spec.command_for(values), None


def action_prompt_section(actions: tuple[ActionSpec, ...] = AI_ACTIONS) -> str:
    """The whitelist exactly as the model sees it, plus the JSON contract."""
    lines = [
        "ACTIONS YOU MAY REQUEST - pick at most ONE, or none:",
    ]
    for spec in actions:
        line = f"- {spec.name}: {spec.summary}"
        if spec.params:
            described = "; ".join(
                f"{param_name} ({param.range_text})" for param_name, param in spec.params
            )
            line += f" Parameters: {described}."
        lines.append(line)
    lines.extend([
        "",
        "HOW TO ANSWER - reply with ONE JSON object and nothing else:",
        '{"reply": "your answer as plain text", "action": null}',
        'or {"reply": "your answer as plain text", "action": {"action": "mean_filter", "params": {"window": 5}}}',
        "action must be null unless the user clearly asks for one of the actions above.",
        "Use null for questions, definitions, greetings and anything unclear; ask what they want instead.",
        "Never invent an action name, never add a parameter that is not listed, never guess a missing value:",
        "ask for it in the reply instead.",
        "Only choose an action that needs a loaded image when the state below says an image is loaded; if the",
        "state says no image is loaded, answer in text and ask the user to upload or fetch one first.",
        "Only choose classify_clusters or export_label_map when the state says a K-Means result exists.",
        "Only choose undo when undo is available, and redo when redo is available.",
        "You cannot fetch satellite imagery and you never mention coordinates; the user's explicit",
        "satellite request is handled by the app itself.",
        "reply holds plain text only: no LaTeX, no math markup, no markdown, no JSON, at most 3 sentences.",
    ])
    return "\n".join(lines)


def app_state_prompt_section(context: Any = None) -> str:
    """The client's app state, as the model sees it."""
    state = app_context(context)
    return "\n".join([
        "CURRENT APP STATE:",
        f"- Image loaded: {'yes' if state['has_image'] else 'no'}",
        f"- K-Means result available: {'yes' if state['has_clusters'] else 'no'}",
        f"- Undo available: {'yes' if state['can_undo'] else 'no'}",
        f"- Redo available: {'yes' if state['can_redo'] else 'no'}",
    ])


def _build_action_system_prompt() -> str:
    return "\n\n".join([
        SYSTEM_PROMPT_BASE,
        glossary_prompt_section(),
        action_prompt_section(),
    ])


ACTION_SYSTEM_PROMPT = _build_action_system_prompt()


# ------------------------------------------------------- model reply handling

@dataclass(frozen=True)
class AssistantOutcome:
    """What one chat message produced: text, and at most one valid action."""

    reply: str
    action: dict[str, Any] | None = None
    #: why a model-requested action was dropped (logged, never sent to a client)
    rejected: str | None = None


def _json_object_from(text: str) -> dict[str, Any] | None:
    """The JSON object in the model's answer, tolerating ``` fences and prose."""
    raw = str(text or "").strip()
    if not raw:
        return None
    fenced = re.search(r"```(?:json)?\s*(.*?)```", raw, flags=re.DOTALL)
    if fenced:
        raw = fenced.group(1).strip()
    try:
        data = json.loads(raw)
    except ValueError:
        start, end = raw.find("{"), raw.rfind("}")
        if start == -1 or end <= start:
            return None
        try:
            data = json.loads(raw[start:end + 1])
        except ValueError:
            return None
    return data if isinstance(data, dict) else None


def interpret_ai_reply(text: str, context: Any = None) -> AssistantOutcome:
    """Turn the model's JSON answer into a reply and (optionally) a command.

    A reply that is not JSON at all is still shown as plain text: the assistant
    must never be silent just because the provider ignored the format.
    """
    data = _json_object_from(text)
    if data is None:
        return AssistantOutcome(reply=clean_response(text)[:MAX_REPLY_CHARS], action=None, rejected="not-json")

    reply = clean_response(str(data.get("reply") or data.get("answer") or ""))[:MAX_REPLY_CHARS]
    action, rejected = validate_ai_action(data.get("action"), context)

    if action is None and rejected:
        logger.info("dropped the model's requested action: %s", rejected)
    # a rejected action still needs a text answer the user can act on
    if not reply and rejected:
        reply = _clarification_for(rejected)
    if not reply and action is not None:
        reply = f"Applying that now: {action['action'].replace('_', ' ')}."
    return AssistantOutcome(reply=reply, action=action, rejected=rejected)


def _clarification_for(reason: str) -> str:
    """Plain-text answer used when the model asked for something unusable."""
    kind, _, detail = reason.partition(":")
    if kind == "missing-parameter":
        action_name, _, parameter = detail.partition(".")
        spec = AI_ACTIONS_BY_NAME.get(action_name)
        for param_name, param in (spec.params if spec else ()):
            if param_name == parameter and param.question:
                return param.question
        return "Which value should I use? Tell me the number and I will apply it."
    if kind == "unavailable":
        return (
            "I cannot do that yet - load an image first (or run K-Means when the classification is needed), "
            "then ask me again."
        )
    if kind == "unknown-action":
        return "I am not sure which tool you mean. Tell me the tool name and the value, or use the panels on the left."
    if kind == "out-of-range":
        return "That value is outside the range the tool accepts. The panels on the left show the valid range."
    if kind == "not-json":
        return ""
    return "Tell me a little more and I will do it, or use the panels on the left."


class AIAssistant:
    """Groq wrapper (OpenAI-compatible JSON mode)."""

    def __init__(self, api_key: str | None = None) -> None:
        if api_key is not None:
            key = api_key
        else:
            key = os.getenv(GROQ_API_KEY_ENV) or os.getenv(LEGACY_API_KEY_ENV)
        self._api_key = key or None
        self._client: OpenAI | None = None

    @property
    def available(self) -> bool:
        return bool(self._api_key)

    def _ensure_client(self) -> OpenAI:
        if not self.available:
            raise AssistantUnavailable(f"{GROQ_API_KEY_ENV} is not configured.")
        if self._client is None:
            self._client = OpenAI(api_key=self._api_key, base_url=GROQ_BASE_URL)
        return self._client

    def _completion(self, messages: list[dict[str, str]], *, json_mode: bool) -> str:
        client = self._ensure_client()
        request: dict[str, Any] = {
            "model": GROQ_MODEL,
            "messages": messages,
            "temperature": LLM_TEMPERATURE,
            "max_tokens": LLM_MAX_TOKENS,
        }
        if json_mode:
            request["response_format"] = {"type": "json_object"}
        try:
            response = client.chat.completions.create(**request)
            answer = response.choices[0].message.content
        except Exception as exc:  # noqa: BLE001 - provider errors are opaque here
            logger.error("Groq chat completion failed: %s: %s", exc.__class__.__name__, exc)
            raise AssistantProviderError("The AI provider is unavailable.") from exc
        return answer or ""

    def ask(self, prompt: str) -> str:
        """Plain-text answer, no action (kept for callers that only want text)."""
        answer = self._completion(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            json_mode=False,
        )
        return clean_response(answer)[:MAX_REPLY_CHARS]

    def ask_with_action(self, prompt: str, context: Any = None) -> AssistantOutcome:
        """Answer `prompt` and return the reply plus an optional valid action."""
        answer = self._completion(
            [
                {"role": "system", "content": f"{ACTION_SYSTEM_PROMPT}\n\n{app_state_prompt_section(context)}"},
                {"role": "user", "content": prompt},
            ],
            json_mode=True,
        )
        return interpret_ai_reply(answer, context)
