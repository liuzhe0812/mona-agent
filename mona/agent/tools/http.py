"""HTTP request tool: structured HTTP client for the agent.

Unlike ``web_fetch`` (which extracts readable content from a page), this tool
issues a raw HTTP request and returns status code, response headers, and the
raw response body. It is the right tool for API testing, webhook calls, and
any scenario where the agent needs to inspect HTTP-level details.

SSRF protection reuses ``mona.security.network.validate_url_target``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from loguru import logger
from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.config.schema import Base

_MAX_REDIRECTS = 5
_MAX_BODY_CHARS = 50_000
_DEFAULT_TIMEOUT = 30.0
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"})


class HttpToolConfig(Base):
    """HTTP request tool configuration."""

    enable: bool = True
    proxy: str | None = None
    user_agent: str = "mona-http-tool/1.0"
    timeout: float = Field(default=_DEFAULT_TIMEOUT, ge=1.0, le=300.0)
    max_body_chars: int = Field(default=_MAX_BODY_CHARS, ge=1000)


def _validate_url_safe(url: str) -> tuple[bool, str]:
    """SSRF-aware URL validation."""
    from mona.security.network import validate_url_target

    return validate_url_target(url)


def _redact_headers(headers: dict[str, str]) -> dict[str, str]:
    """Mask sensitive header values for safe logging/return."""
    sensitive = {"authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"}
    out: dict[str, str] = {}
    for k, v in headers.items():
        if k.lower() in sensitive:
            # Keep prefix so the agent can tell the auth scheme, mask the secret part
            if len(v) > 12:
                out[k] = v[:8] + "…" + f"({len(v)} chars)"
            else:
                out[k] = "<redacted>"
        else:
            out[k] = v
    return out


def _format_body(body: Any, content_type: str, max_chars: int) -> tuple[str, bool]:
    """Render a response body as text, capped at max_chars. Returns (text, truncated)."""
    if body is None:
        return "", False
    if isinstance(body, bytes):
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            # Binary body — show size instead
            return f"<binary {len(body)} bytes>", False
    else:
        text = str(body)

    # Pretty-print JSON if applicable
    ct_lower = content_type.lower()
    if "json" in ct_lower:
        try:
            parsed = json.loads(text)
            text = json.dumps(parsed, indent=2, ensure_ascii=False)
        except (ValueError, TypeError):
            pass

    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True


@tool_parameters(
    tool_parameters_schema(
        url=StringSchema("Target URL (http/https only)", min_length=1),
        method=StringSchema(
            "HTTP method",
            enum=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        ),
        headers=ObjectSchema(
            description="Optional request headers as key-value pairs.",
            additional_properties={"type": "string"},
        ),
        body=StringSchema(
            "Optional request body. For JSON requests, pass a JSON string directly.",
        ),
        params=ObjectSchema(
            description="Optional URL query parameters as key-value pairs.",
            additional_properties={"type": "string"},
        ),
        timeout=IntegerSchema(
            30,
            description="Request timeout in seconds (1-300).",
            minimum=1,
            maximum=300,
        ),
        required=["url"],
    )
)
class HttpTool(Tool):
    """Issue a structured HTTP request and return status, headers, and body."""

    _scopes = {"core", "subagent"}
    config_key = "http"

    name = "http_request"
    description = (
        "Send a structured HTTP request to a URL and return status code, response headers, "
        "and raw body. Use this for API calls, webhooks, and HTTP-level testing. "
        "For reading web pages as readable text, prefer web_fetch instead. "
        "JSON responses are pretty-printed; binary bodies are summarized by size."
    )

    @classmethod
    def config_cls(cls):
        return HttpToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.http.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            config=ctx.config.http,
        )

    def __init__(self, *, config: HttpToolConfig | None = None) -> None:
        self.config = config or HttpToolConfig()

    @property
    def read_only(self) -> bool:
        # POST/PUT/DELETE have side effects; treat as non-read-only for safety
        return False

    async def execute(
        self,
        url: str,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: str | None = None,
        params: dict[str, str] | None = None,
        timeout: int | None = None,
        **kwargs: Any,
    ) -> str:
        url = url.strip(" \t\r\n`\"'")
        method = (method or "GET").upper()
        if method not in _SAFE_METHODS:
            return json.dumps({"error": f"Unsupported method: {method}"}, ensure_ascii=False)

        ok, err = _validate_url_safe(url)
        if not ok:
            return json.dumps({"error": f"URL validation failed: {err}", "url": url}, ensure_ascii=False)

        req_headers: dict[str, str] = {}
        # Default User-Agent unless caller overrides
        req_headers["User-Agent"] = self.config.user_agent
        if headers:
            for k, v in headers.items():
                if isinstance(v, str) and v:
                    req_headers[k] = v

        # Detect JSON body and ensure Content-Type is set
        req_body: Any = None
        if body is not None and body != "":
            req_body = body
            ct = req_headers.get("Content-Type") or req_headers.get("content-type")
            if not ct:
                # Sniff: if it parses as JSON, set application/json
                stripped = body.lstrip()
                if stripped and stripped[0] in "[{":
                    try:
                        json.loads(body)
                        req_headers["Content-Type"] = "application/json"
                    except ValueError:
                        req_headers["Content-Type"] = "text/plain; charset=utf-8"
                else:
                    req_headers["Content-Type"] = "text/plain; charset=utf-8"

        timeout_s = float(timeout or self.config.timeout)
        timeout_s = max(1.0, min(300.0, timeout_s))

        try:
            async with httpx.AsyncClient(
                proxy=self.config.proxy,
                follow_redirects=True,
                max_redirects=_MAX_REDIRECTS,
                timeout=timeout_s,
            ) as client:
                response = await client.request(
                    method,
                    url,
                    headers=req_headers,
                    content=req_body,
                    params=params,
                )
        except httpx.TimeoutException:
            return json.dumps(
                {"error": f"Request timed out after {timeout_s}s", "url": url},
                ensure_ascii=False,
            )
        except httpx.HTTPError as e:
            logger.debug("http_request error for {}: {}", url, e)
            return json.dumps(
                {"error": f"{type(e).__name__}: {e}", "url": url},
                ensure_ascii=False,
            )

        # Validate the final resolved URL too (redirect target)
        from mona.security.network import validate_resolved_url

        final_url = str(response.url)
        redir_ok, redir_err = validate_resolved_url(final_url)
        if not redir_ok:
            return json.dumps(
                {"error": f"Redirect blocked: {redir_err}", "url": url, "finalUrl": final_url},
                ensure_ascii=False,
            )

        content_type = response.headers.get("content-type", "")
        body_text, truncated = _format_body(
            response.content, content_type, self.config.max_body_chars
        )

        result = {
            "url": url,
            "finalUrl": final_url,
            "method": method,
            "status": response.status_code,
            "reason": response.reason_phrase,
            "headers": _redact_headers(dict(response.headers)),
            "contentType": content_type,
            "bodyLength": len(response.content),
            "truncated": truncated,
            "body": body_text,
        }
        return json.dumps(result, ensure_ascii=False, indent=2)
