"""Shared TypeSafe decision-model HTTP contract."""

from __future__ import annotations

import math
from typing import Any

import httpx

from mona.config.schema import JevConfig
from mona.security.network import validate_url_target


def decision_endpoint(config: JevConfig) -> str:
    base = config.api_base.strip().rstrip("/")
    return base if base.endswith("/systemone") else f"{base}/systemone"


def validated_choice(answer: Any, choices: dict[str, Any], name: str) -> str:
    if not isinstance(answer, dict) or answer.get("choice") not in choices:
        raise ValueError(f"Decision model returned an invalid {name} choice")
    probabilities = answer.get("probabilities")
    confidence = answer.get("confidence")
    if probabilities is not None:
        if not isinstance(probabilities, dict) or set(probabilities) != set(choices):
            raise ValueError(f"Decision model returned invalid {name} probabilities")
        values = [*probabilities.values(), confidence]
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
            or value > 1
            for value in values
        ):
            raise ValueError(f"Decision model returned invalid {name} confidence")
    return str(answer["choice"])


async def request_decisions(
    *,
    config: JevConfig,
    state: dict[str, Any],
    questions: dict[str, Any],
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    if not config.api_key.strip():
        raise ValueError("Decision model API Key is not configured")
    endpoint = decision_endpoint(config)
    ok, error = validate_url_target(endpoint)
    if not ok:
        raise ValueError(f"Decision model API address is blocked: {error}")

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(config.timeout_seconds),
            follow_redirects=False,
        )
    try:
        response = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {config.api_key}"},
            json={"model": config.model, "state": state, "questions": questions},
        )
    finally:
        if owns_client:
            await client.aclose()
    if response.status_code in {401, 403}:
        raise RuntimeError("Decision model API Key was rejected")
    if response.status_code >= 400:
        raise RuntimeError(f"Decision model service returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("Decision model service returned invalid JSON") from exc
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        raise RuntimeError("Decision model response is missing answers")
    return answers
