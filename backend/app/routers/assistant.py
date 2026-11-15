"""AI assistant - "Ask Atlas" (docs/SPEC.md section 6.14).

The router is a thin HTTP layer over :mod:`app.services.assistant_engine`, which holds the data tools, the
Claude tool-use loop and the deterministic offline engine.

Endpoints (public - the assistant is part of the open module, SPEC section 5)
------------------------------------------------------------------------------
* ``GET  /api/assistant/status`` -> ``{mode: "claude" | "offline", model: str | null, tools: [str],
  limits: {max_messages, max_chars}}``. ``mode`` is ``claude`` when the server has ``ANTHROPIC_API_KEY``.
* ``POST /api/assistant/chat {messages: [{role: "user" | "assistant", content}]}`` ->
  ``{reply (markdown), citations: [{type, id, label, route}], mode, tools_used: [str], model: str | null}``.

Request rules (decisions recorded here, per the SPEC's "write the decision into your docstring")
------------------------------------------------------------------------------------------------
* The conversation must end with a ``user`` turn that has text (422 otherwise). Empty turns are dropped and
  consecutive same-role turns merged by :func:`app.services.assistant_engine.normalize_messages`.
* Only the last :data:`MAX_MESSAGES` turns are answered from (older context is dropped, the newest user turn is
  always kept). A user turn may hold at most :data:`MAX_CHARS` characters (422 above it); earlier assistant
  replies, which the client sends back verbatim and which can be long tables, are shortened to
  :data:`MAX_ASSISTANT_CHARS` instead of being rejected. This bounds the cost of a Claude-mode call and the work
  of an offline answer.
* Claude mode is rate-limited per client address (:data:`CLAUDE_RATE_PER_MINUTE`, env
  ``ATLAS_ASSISTANT_RATE_PER_MINUTE``; 429 with ``Retry-After`` when exceeded) because it spends API credit on
  behalf of anonymous visitors. Offline answers are local SQL only and are not limited.
* Privacy: nothing leaves the server in offline mode. In Claude mode only the conversation and the results of the
  Atlas's own tools are sent, and only to the Anthropic API. The chat is not stored or audited (it changes no
  data); the log records mode, tools and latency, never the text.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.config import get_settings
from app.db import get_db
from app.security import RateLimiter
from app.services import assistant_engine as engine

log = logging.getLogger("atlas.assistant")

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

#: Turns kept from the end of the conversation.
MAX_MESSAGES = 20
#: Maximum characters in one user turn.
MAX_CHARS = 4000
#: Earlier assistant replies are shortened to this many characters.
MAX_ASSISTANT_CHARS = 6000
#: Hard ceiling on any turn in the request body (anything longer is rejected by validation).
MAX_BODY_CHARS = 100_000
#: Claude-mode requests per client address per minute (0 disables the limit).
CLAUDE_RATE_PER_MINUTE = 20


class ChatMessage(BaseModel):
    """One conversation turn."""

    role: Literal["user", "assistant"]
    content: str = Field(default="", max_length=MAX_BODY_CHARS)


class ChatRequest(BaseModel):
    """``POST /api/assistant/chat`` body."""

    messages: list[ChatMessage] = Field(min_length=1, max_length=200)


class Citation(BaseModel):
    """A link from the answer to an Atlas page."""

    type: str
    id: str
    label: str | None = None
    route: str | None = None


class ChatResponse(BaseModel):
    """``POST /api/assistant/chat`` reply."""

    reply: str
    citations: list[Citation]
    mode: str  # "claude" | "groq" | "xai" | "gemini" | "openrouter" | "custom" | "offline"
    tools_used: list[str]
    model: str | None = None


_RateLimiter = RateLimiter  # shared sliding-window limiter (app.security), also used by the login throttle


_limiter = _RateLimiter()


def _preload_sdk() -> None:
    """Import the Anthropic SDK in the background when Claude mode is configured (the first import takes
    several seconds on slow disks, which would otherwise delay the first answer)."""
    def _load() -> None:
        try:
            import anthropic  # noqa: F401 - warm the module cache only
        except Exception as exc:  # noqa: BLE001 - Claude mode then falls back to offline per request
            log.warning("could not import the anthropic SDK: %s", exc)

    if get_settings().anthropic_api_key:
        threading.Thread(target=_load, name="atlas-anthropic-preload", daemon=True).start()


_preload_sdk()


def _rate_per_minute() -> int:
    raw = os.environ.get("ATLAS_ASSISTANT_RATE_PER_MINUTE")
    if raw is None or not raw.strip():
        return CLAUDE_RATE_PER_MINUTE
    try:
        return max(0, int(raw))
    except ValueError:
        log.warning("ATLAS_ASSISTANT_RATE_PER_MINUTE=%r is not an integer - using %d", raw,
                    CLAUDE_RATE_PER_MINUTE)
        return CLAUDE_RATE_PER_MINUTE


def _prepare(messages: list[ChatMessage]) -> list[dict]:
    """Normalise the conversation and keep its tail; 422 when it does not end with a user question."""
    convo = engine.normalize_messages([m.model_dump() for m in messages])
    if not convo or convo[-1]["role"] != "user":
        raise HTTPException(status_code=422, detail="The conversation must end with a non-empty user message.")
    convo = convo[-MAX_MESSAGES:]
    while convo and convo[0]["role"] != "user":  # the Messages API needs the first turn to be the user's
        convo.pop(0)
    for turn in convo:
        if turn["role"] == "user" and len(turn["content"]) > MAX_CHARS:
            raise HTTPException(status_code=422,
                                detail=f"A question may be at most {MAX_CHARS} characters - please shorten it.")
        if turn["role"] == "assistant" and len(turn["content"]) > MAX_ASSISTANT_CHARS:
            turn["content"] = turn["content"][:MAX_ASSISTANT_CHARS] + "\n\n[earlier answer shortened]"
    return convo


@router.get("/status", summary="Assistant mode (Claude or offline) and model")
def assistant_status() -> dict:
    """``{mode, model, tools, limits}`` - ``claude`` when ``ANTHROPIC_API_KEY`` is configured on the server."""
    body = engine.status()
    body["limits"] = {"max_messages": MAX_MESSAGES, "max_chars": MAX_CHARS}
    return body


@router.post("/chat", response_model=ChatResponse, summary="Ask the Atlas a question")
def assistant_chat(payload: ChatRequest, request: Request,
                   conn: sqlite3.Connection = Depends(get_db)) -> dict:
    """Answer the conversation from the Atlas's own data, with citations to the pages behind the numbers."""
    convo = _prepare(payload.messages)
    if get_settings().anthropic_api_key or engine.llm_config():
        client = request.client.host if request.client else "unknown"
        retry_after = _limiter.check(client, _rate_per_minute())
        if retry_after is not None:
            raise HTTPException(status_code=429,
                                detail="Too many assistant questions - please wait a moment and try again.",
                                headers={"Retry-After": str(int(retry_after + 0.999))})
    started = time.perf_counter()
    result = engine.chat(conn, convo)
    log.info("assistant answered: mode=%s tools=%s turns=%d in %.0f ms", result.get("mode"),
             ",".join(result.get("tools_used") or []) or "-", len(convo), (time.perf_counter() - started) * 1000)
    return {"reply": result.get("reply") or "", "citations": result.get("citations") or [],
            "mode": result.get("mode") or "offline", "tools_used": result.get("tools_used") or [],
            "model": result.get("model")}
