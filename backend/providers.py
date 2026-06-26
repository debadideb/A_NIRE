"""Pluggable LLM backends for rationale generation.

Provider selection is entirely env-driven, so a different model can be swapped
in for experiments with NO code change — set `LLM_PROVIDER` (+ that provider's
vars) in `.env` and restart. Two providers ship:

  anthropic  → Anthropic SDK (Claude).
               Vars: ANTHROPIC_API_KEY [, ANTHROPIC_BASE_URL]
  openai     → ANY OpenAI-compatible endpoint via the `openai` SDK.
               Vars: OPENAI_BASE_URL, OPENAI_API_KEY.
               Covers Ollama (local, free), Qwen/DashScope, OpenRouter, Groq,
               GLM (z.ai OpenAI mode), vLLM, LM Studio, …

To add a provider: write a `_complete_<name>` function (it takes
system/user/model/timeout and returns the text, raising on failure) and add it
to PROVIDERS + DEFAULT_MODELS. Nothing else changes — llm.py and the API are
provider-agnostic.

Keys are read from the environment here, server-side; they never reach the
frontend (only the finished rationale text does).
"""

import os

MAX_TOKENS = 1024

DEFAULT_MODELS = {
    "anthropic": "claude-opus-4-8",
    "openai": "qwen2.5",  # e.g. Ollama's qwen2.5; override with LLM_MODEL
}


def _complete_anthropic(system: str, user: str, model: str, timeout: float) -> str:
    import anthropic

    client = anthropic.Anthropic(timeout=timeout, max_retries=1)  # ANTHROPIC_API_KEY [+ ANTHROPIC_BASE_URL]
    msg = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(b.text for b in msg.content if b.type == "text").strip()


def _complete_openai(system: str, user: str, model: str, timeout: float) -> str:
    from openai import OpenAI

    client = OpenAI(
        base_url=os.environ.get("OPENAI_BASE_URL") or None,
        api_key=os.environ.get("OPENAI_API_KEY") or "not-needed",  # Ollama ignores it
        timeout=timeout,
        max_retries=1,
    )
    resp = client.chat.completions.create(
        model=model,
        max_tokens=MAX_TOKENS,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return (resp.choices[0].message.content or "").strip()


PROVIDERS = {
    "anthropic": _complete_anthropic,
    "openai": _complete_openai,
}


def status() -> tuple[str, str | None, bool, str]:
    """Resolve the configured provider/model and whether it is usable.

    Returns (provider, model, ready, reason). `ready` is False — with a short
    machine-readable `reason` — when the provider is unknown or its required
    env vars are missing, so the caller can fall back without a doomed call.
    """
    provider = (os.environ.get("LLM_PROVIDER") or "anthropic").strip().lower()
    if provider not in PROVIDERS:
        return provider, None, False, f"unknown_provider:{provider}"

    model = (os.environ.get("LLM_MODEL") or "").strip() or DEFAULT_MODELS[provider]

    if provider == "anthropic":
        if not (os.environ.get("ANTHROPIC_API_KEY") or "").strip():
            return provider, model, False, "no_anthropic_key"
    elif provider == "openai":
        # Require an EXPLICIT base URL: without it the openai SDK defaults to
        # api.openai.com, which could send a key meant for OpenRouter/DashScope/
        # GLM/Ollama to the wrong endpoint. For official OpenAI, set
        # OPENAI_BASE_URL=https://api.openai.com/v1 explicitly.
        if not (os.environ.get("OPENAI_BASE_URL") or "").strip():
            return provider, model, False, "no_openai_base_url"

    return provider, model, True, "ok"


def complete(system: str, user: str, timeout: float = 30.0) -> tuple[str, str, str]:
    """Run the configured provider. Returns (text, provider, model); raises on failure."""
    provider, model, ready, reason = status()
    if not ready:
        raise RuntimeError(reason)
    text = PROVIDERS[provider](system, user, model, timeout)
    return text, provider, model
