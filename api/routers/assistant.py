"""
AI chat: rule-based routing, the offline app glossary, then the model.

Order matters (item 15). A tool question ("what does the mean filter do") is
answered from `geocluster/data/app_help.json` and returns 200 with the glossary
text even when no API key is configured or the provider is rate limited; only
questions the glossary cannot answer reach the language model.

Task 1: the model may both answer in text and pick ONE action from the fixed
whitelist in `geocluster/assistant.py`. The action travels back in `action`
(with the same object also present in `commands`, the list the client
executes), is always range-checked server-side, and is dropped - not forwarded
- when the name is unknown, a parameter is out of range or the app state the
client reported cannot run it. The model can never pick satellite coordinates
or start a satellite fetch: no such action exists in the whitelist.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

import schemas
from dependencies import require_auth
from geocluster.assistant import build_commands
from geocluster.errors import AssistantProviderError, AssistantUnavailable
from ratelimit import rate_limit_dependency

router = APIRouter(prefix="/ai", tags=["assistant"], dependencies=[Depends(require_auth)])


def _rate_limit(request: Request) -> None:
    limiter = getattr(request.app.state, "ai_limiter", None)
    if limiter is None:
        return
    dependency = rate_limit_dependency(limiter, "Too many AI requests; try again shortly.")
    dependency(request)


@router.post("/chat", response_model=schemas.ChatResponse)
def chat(request: schemas.ChatRequest, http_request: Request) -> schemas.ChatResponse:
    _rate_limit(http_request)
    command_router = http_request.app.state.command_router
    assistant = http_request.app.state.assistant

    result = command_router.route(request.message)
    intent = str(result.get("intent", "ask_question"))

    if intent == "help":
        # offline: answered from the glossary above, never from the provider
        return schemas.ChatResponse(intent="help", reply=str(result.get("answer") or ""), commands=[])

    if intent != "ask_question":
        # explicit one-line commands and satellite requests never call the
        # model: they keep working with no key, no network and when it is down
        return schemas.ChatResponse(intent=intent, reply=None, commands=build_commands(result))

    if not assistant.available:
        raise HTTPException(status_code=503, detail="The AI assistant is not configured.")
    question = str(result.get("question") or request.message)
    try:
        outcome = assistant.ask_with_action(question, request.app_context())
    except AssistantUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AssistantProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    action = schemas.ChatAction(**outcome.action) if outcome.action else None
    return schemas.ChatResponse(
        intent="action" if action else intent,
        reply=outcome.reply,
        action=action,
        # the same validated command the router would have produced, so the
        # client keeps ONE execution path for every kind of message
        commands=[dict(outcome.action)] if outcome.action else [],
    )
