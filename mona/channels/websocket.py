"""WebSocket server channel: mona acts as a WebSocket server and serves connected clients."""

from __future__ import annotations

import asyncio
import base64
import binascii
import email.utils
import hashlib
import hmac
import http
import json
import mimetypes
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Self
from urllib.parse import parse_qs, unquote, urlparse

from loguru import logger
from pydantic import Field, field_validator, model_validator
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request as WsRequest
from websockets.http11 import Response

from mona.agent.partners import MONA_AGENT_ID
from mona.bus.events import OUTBOUND_META_AGENT_UI, OutboundMessage
from mona.bus.queue import MessageBus
from mona.channels.base import BaseChannel
from mona.command.builtin import builtin_command_palette
from mona.config.paths import get_data_dir, get_media_dir
from mona.config.schema import Base
from mona.session.goal_state import goal_state_ws_blob
from mona.session.webui_turns import websocket_turn_wall_started_at
from mona.utils.helpers import safe_filename
from mona.utils.media_decode import (
    FileSizeExceeded,
    save_base64_data_url,
)
from mona.utils.subagent_channel_display import scrub_subagent_messages_for_channel
from mona.webui.settings_api import (
    WebUISettingsError,
    fetch_zen_free_models,
    probe_provider_models,
    settings_payload,
    update_agent_settings,
    update_channel_settings,
    update_image_generation_settings,
    update_provider_settings,
    update_tts_settings,
    update_video_generation_settings,
    update_web_search_settings,
)
from mona.webui.sidebar_state import (
    read_webui_sidebar_state,
    write_webui_sidebar_state,
)
from mona.webui.thread_disk import delete_webui_thread
from mona.webui.transcript import append_transcript_object, build_webui_thread_response

if TYPE_CHECKING:
    from mona.session.manager import SessionManager


def _strip_trailing_slash(path: str) -> str:
    if len(path) > 1 and path.endswith("/"):
        return path.rstrip("/")
    return path or "/"


def _normalize_config_path(path: str) -> str:
    return _strip_trailing_slash(path)


class WebSocketConfig(Base):
    """WebSocket server channel configuration.

    Clients connect with URLs like ``ws://{host}:{port}{path}?client_id=...&token=...``.
    - ``client_id``: Used for ``allow_from`` authorization; if omitted, a value is generated and logged.
    - ``token``: If non-empty, the ``token`` query param may match this static secret; short-lived tokens
      from ``token_issue_path`` are also accepted.
    - ``token_issue_path``: If non-empty, **GET** (HTTP/1.1) to this path returns JSON
      ``{"token": "...", "expires_in": <seconds>}``; use ``?token=...`` when opening the WebSocket.
      Must differ from ``path`` (the WS upgrade path). If the client runs in the **same process** as
      mona and shares the asyncio loop, use a thread or async HTTP client for GET—do not call
      blocking ``urllib`` or synchronous ``httpx`` from inside a coroutine.
    - ``token_issue_secret``: If non-empty, token requests must send ``Authorization: Bearer <secret>`` or
      ``X-mona-Auth: <secret>``.
    - ``websocket_requires_token``: If True, the handshake must include a valid token (static or issued and not expired).
    - Each connection has its own session: a unique ``chat_id`` maps to the agent session internally.
    - ``media`` field in outbound messages contains local filesystem paths; remote clients need a
      shared filesystem or an HTTP file server to access these files.
    """

    enabled: bool = False
    host: str = "127.0.0.1"
    port: int = 8765
    path: str = "/"
    token: str = ""
    token_issue_path: str = ""
    token_issue_secret: str = ""
    token_ttl_s: int = Field(default=300, ge=30, le=86_400)
    websocket_requires_token: bool = True
    allow_from: list[str] = Field(default_factory=lambda: ["*"])
    streaming: bool = True
    # Default 36 MB, upper 40 MB: supports up to 4 images at ~6 MB each after
    # client-side Worker normalization (see webui Composer). 4 × 6 MB × 1.37
    # (base64 overhead) + envelope framing stays under 36 MB; the 40 MB ceiling
    # leaves a small margin for sender slop without opening a DoS avenue.
    max_message_bytes: int = Field(default=37_748_736, ge=1024, le=41_943_040)
    ping_interval_s: float = Field(default=20.0, ge=5.0, le=300.0)
    ping_timeout_s: float = Field(default=20.0, ge=5.0, le=300.0)
    ssl_certfile: str = ""
    ssl_keyfile: str = ""

    @field_validator("path")
    @classmethod
    def path_must_start_with_slash(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError('path must start with "/"')
        return _normalize_config_path(value)

    @field_validator("token_issue_path")
    @classmethod
    def token_issue_path_format(cls, value: str) -> str:
        value = value.strip()
        if not value:
            return ""
        if not value.startswith("/"):
            raise ValueError('token_issue_path must start with "/"')
        return _normalize_config_path(value)

    @model_validator(mode="after")
    def token_issue_path_differs_from_ws_path(self) -> Self:
        if not self.token_issue_path:
            return self
        if _normalize_config_path(self.token_issue_path) == _normalize_config_path(self.path):
            raise ValueError("token_issue_path must differ from path (the WebSocket upgrade path)")
        return self

    @model_validator(mode="after")
    def wildcard_host_requires_auth(self) -> Self:
        if self.host not in ("0.0.0.0", "::"):
            return self
        if self.token.strip() or self.token_issue_secret.strip():
            return self
        raise ValueError(
            "host is 0.0.0.0 (all interfaces) but neither token nor "
            "token_issue_secret is set — set one to prevent unauthenticated access"
        )


def _http_json_response(data: dict[str, Any], *, status: int = 200) -> Response:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    headers = Headers(
        [
            ("Date", email.utils.formatdate(usegmt=True)),
            ("Connection", "close"),
            ("Content-Length", str(len(body))),
            ("Content-Type", "application/json; charset=utf-8"),
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"),
            ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
        ]
    )
    reason = http.HTTPStatus(status).phrase
    return Response(status, reason, headers, body)


def publish_runtime_model_update(
    bus: MessageBus,
    model: str,
    model_preset: str | None,
) -> None:
    """Enqueue a runtime model snapshot for websocket subscribers (fan-out in-channel)."""
    bus.outbound.put_nowait(OutboundMessage(
        channel="websocket",
        chat_id="*",
        content="",
        metadata={
            "_runtime_model_updated": True,
            "model": model,
            "model_preset": model_preset,
        },
    ))


def _default_model_name_from_config() -> str | None:
    """Resolved model string from on-disk config (bootstrap fallback)."""
    try:
        from mona.config.loader import load_config

        model = load_config().resolve_preset().model.strip()
        return model or None
    except Exception as e:
        logger.debug("bootstrap model_name could not load from config: {}", e)
        return None


def _resolve_bootstrap_model_name(
    runtime_name: Callable[[], str | None] | None,
) -> str | None:
    """Prefer an in-process resolver (e.g. AgentLoop); else config-derived default."""
    if runtime_name is not None:
        try:
            raw = runtime_name()
        except Exception as e:
            logger.debug("bootstrap runtime model resolver failed: {}", e)
        else:
            if isinstance(raw, str):
                stripped = raw.strip()
                if stripped:
                    return stripped
    return _default_model_name_from_config()


def _parse_request_path(path_with_query: str) -> tuple[str, dict[str, list[str]]]:
    """Parse normalized path and query parameters in one pass."""
    parsed = urlparse("ws://x" + path_with_query)
    path = _strip_trailing_slash(parsed.path or "/")
    return path, parse_qs(parsed.query, keep_blank_values=True)


def _normalize_http_path(path_with_query: str) -> str:
    """Return the path component (no query string), with trailing slash normalized (root stays ``/``)."""
    return _parse_request_path(path_with_query)[0]


def _parse_query(path_with_query: str) -> dict[str, list[str]]:
    return _parse_request_path(path_with_query)[1]


def _query_first(query: dict[str, list[str]], key: str) -> str | None:
    """Return the first value for *key*, or None."""
    values = query.get(key)
    return values[0] if values else None


def _parse_inbound_payload(raw: str) -> str | None:
    """Parse a client frame into text; return None for empty or unrecognized content."""
    text = raw.strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(data, dict):
            for key in ("content", "text", "message"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value
            return None
        return None
    return text


# Accept UUIDs and short scoped keys like "unified:default". Keeps the capability
# namespace small enough to rule out path traversal / quote injection tricks.
_CHAT_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,64}$")


def _is_valid_chat_id(value: Any) -> bool:
    return isinstance(value, str) and _CHAT_ID_RE.match(value) is not None


def _parse_envelope(raw: str) -> dict[str, Any] | None:
    """Return a typed envelope dict if the frame is a new-style JSON envelope, else None.

    A frame qualifies when it parses as a JSON object with a string ``type`` field.
    Legacy frames (plain text, or ``{"content": ...}`` without ``type``) return None;
    callers should fall back to :func:`_parse_inbound_payload` for those.
    """
    text = raw.strip()
    if not text.startswith("{"):
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    t = data.get("type")
    if not isinstance(t, str):
        return None
    return data


# Per-message media limits. The server-side guard is a touch looser than the
# client's ``Worker`` normalization target (6 MB) — tolerate client slop, but
# still cap total ingress at ``_MAX_IMAGES_PER_MESSAGE * _MAX_IMAGE_BYTES``
# which fits comfortably inside ``max_message_bytes``.
_MAX_IMAGES_PER_MESSAGE = 4
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_VIDEOS_PER_MESSAGE = 1
_MAX_VIDEO_BYTES = 20 * 1024 * 1024

# Shared output directory watch cadence: the signature scan is metadata-
# only (path + mtime + size), so a 2s poll is cheap and still feels live.
_ARTIFACT_WATCH_INTERVAL_S = 2.0

# Image MIME whitelist — matches the Composer's ``accept`` list. SVG is
# explicitly excluded to avoid the XSS surface inside embedded scripts.
_IMAGE_MIME_ALLOWED: frozenset[str] = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
})

_VIDEO_MIME_ALLOWED: frozenset[str] = frozenset({
    "video/mp4",
    "video/webm",
    "video/quicktime",
})

_UPLOAD_MIME_ALLOWED: frozenset[str] = _IMAGE_MIME_ALLOWED | _VIDEO_MIME_ALLOWED

_PPT_DOC_MIME_ALLOWED: frozenset[str] = frozenset({
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
})
_PPT_DOC_MAX_BYTES = 20 * 1024 * 1024

# Document MIME whitelist for the "文档加工" workbench (doc_upload envelope).
# Superset of _PPT_DOC_MIME_ALLOWED: adds Excel (xlsx/xls) and legacy PPT.
_DOC_MIME_ALLOWED: frozenset[str] = frozenset({
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
})
_DOC_MAX_BYTES = 20 * 1024 * 1024

_DATA_URL_MIME_RE = re.compile(r"^data:([^;]+);base64,", re.DOTALL)
_DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)


def _extract_data_url_mime(url: str) -> str | None:
    """Return the MIME type of a ``data:<mime>;base64,...`` URL, else ``None``."""
    if not isinstance(url, str):
        return None
    m = _DATA_URL_MIME_RE.match(url)
    if not m:
        return None
    return m.group(1).strip().lower() or None


def _decode_data_url_payload(url: str, max_bytes: int = _PPT_DOC_MAX_BYTES) -> bytes | None:
    m = _DATA_URL_RE.match(url)
    if not m:
        return None
    b64 = m.group(2)
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    if len(raw) > max_bytes:
        raise FileSizeExceeded(f"File exceeds {max_bytes // (1024 * 1024)}MB limit")
    return raw


_LOCALHOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

# Matches the legacy chat-id pattern but allows file-system-safe stems too,
# so the API can address sessions whose keys came from non-WebSocket channels.
_API_KEY_RE = re.compile(r"^[A-Za-z0-9_:.-]{1,128}$")


def _decode_api_key(raw_key: str) -> str | None:
    """Decode a percent-encoded API path segment, then validate the result."""
    key = unquote(raw_key)
    if _API_KEY_RE.match(key) is None:
        return None
    return key


def _is_localhost(connection: Any) -> bool:
    """Return True if *connection* originated from the loopback interface."""
    addr = getattr(connection, "remote_address", None)
    if not addr:
        return False
    host = addr[0] if isinstance(addr, tuple) else addr
    if not isinstance(host, str):
        return False
    # ``::ffff:127.0.0.1`` is loopback in IPv6-mapped form.
    if host.startswith("::ffff:"):
        host = host[7:]
    return host in _LOCALHOSTS




def _http_response(
    body: bytes,
    *,
    status: int = 200,
    content_type: str = "text/plain; charset=utf-8",
    extra_headers: list[tuple[str, str]] | None = None,
) -> Response:
    headers = [
        ("Date", email.utils.formatdate(usegmt=True)),
        ("Connection", "close"),
        ("Content-Length", str(len(body))),
        ("Content-Type", content_type),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    reason = http.HTTPStatus(status).phrase
    return Response(status, reason, Headers(headers), body)


def _http_error(status: int, message: str | None = None) -> Response:
    body = (message or http.HTTPStatus(status).phrase).encode("utf-8")
    return _http_response(body, status=status)


def _bearer_token(headers: Any) -> str | None:
    """Pull a Bearer token out of standard or query-style headers."""
    auth = headers.get("Authorization") or headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def _is_websocket_upgrade(request: WsRequest) -> bool:
    """Detect an actual WS upgrade; plain HTTP GETs to the same path should fall through."""
    upgrade = request.headers.get("Upgrade") or request.headers.get("upgrade")
    connection = request.headers.get("Connection") or request.headers.get("connection")
    if not upgrade or "websocket" not in upgrade.lower():
        return False
    if not connection or "upgrade" not in connection.lower():
        return False
    return True


def _b64url_encode(data: bytes) -> str:
    """URL-safe base64 without padding — compact + friendly in URL paths."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Reverse of :func:`_b64url_encode`; caller handles ``ValueError``."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)



# Allowed MIME types we actually serve from the media endpoint. Anything
# outside this set is degraded to ``application/octet-stream`` so an
# attacker who somehow gets a signed URL for an unexpected file type can't
# trick the browser into sniffing executable content.
_MEDIA_ALLOWED_MIMES: frozenset[str] = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
})

_MEDIA_SECRET_FILE = "media_secret.key"
_MEDIA_SECRET_SIZE = 32


def _load_or_create_media_secret() -> bytes:
    """Load the persisted HMAC media secret, creating it on first run.

    The secret is stored as raw bytes in ``<data_dir>/media_secret.key`` so
    signed media URLs remain valid across gateway restarts. On any read
    error a fresh random secret is returned (and written) so the gateway
    can still start — old URLs simply become invalid, same as before.
    """
    try:
        path = get_data_dir() / _MEDIA_SECRET_FILE
        existing = path.read_bytes()
        if len(existing) == _MEDIA_SECRET_SIZE:
            return existing
    except OSError:
        pass
    secret = secrets.token_bytes(_MEDIA_SECRET_SIZE)
    try:
        path = get_data_dir() / _MEDIA_SECRET_FILE
        path.write_bytes(secret)
    except OSError as exc:
        logger.warning("failed to persist media secret: {}", exc)
    return secret


def _issue_route_secret_matches(headers: Any, configured_secret: str) -> bool:
    """Return True if the token-issue HTTP request carries credentials matching ``token_issue_secret``."""
    if not configured_secret:
        return True
    authorization = headers.get("Authorization") or headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
        return hmac.compare_digest(supplied, configured_secret)
    header_token = headers.get("X-mona-Auth") or headers.get("x-mona-auth")
    if not header_token:
        return False
    return hmac.compare_digest(header_token.strip(), configured_secret)


def _get_ppt_project_status(project_dir: Path) -> dict:
    svg_output_dir = project_dir / "svg_output"
    svg_final_dir = project_dir / "svg_final"
    output_dir = project_dir / "output"
    spec_lock = project_dir / "spec_lock.md"
    generating_marker = project_dir / ".generating"
    export_dir = project_dir / "exports"
    design_spec = project_dir / "design_spec.md"
    notes_dir = project_dir / "notes"
    images_dir = project_dir / "images"
    visual_plan = project_dir / "page_visual_plan.json"

    svg_count = (
        len(list(svg_output_dir.glob("*.svg"))) if svg_output_dir.is_dir() else 0
    )
    svg_final_count = (
        len(list(svg_final_dir.glob("*.svg"))) if svg_final_dir.is_dir() else 0
    )
    # New pipeline: output/output.pptx
    output_pptx = output_dir / "output.pptx"
    has_output_pptx = output_pptx.is_file()
    # New pipeline: preview images in output/preview/ (e.g. slide_1.png)
    preview_dir = output_dir / "preview"
    output_image_count = (
        len(list(preview_dir.glob("slide_*.png"))) if preview_dir.is_dir() else 0
    )
    # Also check output/ directly for legacy preview images
    if output_image_count == 0:
        output_image_count = (
            len(list(output_dir.glob("slide_*.png"))) if output_dir.is_dir() else 0
        )
    pptx_files = (
        sorted(
            export_dir.glob("*.pptx"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if export_dir.exists()
        else []
    )

    # --- V2 phase derivation (with meta.json) ---
    import json as _json

    meta: dict = {}
    meta_file = project_dir / "meta.json"
    if meta_file.is_file():
        try:
            meta = _json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            meta = {}

    has_outline = visual_plan.is_file()
    outline_locked = meta.get("outlineLocked", False)
    export_requested = meta.get("exportRequestedAt") is not None

    if pptx_files or has_output_pptx:
        v2_phase = "done"
    elif export_requested:
        v2_phase = "exporting"
    elif spec_lock.exists() or outline_locked:
        v2_phase = "producing"
    elif has_outline:
        v2_phase = "outline"
    elif generating_marker.exists():
        v2_phase = "generating"
    else:
        v2_phase = "config"

    # Legacy status (backward compat)
    if pptx_files or has_output_pptx:
        project_status = "done"
    elif generating_marker.exists():
        project_status = "generating"
    elif svg_count > 0 or svg_final_count > 0:
        project_status = "generating"
    elif spec_lock.exists():
        project_status = "planning"
    else:
        project_status = "init"

    # Determine fine-grained pipeline stage
    pipeline_stage = "init"
    if project_status == "done":
        pipeline_stage = "exported"
    elif svg_final_count > 0:
        pipeline_stage = "postprocess"
    elif svg_count > 0:
        pipeline_stage = "rendering"
    elif spec_lock.exists():
        pipeline_stage = "planned"
    elif images_dir.is_dir() and any(images_dir.iterdir()):
        pipeline_stage = "images"
    elif design_spec.exists() or (notes_dir.is_dir() and list(notes_dir.glob("*.md"))):
        pipeline_stage = "designing"

    return {
        "status": project_status,
        "phase": v2_phase,
        "hasOutline": has_outline,
        "outlineLocked": outline_locked,
        "hasDesignSpec": design_spec.exists(),
        "slideCount": max(svg_count, svg_final_count, output_image_count),
        "hasExport": len(pptx_files) > 0 or has_output_pptx,
        "hasSvgOutput": svg_count > 0 or svg_final_count > 0,
        "hasPptxOutput": has_output_pptx,
        "hasSpecLock": spec_lock.exists(),
        "exportFile": pptx_files[0].name if pptx_files else (
            "output.pptx" if has_output_pptx else None
        ),
        "pipelineStage": pipeline_stage,
        "svgOutputCount": svg_count,
        "svgFinalCount": svg_final_count,
    }


class WebSocketChannel(BaseChannel):
    """Run a local WebSocket server; forward text/JSON messages to the message bus."""

    name = "websocket"
    display_name = "WebSocket"

    def __init__(
        self,
        config: Any,
        bus: MessageBus,
        *,
        session_manager: "SessionManager | None" = None,
        static_dist_path: Path | None = None,
        runtime_model_name: Callable[[], str | None] | None = None,
        subagent_manager: Any | None = None,
    ):
        if isinstance(config, dict):
            config = WebSocketConfig.model_validate(config)
        super().__init__(config, bus)
        self.config: WebSocketConfig = config
        # chat_id -> connections subscribed to it (fan-out target).
        self._subs: dict[str, set[Any]] = {}
        # connection -> chat_ids it is subscribed to (O(1) cleanup on disconnect).
        self._conn_chats: dict[Any, set[str]] = {}
        # connection -> default chat_id for legacy frames that omit routing.
        self._conn_default: dict[Any, str] = {}
        # Single-use tokens consumed at WebSocket handshake.
        self._issued_tokens: dict[str, float] = {}
        # Multi-use tokens for HTTP routes served beside WS; checked but not consumed.
        self._api_tokens: dict[str, float] = {}
        self._stop_event: asyncio.Event | None = None
        self._server_task: asyncio.Task[None] | None = None
        self._artifact_watch_task: asyncio.Task[None] | None = None
        self._session_manager = session_manager
        self._subagent_manager = subagent_manager
        self._static_dist_path: Path | None = (
            static_dist_path.resolve() if static_dist_path is not None else None
        )
        self._runtime_model_name = runtime_model_name
        self._settings_restart_sections: set[str] = set()
        # Process-local WeChat QR login session (single-use, replaced on each start).
        self._weixin_login_session: Any = None
        # HMAC secret for signing media URLs. Persisted to disk so signed
        # URLs survive gateway restarts (historical session media stays
        # accessible). Falls back to a fresh random secret on any read error.
        self._media_secret: bytes = _load_or_create_media_secret()

    # -- Subscription bookkeeping -------------------------------------------

    def _attach(self, connection: Any, chat_id: str) -> None:
        """Idempotently subscribe *connection* to *chat_id*."""
        self._subs.setdefault(chat_id, set()).add(connection)
        self._conn_chats.setdefault(connection, set()).add(chat_id)

    def _cleanup_connection(self, connection: Any) -> None:
        """Remove *connection* from every subscription set; safe to call multiple times."""
        chat_ids = self._conn_chats.pop(connection, set())
        for cid in chat_ids:
            subs = self._subs.get(cid)
            if subs is None:
                continue
            subs.discard(connection)
            if not subs:
                self._subs.pop(cid, None)
        self._conn_default.pop(connection, None)

    async def _maybe_push_active_goal_state(self, chat_id: str) -> None:
        """Replay an active sustained goal from session metadata after *chat_id* is subscribed.

        Goal metadata lives on the session JSONL and survives gateway restarts, but
        connected clients normally see it via ``goal_state`` / ``turn_end`` frames.
        Pushing here makes refresh + reconnect restore the strip without a new model turn.
        """
        if self._session_manager is None:
            return
        row = self._session_manager.read_session_file(f"websocket:{chat_id}")
        meta = row.get("metadata", {}) if isinstance(row, dict) else {}
        if not isinstance(meta, dict):
            meta = {}
        blob = goal_state_ws_blob(meta)
        if not blob.get("active"):
            return
        await self.send_goal_state(chat_id, blob)

    async def _maybe_push_turn_run_wall_clock(self, chat_id: str) -> None:
        """Replay ``goal_status: running`` when a turn is still active (same-process refresh)."""
        t0 = websocket_turn_wall_started_at(chat_id)
        if t0 is None:
            return
        await self.send_goal_status(chat_id, "running", started_at=t0)

    async def _hydrate_after_subscribe(self, chat_id: str) -> None:
        """Replay goal/run strip state after subscribe (same-process refresh)."""
        await self._maybe_push_active_goal_state(chat_id)
        await self._maybe_push_turn_run_wall_clock(chat_id)

    async def _send_event(self, connection: Any, event: str, **fields: Any) -> None:
        """Send a control event (attached, error, ...) to a single connection."""
        payload: dict[str, Any] = {"event": event}
        payload.update(fields)
        raw = json.dumps(payload, ensure_ascii=False)
        try:
            await connection.send(raw)
        except ConnectionClosed:
            self._cleanup_connection(connection)
        except Exception as e:
            self.logger.warning("failed to send {} event: {}", event, e)

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return WebSocketConfig().model_dump(by_alias=True)

    def _expected_path(self) -> str:
        return _normalize_config_path(self.config.path)

    def _build_ssl_context(self) -> ssl.SSLContext | None:
        cert = self.config.ssl_certfile.strip()
        key = self.config.ssl_keyfile.strip()
        if not cert and not key:
            return None
        if not cert or not key:
            raise ValueError(
                "ssl_certfile and ssl_keyfile must both be set for WSS, or both left empty"
            )
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(certfile=cert, keyfile=key)
        return ctx

    _MAX_ISSUED_TOKENS = 10_000

    def _purge_expired_issued_tokens(self) -> None:
        now = time.monotonic()
        for token_key, expiry in list(self._issued_tokens.items()):
            if now > expiry:
                self._issued_tokens.pop(token_key, None)

    def _take_issued_token_if_valid(self, token_value: str | None) -> bool:
        """Validate and consume one issued token (single use per connection attempt).

        Uses single-step pop to minimize the window between lookup and removal;
        safe under asyncio's single-threaded cooperative model.
        """
        if not token_value:
            return False
        self._purge_expired_issued_tokens()
        expiry = self._issued_tokens.pop(token_value, None)
        if expiry is None:
            return False
        if time.monotonic() > expiry:
            return False
        return True

    def _handle_token_issue_http(self, connection: Any, request: Any) -> Any:
        secret = self.config.token_issue_secret.strip()
        if secret:
            if not _issue_route_secret_matches(request.headers, secret):
                return _http_response(b"Unauthorized", status=401)
        else:
            self.logger.warning(
                "token_issue_path is set but token_issue_secret is empty; "
                "any client can obtain connection tokens — set token_issue_secret for production."
            )
        self._purge_expired_issued_tokens()
        if len(self._issued_tokens) >= self._MAX_ISSUED_TOKENS:
            self.logger.error(
                "too many outstanding issued tokens ({}), rejecting issuance",
                len(self._issued_tokens),
            )
            return _http_json_response({"error": "too many outstanding tokens"}, status=429)
        token_value = f"nbwt_{secrets.token_urlsafe(32)}"
        self._issued_tokens[token_value] = time.monotonic() + float(self.config.token_ttl_s)

        return _http_json_response(
            {"token": token_value, "expires_in": self.config.token_ttl_s}
        )

    # -- HTTP dispatch ------------------------------------------------------

    async def _dispatch_http(self, connection: Any, request: WsRequest) -> Any:
        """Route an inbound HTTP request to a handler or to the WS upgrade path."""
        got, query = _parse_request_path(request.path)
        return await self._dispatch_http_inner(connection, request, got, query)

    async def _dispatch_http_inner(self, connection: Any, request: WsRequest, got: str, query: list[tuple[str, str]]) -> Any:

        # 1. Token issue endpoint (legacy, optional, gated by configured secret).
        if self.config.token_issue_path:
            issue_expected = _normalize_config_path(self.config.token_issue_path)
            if got == issue_expected:
                return self._handle_token_issue_http(connection, request)

        # 2. Bootstrap (`/webui/bootstrap`): mint WS/API tokens + shared session metadata.
        if got == "/webui/bootstrap":
            return self._handle_bootstrap(connection, request)

        # 3. REST handlers co-located with this channel (sessions, settings, …).
        if got == "/api/sessions":
            return self._handle_sessions_list(request)

        if got == "/api/agents":
            return self._handle_agents_list(request)

        if got == "/api/settings":
            return self._handle_settings(request)

        if got == "/api/zen/models":
            return await self._handle_zen_models(request)

        if got == "/api/commands":
            return self._handle_commands(request)

        if got == "/api/webui/sidebar-state":
            return self._handle_webui_sidebar_state(request)

        if got == "/api/webui/sidebar-state/update":
            return self._handle_webui_sidebar_state_update(request)

        if got == "/api/settings/update":
            return self._handle_settings_update(request)

        if got == "/api/settings/provider/update":
            return self._handle_settings_provider_update(request)

        if got == "/api/settings/provider/models":
            return await self._handle_settings_provider_models(request)

        if got == "/api/settings/web-search/update":
            return self._handle_settings_web_search_update(request)

        if got == "/api/settings/image-generation/update":
            return self._handle_settings_image_generation_update(request)

        if got == "/api/settings/video-generation/update":
            return self._handle_settings_video_generation_update(request)

        if got == "/api/settings/channels/update":
            return self._handle_settings_channels_update(request)

        if got == "/api/settings/tts/update":
            return self._handle_settings_tts_update(request)

        if got == "/api/channels/weixin/login/start":
            return self._handle_weixin_login_start(request)

        if got == "/api/channels/weixin/login/status":
            return self._handle_weixin_login_status(request)

        if got == "/api/channels/weixin/login/cancel":
            return self._handle_weixin_login_cancel(request)

        if got == "/api/channels/weixin/logout":
            return self._handle_weixin_logout(request)

        if got == "/api/ppt/templates":
            return self._handle_ppt_templates(request)

        if got == "/api/ppt/template-svg":
            return self._handle_ppt_template_svg(request)

        if got == "/api/ppt/add-sources":
            return self._handle_ppt_add_sources(request)

        if got == "/api/ppt/fetch-url":
            return self._handle_ppt_fetch_url(request)

        if got == "/api/ppt/projects":
            return self._handle_ppt_projects(request)

        if got == "/api/ppt/download":
            return self._handle_ppt_download(request)

        if got == "/api/ppt/preview-port":
            return self._handle_ppt_preview_port(request)

        if got == "/api/ppt/export-status":
            return self._handle_ppt_export_status(request)

        if got == "/api/ppt/generate-preview":
            return self._handle_ppt_generate_preview(request)

        if got == "/api/ppt/mark-generating":
            return self._handle_ppt_mark_generating(request)

        if got == "/api/ppt/save-chat-id":
            return self._handle_ppt_save_chat_id(request)

        if got == "/api/ppt/delete-project":
            return self._handle_ppt_delete_project(request)

        if got == "/api/video/download":
            return self._handle_video_download(request)

        if got == "/api/video/delete-project":
            return self._handle_video_delete_project(request)

        if got == "/api/ppt/project-slides":
            return self._handle_ppt_project_slides(request)

        if got == "/api/ppt/visual-plan":
            return self._handle_ppt_visual_plan(request)

        if got == "/api/ppt/officecli-check":
            return self._handle_ppt_officecli_check(request)

        if got == "/api/ppt/officecli-download":
            return await self._handle_ppt_officecli_download(request)

        if got.startswith("/api/ppt/project-svg"):
            return self._handle_ppt_project_svg(request)

        if got.startswith("/api/ppt/project-file"):
            return self._handle_ppt_project_file(request)

        m = re.match(r"^/api/sessions/([^/]+)/messages$", got)
        if m:
            return self._handle_session_messages(request, m.group(1))

        m = re.match(r"^/api/sessions/([^/]+)/webui-thread$", got)
        if m:
            return self._handle_webui_thread_get(request, m.group(1))

        # NOTE: websockets' HTTP parser only accepts GET, so we cannot expose a
        # true ``DELETE`` verb. The action is folded into the path instead.
        m = re.match(r"^/api/sessions/([^/]+)/delete$", got)
        if m:
            return self._handle_session_delete(request, m.group(1))

        # Signed media fetch: ``<sig>`` is an HMAC over ``<payload>``; the
        # payload decodes to a path inside :func:`get_media_dir`. See
        # :meth:`_sign_media_path` for the inverse direction used to build
        # these URLs when replaying a session.
        m = re.match(r"^/api/media/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)$", got)
        if m:
            return self._handle_media_fetch(m.group(1), m.group(2))

        if got.startswith("/api/file-preview"):
            return self._handle_file_preview(
                request,
                scope=_query_first(query, "scope") or "",
                session_key=_query_first(query, "session_key") or "",
                path=_query_first(query, "path") or "",
            )

        if got == "/api/artifacts":
            return self._handle_artifacts_list(request)

        # 4. WebSocket upgrade (the channel's primary purpose). Only run the
        # handshake gate on requests that actually ask to upgrade; otherwise
        # a bare ``GET /`` from the browser would be rejected as an
        # unauthorized WS handshake instead of serving the SPA's index.html.
        expected_ws = self._expected_path()
        if got == expected_ws and _is_websocket_upgrade(request):
            client_id = _query_first(query, "client_id") or ""
            if len(client_id) > 128:
                client_id = client_id[:128]
            if not self.is_allowed(client_id):
                return _http_response(b"Forbidden", status=403)
            return self._authorize_websocket_handshake(connection, query)

        # 5. Static SPA serving (only if a build directory was wired in).
        if self._static_dist_path is not None:
            response = self._serve_static(got)
            if response is not None:
                return response

        return _http_response(b"Not Found", status=404)

    # -- HTTP route handlers ------------------------------------------------

    def _check_api_token(self, request: WsRequest) -> bool:
        """Validate a request against the API token pool (multi-use, TTL-bound)."""
        self._purge_expired_api_tokens()
        token = _bearer_token(request.headers) or _query_first(
            _parse_query(request.path), "token"
        )
        if not token:
            return False
        expiry = self._api_tokens.get(token)
        if expiry is None or time.monotonic() > expiry:
            self._api_tokens.pop(token, None)
            return False
        return True

    def _purge_expired_api_tokens(self) -> None:
        now = time.monotonic()
        for token_key, expiry in list(self._api_tokens.items()):
            if now > expiry:
                self._api_tokens.pop(token_key, None)

    def _handle_bootstrap(self, connection: Any, request: Any) -> Response:
        # When a secret is configured (token_issue_secret or static token),
        # validate it regardless of source IP.  This secures deployments
        # behind a reverse proxy where all connections appear as localhost.
        secret = self.config.token_issue_secret.strip() or self.config.token.strip()
        if secret:
            if not _issue_route_secret_matches(request.headers, secret):
                return _http_error(401, "Unauthorized")
        elif not _is_localhost(connection):
            # No secret configured: only allow localhost (local dev mode).
            return _http_error(403, "bootstrap is localhost-only")
        # Cap outstanding tokens to avoid runaway growth from a misbehaving client.
        self._purge_expired_issued_tokens()
        self._purge_expired_api_tokens()
        if (
            len(self._issued_tokens) >= self._MAX_ISSUED_TOKENS
            or len(self._api_tokens) >= self._MAX_ISSUED_TOKENS
        ):
            return _http_response(
                json.dumps({"error": "too many outstanding tokens"}).encode("utf-8"),
                status=429,
                content_type="application/json; charset=utf-8",
            )
        token = f"nbwt_{secrets.token_urlsafe(32)}"
        expiry = time.monotonic() + float(self.config.token_ttl_s)
        # Same string registered in both pools: the WS handshake consumes one copy
        # while the REST surface keeps validating the other until TTL expiry.
        self._issued_tokens[token] = expiry
        self._api_tokens[token] = expiry
        return _http_json_response(
            {
                "token": token,
                "ws_path": self._expected_path(),
                "expires_in": self.config.token_ttl_s,
                "model_name": _resolve_bootstrap_model_name(self._runtime_model_name),
            }
        )

    def _handle_sessions_list(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        if self._session_manager is None:
            return _http_error(503, "session manager unavailable")
        sessions = self._session_manager.list_sessions()
        # Sidebar/chat listing for WS-backed sessions only — CLI / Slack / etc.
        # keys are not intended for resume over this HTTP surface.
        #
        # Collect chat IDs owned by video / PPT projects so they can be hidden
        # from the sidebar (each maker view has its own history panel).
        hidden_chat_ids: set[str] = set()
        try:
            from mona.config.paths import get_workspace_path

            workspace_path = get_workspace_path()
            # Video and PPT sessions are hidden from the main sidebar — each
            # has its own history panel inside the dedicated maker view.
            for kind in ("video_projects", "ppt_projects"):
                kind_dir = workspace_path / kind
                if kind_dir.is_dir():
                    for dot in kind_dir.glob("*/.chat_id"):
                        cid = dot.read_text(encoding="utf-8").strip()
                        if cid:
                            hidden_chat_ids.add(cid)
        except Exception:
            pass
        cleaned = []
        for s in sessions:
            key = s.get("key")
            if not (isinstance(key, str) and key.startswith("websocket:")):
                continue
            if key.startswith("websocket:ephemeral:"):
                continue
            chat_id = key.split(":", 1)[1]
            if chat_id in hidden_chat_ids:
                continue
            row = {k: v for k, v in s.items() if k != "path"}
            started_at = websocket_turn_wall_started_at(chat_id)
            if started_at is not None:
                row["run_started_at"] = started_at
            cleaned.append(row)
        return _http_json_response({"sessions": cleaned})

    def _handle_agents_list(self, request: WsRequest) -> Response:
        """List all loaded agents (multi-agent phase 2d).

        Broken installed manifests are skipped at registry load time, so every
        listed agent is usable; ``enabled`` is always true and kept only for
        forward compatibility with an enable/disable toggle.
        """
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        registry = self._room_agent_registry()
        agents = [
            {
                "id": definition.id,
                "displayName": definition.display_name,
                "description": definition.description,
                "avatarUrl": definition.avatar,
                "enabled": True,
            }
            for definition in registry.list_agents()
        ]
        return _http_json_response({"agents": agents})

    def _handle_settings(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response(self._with_settings_restart_state(settings_payload()))

    async def _handle_zen_models(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        models = await fetch_zen_free_models()
        return _http_json_response({"models": models})

    def _with_settings_restart_state(
        self,
        payload: dict[str, Any],
        *,
        section: str | None = None,
    ) -> dict[str, Any]:
        """Keep restart-required state alive for this gateway process."""
        if section and payload.get("requires_restart"):
            self._settings_restart_sections.add(section)
        if self._settings_restart_sections:
            payload = dict(payload)
            payload["requires_restart"] = True
            payload["restart_required_sections"] = sorted(self._settings_restart_sections)
        else:
            payload = dict(payload)
            payload["restart_required_sections"] = []
        return payload

    def _handle_commands(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response({"commands": builtin_command_palette()})

    def _handle_webui_sidebar_state(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response(read_webui_sidebar_state())

    def _handle_webui_sidebar_state_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        raw_state = _query_first(query, "state")
        if raw_state is None:
            return _http_error(400, "missing state")
        try:
            decoded = json.loads(raw_state)
        except json.JSONDecodeError:
            return _http_error(400, "state must be JSON")
        if not isinstance(decoded, dict):
            return _http_error(400, "state must be an object")
        try:
            state = write_webui_sidebar_state(decoded)
        except ValueError as e:
            return _http_error(400, str(e))
        except OSError:
            self.logger.exception("failed to write webui sidebar state")
            return _http_error(500, "failed to write sidebar state")
        return _http_json_response(state)

    def _handle_settings_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_agent_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(
            self._with_settings_restart_state(payload, section="runtime")
        )

    def _handle_settings_provider_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_provider_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="image"))

    async def _handle_settings_provider_models(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        provider_name = (_query_first(query, "provider") or "").strip()
        if not provider_name:
            return _http_error(400, "provider is required")
        # Allow callers to override api_key / api_base (e.g. when the user is
        # editing the form but hasn't saved yet). Fall back to saved config.
        api_key = _query_first(query, "api_key") or _query_first(query, "apiKey")
        api_base = _query_first(query, "api_base") or _query_first(query, "apiBase")
        try:
            models = await probe_provider_models(
                provider_name=provider_name,
                api_key=api_key,
                api_base=api_base,
            )
        except WebUISettingsError as e:
            return _http_json_response({"error": e.message, "models": []})
        return _http_json_response({"models": models})

    def _handle_settings_web_search_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_web_search_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="web"))

    def _handle_settings_image_generation_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_image_generation_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="image"))

    def _handle_settings_video_generation_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_video_generation_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="image"))

    def _handle_settings_channels_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_channel_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="channels"))

    def _handle_settings_tts_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_tts_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload))

    def _get_weixin_config(self) -> Any:
        """Load the current WeChat channel config (or defaults)."""
        from mona.channels.weixin import WeixinConfig
        from mona.config.loader import load_config

        config = load_config()
        section = getattr(config.channels, "weixin", None)
        if section is None:
            return WeixinConfig()
        if isinstance(section, dict):
            return WeixinConfig.model_validate(section)
        return section

    def _handle_weixin_login_start(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.webui.weixin_login import WeixinLoginSession

        # Cancel any in-flight session before starting a new one.
        if self._weixin_login_session is not None:
            self._weixin_login_session._cancel_sync()
            self._weixin_login_session = None

        try:
            config = self._get_weixin_config()
        except Exception as e:
            return _http_error(500, f"failed to load weixin config: {e}")

        session = WeixinLoginSession(config)
        self._weixin_login_session = session
        session.start()
        return _http_json_response(session.get_status())

    def _handle_weixin_login_status(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        session = self._weixin_login_session
        if session is None:
            from mona.webui.weixin_login import WeixinLoginSession

            return _http_json_response({
                "state": "idle",
                "logged_in": WeixinLoginSession.has_saved_token(),
            })
        status = session.get_status()
        # Augment with on-disk login state for convenience.
        from mona.webui.weixin_login import WeixinLoginSession

        status = dict(status)
        status["logged_in"] = WeixinLoginSession.has_saved_token()
        return _http_json_response(status)

    def _handle_weixin_login_cancel(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        session = self._weixin_login_session
        self._weixin_login_session = None
        if session is None:
            return _http_json_response({"state": "cancelled"})
        session._cancel_sync()
        return _http_json_response({"state": "cancelled"})

    def _handle_weixin_logout(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.webui.weixin_login import WeixinLoginSession

        # Cancel any in-flight login session.
        if self._weixin_login_session is not None:
            self._weixin_login_session._cancel_sync()
            self._weixin_login_session = None

        ok = WeixinLoginSession.clear_saved_token()
        if not ok:
            return _http_error(500, "failed to delete weixin account state")
        return _http_json_response({"logged_in": False})

    def _handle_ppt_templates(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from urllib.parse import quote

            from mona.agent.skills import BUILTIN_SKILLS_DIR

            skill_dir = BUILTIN_SKILLS_DIR / "mona-ppt"
            layouts_index = (
                skill_dir / "scripts" / "templates_full" / "layouts" / "layouts_index.json"
            )
            brands_index = (
                skill_dir / "scripts" / "templates_full" / "brands" / "brands_index.json"
            )

            templates = []
            if layouts_index.exists():
                raw = json.loads(layouts_index.read_text(encoding="utf-8"))
                for key, info in raw.items():
                    templates.append({
                        "key": key,
                        "kind": "layout",
                        "group": "通用",
                        "name": info.get("name", key),
                        "summary": info.get("summary", ""),
                        "pageCount": info.get("page_count", 0),
                        "canvasFormat": info.get("canvas_format", "ppt169"),
                        "coverSvgUrl": (
                            f"/api/ppt/template-svg?kind=layout&key={quote(key, safe='')}&file=01_cover.svg"
                        ),
                    })

            if brands_index.exists():
                raw = json.loads(brands_index.read_text(encoding="utf-8"))
                for key, info in raw.items():
                    # Check if cover image exists (any supported format)
                    brand_dir = brands_index.parent / key
                    cover_url = ""
                    if brand_dir.is_dir():
                        for ext in (".svg", ".png", ".jpg", ".jpeg"):
                            if (brand_dir / f"01_cover{ext}").exists():
                                cover_url = (
                                    f"/api/ppt/template-svg?kind=brand"
                                    f"&key={quote(key, safe='')}&file=01_cover{ext}"
                                )
                                break
                    templates.append({
                        "key": key,
                        "kind": "brand",
                        "group": "品牌预设",
                        "name": info.get("name", key),
                        "summary": info.get("summary", ""),
                        "pageCount": info.get("page_count", 0),
                        "canvasFormat": info.get("canvas_format", "ppt169"),
                        "primaryColor": info.get("primary_color", ""),
                        "coverSvgUrl": cover_url,
                        "userCreated": info.get("userCreated", False),
                    })

            # --- Native templates ---
            native_index = (
                skill_dir / "scripts" / "templates_full" / "native" / "native_index.json"
            )
            if native_index.exists():
                raw = json.loads(native_index.read_text(encoding="utf-8"))
                for key, info in raw.items():
                    native_dir = native_index.parent / key
                    cover_url = ""
                    if native_dir.is_dir():
                        cover_file = native_dir / "01_cover.png"
                        if cover_file.exists():
                            cover_url = (
                                f"/api/ppt/template-svg?kind=native"
                                f"&key={quote(key, safe='')}&file=01_cover.png"
                            )
                    templates.append({
                        "key": key,
                        "kind": "native",
                        "group": "自定义模板",
                        "name": info.get("name", key),
                        "summary": info.get("summary", ""),
                        "pageCount": info.get("page_count", 0),
                        "canvasFormat": info.get("canvas_format", "ppt169"),
                        "primaryColor": info.get("primary_color", ""),
                        "coverSvgUrl": cover_url,
                        "userCreated": info.get("userCreated", False),
                    })

            canvas_formats = [
                {
                    "key": "ppt169",
                    "label": "PPT 16:9",
                    "viewBox": "1280x720",
                    "desc": "商务演示",
                },
                {
                    "key": "ppt43",
                    "label": "PPT 4:3",
                    "viewBox": "1024x768",
                    "desc": "传统投影",
                },
                {"key": "xhs", "label": "小红书", "viewBox": "1242x1660", "desc": "图文分享"},
                {
                    "key": "square",
                    "label": "方形海报",
                    "viewBox": "1080x1080",
                    "desc": "朋友圈",
                },
                {
                    "key": "story",
                    "label": "竖屏故事",
                    "viewBox": "1080x1920",
                    "desc": "抖音封面",
                },
                {
                    "key": "wx_header",
                    "label": "微信头图",
                    "viewBox": "900x383",
                    "desc": "公众号封面",
                },
                {
                    "key": "banner",
                    "label": "横幅",
                    "viewBox": "1920x1080",
                    "desc": "网页横幅",
                },
                {
                    "key": "portrait",
                    "label": "竖版海报",
                    "viewBox": "1080x1920",
                    "desc": "手机海报",
                },
                {
                    "key": "a4",
                    "label": "A4 打印",
                    "viewBox": "1240x1754",
                    "desc": "打印海报",
                },
            ]

            return _http_json_response({
                "templates": templates,
                "canvasFormats": canvas_formats,
            })
        except Exception as e:
            logger.exception("ppt templates error")
            return _http_error(500, str(e))

    def _handle_ppt_template_svg(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.agent.skills import BUILTIN_SKILLS_DIR

            query = _parse_query(request.path)
            kind = _query_first(query, "kind") or ""
            key = _query_first(query, "key") or ""
            file = _query_first(query, "file") or "01_cover.svg"

            if "/" in key or "\\" in key or ".." in key:
                return _http_error(400, "invalid key")
            # Allow subdirectory paths (e.g. assets/image1.png) but block traversal
            if ".." in file:
                return _http_error(400, "invalid file")

            skill_dir = BUILTIN_SKILLS_DIR / "mona-ppt"
            subdir = {"layout": "layouts", "brand": "brands", "native": "native"}.get(kind)
            if not subdir:
                return _http_error(400, "invalid template kind")
            base_dir = skill_dir / "scripts" / "templates_full" / subdir / key

            # Resolve file path (may include subdirectory like assets/xxx.png)
            file_path = (base_dir / file).resolve()
            # Security: ensure resolved path is still under base_dir
            if not str(file_path).startswith(str(base_dir.resolve())):
                return _http_error(400, "invalid file path")

            if not file_path.exists():
                # Auto-find cover image with any supported extension
                stem = Path(file).stem
                for ext in (".svg", ".png", ".jpg", ".jpeg"):
                    candidate = (base_dir / (stem + ext)).resolve()
                    if candidate.exists() and str(candidate).startswith(
                        str(base_dir.resolve())
                    ):
                        file_path = candidate
                        break

            if not file_path.exists():
                return _http_error(404, "cover image not found")

            content = file_path.read_bytes()
            suffix = file_path.suffix.lower()
            content_type = {
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
            }.get(suffix, "application/octet-stream")

            if suffix == ".svg":
                content = self._sanitize_svg_xml(content)

            return _http_response(
                content,
                content_type=content_type,
                extra_headers=[("Cache-Control", "public, max-age=3600")],
            )
        except Exception as e:
            logger.exception("ppt template svg error")
            return _http_error(500, str(e))

    _PPT_SOURCE_SUFFIXES = frozenset({
        ".md", ".txt", ".pdf", ".doc", ".docx", ".pptx", ".csv", ".json", ".xls", ".xlsx",
    })

    def _handle_ppt_add_sources(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            workspace = get_workspace_path()
            query = _parse_query(request.path)
            sources_str = _query_first(query, "sources") or ""
            if not sources_str:
                return _http_error(400, "missing sources")

            sources_dir = workspace / "ppt_projects" / "_sources"
            sources_dir.mkdir(parents=True, exist_ok=True)

            sources = [s.strip() for s in sources_str.split("|") if s.strip()]
            added: list[dict[str, str]] = []
            for src_str in sources:
                src = Path(src_str)
                if not src.exists():
                    continue
                if src.is_file():
                    if src.suffix.lower() in self._PPT_SOURCE_SUFFIXES:
                        dest = sources_dir / src.name
                        shutil.copy2(src, dest)
                        rel = dest.relative_to(workspace)
                        added.append({
                            "name": src.name,
                            "path": str(rel).replace("\\", "/"),
                        })
                elif src.is_dir():
                    for fp in sorted(src.rglob("*")):
                        if not fp.is_file():
                            continue
                        if fp.suffix.lower() not in self._PPT_SOURCE_SUFFIXES:
                            continue
                        rel_src = fp.relative_to(src)
                        dest = sources_dir / rel_src
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(fp, dest)
                        rel = dest.relative_to(workspace)
                        added.append({
                            "name": rel_src.as_posix(),
                            "path": str(rel).replace("\\", "/"),
                        })

            return _http_json_response({"files": added})
        except Exception as e:
            logger.exception("ppt add sources error")
            return _http_error(500, str(e))

    def _handle_ppt_fetch_url(self, request: WsRequest) -> Response:
        """Fetch a web URL and convert to Markdown source for PPT generation."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            import subprocess

            from mona.agent.skills import BUILTIN_SKILLS_DIR
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            url = _query_first(query, "url") or ""
            project_name = _query_first(query, "project") or ""

            if not url:
                return _http_error(400, "url is required")
            if not url.startswith("http://") and not url.startswith("https://"):
                return _http_error(400, "url must start with http:// or https://")

            workspace = get_workspace_path()
            script = (
                BUILTIN_SKILLS_DIR
                / "mona-ppt"
                / "scripts"
                / "source_to_md"
                / "web_to_md.py"
            )

            if not script.exists():
                return _http_error(500, "web_to_md.py not found")

            # Determine output directory
            if project_name:
                output_dir = workspace / "ppt_projects" / project_name / "sources"
                output_dir.mkdir(parents=True, exist_ok=True)
            else:
                output_dir = workspace / "ppt_projects" / "_url_cache"
                output_dir.mkdir(parents=True, exist_ok=True)

            result = subprocess.run(
                [sys.executable, str(script), url, "--output-dir", str(output_dir)],
                capture_output=True,
                text=True,
                timeout=60,
            )

            if result.returncode == 0:
                # Find the generated markdown file
                md_files = sorted(
                    output_dir.glob("*.md"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                if md_files:
                    try:
                        rel_path = md_files[0].relative_to(workspace)
                        file_path = str(rel_path).replace("\\", "/")
                    except ValueError:
                        file_path = str(md_files[0])
                    return _http_json_response({
                        "ok": True,
                        "file": file_path,
                        "output": result.stdout.strip(),
                    })
                return _http_json_response({"ok": True, "output": result.stdout.strip()})
            else:
                return _http_json_response({
                    "ok": False,
                    "error": result.stderr.strip() or result.stdout.strip() or "fetch failed",
                })
        except subprocess.TimeoutExpired:
            return _http_json_response({"ok": False, "error": "fetch timed out"})
        except Exception as e:
            logger.exception("ppt fetch url error")
            return _http_error(500, str(e))

    def _handle_ppt_projects(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            workspace = get_workspace_path()
            projects_dir = workspace / "ppt_projects"
            if not projects_dir.exists():
                return _http_json_response({"projects": []})

            projects = []
            for d in sorted(projects_dir.iterdir()):
                if not d.is_dir():
                    continue
                if d.name.startswith("_"):
                    continue
                # 过滤前端 markPptGenerating 预创建的占位目录：
                # 只有 .generating / .chat_id 标记文件而无 README.md / meta.json 的目录不算已初始化项目
                existing = {p.name for p in d.iterdir()}
                real_files = existing - {".generating", ".chat_id"}
                if not real_files:
                    continue
                status_info = _get_ppt_project_status(d)
                stat = d.stat()
                chat_id_file = d / ".chat_id"
                chat_id = (
                    chat_id_file.read_text(encoding="utf-8").strip()
                    if chat_id_file.exists()
                    else None
                )
                projects.append({
                    "name": d.name,
                    "createdAt": stat.st_ctime,
                    "format": "ppt169",
                    "slideCount": status_info["slideCount"],
                    "hasExport": status_info["hasExport"],
                    "hasSvgOutput": status_info["hasSvgOutput"],
                    "hasPptxOutput": status_info["hasPptxOutput"],
                    "hasSpecLock": status_info["hasSpecLock"],
                    "status": status_info["status"],
                    "phase": status_info.get("phase"),
                    "chatId": chat_id,
                })

            return _http_json_response({"projects": projects})
        except Exception as e:
            logger.exception("ppt projects error")
            return _http_error(500, str(e))

    def _handle_ppt_download(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name

            # Try exports/ first (legacy + Step 7.3 copy), then output/ (new pipeline)
            export_dir = project_dir / "exports"
            output_dir = project_dir / "output"

            pptx_files = []
            if export_dir.exists():
                pptx_files.extend(export_dir.glob("*.pptx"))
            if output_dir.exists():
                pptx_files.extend(output_dir.glob("*.pptx"))

            if not pptx_files:
                return _http_error(404, "no pptx found")

            # Pick the most recently modified file
            pptx_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            chosen = pptx_files[0]
            content = chosen.read_bytes()
            filename = chosen.name
            return _http_response(
                content,
                content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                extra_headers=[
                    ("Content-Disposition", f'attachment; filename="{filename}"'),
                    ("Cache-Control", "no-cache"),
                ],
            )
        except Exception as e:
            logger.exception("ppt download error")
            return _http_error(500, str(e))

    def _handle_ppt_preview_port(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            lock_file = workspace / "ppt_projects" / project_name / ".live_preview.lock"

            if not lock_file.exists():
                return _http_json_response({"port": None})

            data = json.loads(lock_file.read_text(encoding="utf-8"))
            port = data.get("port")
            return _http_json_response({"port": port})
        except Exception:
            logger.exception("ppt preview port error")
            return _http_json_response({"port": None})

    def _handle_ppt_export_status(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name
            if not project_dir.is_dir():
                return _http_json_response({"status": "not_found"})

            status_info = _get_ppt_project_status(project_dir)
            return _http_json_response({
                "status": status_info["status"],
                "phase": status_info["phase"],
                "slideCount": status_info["slideCount"],
                "hasExport": status_info["hasExport"],
                "hasSvgOutput": status_info["hasSvgOutput"],
                "hasPptxOutput": status_info["hasPptxOutput"],
                "hasSpecLock": status_info["hasSpecLock"],
                "exportFile": status_info["exportFile"],
                "pipelineStage": status_info["pipelineStage"],
                "svgOutputCount": status_info["svgOutputCount"],
                "svgFinalCount": status_info["svgFinalCount"],
            })
        except Exception as e:
            logger.exception("ppt export status error")
            return _http_error(500, str(e))

    def _handle_ppt_officecli_check(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.api.officecli_runtime import OfficeCliRuntime

            return _http_json_response(OfficeCliRuntime().check())
        except Exception as e:
            logger.exception("ppt officecli-check error")
            return _http_error(500, str(e))

    async def _handle_ppt_officecli_download(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.api.officecli_runtime import OfficeCliRuntime

            result = await OfficeCliRuntime().ensure()
            if not result.get("ok"):
                return _http_json_response(result, status=500)
            return _http_json_response(result)
        except Exception as e:
            logger.exception("ppt officecli-download error")
            return _http_error(500, str(e))

    def _handle_ppt_generate_preview(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.agent.skills import BUILTIN_SKILLS_DIR
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            pptx_path = workspace / "ppt_projects" / project_name / "output" / "output.pptx"
            if not pptx_path.exists():
                return _http_error(404, "output.pptx not found")

            script = BUILTIN_SKILLS_DIR / "mona-ppt" / "scripts" / "pptx_to_preview.py"
            if not script.exists():
                return _http_error(500, "preview script not found")

            preview_dir = pptx_path.parent / "preview"
            result = subprocess.run(
                [sys.executable, str(script), str(pptx_path), str(preview_dir)],
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode == 0:
                slide_count = (
                    len(list(preview_dir.glob("slide_*.png")))
                    if preview_dir.exists()
                    else 0
                )
                return _http_json_response({"ok": True, "slideCount": slide_count})
            else:
                return _http_json_response({
                    "ok": False,
                    "error": result.stderr.strip() or result.stdout.strip() or "unknown error",
                })
        except subprocess.TimeoutExpired:
            return _http_json_response({"ok": False, "error": "preview generation timed out"})
        except Exception as e:
            logger.exception("ppt generate preview error")
            return _http_error(500, str(e))

    def _handle_ppt_mark_generating(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            action = _query_first(query, "action") or "start"

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name
            marker = project_dir / ".generating"

            if action == "start":
                project_dir.mkdir(parents=True, exist_ok=True)
                marker.write_text("1", encoding="utf-8")
            elif action == "finish":
                marker.unlink(missing_ok=True)

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("ppt mark generating error")
            return _http_error(500, str(e))

    def _handle_ppt_save_chat_id(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            chat_id = _query_first(query, "chatId") or ""

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name
            if not project_dir.is_dir():
                return _http_error(404, "project not found")

            chat_id_file = project_dir / ".chat_id"
            chat_id_file.write_text(chat_id, encoding="utf-8")

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("ppt save chat id error")
            return _http_error(500, str(e))

    def _handle_ppt_delete_project(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            import shutil

            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name
            if not project_dir.is_dir():
                return _http_error(404, "project not found")

            shutil.rmtree(project_dir)

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("ppt delete project error")
            return _http_error(500, str(e))

    def _handle_video_download(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "name") or _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "video_projects" / project_name

            # Prefer renders/output.mp4 (new pipeline), fallback to any mp4 in output/.
            candidates = [project_dir / "renders" / "output.mp4"]
            output_dir = project_dir / "output"
            if output_dir.exists():
                candidates.extend(sorted(output_dir.glob("*.mp4"), reverse=True))
            chosen = next((p for p in candidates if p.is_file()), None)
            if chosen is None:
                return _http_error(404, "no mp4 found")

            content = chosen.read_bytes()
            return _http_response(
                content,
                content_type="video/mp4",
                extra_headers=[
                    ("Content-Disposition", f'attachment; filename="{chosen.name}"'),
                    ("Cache-Control", "no-cache"),
                ],
            )
        except Exception as e:
            logger.exception("video download error")
            return _http_error(500, str(e))

    def _handle_video_delete_project(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            import shutil

            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "name") or _query_first(query, "project") or ""

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "video_projects" / project_name
            if not project_dir.is_dir():
                return _http_error(404, "project not found")

            shutil.rmtree(project_dir)

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("video delete project error")
            return _http_error(500, str(e))

    def _handle_ppt_visual_plan(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            plan_path = workspace / "ppt_projects" / project_name / "page_visual_plan.json"
            if not plan_path.is_file():
                return _http_json_response({"pages": []})

            data = json.loads(plan_path.read_text(encoding="utf-8"))
            return _http_json_response(data)
        except Exception as e:
            logger.exception("ppt visual plan error")
            return _http_error(500, str(e))

    def _handle_ppt_project_slides(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from urllib.parse import quote

            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name
            if not project_dir.is_dir():
                return _http_json_response({"slides": []})

            slides: list[dict[str, str]] = []
            seen: set[str] = set()

            # New pipeline: preview images in output/preview/ (slide_1.png, slide_2.png, ...)
            output_dir = project_dir / "output"
            preview_dir = output_dir / "preview"
            if preview_dir.is_dir():
                for f in sorted(preview_dir.glob("slide_*.png")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append({
                            "name": f.name,
                            "type": "image",
                            "url": (
                                f"/api/ppt/project-file?project={quote(project_name, safe='')}"
                                f"&path=output/preview/{quote(f.name, safe='')}"
                            ),
                        })
            # Also check output/ directly for legacy preview images
            if output_dir.is_dir():
                for f in sorted(output_dir.glob("slide_*.png")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append({
                            "name": f.name,
                            "type": "image",
                            "url": (
                                f"/api/ppt/project-file?project={quote(project_name, safe='')}"
                                f"&path=output/{quote(f.name, safe='')}"
                            ),
                        })

            # Legacy pipeline: svg_final (self-contained), fall back to svg_output
            svg_final_dir = project_dir / "svg_final"
            svg_output_dir = project_dir / "svg_output"

            # svg_final files first (self-contained, no external refs)
            if svg_final_dir.is_dir():
                for f in sorted(svg_final_dir.glob("*.svg")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append({
                            "name": f.name,
                            "type": "svg",
                            "url": (
                                f"/api/ppt/project-svg?project={quote(project_name, safe='')}"
                                f"&file={quote(f.name, safe='')}&dir=final"
                            ),
                        })

            # svg_output files not already in svg_final
            if svg_output_dir.is_dir():
                for f in sorted(svg_output_dir.glob("*.svg")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append({
                            "name": f.name,
                            "type": "svg",
                            "url": (
                                f"/api/ppt/project-svg?project={quote(project_name, safe='')}"
                                f"&file={quote(f.name, safe='')}&dir=output"
                            ),
                        })

            return _http_json_response({"slides": slides})
        except Exception:
            logger.exception("ppt project slides error")
            return _http_error(500, "internal error")

    def _handle_ppt_project_svg(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            file_name = _query_first(query, "file") or ""
            svg_dir = _query_first(query, "dir") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")
            if not file_name or "/" in file_name or "\\" in file_name or ".." in file_name:
                return _http_error(400, "invalid file name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name

            # Determine which directory to read from
            if svg_dir == "final":
                svg_path = project_dir / "svg_final" / file_name
            elif svg_dir == "output":
                svg_path = project_dir / "svg_output" / file_name
            else:
                # Legacy: try svg_final first, then svg_output
                svg_path = project_dir / "svg_final" / file_name
                if not svg_path.exists():
                    svg_path = project_dir / "svg_output" / file_name

            if not svg_path.exists():
                return _http_error(404, "svg not found")

            content = svg_path.read_bytes()

            # For svg_output files, rewrite external references to use the
            # project-file API so the browser can resolve images/icons.
            # Must happen BEFORE _sanitize_svg_xml, because _rewrite_svg_refs
            # introduces '&' in URL query params that need XML escaping.
            if svg_dir == "output" or (
                not svg_dir and svg_path.parent.name == "svg_output"
            ):
                content = self._rewrite_svg_refs(content, project_name)

            # Sanitize XML after all transformations: AI-generated SVGs
            # frequently contain bare '&' or HTML named entities, and
            # _rewrite_svg_refs adds '&' in URL query params — all of which
            # must be well-formed XML before serving to the browser.
            content = self._sanitize_svg_xml(content)

            return _http_response(
                content,
                content_type="image/svg+xml",
                extra_headers=[("Cache-Control", "public, max-age=3600")],
            )
        except Exception:
            logger.exception("ppt project svg error")
            return _http_error(500, "internal error")

    @staticmethod
    def _sanitize_svg_xml(content: bytes) -> bytes:
        """Defensively fix common XML entity errors in AI-generated SVGs.

        SVG served to the browser must be well-formed XML. AI frequently emits:
        - Bare ``&`` in text (e.g. "R&D", "A&B") which the browser parses as an
          entity reference and fails with ``EntityRef``.
        - HTML named entities (``&nbsp;``, ``&mdash;``, ``&copy;``…) which are
          not predefined in XML.

        We preserve existing XML builtin entities (``&amp;``, ``&lt;``, ``&gt;``,
        ``&quot;``, ``&apos;``) and numeric character references, convert known
        HTML named entities to raw Unicode, and escape any remaining bare ``&``.
        """
        import html
        import re

        text = content.decode("utf-8", errors="replace")

        # XML builtin entities and numeric refs must be preserved verbatim.
        xml_builtin = {"amp", "lt", "gt", "quot", "apos"}
        entity_re = re.compile(
            r"&([A-Za-z_][A-Za-z0-9_]*|#[0-9]+|#x[0-9A-Fa-f]+);"
        )

        def _fix_entity(m: re.Match) -> str:
            ref = m.group(1)
            # Preserve XML builtin entities and numeric refs.
            if ref in xml_builtin:
                return m.group(0)
            if re.fullmatch(r"#[0-9]+|#x[0-9A-Fa-f]+", ref):
                return m.group(0)
            # Convert known HTML named entities (e.g. nbsp, mdash, copy) to
            # raw Unicode. Unknown/malformed entities are escaped as bare
            # ampersands so the document remains well-formed.
            expanded = html.unescape(m.group(0))
            if expanded != m.group(0):
                return expanded
            return "&amp;" + ref + ";"

        text = entity_re.sub(_fix_entity, text)

        # Escape any remaining bare ampersands (e.g. "R&D", "A & B", "&&",
        # malformed "&#160" without semicolon, or a trailing "&"). The
        # negative lookahead avoids double-escaping valid builtin/numeric
        # entities that were preserved above.
        text = re.sub(
            r"&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9A-Fa-f]+;)",
            "&amp;",
            text,
        )

        # Escape bare '<' that is not the start of a tag/declaration/comment.
        # In XML text content, '<' must be '&lt;'. A '<' followed by a
        # letter, '/', '!', or '?' is a tag/comment/PI start; anything else
        # (digit, space, '<', '&', end-of-string…) is a bare '<' in text.
        text = re.sub(r"<(?![A-Za-z/!?])", "&lt;", text)

        # Escape ']]>' sequences (illegal in XML text outside CDATA).
        text = re.sub("]]>", "]]&gt;", text)
        return text.encode("utf-8")

    @staticmethod
    def _rewrite_svg_refs(content: bytes, project_name: str) -> bytes:
        """Rewrite external file references in SVG content to use the project-file API.

        Handles patterns like:
        - ``href="../images/photo.jpg"`` →
          ``href="/api/ppt/project-file?project=X&path=images/photo.jpg"``
        - ``xlink:href="../images/photo.jpg"`` → same
        """
        import re
        from urllib.parse import quote

        text = content.decode("utf-8", errors="replace")
        encoded_project = quote(project_name, safe="")

        def _replace_path(m: re.Match) -> str:
            prefix = m.group(1)  # 'href="' or 'xlink:href="'
            raw_path = m.group(2)
            # Strip leading ../ or ./
            clean = raw_path.lstrip("./")
            # Only rewrite paths that look like file references (not data: or http)
            if clean.startswith("data:") or clean.startswith("http"):
                return m.group(0)
            # Use &amp; for XML attribute safety — the '&' in URL query
            # params must be escaped in XML attribute values.
            encoded_path = quote(clean, safe="")
            api_url = f"/api/ppt/project-file?project={encoded_project}&amp;path={encoded_path}"
            return f'{prefix}{api_url}"'

        # Match href="..." and xlink:href="..." with relative paths
        text = re.sub(
            r'(xlink:href="|href=")((?:\.\./|\./)[^"]+)"',
            _replace_path,
            text,
        )
        return text.encode("utf-8")

    _PROJECT_FILE_EXTENSIONS: ClassVar[dict[str, str]] = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".css": "text/css",
        ".js": "application/javascript",
        ".json": "application/json",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
    }

    def _handle_ppt_project_file(self, request: WsRequest) -> Response:
        """Serve arbitrary files from a PPT project directory (images, fonts, etc.).

        This allows SVGs in ``svg_output/`` to resolve external references like
        ``../images/photo.jpg`` when rendered by the browser via ``<object>``.
        """
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            file_path = _query_first(query, "path") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")
            if not file_path or ".." in file_path:
                return _http_error(400, "invalid file path")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt_projects" / project_name

            # Resolve and verify the path stays within the project directory
            resolved = (project_dir / file_path).resolve()
            if not str(resolved).startswith(str(project_dir.resolve())):
                return _http_error(403, "path outside project")

            if not resolved.is_file():
                return _http_error(404, "file not found")

            ext = resolved.suffix.lower()
            content_type = self._PROJECT_FILE_EXTENSIONS.get(ext, "application/octet-stream")
            content = resolved.read_bytes()
            return _http_response(
                content,
                content_type=content_type,
                extra_headers=[("Cache-Control", "public, max-age=3600")],
            )
        except Exception:
            logger.exception("ppt project file error")
            return _http_error(500, "internal error")

    @staticmethod
    def _is_websocket_channel_session_key(key: str) -> bool:
        """True when *key* is a ``websocket:…`` session exposed on this HTTP surface."""
        return key.startswith("websocket:")

    def _handle_session_messages(self, request: WsRequest, key: str) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        if self._session_manager is None:
            return _http_error(503, "session manager unavailable")
        decoded_key = _decode_api_key(key)
        if decoded_key is None:
            return _http_error(400, "invalid session key")
        # Only ``websocket:…`` sessions are listed/served here — same boundary as
        # ``/api/sessions``. Block handcrafted URLs from probing CLI / Slack / etc.
        if not self._is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        data = self._session_manager.read_session_file(decoded_key)
        if data is None:
            return _http_error(404, "session not found")
        messages = data.get("messages")
        if isinstance(messages, list):
            scrub_subagent_messages_for_channel(messages)
        # Decorate persisted user messages with signed media URLs so the
        # client can render previews. The raw on-disk ``media`` paths are
        # stripped on the way out — they leak server filesystem layout and
        # the client never needs them once it has the signed fetch URL.
        self._augment_media_urls(data)
        return _http_json_response(data)

    def _handle_webui_thread_get(self, request: WsRequest, key: str) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        decoded_key = _decode_api_key(key)
        if decoded_key is None:
            return _http_error(400, "invalid session key")
        if not self._is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        data = build_webui_thread_response(
            decoded_key,
            augment_user_media=self._augment_transcript_user_media,
        )
        if data is None:
            return _http_error(404, "webui thread not found")
        return _http_json_response(data)

    def _try_append_webui_transcript(self, chat_id: str, wire: dict[str, Any]) -> None:
        sk = f"websocket:{chat_id}"
        try:
            dup = json.loads(json.dumps(wire, ensure_ascii=False))
            append_transcript_object(sk, dup)
        except (ValueError, TypeError) as e:
            self.logger.warning("webui transcript append failed: {}", e)

    def _augment_transcript_user_media(self, paths: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for pstr in paths:
            path = Path(pstr)
            att = self._sign_or_stage_media_path(path)
            if att is None:
                continue
            mime, _ = mimetypes.guess_type(path.name)
            kind = "video" if mime and mime.startswith("video/") else "image"
            out.append(
                {"kind": kind, "url": att["url"], "name": att.get("name", path.name)},
            )
        return out

    async def _handle_message(
        self,
        sender_id: str,
        chat_id: str,
        content: str,
        media: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        session_key: str | None = None,
        is_dm: bool = False,
    ) -> None:
        meta = metadata or {}
        if meta.get("webui"):
            user_obj: dict[str, Any] = {
                "event": "user",
                "chat_id": chat_id,
                "text": content,
            }
            # IMPORTANT: persist display_content so history replay shows the
            # short label (e.g. "健康巡检") instead of the full enriched prompt.
            # DO NOT remove — multiple modules (terminal, db, notes) depend on this.
            display_content = meta.get("display_content")
            if isinstance(display_content, str) and display_content:
                user_obj["display_content"] = display_content
            if media:
                user_obj["media_paths"] = list(media)
            self._try_append_webui_transcript(chat_id, user_obj)
        await super()._handle_message(
            sender_id,
            chat_id,
            content,
            media,
            metadata,
            session_key,
            is_dm,
        )

    def _augment_media_urls(self, payload: dict[str, Any]) -> None:
        """Mutate *payload* in place: each message's ``media`` path list is
        replaced by a parallel ``media_urls`` list of signed fetch URLs.

        Messages without media or with non-string path entries are left
        untouched. Paths that no longer live inside ``media_dir`` (e.g. the
        file was deleted, or the dir was relocated) are silently skipped;
        the client falls back to the historical-replay placeholder tile.
        """
        messages = payload.get("messages")
        if not isinstance(messages, list):
            return
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            media = msg.get("media")
            if not isinstance(media, list) or not media:
                continue
            urls: list[dict[str, str]] = []
            for entry in media:
                if not isinstance(entry, str) or not entry:
                    continue
                signed = self._sign_media_path(Path(entry))
                if signed is None:
                    continue
                urls.append({"url": signed, "name": Path(entry).name})
            if urls:
                msg["media_urls"] = urls
            # Always drop the raw paths from the wire payload.
            msg.pop("media", None)

    def _sign_media_path(self, abs_path: Path) -> str | None:
        """Return a ``/api/media/<sig>/<payload>`` URL for *abs_path*, or
        ``None`` when the path does not resolve inside the media root.

        The URL is self-authenticating: the signature binds the payload to
        this process's ``_media_secret``, so only paths we chose to sign can
        be fetched. The returned path is relative to the server origin; the
        client joins it against this server's HTTP origin (same host as WS).
        """
        try:
            media_root = get_media_dir().resolve()
            rel = abs_path.resolve().relative_to(media_root)
        except (OSError, ValueError):
            return None
        payload = _b64url_encode(rel.as_posix().encode("utf-8"))
        mac = hmac.new(
            self._media_secret, payload.encode("ascii"), hashlib.sha256
        ).digest()[:16]
        return f"/api/media/{_b64url_encode(mac)}/{payload}"

    def _sign_or_stage_media_path(self, path: Path) -> dict[str, str] | None:
        """Return a signed media URL payload for *path*.

        Persisted inbound media already lives under ``get_media_dir`` and can
        be signed directly. Outbound bot-generated files may live anywhere on
        disk; copy those into the websocket media bucket first so the browser
        can fetch them through the existing signed media route without
        exposing arbitrary filesystem paths.
        """
        signed = self._sign_media_path(path)
        if signed is not None:
            return {"url": signed, "name": path.name}
        try:
            if not path.is_file():
                return None
            media_dir = get_media_dir("websocket")
            safe_name = safe_filename(path.name) or "attachment"
            staged = media_dir / f"{uuid.uuid4().hex[:12]}-{safe_name}"
            shutil.copyfile(path, staged)
        except OSError as exc:
            self.logger.warning("failed to stage outbound media {}: {}", path, exc)
            return None
        signed = self._sign_media_path(staged)
        if signed is None:
            return None
        return {"url": signed, "name": path.name}

    def _handle_media_fetch(self, sig: str, payload: str) -> Response:
        """Serve a single media file previously signed via
        :meth:`_sign_media_path`. Validates the signature, decodes the
        payload to a relative path, and streams the file bytes with a
        long-lived immutable cache header (the URL already encodes the
        file identity, so caches can be aggressive)."""
        try:
            provided_mac = _b64url_decode(sig)
        except (ValueError, binascii.Error):
            return _http_error(401, "invalid signature")
        expected_mac = hmac.new(
            self._media_secret, payload.encode("ascii"), hashlib.sha256
        ).digest()[:16]
        if not hmac.compare_digest(expected_mac, provided_mac):
            return _http_error(401, "invalid signature")
        try:
            rel_bytes = _b64url_decode(payload)
            rel_str = rel_bytes.decode("utf-8")
        except (ValueError, binascii.Error, UnicodeDecodeError):
            return _http_error(400, "invalid payload")
        # An attacker who somehow bypassed the HMAC check would still need
        # the resolved path to escape the media root; guard defensively.
        try:
            media_root = get_media_dir().resolve()
            candidate = (media_root / rel_str).resolve()
            candidate.relative_to(media_root)
        except (OSError, ValueError):
            return _http_error(404, "not found")
        if not candidate.is_file():
            return _http_error(404, "not found")
        try:
            body = candidate.read_bytes()
        except OSError:
            return _http_error(500, "read error")
        mime, _ = mimetypes.guess_type(candidate.name)
        if mime not in _MEDIA_ALLOWED_MIMES:
            mime = "application/octet-stream"
        return _http_response(
            body,
            content_type=mime,
            extra_headers=[
                ("Cache-Control", "private, max-age=31536000, immutable"),
                # Paired with the MIME whitelist above: prevents browsers from
                # MIME-sniffing an octet-stream fallback into executable HTML.
                ("X-Content-Type-Options", "nosniff"),
            ],
        )

    def _handle_file_preview(
        self,
        request: WsRequest,
        *,
        scope: str,
        session_key: str,
        path: str,
    ) -> Response:
        # 1. Auth: every file-preview request must carry a valid API token.
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")

        # 2. Path validation: only non-empty relative paths without traversal.
        if not path:
            return _http_error(400, "missing path")
        # Reject absolute paths: Windows drive letter (C:\), POSIX root (/),
        # or UNC/Windows-rooted backslash prefix.
        if re.match(r"^[A-Za-z]:[\\/]", path) or path.startswith("/") or path.startswith("\\"):
            return _http_error(400, "absolute paths are not allowed")
        if ".." in re.split(r"[\\/]", path):
            return _http_error(400, "path traversal is not allowed")

        # 3. Resolve the workspace root by scope.
        if scope == "shared":
            from mona.config.paths import get_shared_output_dir, get_workspace_path

            root = get_shared_output_dir(get_workspace_path())
        elif scope == "project":
            if not session_key:
                return _http_error(400, "missing session_key")
            if self._session_manager is None:
                return _http_error(404, "session not found")
            decoded_key = _decode_api_key(session_key)
            if decoded_key is None or not self._is_websocket_channel_session_key(decoded_key):
                return _http_error(404, "session not found")
            data = self._session_manager.read_session_file(decoded_key)
            if data is None:
                return _http_error(404, "session not found")
            metadata = data.get("metadata") or {}
            workspace = metadata.get("workspace")
            if not workspace:
                return _http_error(404, "session not found")
            root = Path(workspace).expanduser()
        else:
            return _http_error(400, "invalid scope")

        # 4. Combine and resolve, then re-check the boundary to block symlink
        # escapes that point outside the resolved root.
        try:
            root_resolved = root.resolve()
            target = (root_resolved / path).resolve()
            target.relative_to(root_resolved)
        except (ValueError, OSError):
            return _http_error(400, "invalid path")

        # 4a. Fallback: deliver_file sends paths relative to workspace (e.g.
        # "output/report.docx"), while listArtifacts sends paths relative to
        # output dir (e.g. "report.docx"). If the direct resolve misses, try
        # resolving from the workspace root for shared scope.
        if not target.is_file() and scope == "shared":
            try:
                from mona.config.paths import get_workspace_path

                ws_root = get_workspace_path().resolve()
                target2 = (ws_root / path).resolve()
                target2.relative_to(ws_root)
                if target2.is_file():
                    target = target2
            except (ValueError, OSError):
                pass

        # 5. File existence and read.
        if not target.is_file():
            return _http_error(404, "file not found")
        try:
            data = target.read_bytes()
        except OSError:
            return _http_error(500, "read error")

        # 6. MIME handling. HTML/Htm are forced to text/plain so the browser
        # never executes the page or loads its relative resources; the preview
        # surface only shows source.
        if target.suffix.lower() in (".html", ".htm"):
            content_type = "text/plain; charset=utf-8"
        else:
            mime, _ = mimetypes.guess_type(str(target))
            if not mime:
                mime = "application/octet-stream"
            safe_mimes = {
                "text/plain", "text/html", "text/css", "text/javascript",
                "application/json", "application/xml", "text/xml",
                "text/markdown", "text/csv",
                "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
            }
            if mime not in safe_mimes:
                mime = "text/plain"
            content_type = f"{mime}; charset=utf-8" if mime.startswith("text/") else mime

        return _http_response(
            data,
            content_type=content_type,
            extra_headers=[
                ("Cache-Control", "no-store"),
                ("X-Content-Type-Options", "nosniff"),
            ],
        )

    def _handle_artifacts_list(self, request: WsRequest) -> Response:
        """List shared artifacts under ``<workspace>/output``.

        Requires API token. The root is fixed to the configured workspace's
        ``output/`` directory; clients cannot pass an arbitrary root.
        """
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.config.paths import get_shared_output_dir, get_workspace_path
        from mona.utils.artifact_listing import list_artifacts

        output_dir = get_shared_output_dir(get_workspace_path())
        try:
            result = list_artifacts(output_dir)
        except Exception:
            logger.exception("Failed to list artifacts in {}", output_dir)
            return _http_error(500, "scan failed")
        payload = {
            "files": [
                {
                    "path": f.path,
                    "absolute_path": f.absolute_path,
                    "name": f.name,
                    "size": f.size,
                    "size_human": f.size_human,
                    "mime": f.mime,
                    "modified_at": f.modified_at,
                }
                for f in result.files
            ],
            "truncated": result.truncated,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return _http_response(
            body,
            content_type="application/json; charset=utf-8",
            extra_headers=[("Cache-Control", "no-store")],
        )

    def _handle_session_delete(self, request: WsRequest, key: str) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        if self._session_manager is None:
            return _http_error(503, "session manager unavailable")
        decoded_key = _decode_api_key(key)
        if decoded_key is None:
            return _http_error(400, "invalid session key")
        # Same boundary as ``_handle_session_messages``: mutations apply only to
        # websocket-channel sessions; deletion unlinks local JSONL — keep scope narrow.
        if not self._is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        deleted = self._session_manager.delete_session(decoded_key)
        delete_webui_thread(decoded_key)
        return _http_json_response({"deleted": bool(deleted)})

    def _serve_static(self, request_path: str) -> Response | None:
        """Resolve *request_path* against the built SPA directory; SPA fallback to index.html."""
        assert self._static_dist_path is not None
        rel = request_path.lstrip("/")
        if not rel:
            rel = "index.html"
        # Reject path-traversal attempts and absolute targets.
        if ".." in rel.split("/") or rel.startswith("/"):
            return _http_error(403, "Forbidden")
        candidate = (self._static_dist_path / rel).resolve()
        try:
            candidate.relative_to(self._static_dist_path)
        except ValueError:
            return _http_error(403, "Forbidden")
        if not candidate.is_file():
            # SPA history-mode fallback: unknown routes serve index.html so the
            # client-side router can render them.
            index = self._static_dist_path / "index.html"
            if index.is_file():
                candidate = index
            else:
                return None
        try:
            body = candidate.read_bytes()
        except OSError as e:
            self.logger.warning("static: failed to read {}: {}", candidate, e)
            return _http_error(500, "Internal Server Error")
        ctype, _ = mimetypes.guess_type(candidate.name)
        if ctype is None:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in {"application/javascript", "application/json"}:
            ctype = f"{ctype}; charset=utf-8"
        # Hash-named build assets are cache-friendly; index.html must stay fresh.
        if candidate.name == "index.html":
            cache = "no-cache"
        else:
            cache = "public, max-age=31536000, immutable"
        return _http_response(
            body,
            status=200,
            content_type=ctype,
            extra_headers=[("Cache-Control", cache)],
        )

    def _authorize_websocket_handshake(self, connection: Any, query: dict[str, list[str]]) -> Any:
        supplied = _query_first(query, "token")
        static_token = self.config.token.strip()

        if static_token:
            if supplied and hmac.compare_digest(supplied, static_token):
                return None
            if supplied and self._take_issued_token_if_valid(supplied):
                return None
            return connection.respond(401, "Unauthorized")

        if self.config.websocket_requires_token:
            if supplied and self._take_issued_token_if_valid(supplied):
                return None
            return connection.respond(401, "Unauthorized")

        if supplied:
            self._take_issued_token_if_valid(supplied)
        return None

    async def start(self) -> None:
        from mona.utils.logging_bridge import redirect_lib_logging

        redirect_lib_logging("websockets", level="WARNING")

        self._running = True
        self._stop_event = asyncio.Event()

        ssl_context = self._build_ssl_context()
        scheme = "wss" if ssl_context else "ws"

        async def process_request(
            connection: ServerConnection,
            request: WsRequest,
        ) -> Any:
            return await self._dispatch_http(connection, request)

        async def handler(connection: ServerConnection) -> None:
            await self._connection_loop(connection)

        async def runner() -> None:
            async with serve(
                handler,
                self.config.host,
                self.config.port,
                process_request=process_request,
                max_size=self.config.max_message_bytes,
                ping_interval=self.config.ping_interval_s,
                ping_timeout=self.config.ping_timeout_s,
                ssl=ssl_context,
            ):
                self.logger.info(
                    "WebSocket server listening on {}://{}:{}{}",
                    scheme,
                    self.config.host,
                    self.config.port,
                    self.config.path,
                )
                if self.config.token_issue_path:
                    self.logger.info(
                        "WebSocket token issue route: {}://{}:{}{}",
                        scheme,
                        self.config.host,
                        self.config.port,
                        _normalize_config_path(self.config.token_issue_path),
                    )
                assert self._stop_event is not None
                await self._stop_event.wait()

        self._server_task = asyncio.create_task(runner())
        self._artifact_watch_task = asyncio.create_task(self._watch_artifacts())
        await self._server_task

    async def _watch_artifacts(self) -> None:
        """Poll the shared output dir signature; broadcast on change.

        Runs only while at least one websocket connection is open; the
        scan is a metadata-only aggregate hash (no file content reads).
        The first observation after startup (or after all clients went
        away) becomes the baseline and is not broadcast.
        """
        from mona.config.paths import get_shared_output_dir, get_workspace_path
        from mona.utils.artifact_listing import artifact_signature

        last: str | None = None
        while True:
            await asyncio.sleep(_ARTIFACT_WATCH_INTERVAL_S)
            if not self._conn_chats:
                continue
            try:
                signature = await asyncio.to_thread(
                    artifact_signature,
                    get_shared_output_dir(get_workspace_path()),
                )
            except Exception:
                logger.exception("artifact watch scan failed")
                continue
            if last is None:
                last = signature
                continue
            if signature != last:
                last = signature
                await self.send_artifacts_changed()

    async def _connection_loop(self, connection: Any) -> None:
        request = connection.request
        path_part = request.path if request else "/"
        _, query = _parse_request_path(path_part)
        client_id_raw = _query_first(query, "client_id")
        client_id = client_id_raw.strip() if client_id_raw else ""
        if not client_id:
            client_id = f"anon-{uuid.uuid4().hex[:12]}"
        elif len(client_id) > 128:
            self.logger.warning("client_id too long ({} chars), truncating", len(client_id))
            client_id = client_id[:128]

        default_chat_id = str(uuid.uuid4())

        try:
            await connection.send(
                json.dumps(
                    {
                        "event": "ready",
                        "chat_id": default_chat_id,
                        "client_id": client_id,
                    },
                    ensure_ascii=False,
                )
            )
            # Register only after ready is successfully sent to avoid out-of-order sends
            self._conn_default[connection] = default_chat_id
            self._attach(connection, default_chat_id)
            await self._hydrate_after_subscribe(default_chat_id)

            async for raw in connection:
                if isinstance(raw, bytes):
                    try:
                        raw = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        self.logger.warning("ignoring non-utf8 binary frame")
                        continue

                envelope = _parse_envelope(raw)
                if envelope is not None:
                    await self._dispatch_envelope(connection, client_id, envelope)
                    continue

                content = _parse_inbound_payload(raw)
                if content is None:
                    continue
                # WebSocket already authenticates at handshake time (token),
                # so pairing is not applicable. Treat as non-DM to avoid
                # sending pairing codes to an already-authenticated client.
                await self._handle_message(
                    sender_id=client_id,
                    chat_id=default_chat_id,
                    content=content,
                    metadata={"remote": getattr(connection, "remote_address", None)},
                    is_dm=False,
                )
        except Exception as e:
            self.logger.debug("connection ended: {}", e)
        finally:
            self._cleanup_connection(connection)

    def _save_envelope_media(
        self,
        media: list[Any],
    ) -> tuple[list[str], str | None]:
        """Decode and persist ``media`` items from a ``message`` envelope.

        Returns ``(paths, None)`` on success or ``([], reason)`` on the first
        failure — the caller is expected to surface ``reason`` to the client
        and skip publishing so no half-formed message ever reaches the agent.
        On failure, any files already written to disk earlier in the same
        call are unlinked so partial ingress doesn't leak orphan files.
        ``reason`` is a short, stable token suitable for UI localization.

        Shape: ``list[{"data_url": str, "name"?: str | None}]``.
        """
        image_count = 0
        video_count = 0
        for item in media:
            mime = _extract_data_url_mime(item.get("data_url", "")) if isinstance(item, dict) else None
            if mime in _VIDEO_MIME_ALLOWED:
                video_count += 1
            elif mime in _IMAGE_MIME_ALLOWED:
                image_count += 1
        if image_count > _MAX_IMAGES_PER_MESSAGE:
            return [], "too_many_images"
        if video_count > _MAX_VIDEOS_PER_MESSAGE:
            return [], "too_many_videos"

        media_dir = get_media_dir("websocket")
        paths: list[str] = []

        def _abort(reason: str) -> tuple[list[str], str]:
            for p in paths:
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError as exc:
                    self.logger.warning(
                        "failed to unlink partial media {}: {}", p, exc
                    )
            return [], reason

        for item in media:
            if not isinstance(item, dict):
                return _abort("malformed")
            data_url = item.get("data_url")
            if not isinstance(data_url, str) or not data_url:
                return _abort("malformed")
            mime = _extract_data_url_mime(data_url)
            if mime is None:
                return _abort("decode")
            if mime not in _UPLOAD_MIME_ALLOWED:
                return _abort("mime")
            is_video = mime in _VIDEO_MIME_ALLOWED
            max_bytes = _MAX_VIDEO_BYTES if is_video else _MAX_IMAGE_BYTES
            try:
                saved = save_base64_data_url(
                    data_url, media_dir, max_bytes=max_bytes,
                )
            except FileSizeExceeded:
                return _abort("size")
            except Exception as exc:
                self.logger.warning("media decode failed: {}", exc)
                return _abort("decode")
            if saved is None:
                return _abort("decode")
            paths.append(saved)
        return paths, None

    async def _handle_ppt_import_native_envelope(
        self,
        connection: Any,
        envelope: dict[str, Any],
    ) -> None:
        """Handle ppt_import_native envelope: import PPTX as a native template."""
        file_info = envelope.get("file")
        if not isinstance(file_info, dict):
            await self._send_event(
                connection, "ppt_import_native_result", ok=False, error="no file",
            )
            return

        name = file_info.get("name", "")
        data_url = file_info.get("data_url", "")
        mime = _extract_data_url_mime(data_url)
        if mime != "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            await self._send_event(
                connection, "ppt_import_native_result", ok=False, error="not a pptx file",
            )
            return

        try:
            raw = _decode_data_url_payload(data_url, _PPT_DOC_MAX_BYTES)
        except FileSizeExceeded:
            await self._send_event(
                connection, "ppt_import_native_result", ok=False, error="file too large",
            )
            return
        except Exception:
            await self._send_event(
                connection, "ppt_import_native_result", ok=False, error="decode failed",
            )
            return
        if raw is None:
            await self._send_event(
                connection, "ppt_import_native_result", ok=False, error="decode failed",
            )
            return

        try:
            import tempfile
            from urllib.parse import quote

            from mona.agent.skills import BUILTIN_SKILLS_DIR

            with tempfile.TemporaryDirectory(prefix="ppt_native_") as tmp_dir:
                tmp_path = Path(tmp_dir) / safe_filename(name or "upload.pptx")
                tmp_path.write_bytes(raw)

                skill_dir = BUILTIN_SKILLS_DIR / "mona-ppt"

                # Run native_template_inspect.py
                inspect_script = skill_dir / "scripts" / "native_template_inspect.py"
                output_dir = Path(tmp_dir) / "native_output"
                result = subprocess.run(
                    [
                        "python", str(inspect_script), str(tmp_path),
                        "-o", str(output_dir),
                        "--name", Path(name).stem if name else "template",
                    ],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode != 0:
                    await self._send_event(
                        connection,
                        "ppt_import_native_result",
                        ok=False,
                        error=f"inspect failed: {result.stderr[:300]}",
                    )
                    return

                # Read manifest for metadata
                manifest_path = output_dir / "template_manifest.json"
                manifest = {}
                if manifest_path.exists():
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

                page_count = manifest.get("slide_count", 0)
                canvas_format = manifest.get("canvas_format", "ppt169")

                # Extract primary color from roles
                primary_color = "#1A1A1A"

                # Generate template_id
                template_id = safe_filename(Path(name).stem if name else "template")
                if not template_id or template_id == ".":
                    template_id = f"native_{int(time.time())}"

                display_name = Path(name).stem if name else template_id

                # Copy to templates_full/native/<template_id>
                target_dir = skill_dir / "scripts" / "templates_full" / "native" / template_id
                if target_dir.exists():
                    shutil.rmtree(target_dir)
                shutil.copytree(output_dir, target_dir)

                # Sync to templates/native/<template_id>
                skill_target = skill_dir / "templates" / "native" / template_id
                if skill_target.exists():
                    shutil.rmtree(skill_target)
                shutil.copytree(output_dir, skill_target)

                # Update native_index.json (both copies)
                for index_path in [
                    skill_dir / "scripts" / "templates_full" / "native" / "native_index.json",
                    skill_dir / "templates" / "native" / "native_index.json",
                ]:
                    index_data: dict[str, Any] = {}
                    if index_path.exists():
                        index_data = json.loads(index_path.read_text(encoding="utf-8"))
                    index_data[template_id] = {
                        "name": display_name,
                        "summary": f"从用户上传 PPTX 导入的自定义模板，共 {page_count} 页",
                        "canvas_format": canvas_format,
                        "page_count": page_count,
                        "primary_color": primary_color,
                        "userCreated": True,
                    }
                    index_path.parent.mkdir(parents=True, exist_ok=True)
                    index_path.write_text(
                        json.dumps(index_data, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8",
                    )

                # Generate cover URL
                cover_url = ""
                cover_file = target_dir / "01_cover.png"
                if cover_file.exists():
                    cover_url = (
                        f"/api/ppt/template-svg?kind=native"
                        f"&key={quote(template_id, safe='')}&file=01_cover.png"
                    )

                # Send result
                await self._send_event(
                    connection,
                    "ppt_import_native_result",
                    ok=True,
                    templateId=template_id,
                    name=display_name,
                    pageCount=page_count,
                    coverUrl=cover_url,
                    primaryColor=primary_color,
                )

        except Exception as exc:
            logger.exception("ppt_import_native error")
            await self._send_event(
                connection,
                "ppt_import_native_result",
                ok=False,
                error=str(exc)[:200],
            )

    async def _handle_ppt_delete_native(
        self,
        connection: Any,
        envelope: dict[str, Any],
    ) -> None:
        """Handle ppt_delete_native envelope."""
        data = envelope.get("data", {})
        if not isinstance(data, dict):
            data = {}
        template_id = data.get("templateId") or envelope.get("templateId", "")
        if (
            not isinstance(template_id, str)
            or not template_id
            or "/" in template_id
            or "\\" in template_id
            or ".." in template_id
        ):
            await self._send_event(
                connection, "ppt_delete_native_result", ok=False, error="invalid templateId",
            )
            return

        from mona.agent.skills import BUILTIN_SKILLS_DIR

        skill_dir = BUILTIN_SKILLS_DIR / "mona-ppt"
        primary_index = (
            skill_dir / "scripts" / "templates_full" / "native" / "native_index.json"
        )
        fallback_index = skill_dir / "templates" / "native" / "native_index.json"

        index_data: dict[str, Any] = {}
        for index_path in (primary_index, fallback_index):
            if index_path.exists():
                index_data = json.loads(index_path.read_text(encoding="utf-8"))
                if template_id in index_data:
                    break

        info = index_data.get(template_id)
        if not isinstance(info, dict):
            await self._send_event(
                connection, "ppt_delete_native_result", ok=False, error="template not found",
            )
            return
        if info.get("userCreated") is not True:
            await self._send_event(
                connection,
                "ppt_delete_native_result",
                ok=False,
                error="cannot delete built-in template",
            )
            return

        for native_base in [
            skill_dir / "scripts" / "templates_full" / "native",
            skill_dir / "templates" / "native",
        ]:
            native_dir = native_base / template_id
            if native_dir.exists():
                shutil.rmtree(native_dir)

            index_path = native_base / "native_index.json"
            if index_path.exists():
                index_data = json.loads(index_path.read_text(encoding="utf-8"))
                index_data.pop(template_id, None)
                index_path.write_text(
                    json.dumps(index_data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )

        await self._send_event(
            connection, "ppt_delete_native_result", ok=True, templateId=template_id,
        )

    async def _handle_ppt_upload_envelope(
        self,
        connection: Any,
        envelope: dict[str, Any],
    ) -> None:
        files = envelope.get("files")
        if not isinstance(files, list) or not files:
            await self._send_event(connection, "ppt_upload_result", ok=False, error="no files")
            return
        try:
            from mona.config.paths import get_workspace_path

            workspace = get_workspace_path()
            sources_dir = workspace / "ppt_projects" / "_sources"
            sources_dir.mkdir(parents=True, exist_ok=True)

            added: list[dict[str, str]] = []
            for item in files:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                data_url = item.get("data_url")
                if not isinstance(name, str) or not isinstance(data_url, str):
                    continue
                mime = _extract_data_url_mime(data_url)
                if mime is None or mime not in _PPT_DOC_MIME_ALLOWED:
                    continue
                try:
                    raw = _decode_data_url_payload(data_url, _PPT_DOC_MAX_BYTES)
                except FileSizeExceeded:
                    continue
                except Exception:
                    continue
                if raw is None:
                    continue
                safe_name = safe_filename(name)
                dest = sources_dir / safe_name
                dest.write_bytes(raw)
                rel = dest.relative_to(workspace)
                added.append({"name": safe_name, "path": str(rel).replace("\\", "/")})

            await self._send_event(
                connection, "ppt_upload_result", ok=len(added) > 0, files=added,
                error=None if added else "no valid files",
            )
        except Exception as e:
            logger.exception("ppt_upload error")
            await self._send_event(connection, "ppt_upload_result", ok=False, error=str(e))

    async def _handle_doc_upload_envelope(
        self,
        connection: Any,
        envelope: dict[str, Any],
    ) -> None:
        """Handle document uploads for the "文档加工" workbench.

        Envelope shape: {type: "doc_upload", chat_id: str, files: [{name, data_url}]}
        Files are written to ``workspace/uploads/<chat_id>/`` and the relative
        paths are returned to the caller. The original user file is never
        modified — only the working copy under uploads/ is written.
        """
        files = envelope.get("files")
        if not isinstance(files, list) or not files:
            await self._send_event(connection, "doc_upload_result", ok=False, error="no files")
            return
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(connection, "doc_upload_result", ok=False, error="invalid chat_id")
            return
        try:
            from mona.config.paths import get_workspace_path

            workspace = get_workspace_path()
            # Sanitize chat_id for folder name: strip "ephemeral:" prefix and
            # keep only filesystem-safe characters.
            safe_chat = str(chat_id).replace("ephemeral:", "eph_")
            uploads_dir = workspace / "uploads" / safe_chat
            uploads_dir.mkdir(parents=True, exist_ok=True)

            added: list[dict[str, str]] = []
            for item in files:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                data_url = item.get("data_url")
                if not isinstance(name, str) or not isinstance(data_url, str):
                    continue
                mime = _extract_data_url_mime(data_url)
                if mime is None or mime not in _DOC_MIME_ALLOWED:
                    continue
                try:
                    raw = _decode_data_url_payload(data_url, _DOC_MAX_BYTES)
                except FileSizeExceeded:
                    continue
                except Exception:
                    continue
                if raw is None:
                    continue
                safe_name = safe_filename(name)
                # Prefix with a short uuid to avoid collisions when the same
                # filename is uploaded twice in the same chat session.
                short_id = uuid.uuid4().hex[:8]
                dest = uploads_dir / f"{short_id}-{safe_name}"
                dest.write_bytes(raw)
                rel = dest.relative_to(workspace)
                added.append({
                    "name": safe_name,
                    "path": str(rel).replace("\\", "/"),
                    "size": len(raw),
                    "mime": mime,
                })

            await self._send_event(
                connection, "doc_upload_result", ok=len(added) > 0, files=added,
                chat_id=chat_id,
                error=None if added else "no valid files",
            )
        except Exception as e:
            logger.exception("doc_upload error")
            await self._send_event(connection, "doc_upload_result", ok=False, error=str(e))

    # -- Collaboration rooms (multi-agent phase 2, guide 7.5) ---------------

    def _room_agent_registry(self) -> Any:
        """Lazy AgentRegistry used to validate room membership."""
        registry = getattr(self, "_room_registry", None)
        if registry is None:
            from mona.agent.partners import AgentRegistry

            registry = AgentRegistry()
            self._room_registry = registry
        return registry

    def _validate_room_agent_ids(
        self, raw: Any
    ) -> tuple[list[str] | None, str | None, str | None]:
        """Validate a client-supplied room member list.

        Returns ``(agent_ids, None, None)`` on success or ``(None, code,
        detail)`` on failure. The reserved Mona agent coordinates every room
        and is always kept as a member; every other ID must be an installed
        agent. Client-supplied users, initiating agents and permission fields
        are never trusted — membership is the only input.
        """
        from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id

        if not isinstance(raw, list) or not raw:
            return None, "invalid_agents", "agent_ids must be a non-empty list of agent IDs"
        normalized: list[str] = []
        for entry in raw:
            if not isinstance(entry, str):
                return None, "invalid_agents", "agent_ids entries must be strings"
            try:
                agent_id = normalize_agent_id(entry)
            except ValueError:
                return None, "invalid_agent_id", f"invalid agent id {entry!r}"
            if agent_id not in normalized:
                normalized.append(agent_id)
        if MONA_AGENT_ID not in normalized:
            normalized.insert(0, MONA_AGENT_ID)
        if len(normalized) < 2:
            return None, "not_enough_agents", "a room needs at least one partner agent"
        registry = self._room_agent_registry()
        unknown = [a for a in normalized if registry.get(a) is None]
        if unknown:
            return None, "unknown_agent", f"unknown or disabled agents: {', '.join(unknown)}"
        return normalized, None, None

    def _room_state_payload(self, conversation: Any) -> dict[str, Any]:
        registry = self._room_agent_registry()
        agents = []
        for agent_id in conversation.agent_ids:
            definition = registry.get(agent_id)
            agents.append({
                "id": agent_id,
                "displayName": definition.display_name if definition else agent_id,
                "description": definition.description if definition else "",
            })
        return {
            "conversation": conversation.to_session_metadata(),
            "agents": agents,
        }

    @staticmethod
    def _room_request_id(envelope: dict[str, Any]) -> str | None:
        request_id = envelope.get("request_id")
        return request_id if isinstance(request_id, str) and request_id else None

    async def _handle_create_room_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.partners import CONVERSATION_METADATA_KEY, ConversationMetadata

        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection, "create_room_result", ok=False,
                code="invalid_chat_id", detail="invalid chat_id", request_id=request_id,
            )
            return
        agent_ids, code, detail = self._validate_room_agent_ids(envelope.get("agent_ids"))
        if agent_ids is None:
            await self._send_event(
                connection, "create_room_result", ok=False,
                code=code, detail=detail, chat_id=chat_id, request_id=request_id,
            )
            return
        title = envelope.get("title")
        if not isinstance(title, str):
            title = ""
        goal = envelope.get("goal")
        if not isinstance(goal, str) or not goal.strip():
            goal = None
        if self._session_manager is None:
            await self._send_event(
                connection, "create_room_result", ok=False,
                code="unavailable", detail="session manager unavailable",
                chat_id=chat_id, request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        if session.conversation_metadata.type == "room":
            await self._send_event(
                connection, "create_room_result", ok=False,
                code="already_a_room", detail="chat is already a collaboration room",
                chat_id=chat_id, request_id=request_id,
            )
            return
        conversation = ConversationMetadata.room(agent_ids, title=title.strip(), goal=goal)
        session.metadata[CONVERSATION_METADATA_KEY] = conversation.to_session_metadata()
        self._session_manager.save(session)
        await self._send_event(
            connection, "create_room_result", ok=True, chat_id=chat_id,
            request_id=request_id, **self._room_state_payload(conversation),
        )
        await self.send_room_updated(chat_id, self._room_state_payload(conversation))

    async def _handle_update_room_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.partners import CONVERSATION_METADATA_KEY

        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection, "update_room_result", ok=False,
                code="invalid_chat_id", detail="invalid chat_id", request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection, "update_room_result", ok=False,
                code="unavailable", detail="session manager unavailable",
                chat_id=chat_id, request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection, "update_room_result", ok=False,
                code="not_a_room", detail="chat is not a collaboration room",
                chat_id=chat_id, request_id=request_id,
            )
            return
        raw_agents = envelope.get("agent_ids")
        if raw_agents is not None:
            agent_ids, code, detail = self._validate_room_agent_ids(raw_agents)
            if agent_ids is None:
                await self._send_event(
                    connection, "update_room_result", ok=False,
                    code=code, detail=detail, chat_id=chat_id, request_id=request_id,
                )
                return
            conversation.agent_ids = agent_ids
        title = envelope.get("title")
        if isinstance(title, str):
            conversation.title = title.strip()
        goal = envelope.get("goal")
        if isinstance(goal, str):
            conversation.goal = goal.strip() or None
        session.metadata[CONVERSATION_METADATA_KEY] = conversation.to_session_metadata()
        self._session_manager.save(session)
        await self._send_event(
            connection, "update_room_result", ok=True, chat_id=chat_id,
            request_id=request_id, **self._room_state_payload(conversation),
        )
        await self.send_room_updated(chat_id, self._room_state_payload(conversation))

    async def _handle_get_room_state_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection, "room_state_result", ok=False,
                code="invalid_chat_id", detail="invalid chat_id", request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection, "room_state_result", ok=False,
                code="unavailable", detail="session manager unavailable",
                chat_id=chat_id, request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection, "room_state_result", ok=False,
                code="not_a_room", detail="chat is not a collaboration room",
                chat_id=chat_id, request_id=request_id,
            )
            return
        await self._send_event(
            connection, "room_state_result", ok=True, chat_id=chat_id,
            request_id=request_id, **self._room_state_payload(conversation),
        )

    async def _handle_cancel_agent_job_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        """Cancel a queued/running room job (multi-agent phase 2c, guide 7.4).

        Permission: the chat must be a collaboration room and the job must
        belong to it. A client-supplied ``agent_id`` is treated only as a
        membership claim — it must be a room member (Mona is always one);
        when omitted the human room owner is the requester. Client-supplied
        users and permission flags are never trusted.
        """
        from mona.agent.jobs import JobNotFoundError, JobTransitionError, serialize_job
        from mona.agent.partners import normalize_agent_id

        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="invalid_chat_id", detail="invalid chat_id", request_id=request_id,
            )
            return
        job_id = envelope.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="invalid_job_id", detail="invalid job_id",
                chat_id=chat_id, request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="unavailable", detail="session manager unavailable",
                chat_id=chat_id, request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="not_a_room", detail="chat is not a collaboration room",
                chat_id=chat_id, request_id=request_id,
            )
            return
        requester = envelope.get("agent_id")
        if requester is not None:
            if not isinstance(requester, str):
                await self._send_event(
                    connection, "cancel_agent_job_result", ok=False,
                    code="invalid_agent_id", detail="invalid agent_id",
                    chat_id=chat_id, request_id=request_id,
                )
                return
            try:
                requester = normalize_agent_id(requester)
            except ValueError:
                await self._send_event(
                    connection, "cancel_agent_job_result", ok=False,
                    code="invalid_agent_id", detail="invalid agent_id",
                    chat_id=chat_id, request_id=request_id,
                )
                return
            if requester not in conversation.agent_ids:
                await self._send_event(
                    connection, "cancel_agent_job_result", ok=False,
                    code="not_a_member",
                    detail=f"agent {requester!r} is not a room member",
                    chat_id=chat_id, request_id=request_id,
                )
                return
        if self._subagent_manager is None:
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="unavailable", detail="subagent manager unavailable",
                chat_id=chat_id, request_id=request_id,
            )
            return
        reason = envelope.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            reason = None
        try:
            job = await self._subagent_manager.cancel_job(
                job_id, room_id=chat_id, reason=reason
            )
        except JobNotFoundError:
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="job_not_found", detail="job not found in this room",
                chat_id=chat_id, request_id=request_id,
            )
            return
        except JobTransitionError:
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="job_not_cancellable",
                detail="job is already in a terminal state",
                chat_id=chat_id, request_id=request_id,
            )
            return
        except ValueError:
            await self._send_event(
                connection, "cancel_agent_job_result", ok=False,
                code="invalid_job_id", detail="invalid job_id",
                chat_id=chat_id, request_id=request_id,
            )
            return
        await self._send_event(
            connection, "cancel_agent_job_result", ok=True, chat_id=chat_id,
            job_id=job.id, request_id=request_id, job=serialize_job(job),
        )

    async def _dispatch_envelope(
        self,
        connection: Any,
        client_id: str,
        envelope: dict[str, Any],
    ) -> None:
        """Route one typed inbound envelope (``new_chat`` / ``attach`` / ``message``)."""
        t = envelope.get("type")
        if t == "new_chat":
            new_id = str(uuid.uuid4())
            ephemeral = envelope.get("ephemeral") is True
            if ephemeral:
                new_id = f"ephemeral:{new_id}"
            self._attach(connection, new_id)
            # Persist workspace binding on the session so AgentLoop can route
            # file operations to the project directory. ``None`` (or omitted)
            # means the default workspace (~/.mona/workspace/).
            workspace = envelope.get("workspace")
            if workspace is not None and not isinstance(workspace, str):
                workspace = None
            if isinstance(workspace, str):
                workspace = workspace.strip() or None
            # ``agent_kind`` marks the session for a dedicated document agent loop.
            # Supported kinds are resolved dynamically from DOCUMENT_PROFILES
            # (ppt / video / 3d / ...), each routing to a DocumentAgentLoop
            # with its own tool whitelist + soul prompt.
            from mona.agent.document_loop import DOCUMENT_PROFILES
            agent_kind = envelope.get("agent_kind")
            if not isinstance(agent_kind, str):
                agent_kind = None
            agent_kind = agent_kind.strip() if agent_kind else None
            if agent_kind not in (*DOCUMENT_PROFILES.keys(), None):
                agent_kind = None
            if (workspace is not None or agent_kind is not None) and self._session_manager is not None:
                session = self._session_manager.get_or_create(f"websocket:{new_id}")
                if workspace is not None:
                    session.metadata["workspace"] = workspace
                if agent_kind is not None:
                    session.metadata["agent_kind"] = agent_kind
                self._session_manager.save(session)
            await self._send_event(connection, "attached", chat_id=new_id)
            await self._hydrate_after_subscribe(new_id)
            return
        if t == "attach":
            cid = envelope.get("chat_id")
            if not _is_valid_chat_id(cid):
                await self._send_event(connection, "error", detail="invalid chat_id")
                return
            self._attach(connection, cid)
            await self._send_event(connection, "attached", chat_id=cid)
            await self._hydrate_after_subscribe(cid)
            return
        if t == "ppt_upload":
            await self._handle_ppt_upload_envelope(connection, envelope)
            return
        if t == "doc_upload":
            await self._handle_doc_upload_envelope(connection, envelope)
            return
        if t == "ppt_import_native":
            await self._handle_ppt_import_native_envelope(connection, envelope)
            return
        if t == "ppt_delete_native":
            await self._handle_ppt_delete_native(connection, envelope)
            return
        if t == "create_room":
            await self._handle_create_room_envelope(connection, envelope)
            return
        if t == "update_room":
            await self._handle_update_room_envelope(connection, envelope)
            return
        if t == "get_room_state":
            await self._handle_get_room_state_envelope(connection, envelope)
            return
        if t == "cancel_agent_job":
            await self._handle_cancel_agent_job_envelope(connection, envelope)
            return
        if t == "message":
            cid = envelope.get("chat_id")
            content = envelope.get("content")
            if not _is_valid_chat_id(cid):
                await self._send_event(connection, "error", detail="invalid chat_id")
                return
            if not isinstance(content, str):
                await self._send_event(connection, "error", detail="missing content")
                return

            raw_media = envelope.get("media")
            media_paths: list[str] = []
            if raw_media is not None:
                if not isinstance(raw_media, list):
                    await self._send_event(
                        connection, "error",
                        detail="image_rejected", reason="malformed",
                    )
                    return
                media_paths, reason = self._save_envelope_media(raw_media)
                if reason is not None:
                    await self._send_event(
                        connection, "error",
                        detail="image_rejected", reason=reason,
                    )
                    return

            # Document paths uploaded via the "doc_upload" envelope. These are
            # workspace-relative paths returned by _handle_doc_upload_envelope.
            # Resolve them to absolute paths so extract_documents() can read
            # them and inject the extracted text into the user message.
            raw_doc_paths = envelope.get("doc_paths")
            if raw_doc_paths is not None:
                if not isinstance(raw_doc_paths, list):
                    raw_doc_paths = None
            if raw_doc_paths:
                from mona.config.paths import get_workspace_path

                workspace = get_workspace_path()
                for dp in raw_doc_paths:
                    if not isinstance(dp, str) or not dp:
                        continue
                    # Defensive: reject absolute paths and parent traversal to
                    # prevent escaping the workspace.
                    if dp.startswith("/") or ".." in Path(dp).parts:
                        continue
                    abs_path = (workspace / dp).resolve()
                    try:
                        # Ensure the resolved path stays inside workspace.
                        abs_path.relative_to(workspace.resolve())
                    except ValueError:
                        continue
                    if abs_path.is_file():
                        media_paths.append(str(abs_path))

            # Allow image-only turns (content may be empty when media is attached).
            if not content.strip() and not media_paths:
                await self._send_event(connection, "error", detail="missing content")
                return

            # Auto-attach on first use so clients can one-shot without a separate attach.
            self._attach(connection, cid)
            await self._hydrate_after_subscribe(cid)
            metadata: dict[str, Any] = {"remote": getattr(connection, "remote_address", None)}
            if envelope.get("webui") is True:
                metadata["webui"] = True
            terminal_session_id = envelope.get("terminal_session_id")
            if isinstance(terminal_session_id, str) and terminal_session_id:
                metadata["terminal_session_id"] = terminal_session_id
            terminal_exec_mode = envelope.get("terminal_exec_mode")
            if isinstance(terminal_exec_mode, str) and terminal_exec_mode in ("auto", "approval"):
                metadata["terminal_exec_mode"] = terminal_exec_mode
            db_connection_id = envelope.get("db_connection_id")
            if isinstance(db_connection_id, str) and db_connection_id:
                metadata["connection_id"] = db_connection_id
            db_database = envelope.get("db_database")
            if isinstance(db_database, str) and db_database:
                metadata["database"] = db_database
            db_table = envelope.get("db_table")
            if isinstance(db_table, str) and db_table:
                metadata["table"] = db_table
            db_type = envelope.get("db_type")
            if isinstance(db_type, str) and db_type:
                metadata["db_type"] = db_type
            db_server_version = envelope.get("db_server_version")
            if isinstance(db_server_version, str) and db_server_version:
                metadata["server_version"] = db_server_version
            db_current_sql = envelope.get("db_current_sql")
            if isinstance(db_current_sql, str) and db_current_sql:
                # Cap oversized SQL to avoid bloating context.
                cap = 2000
                if len(db_current_sql) > cap:
                    metadata["current_sql"] = db_current_sql[:cap] + " /* truncated */"
                    metadata["current_sql_truncated"] = True
                else:
                    metadata["current_sql"] = db_current_sql
            db_last_error = envelope.get("db_last_error")
            if isinstance(db_last_error, str) and db_last_error:
                cap_err = 1000
                if len(db_last_error) > cap_err:
                    metadata["last_error"] = db_last_error[:cap_err] + " /* truncated */"
                else:
                    metadata["last_error"] = db_last_error
            browser_page_url = envelope.get("browser_page_url")
            if isinstance(browser_page_url, str) and browser_page_url:
                metadata["browser_page_url"] = browser_page_url
            browser_page_title = envelope.get("browser_page_title")
            if isinstance(browser_page_title, str) and browser_page_title:
                metadata["browser_page_title"] = browser_page_title
            # IMPORTANT: persist display_content for history replay.
            # DO NOT remove — keeps user messages showing original input, not enriched prompts.
            display_content = envelope.get("display_content")
            if isinstance(display_content, str) and display_content:
                metadata["display_content"] = display_content
            image_generation = envelope.get("image_generation")
            if isinstance(image_generation, dict) and image_generation.get("enabled") is True:
                aspect_ratio = image_generation.get("aspect_ratio")
                metadata["image_generation"] = {
                    "enabled": True,
                    "aspect_ratio": aspect_ratio if isinstance(aspect_ratio, str) else None,
                }
            video_generation = envelope.get("video_generation")
            if isinstance(video_generation, dict) and video_generation.get("enabled") is True:
                # WebUI video mode now only signals intent — the AI picks
                # aspect_ratio / duration and treats attached images as
                # image-to-video references via the generate_video tool.
                metadata["video_generation"] = {"enabled": True}
            # Persist doc references for history replay: the front-end renders
            # document chips from this list. Only name and relative path are
            # stored — file bytes live in workspace/uploads/.
            if raw_doc_paths:
                doc_meta: list[dict[str, str]] = []
                from mona.config.paths import get_workspace_path as _gwp

                ws = _gwp()
                for dp in raw_doc_paths:
                    if not isinstance(dp, str) or not dp:
                        continue
                    if dp.startswith("/") or ".." in Path(dp).parts:
                        continue
                    abs_p = (ws / dp).resolve()
                    try:
                        abs_p.relative_to(ws.resolve())
                    except ValueError:
                        continue
                    if abs_p.is_file():
                        doc_meta.append({"name": abs_p.name, "path": dp})
                if doc_meta:
                    metadata["doc_paths"] = doc_meta
            await self._handle_message(
                sender_id=client_id,
                chat_id=cid,
                content=content,
                media=media_paths or None,
                metadata=metadata,
                is_dm=False,
            )
            return
        if t == "delete_chat":
            cid = envelope.get("chat_id")
            if not _is_valid_chat_id(cid):
                await self._send_event(connection, "error", detail="invalid chat_id")
                return
            if cid.startswith("ephemeral:"):
                self._cleanup_ephemeral_session(cid)
            await self._send_event(connection, "deleted", chat_id=cid)
            return
        await self._send_event(connection, "error", detail=f"unknown type: {t!r}")

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        if self._stop_event:
            self._stop_event.set()
        if self._server_task:
            try:
                await self._server_task
            except Exception as e:
                self.logger.warning("server task error during shutdown: {}", e)
            self._server_task = None
        if self._artifact_watch_task:
            self._artifact_watch_task.cancel()
            try:
                await self._artifact_watch_task
            except asyncio.CancelledError:
                pass
            self._artifact_watch_task = None
        self._subs.clear()
        self._conn_chats.clear()
        self._conn_default.clear()
        self._issued_tokens.clear()
        self._api_tokens.clear()

    async def _safe_send_to(self, connection: Any, raw: str, *, label: str = "") -> None:
        """Send a raw frame to one connection, cleaning up on ConnectionClosed."""
        try:
            await connection.send(raw)
        except ConnectionClosed:
            self._cleanup_connection(connection)
            self.logger.warning("connection gone{}", label)
        except Exception:
            self.logger.exception("send failed{}", label)
            raise

    async def _send_deliver_files_event(
        self,
        chat_id: str,
        files: list[dict[str, Any]],
        conns: list[Any],
    ) -> None:
        payload: dict[str, Any] = {
            "event": "deliver_files",
            "chat_id": chat_id,
            "files": files,
        }
        self._try_append_webui_transcript(chat_id, payload)
        raw = json.dumps(payload, ensure_ascii=False)
        self.logger.debug(
            "deliver_files: sending to {} subscribers for chat_id={}, files={}",
            len(conns), chat_id, [f.get("name") for f in files],
        )
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" ")

    async def send(self, msg: OutboundMessage) -> None:
        if msg.metadata.get("_runtime_model_updated"):
            await self.send_runtime_model_updated(
                model_name=msg.metadata.get("model"),
                model_preset=msg.metadata.get("model_preset"),
            )
            return

        # Snapshot the subscriber set so ConnectionClosed cleanups mid-iteration are safe.
        conns = list(self._subs.get(msg.chat_id, ()))
        if not conns:
            if (
                msg.metadata.get("_progress")
                or msg.metadata.get("_file_edit_events")
                or msg.metadata.get("_turn_end")
                or msg.metadata.get("_session_updated")
                or msg.metadata.get("_goal_status")
                or msg.metadata.get("_goal_state_sync")
                or msg.metadata.get("_deliver_files")
            ):
                self.logger.debug("no active subscribers for chat_id={}", msg.chat_id)
            else:
                self.logger.warning("no active subscribers for chat_id={}", msg.chat_id)
            return
        if msg.metadata.get("_goal_state_sync"):
            blob = msg.metadata.get("goal_state")
            await self.send_goal_state(msg.chat_id, blob if isinstance(blob, dict) else {"active": False})
            return
        if msg.metadata.get("_goal_status"):
            status = msg.metadata.get("goal_status")
            if status in ("running", "idle"):
                started_raw = msg.metadata.get("started_at", msg.metadata.get("goal_started_at"))
                await self.send_goal_status(
                    msg.chat_id,
                    status,
                    started_at=float(started_raw) if isinstance(started_raw, int | float) else None,
                )
            return
        # Signal that the agent has fully finished processing the current turn.
        if msg.metadata.get("_turn_end"):
            lat = msg.metadata.get("latency_ms")
            lat_i = int(lat) if isinstance(lat, (int, float)) else None
            gs = msg.metadata.get("goal_state")
            gs_blob = gs if isinstance(gs, dict) else None
            await self.send_turn_end(msg.chat_id, latency_ms=lat_i, goal_state=gs_blob)
            return
        if msg.metadata.get("_session_updated"):
            scope = msg.metadata.get("_session_update_scope")
            await self.send_session_updated(
                msg.chat_id,
                scope=scope if isinstance(scope, str) else None,
            )
            return
        if msg.metadata.get("_file_edit_events"):
            payload: dict[str, Any] = {
                "event": "file_edit",
                "chat_id": msg.chat_id,
                "edits": msg.metadata["_file_edit_events"],
            }
            self._try_append_webui_transcript(msg.chat_id, payload)
            raw = json.dumps(payload, ensure_ascii=False)
            for connection in conns:
                await self._safe_send_to(connection, raw, label=" ")
            return
        deliver_files_raw = msg.metadata.get("_deliver_files")
        deliver_files = deliver_files_raw if isinstance(deliver_files_raw, list) else []
        if deliver_files and not msg.content and not msg.media:
            await self._send_deliver_files_event(msg.chat_id, deliver_files, conns)
            return
        text = msg.content
        payload: dict[str, Any] = {
            "event": "message",
            "chat_id": msg.chat_id,
            "text": text,
        }
        # Multi-agent phase 0: every assistant message names its author.
        # Senders without an explicit author_id default to the reserved Mona
        # agent; older clients simply ignore the unknown fields.
        author_id = msg.metadata.get("author_id")
        payload["author_id"] = (
            author_id if isinstance(author_id, str) and author_id else MONA_AGENT_ID
        )
        message_type = msg.metadata.get("message_type")
        if isinstance(message_type, str) and message_type:
            payload["message_type"] = message_type
        # Schedule reminders carry a flag so webui clients can fire a native
        # system notification in addition to rendering the message bubble.
        if msg.metadata.get("_schedule_reminder"):
            payload["schedule_reminder"] = True
            item_id = msg.metadata.get("schedule_item_id")
            if item_id:
                payload["schedule_item_id"] = item_id
        if msg.media:
            payload["media"] = msg.media
            urls: list[dict[str, str]] = []
            for entry in msg.media:
                signed = self._sign_or_stage_media_path(Path(entry))
                if signed is not None:
                    urls.append(signed)
            if urls:
                payload["media_urls"] = urls
        if msg.reply_to:
            payload["reply_to"] = msg.reply_to
        lat = msg.metadata.get("latency_ms")
        if isinstance(lat, (int, float)):
            payload["latency_ms"] = int(lat)
        if msg.metadata.get("_tool_events"):
            payload["tool_events"] = msg.metadata["_tool_events"]
        agent_ui = msg.metadata.get(OUTBOUND_META_AGENT_UI)
        if agent_ui is not None:
            payload["agent_ui"] = agent_ui
        # Mark intermediate agent breadcrumbs (tool-call hints, generic
        # progress strings) so WS clients can render them as subordinate
        # trace rows rather than conversational replies.
        if msg.metadata.get("_tool_hint"):
            payload["kind"] = "tool_hint"
        elif msg.metadata.get("_progress"):
            payload["kind"] = "progress"
        self._try_append_webui_transcript(msg.chat_id, payload)
        raw = json.dumps(payload, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" ")
        if deliver_files:
            await self._send_deliver_files_event(msg.chat_id, deliver_files, conns)

    async def send_reasoning_delta(
        self,
        chat_id: str,
        delta: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Push one chunk of model reasoning. Mirrors ``send_delta`` shape so
        clients receive a stream that opens, updates in place, and closes —
        rendered above the active assistant bubble with a shimmer header
        until the matching ``reasoning_end`` arrives.
        """
        conns = list(self._subs.get(chat_id, ()))
        if not conns or not delta:
            return
        meta = metadata or {}
        body: dict[str, Any] = {
            "event": "reasoning_delta",
            "chat_id": chat_id,
            "text": delta,
        }
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            body["stream_id"] = stream_id
        self._try_append_webui_transcript(chat_id, body)
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" reasoning ")

    async def send_reasoning_end(
        self,
        chat_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Close the current reasoning stream segment for in-place renderers."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        meta = metadata or {}
        body: dict[str, Any] = {
            "event": "reasoning_end",
            "chat_id": chat_id,
        }
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            body["stream_id"] = stream_id
        self._try_append_webui_transcript(chat_id, body)
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" reasoning_end ")

    async def send_delta(
        self,
        chat_id: str,
        delta: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        meta = metadata or {}
        if meta.get("_stream_end"):
            body: dict[str, Any] = {"event": "stream_end", "chat_id": chat_id}
        else:
            body = {
                "event": "delta",
                "chat_id": chat_id,
                "text": delta,
            }
            # Streaming frames carry the author too (guide 5.3); the stream
            # cursor stays chat-scoped until parallel streams land.
            author_id = meta.get("author_id")
            body["author_id"] = (
                author_id if isinstance(author_id, str) and author_id else MONA_AGENT_ID
            )
        if meta.get("_stream_id") is not None:
            body["stream_id"] = meta["_stream_id"]
        self._try_append_webui_transcript(chat_id, body)
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" stream ")

    async def send_turn_end(
        self,
        chat_id: str,
        latency_ms: int | None = None,
        *,
        goal_state: dict[str, Any] | None = None,
    ) -> None:
        """Signal that the agent has fully finished processing the current turn."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "turn_end", "chat_id": chat_id}
        if latency_ms is not None:
            body["latency_ms"] = int(latency_ms)
        if goal_state is not None:
            body["goal_state"] = goal_state
        self._try_append_webui_transcript(chat_id, body)
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" turn_end ")

    def _cleanup_ephemeral_session(self, chat_id: str) -> None:
        if self._session_manager is None:
            return
        session_key = f"websocket:{chat_id}"
        self._session_manager.delete_session(session_key)
        self._subs.pop(chat_id, None)
        logger.debug("Cleaned up ephemeral session {}", session_key)

    async def send_goal_state(self, chat_id: str, blob: dict[str, Any]) -> None:
        """Push persisted goal-state snapshot for *chat_id* (multi-chat isolation)."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body = {"event": "goal_state", "chat_id": chat_id, "goal_state": blob}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" goal_state ")

    async def send_goal_status(
        self,
        chat_id: str,
        status: str,
        *,
        started_at: float | None = None,
    ) -> None:
        """Notify subscribed clients that a turn started or finished (wall-clock hint)."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {
            "event": "goal_status",
            "chat_id": chat_id,
            "status": status,
        }
        if status == "running" and started_at is not None:
            body["started_at"] = started_at
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" goal_status ")

    async def send_session_updated(self, chat_id: str, *, scope: str | None = None) -> None:
        """Notify clients that session metadata changed outside the main turn."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "session_updated", "chat_id": chat_id}
        if scope:
            body["scope"] = scope
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" session_updated ")

    async def send_room_updated(self, chat_id: str, payload: dict[str, Any]) -> None:
        """Broadcast the current room state to every connection attached to *chat_id*."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "room_updated", "chat_id": chat_id, **payload}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" room_updated ")

    async def send_artifacts_changed(self) -> None:
        """Broadcast a shared-output change hint to every open websocket connection."""
        conns = list(self._conn_chats)
        if not conns:
            return
        raw = json.dumps({"event": "artifacts_changed"}, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" artifacts_changed ")

    async def send_runtime_model_updated(
        self,
        *,
        model_name: Any,
        model_preset: Any = None,
    ) -> None:
        """Broadcast runtime model changes to every open websocket connection."""
        conns = list(self._conn_chats)
        if not conns or not isinstance(model_name, str) or not model_name.strip():
            return
        body: dict[str, Any] = {
            "event": "runtime_model_updated",
            "model_name": model_name.strip(),
        }
        if isinstance(model_preset, str) and model_preset.strip():
            body["model_preset"] = model_preset.strip()
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" runtime_model_updated ")
