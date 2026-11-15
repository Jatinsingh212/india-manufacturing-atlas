"""Free / OpenAI-compatible LLM mode of the assistant (Groq, xAI Grok, Gemini, OpenRouter) with a fake HTTP client."""
from __future__ import annotations

import json

import pytest

from app.services import assistant_engine as engine

LLM_ENV = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "GROQ_API_KEY", "XAI_API_KEY",
           "GEMINI_API_KEY", "OPENROUTER_API_KEY"]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in LLM_ENV:
        monkeypatch.delenv(name, raising=False)


class FakeResponse:
    def __init__(self, status: int, body: dict | None = None):
        self.status_code = status
        self._body = body or {}
        self.text = json.dumps(self._body)

    def json(self) -> dict:
        return self._body


class FakePost:
    """Replays queued responses and records each request body."""

    def __init__(self, *responses: FakeResponse):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, url, headers=None, json=None, timeout=None):  # noqa: A002 - mirrors requests.post
        self.calls.append({"url": url, "headers": headers, "json": dict(json or {})})  # snapshot: body is reused
        return self.responses.pop(0)


def _tool_call(name: str, args: dict) -> FakeResponse:
    return FakeResponse(200, {"choices": [{"finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": None,
        "tool_calls": [{"id": "call_1", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)}}]}}]})


def _answer(text: str) -> FakeResponse:
    return FakeResponse(200, {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": text}}]})


def test_no_key_means_offline():
    assert engine.llm_config() is None
    assert engine.status()["mode"] == "offline"


def test_groq_key_selects_groq_preset(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    cfg = engine.llm_config()
    assert cfg["provider"] == "groq" and cfg["base_url"].startswith("https://api.groq.com")
    st = engine.status()
    assert st["mode"] == "groq" and st["provider"] == "Groq" and st["model"]


def test_explicit_provider_and_model_override(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "xai")
    monkeypatch.setenv("LLM_API_KEY", "xai-test")
    monkeypatch.setenv("LLM_MODEL", "grok-custom")
    cfg = engine.llm_config()
    assert (cfg["provider"], cfg["model"], cfg["base_url"]) == ("xai", "grok-custom", "https://api.x.ai/v1")


def test_unknown_provider_without_base_url_stays_offline(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "nope")
    monkeypatch.setenv("LLM_API_KEY", "k")
    assert engine.llm_config() is None


def test_tool_loop_runs_atlas_tool_and_cites(db_conn):
    cfg = {"provider": "groq", "label": "Groq", "base_url": "https://example.test/v1", "model": "m",
           "api_key": "k"}
    post = FakePost(_tool_call("get_product", {"hsn8": "61091000"}),
                    _answer("Cotton T-shirts (6109.10.00) are owned by the Ministry of Textiles."))
    out = engine.chat_llm(db_conn, [{"role": "user", "content": "Who owns cotton T-shirts?"}], cfg, post=post)
    assert out["mode"] == "groq" and out["model"] == "m"
    assert "get_product" in out["tools_used"]
    assert "Ministry of Textiles" in out["reply"]
    # second request carries the tool result back to the model, and the bearer key
    second = post.calls[1]["json"]["messages"]
    assert second[0]["role"] == "system" and any(m["role"] == "tool" for m in second)
    assert post.calls[0]["headers"]["Authorization"] == "Bearer k"
    assert post.calls[0]["json"]["tools"][0]["type"] == "function"


def test_rate_limited_model_falls_over_to_the_next_model(db_conn):
    cfg = {"provider": "groq", "label": "Groq", "base_url": "https://example.test/v1", "model": "a",
           "models": ["a", "b"], "api_key": "k"}
    post = FakePost(FakeResponse(429), _answer("Answered by the second model."))
    out = engine.chat_llm(db_conn, [{"role": "user", "content": "hi"}], cfg, post=post, sleep=lambda s: None)
    assert out["mode"] == "groq" and out["model"] == "b"
    assert [c["json"]["model"] for c in post.calls] == ["a", "b"]


def test_groq_preset_lists_fallback_models(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    models = engine.llm_config()["models"]
    assert models[0] == "openai/gpt-oss-120b" and len(models) >= 2
    monkeypatch.setenv("LLM_FALLBACK_MODELS", "")
    assert engine.llm_config()["models"] == ["openai/gpt-oss-120b"]


def test_bad_tool_arguments_go_back_to_the_model_as_an_error(db_conn):
    cfg = {"provider": "groq", "label": "Groq", "base_url": "https://example.test/v1", "model": "m",
           "api_key": "k"}
    post = FakePost(_tool_call("get_product", {"code": "61091000"}), _answer("Sorry, retrying."))
    out = engine.chat_llm(db_conn, [{"role": "user", "content": "61091000"}], cfg, post=post)
    tool_msg = next(m for m in post.calls[1]["json"]["messages"] if m["role"] == "tool")
    assert tool_msg["content"].startswith("Error:") and "hsn8" in tool_msg["content"]
    assert out["mode"] == "groq"


@pytest.mark.parametrize("status, phrase", [(401, "rejected the API key"), (429, "free-tier limit"),
                                            (500, "HTTP 500")])
def test_api_errors_fall_back_to_offline(db_conn, status, phrase):
    cfg = {"provider": "groq", "label": "Groq", "base_url": "https://example.test/v1", "model": "m",
           "api_key": "k"}
    out = engine.chat_llm(db_conn, [{"role": "user", "content": "61091000"}], cfg, post=FakePost(FakeResponse(status)))
    assert out["mode"] == "offline" and phrase in out["reply"]
