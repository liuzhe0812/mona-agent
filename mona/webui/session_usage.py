"""Whole-session usage from completed turns' recorded model counters."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def summarize_session_usage(
    turns: Iterable[tuple[dict[str, Any] | None, int | None]],
) -> dict[str, Any] | None:
    prompt_tokens = completion_tokens = timed_output_tokens = timed_ms = 0
    cache_read_tokens = cache_write_tokens = latency_ms = None
    models: dict[str, None] = {}

    for usage, duration in turns:
        duration = _count(duration)
        if duration is not None:
            latency_ms = (latency_ms or 0) + duration
        if not usage:
            continue
        prompt = _count(usage.get("promptTokens")) or 0
        output = _count(usage.get("completionTokens")) or 0
        if prompt + output == 0:
            continue
        prompt_tokens += prompt
        completion_tokens += output

        read = _count(usage.get("cacheReadTokens"))
        if read is not None and read <= prompt:
            cache_read_tokens = (cache_read_tokens or 0) + read
        write = _count(usage.get("cacheWriteTokens"))
        if write is not None and write <= prompt:
            cache_write_tokens = (cache_write_tokens or 0) + write
        if duration:
            timed_output_tokens += output
            timed_ms += duration
        model = usage.get("contextModel")
        if isinstance(model, str) and model.strip():
            models[model.strip()] = None

    if prompt_tokens + completion_tokens == 0:
        return None
    return {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "cacheHitRate": cache_read_tokens / prompt_tokens if cache_read_tokens is not None and prompt_tokens else None,
        "latencyMs": latency_ms,
        "outputTokensPerSecond": timed_output_tokens * 1000 / timed_ms if timed_ms else None,
        "models": list(models),
    }
