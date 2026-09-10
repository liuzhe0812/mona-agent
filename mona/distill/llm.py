"""Small JSON-only LLM helper for profile distillation tasks."""

from __future__ import annotations

import asyncio
import json
from typing import Any, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


def _json_text(text: str) -> str:
    value = text.strip()
    if value.startswith("```"):
        lines = value.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        value = "\n".join(lines).strip()
    # Validate early so callers get one clear JSON error.
    json.loads(value)
    return value


async def call_json(
    *,
    provider: Any,
    model_name: str,
    system: str,
    user: str,
    output_model: type[T],
    max_tokens: int,
    timeout_seconds: int,
) -> T:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    response = await asyncio.wait_for(
        provider.chat(
            messages=messages,
            model=model_name or None,
            temperature=0.2,
            max_tokens=max_tokens,
        ),
        timeout=timeout_seconds,
    )
    from mona.usage import record_provider_usage

    record_provider_usage(provider, model_name or None, response)
    return output_model.model_validate_json(_json_text(response.content or ""))


__all__ = ["call_json"]
