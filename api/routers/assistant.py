"""
AI chat: rule-based routing, the offline app glossary, then the model.

Order matters (item 15). A tool question ("what does the mean filter do") is
answered from `geocluster/data/app_help.json` and returns 200 with the glossary
text even when no API key is configured or the provider is rate limited; only
questions the glossary cannot answer reach the language model.
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
    commands = build_commands(result)

    if intent == "help":
        # offline: answered from the glossary above, never from the provider
        return schemas.ChatResponse(intent="help", reply=str(result.get("answer") or ""), commands=[])

    if intent != "ask_question":
        return schemas.ChatResponse(intent=intent, reply=None, commands=commands)

    if not assistant.available:
        raise HTTPException(status_code=503, detail="The AI assistant is not configured.")
    question = str(result.get("question") or request.message)
    try:
        reply = assistant.ask(question)
    except AssistantUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AssistantProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return schemas.ChatResponse(intent=intent, reply=reply, commands=[])
