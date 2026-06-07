"""Embedding API client with auto-halve retry.

Supports OpenAI-compatible, Google Gemini native, and Ollama endpoints.
Ported from llm_wiki_tmp/src/lib/embedding.ts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import httpx
from loguru import logger

RESERVED_HEADER_NAMES = frozenset({
    "authorization", "content-type", "host", "content-length", "x-goog-api-key",
})
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

_last_embedding_error: str | None = None


def get_last_embedding_error() -> str | None:
    return _last_embedding_error


@dataclass
class EmbeddingConfig:
    enabled: bool = False
    endpoint: str = ""
    api_key: str = ""
    model: str = ""
    output_dimensionality: int | None = None
    extra_headers: dict[str, str] = field(default_factory=dict)


def _is_google_config(cfg: EmbeddingConfig) -> bool:
    lower = cfg.endpoint.lower()
    return "generativelanguage.googleapis.com" in lower or ":embedcontent" in lower


def _google_endpoint(cfg: EmbeddingConfig) -> str:
    raw = _strip_google_api_key_query(cfg.endpoint.strip()).rstrip("/")
    if ":batchembedcontents" in raw.lower():
        return re.sub(r":batchEmbedContents", ":embedContent", raw, flags=re.IGNORECASE)
    if ":embedcontent" in raw.lower():
        return raw
    model_path = _google_model_path(cfg.model)
    if "/models/" in raw.lower():
        return f"{raw}:embedContent"
    return f"{raw}/models/{model_path}:embedContent"


def _strip_google_api_key_query(endpoint: str) -> str:
    if "?" not in endpoint:
        return endpoint
    try:
        from urllib.parse import parse_qs, urlencode, urlparse
        url = urlparse(endpoint)
        params = [
            (k, v[0])
            for k, vs in parse_qs(url.query).items()
            if k.lower() != "key"
            for v in vs
        ]
        query = urlencode(params) if params else ""
        return url._replace(query=query).geturl().rstrip("?")
    except Exception:
        return endpoint


def _google_model_path(model: str) -> str:
    model = model.strip()
    return model if model.startswith("models/") else f"models/{model}"


def _google_body(model: str, text: str, output_dimensionality: int | None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": _google_model_path(model),
        "content": {"parts": [{"text": text}]},
    }
    if output_dimensionality and output_dimensionality > 0:
        body["output_dimensionality"] = output_dimensionality
    return body


def _looks_like_oversize_error(status: int, body: str) -> bool:
    if status == 413:
        return True
    lower = body.lower()
    return any(kw in lower for kw in [
        "too long", "maximum context", "max_tokens", "max tokens",
        "context length", "token limit", "exceeds", "input length",
    ])


async def fetch_embedding(
    text: str,
    cfg: EmbeddingConfig,
    max_retries: int = 3,
) -> list[float] | None:
    """Fetch embedding vector for text. Returns None on failure."""
    global _last_embedding_error

    if not cfg.endpoint:
        return None

    is_google = _is_google_config(cfg)
    endpoint = _google_endpoint(cfg) if is_google else cfg.endpoint

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if cfg.api_key:
        if is_google:
            headers["x-goog-api-key"] = cfg.api_key
        else:
            headers["Authorization"] = f"Bearer {cfg.api_key}"

    for name, value in cfg.extra_headers.items():
        name = name.strip()
        value = value.strip()
        if name and value and _HEADER_NAME_RE.match(name) and name.lower() not in RESERVED_HEADER_NAMES:
            headers[name] = value

    # SSRF protection
    try:
        from mona.security.network import validate_url_target
        validate_url_target(endpoint)
    except Exception as e:
        _last_embedding_error = f"Endpoint blocked by security policy: {e}"
        logger.warning(f"[Embedding] {_last_embedding_error}")
        return None

    current = text
    attempts = 0
    while attempts <= max_retries:
        attempts += 1
        try:
            body = (
                _google_body(cfg.model, current, cfg.output_dimensionality)
                if is_google
                else {"model": cfg.model, "input": current}
            )
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(endpoint, headers=headers, json=body)

            if resp.status_code == 200:
                data = resp.json()
                embedding = (
                    data.get("embedding", {}).get("values")
                    if is_google
                    else (data.get("data", [{}])[0].get("embedding") if data.get("data") else None)
                )
                if (
                    embedding
                    and isinstance(embedding, list)
                    and len(embedding) > 0
                    and all(isinstance(v, (int, float)) for v in embedding)
                ):
                    _last_embedding_error = None
                    return [float(v) for v in embedding]
                expected = "embedding.values" if is_google else "data[0].embedding"
                _last_embedding_error = f"Response missing {expected}"
                logger.warning(f"[Embedding] {_last_embedding_error}")
                return None

            body_text = resp.text[:500]
            if _looks_like_oversize_error(resp.status_code, body_text):
                if len(current) > 64 and attempts <= max_retries:
                    prev = len(current)
                    current = current[: len(current) // 2]
                    logger.warning(
                        f"[Embedding] auto-halving after HTTP {resp.status_code}: {prev} -> {len(current)} chars"
                    )
                    continue
                _last_embedding_error = f"Endpoint rejected input even at {len(current)} chars"
                return None

            _last_embedding_error = f"API {resp.status_code}: {body_text[:200]}"
            logger.warning(f"[Embedding] {_last_embedding_error}")
            return None

        except httpx.RequestError as e:
            _last_embedding_error = f"Network error: {e}"
            logger.warning(f"[Embedding] {_last_embedding_error}")
            return None
        except Exception as e:
            _last_embedding_error = str(e)
            logger.warning(f"[Embedding] {_last_embedding_error}")
            return None

    _last_embedding_error = f"Exhausted retries at {len(current)} chars"
    return None
