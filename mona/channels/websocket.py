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
from datetime import datetime
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
from mona.session.task_plan import reset_task_plan, task_plan_ws_blob
from mona.session.webui_turns import websocket_turn_wall_started_at
from mona.utils.helpers import safe_filename
from mona.utils.media_decode import (
    FileSizeExceeded,
    save_base64_data_url,
)
from mona.utils.subagent_channel_display import scrub_subagent_messages_for_channel
from mona.webui.settings_api import (
    WebUISettingsError,
    probe_provider_models,
    settings_payload,
    update_agent_settings,
    update_channel_settings,
    update_image_generation_settings,
    update_provider_settings,
    update_stock_settings,
    update_tts_settings,
    update_video_generation_settings,
    update_web_search_settings,
)
from mona.webui.sidebar_state import (
    read_webui_sidebar_state,
    remove_webui_sidebar_session,
    write_webui_sidebar_state,
)
from mona.webui.thread_disk import delete_webui_thread
from mona.webui.transcript import append_transcript_object, build_webui_thread_response

if TYPE_CHECKING:
    from mona.session.manager import SessionManager


async def _has_subscription_access() -> bool:
    try:
        from mona.agent.tools.tauri_ipc import check_subscription_access

        return bool(await asyncio.to_thread(check_subscription_access))
    except Exception as exc:
        logger.debug("subscription access check failed, failing closed: {}", exc)
        return False


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
            (
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization, X-Mona-Provider-Key",
            ),
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
    bus.outbound.put_nowait(
        OutboundMessage(
            channel="websocket",
            chat_id="*",
            content="",
            metadata={
                "_runtime_model_updated": True,
                "model": model,
                "model_preset": model_preset,
            },
        )
    )


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
_ARTIFACT_TASK_STATE_KEY = "artifact_task"
_ARTIFACT_TASK_SKIP_DIRS = frozenset(
    {
        "node_modules",
        "__pycache__",
        "dist",
        "build",
        "target",
        "venv",
    }
)

# Image MIME whitelist — matches the Composer's ``accept`` list. SVG is
# explicitly excluded to avoid the XSS surface inside embedded scripts.
_IMAGE_MIME_ALLOWED: frozenset[str] = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    }
)

_VIDEO_MIME_ALLOWED: frozenset[str] = frozenset(
    {
        "video/mp4",
        "video/webm",
        "video/quicktime",
    }
)

_UPLOAD_MIME_ALLOWED: frozenset[str] = _IMAGE_MIME_ALLOWED | _VIDEO_MIME_ALLOWED

_PPT_DOC_MIME_ALLOWED: frozenset[str] = frozenset(
    {
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
)
_PPT_DOC_MAX_BYTES = 20 * 1024 * 1024

# Conversation attachments are persisted as workspace files and then passed to
# the Agent by path. Their format is intentionally unrestricted.
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

# PPT project lifecycle phases pushed to clients via ``ppt_phase_changed``.
_PPT_PHASES = frozenset({"generating", "outline", "producing", "exporting", "done"})

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
        (
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Mona-Provider-Key",
        ),
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
_MEDIA_ALLOWED_MIMES: frozenset[str] = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "video/mp4",
        "video/webm",
        "video/quicktime",
    }
)

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

    svg_count = len(list(svg_output_dir.glob("*.svg"))) if svg_output_dir.is_dir() else 0
    svg_final_count = len(list(svg_final_dir.glob("*.svg"))) if svg_final_dir.is_dir() else 0
    # New pipeline: output/output.pptx
    output_pptx = output_dir / "output.pptx"
    has_output_pptx = output_pptx.is_file()
    # New pipeline: preview images in output/preview/ (e.g. slide_1.png)
    preview_dir = output_dir / "preview"
    output_image_count = len(list(preview_dir.glob("slide_*.png"))) if preview_dir.is_dir() else 0
    # Also check output/ directly for legacy preview images
    if output_image_count == 0:
        output_image_count = len(list(output_dir.glob("slide_*.png"))) if output_dir.is_dir() else 0
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
        "exportFile": pptx_files[0].name
        if pptx_files
        else ("output.pptx" if has_output_pptx else None),
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
        from mona.config.paths import get_workspace_path

        manager_workspace = getattr(session_manager, "workspace", None)
        self.workspace = (
            Path(manager_workspace).expanduser().resolve()
            if isinstance(manager_workspace, (str, Path))
            else get_workspace_path()
        )
        self._subagent_manager = subagent_manager
        if subagent_manager is not None:
            # Tool-proposed workflow drafts surface as workflow_updated pushes.
            subagent_manager.workflow_draft_observer = self._on_workflow_draft_proposed
            # Run state changes surface as workflow_run_updated pushes; the
            # hook also emits approval_requested for pending approval steps.
            subagent_manager.workflow_run_observer = self._on_workflow_run_updated
            subagent_manager.session_activity_observer = self._on_subagent_session_activity
        self._static_dist_path: Path | None = (
            static_dist_path.resolve() if static_dist_path is not None else None
        )
        # chat_id -> asyncio.Task driving the room's active run loop
        self._workflow_tasks: dict[str, asyncio.Task] = {}
        # run_id -> notified waiting-approval signature (dedupe approval_requested)
        self._approval_notified: dict[str, str] = {}
        # run_id -> last run-level status that triggered a session_updated push
        # (IM plan 11.5: list attention state follows persisted run status).
        self._run_status_notified: dict[str, str] = {}
        # run_id -> step_id -> last observed step status. Seeded on the first
        # observed payload per run so steps that went terminal before this
        # process watched the run (gateway restart mid-run) never re-post
        # their conversation message.
        self._run_step_message_state: dict[str, dict[str, Any]] = {}
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
        """Replay running state for a main turn or room/direct-chat agent job."""
        await self._send_combined_goal_status(chat_id, "running")

    def _on_subagent_session_activity(
        self,
        session_key: str,
        running: bool,
        started_at: float | None,
    ) -> None:
        prefix = "websocket:"
        if not session_key.startswith(prefix):
            return
        chat_id = session_key[len(prefix) :]
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        asyncio.create_task(
            self._send_combined_goal_status(
                chat_id,
                "running" if running else "idle",
                started_at=started_at,
            )
        )

    async def _send_combined_goal_status(
        self,
        chat_id: str,
        status: str,
        *,
        started_at: float | None = None,
    ) -> None:
        main_started = websocket_turn_wall_started_at(chat_id)
        session_key = f"websocket:{chat_id}"
        subagent_started = None
        subagents_running = 0
        if self._subagent_manager is not None:
            get_count = getattr(self._subagent_manager, "get_running_count_by_session", None)
            get_started = getattr(self._subagent_manager, "get_session_started_at", None)
            if callable(get_count):
                subagents_running = int(get_count(session_key) or 0)
            if callable(get_started):
                subagent_started = get_started(session_key)

        active_starts = [
            value
            for value in (main_started, subagent_started, started_at)
            if isinstance(value, (int, float))
        ]
        if status == "running":
            if not active_starts:
                return
            await self.send_goal_status(chat_id, "running", started_at=min(active_starts))
            return
        if main_started is not None or subagents_running > 0:
            return
        await self.send_goal_status(chat_id, "idle")

    async def _maybe_push_artifact_task(self, chat_id: str) -> None:
        state = self._artifact_task_state(f"websocket:{chat_id}")
        task_id = state.get("id") if state else None
        if isinstance(task_id, str) and task_id:
            await self.send_artifact_task_started(chat_id, task_id)

    async def _maybe_push_task_plan(self, chat_id: str) -> None:
        if self._session_manager is None:
            return
        row = self._session_manager.read_session_file(f"websocket:{chat_id}")
        metadata = row.get("metadata", {}) if isinstance(row, dict) else {}
        blob = task_plan_ws_blob(metadata if isinstance(metadata, dict) else {})
        if blob is not None:
            await self.send_task_plan(chat_id, blob)

    async def _hydrate_after_subscribe(self, chat_id: str) -> None:
        """Replay goal/run strip state after subscribe (same-process refresh)."""
        await self._maybe_push_active_goal_state(chat_id)
        await self._maybe_push_turn_run_wall_clock(chat_id)
        await self._maybe_push_artifact_task(chat_id)
        await self._maybe_push_task_plan(chat_id)
        await self.send_artifacts_changed(chat_id=chat_id)

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

        return _http_json_response({"token": token_value, "expires_in": self.config.token_ttl_s})

    # -- HTTP dispatch ------------------------------------------------------

    async def _dispatch_http(self, connection: Any, request: WsRequest) -> Any:
        """Route an inbound HTTP request to a handler or to the WS upgrade path."""
        got, query = _parse_request_path(request.path)
        return await self._dispatch_http_inner(connection, request, got, query)

    async def _dispatch_http_inner(
        self, connection: Any, request: WsRequest, got: str, query: list[tuple[str, str]]
    ) -> Any:

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

        if got.startswith("/api/agents/"):
            return self._handle_agent_management_get(request, got)

        if got == "/api/experts/catalog":
            return await self._handle_expert_catalog(request)

        if got == "/api/experts/install/start":
            return self._handle_expert_install_start(request)

        if got == "/api/experts/install/status":
            return self._handle_expert_install_status(request)

        if got == "/api/experts/install/cancel":
            return await self._handle_expert_install_cancel(request)

        if got == "/api/runtimes/status":
            return await self._handle_runtime_status(request)

        if got == "/api/runtimes/install/start":
            return await self._handle_runtime_install_start(request)

        if got == "/api/runtimes/install/required":
            return await self._handle_runtime_install_required(request)

        if got == "/api/runtimes/install/status":
            return self._handle_runtime_install_status(request)

        if got == "/api/runtimes/install/cancel":
            return await self._handle_runtime_install_cancel(request)

        if got == "/api/runtimes/settings/update":
            return self._handle_runtime_settings_update(request)

        if got == "/api/runtimes/cleanup":
            return self._handle_runtime_cleanup(request)

        if got.startswith("/api/agent-change-proposals/"):
            return self._handle_agent_change_proposal_get(request, got)

        if got == "/api/settings":
            return self._handle_settings(request)

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

        if got == "/api/settings/stock/update":
            return self._handle_settings_stock_update(request)

        if got == "/api/channels/weixin/login/start":
            return self._handle_weixin_login_start(request)

        if got == "/api/channels/weixin/login/status":
            return self._handle_weixin_login_status(request)

        if got == "/api/channels/weixin/login/cancel":
            return self._handle_weixin_login_cancel(request)

        if got == "/api/channels/weixin/logout":
            return self._handle_weixin_logout(request)

        pro_document_http = (
            got.startswith("/api/ppt") and got != "/api/ppt/broadcast-phase"
        ) or got in {"/api/video/download", "/api/video/delete-project"}
        if pro_document_http and not await _has_subscription_access():
            return _http_json_response(
                {
                    "error": "membership_required",
                    "detail": "AI文档需要有效的 Mona Pro 订阅或试用",
                },
                status=403,
            )

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
            return await self._handle_ppt_mark_generating(request)

        if got == "/api/ppt/save-chat-id":
            return await self._handle_ppt_save_chat_id(request)

        if got == "/api/ppt/broadcast-phase":
            return await self._handle_ppt_broadcast_phase(connection, request)

        if got == "/api/video/broadcast-change":
            return await self._handle_video_broadcast_change(connection, request)

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
                room=_query_first(query, "room") or "",
                artifact_id=_query_first(query, "artifact_id") or "",
            )

        if got == "/api/artifacts":
            return self._handle_artifacts_list(request)

        if got == "/api/artifact-rename":
            return self._handle_artifact_rename(request)

        # Stock module report queries (design §10.2, dev plan T16). Detail
        # matches by document content, never by path — see reports.py.
        if got == "/api/stock/reports":
            return self._handle_stock_reports(request)

        if got.startswith("/api/stock/reports/"):
            return self._handle_stock_report_detail(request, got[len("/api/stock/reports/") :])

        # Manual report cleanup (design §9). A GET here follows the channel's
        # process_request constraint (no reliable POST body), same as the
        # video delete-project route.
        if got == "/api/stock/report-delete":
            return self._handle_stock_report_delete(request)

        if got == "/api/stock/dashboard":
            return self._handle_stock_dashboard(request)

        if got == "/api/project-files":
            return self._handle_project_files_list(request, _query_first(query, "key") or "")

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
        token = _bearer_token(request.headers) or _query_first(_parse_query(request.path), "token")
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
            workspace_path = self.workspace
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
            # Hidden rooms (stock-module design §4.4) are invisible execution
            # containers — never listed in the sidebar, same discipline as the
            # video/PPT-owned chats above.
            conversation = s.get("conversation")
            if isinstance(conversation, dict) and conversation.get("hidden") is True:
                continue
            row = {k: v for k, v in s.items() if k != "path"}
            started_at = websocket_turn_wall_started_at(chat_id)
            if started_at is not None:
                row["run_started_at"] = started_at
            cleaned.append(row)
        # IM list attention state (IM plan 12.1): workflow run status,
        # waiting-approval and scheduled come from persisted workflow state,
        # batched per workspace root so runs are not rescanned per room.
        room_chat_ids = [
            row["key"].split(":", 1)[1]
            for row in cleaned
            if isinstance(row.get("conversation"), dict)
            and row["conversation"].get("type") == "room"
        ]
        attention = (
            self._subagent_manager.workflow_attention_for_rooms(room_chat_ids)
            if room_chat_ids and self._subagent_manager is not None
            else {}
        )
        for row in cleaned:
            chat_id = row["key"].split(":", 1)[1]
            state = attention.get(chat_id)
            if state is None:
                row["workflow_run_status"] = None
                row["waiting_approval"] = False
                row["scheduled"] = False
            else:
                row["workflow_run_status"] = state["workflow_run_status"]
                row["waiting_approval"] = state["waiting_approval"]
                row["scheduled"] = state["scheduled"]
        return _http_json_response({"sessions": cleaned})

    def _handle_agents_list(self, request: WsRequest) -> Response:
        """List all loaded agents (multi-agent phase 2d).

        Broken installed manifests are skipped at registry load time. User
        configuration is resolved here so the session list can show the same
        name/state that the runtime will use on its next turn.
        """
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        registry = self._room_agent_registry()
        agents = [self._agent_summary(definition) for definition in registry.list_agents()]
        return _http_json_response({"agents": agents})

    def _expert_install_job_manager(self) -> Any:
        manager = getattr(self, "_expert_jobs", None)
        if manager is None:
            from mona.agent.official_experts import build_official_expert_jobs

            manager = build_official_expert_jobs(
                registry=self._room_agent_registry(),
                workspace=self.workspace,
                bus=self.bus,
                subagent_manager=self._subagent_manager,
                sessions=self._session_manager,
            )
            self._expert_jobs = manager
        return manager

    async def _handle_expert_catalog(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            payload = await self._expert_install_job_manager().catalog_payload()
        except Exception as exc:
            self.logger.warning("expert catalog unavailable: {}", exc)
            return _http_json_response(
                {
                    "schemaVersion": 1,
                    "generatedAt": None,
                    "source": "unavailable",
                    "stale": False,
                    "installEnabled": False,
                    "installUnavailableReason": "official_catalog_unavailable",
                    "experts": [],
                }
            )
        return _http_json_response(payload)

    def _handle_expert_install_start(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        expert_id = (_query_first(query, "expert_id") or "").strip()
        version = (_query_first(query, "version") or "").strip() or None
        try:
            job = self._expert_install_job_manager().start(expert_id, version)
        except ValueError as exc:
            return _http_error(400, str(exc))
        except Exception as exc:
            from mona.agent.expert_jobs import ExpertInstallUnavailableError

            if isinstance(exc, ExpertInstallUnavailableError):
                return _http_error(503, str(exc))
            self.logger.exception("failed to start expert install")
            return _http_error(500, "无法启动专家安装")
        return _http_json_response(
            {"ok": True, "job": job.model_dump(by_alias=True, mode="json")},
            status=202,
        )

    def _handle_expert_install_status(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        job_id = (_query_first(_parse_query(request.path), "job_id") or "").strip()
        manager = self._expert_install_job_manager()
        try:
            if job_id:
                job = manager.get(job_id)
                return _http_json_response({"job": job.model_dump(by_alias=True, mode="json")})
            return _http_json_response(
                {"jobs": [job.model_dump(by_alias=True, mode="json") for job in manager.list()]}
            )
        except KeyError:
            return _http_error(404, "expert install job not found")

    async def _handle_expert_install_cancel(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        job_id = (_query_first(_parse_query(request.path), "job_id") or "").strip()
        if not job_id:
            return _http_error(400, "job_id is required")
        try:
            job = await self._expert_install_job_manager().cancel(job_id)
        except KeyError:
            return _http_error(404, "expert install job not found")
        except ValueError as exc:
            return _http_error(409, str(exc))
        return _http_json_response({"ok": True, "job": job.model_dump(by_alias=True, mode="json")})

    def _runtime_install_job_manager(self) -> Any:
        manager = getattr(self, "_runtime_jobs", None)
        if manager is None:
            from mona.runtime.official import get_official_runtime_jobs

            manager = get_official_runtime_jobs()
            self._runtime_jobs = manager
        return manager

    async def _handle_runtime_status(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            payload = await self._runtime_install_job_manager().status_payload()
        except Exception as exc:
            self.logger.warning("runtime catalog unavailable: {}", exc)
            return _http_error(503, "运行环境目录暂时不可用，请检查网络后重试")
        return _http_json_response(payload)

    async def _handle_runtime_install_start(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        component = (_query_first(query, "component") or "").strip()
        repair = (_query_first(query, "repair") or "false").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        try:
            job = await self._runtime_install_job_manager().start(component, repair=repair)
        except ValueError as exc:
            return _http_error(400, str(exc))
        except Exception as exc:
            from mona.runtime.jobs import RuntimeInstallUnavailableError

            if isinstance(exc, RuntimeInstallUnavailableError):
                return _http_error(503, str(exc))
            self.logger.exception("failed to start runtime install")
            return _http_error(500, "无法启动运行环境安装")
        return _http_json_response(
            {"ok": True, "job": job.model_dump(by_alias=True, mode="json")},
            status=202,
        )

    async def _handle_runtime_install_required(self, request: WsRequest) -> Response:
        """Start a feature-required download on the Gateway-owned manager."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        component = (_query_first(_parse_query(request.path), "component") or "").strip()
        try:
            job = await self._runtime_install_job_manager().start_required(component)
        except ValueError as exc:
            return _http_error(400, str(exc))
        except Exception as exc:
            from mona.runtime.jobs import (
                RuntimeAutoDownloadDisabledError,
                RuntimeInstallUnavailableError,
            )

            if isinstance(exc, RuntimeAutoDownloadDisabledError):
                return _http_error(409, str(exc))
            if isinstance(exc, RuntimeInstallUnavailableError):
                return _http_error(503, str(exc))
            self.logger.exception("failed to start required runtime install")
            return _http_error(500, "无法启动功能资源下载")
        return _http_json_response(
            {"ok": True, "job": job.model_dump(by_alias=True, mode="json")},
            status=202,
        )

    def _handle_runtime_install_status(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        job_id = (_query_first(_parse_query(request.path), "job_id") or "").strip()
        manager = self._runtime_install_job_manager()
        try:
            if job_id:
                job = manager.get(job_id)
                return _http_json_response({"job": job.model_dump(by_alias=True, mode="json")})
            return _http_json_response(
                {"jobs": [job.model_dump(by_alias=True, mode="json") for job in manager.list()]}
            )
        except KeyError:
            return _http_error(404, "runtime install job not found")

    async def _handle_runtime_install_cancel(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        job_id = (_query_first(_parse_query(request.path), "job_id") or "").strip()
        if not job_id:
            return _http_error(400, "job_id is required")
        try:
            job = await self._runtime_install_job_manager().cancel(job_id)
        except KeyError:
            return _http_error(404, "runtime install job not found")
        except ValueError as exc:
            return _http_error(409, str(exc))
        return _http_json_response({"ok": True, "job": job.model_dump(by_alias=True, mode="json")})

    def _handle_runtime_settings_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        if "auto_download" not in query and "autoDownload" not in query:
            return _http_error(400, "auto_download is required")
        try:
            payload = update_agent_settings(query)
        except WebUISettingsError as exc:
            return _http_error(exc.status, exc.message)
        return _http_json_response(
            {"ok": True, "autoDownload": payload["runtime"]["auto_download"]}
        )

    def _handle_runtime_cleanup(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            result = self._runtime_install_job_manager().cleanup()
        except ValueError as exc:
            return _http_error(409, str(exc))
        return _http_json_response({"ok": True, **result})

    @staticmethod
    def _agent_summary(definition: Any) -> dict[str, Any]:
        from mona.agent.user_config import load_agent_user_config, resolve_effective_agent_config

        config = load_agent_user_config(definition.id)
        effective = resolve_effective_agent_config(definition, config)
        return {
            "id": definition.id,
            "displayName": effective.display_name,
            "avatarUrl": effective.avatar,
            "enabled": effective.enabled,
            "visibility": definition.visibility,
            "packageId": definition.package_id,
            "packageVersion": definition.package_version,
            "configRevision": config.revision,
        }

    def _handle_agent_management_get(self, request: WsRequest, path: str) -> Response:
        """Read-only Agent management endpoints served beside the WebSocket."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        parts = path.split("/")
        # /api/agents/<id>[/instructions[/<key>[/history]]|/skills|/proposals]
        if len(parts) < 4 or not parts[3]:
            return _http_error(404, "Not Found")
        from mona.agent.partners import normalize_agent_id

        try:
            agent_id = normalize_agent_id(parts[3])
        except ValueError:
            return _http_error(400, "invalid agent id")
        registry = self._room_agent_registry()
        definition = registry.get(agent_id)
        if definition is None:
            return _http_error(404, "agent not found")
        suffix = parts[4:]
        try:
            if not suffix:
                from mona.agent.agent_management import agent_data_summary, agent_tool_catalog
                from mona.agent.user_config import (
                    load_agent_user_config,
                    resolve_effective_agent_config,
                )

                config = load_agent_user_config(agent_id)
                return _http_json_response(
                    {
                        "agent": self._agent_summary(definition),
                        "definition": {
                            "id": definition.id,
                            "model": definition.model,
                            "toolAllowlist": definition.tool_allowlist,
                            "canDelegate": definition.can_delegate,
                            "skills": definition.skills,
                            "packageId": definition.package_id,
                            "packageVersion": definition.package_version,
                        },
                        "config": config.model_dump(by_alias=True),
                        "effective": resolve_effective_agent_config(definition, config).model_dump(
                            by_alias=True
                        ),
                        "data": agent_data_summary(agent_id),
                        "toolCatalog": agent_tool_catalog(
                            definition,
                            workspace=self.workspace,
                            bus=self.bus,
                            subagent_manager=self._subagent_manager,
                            sessions=self._session_manager,
                        ),
                    }
                )
            if suffix == ["instructions"]:
                from mona.agent.agent_management import list_instructions

                return _http_json_response({"instructions": list_instructions(agent_id)})
            if len(suffix) == 2 and suffix[0] == "instructions":
                from mona.agent.agent_management import read_instruction

                return _http_json_response({"instruction": read_instruction(agent_id, suffix[1])})
            if len(suffix) == 3 and suffix[0] == "instructions" and suffix[2] == "history":
                from mona.agent.agent_management import instruction_history

                return _http_json_response({"history": instruction_history(agent_id, suffix[1])})
            if suffix == ["skills"]:
                from mona.agent.agent_management import SkillManager

                return _http_json_response(
                    {"skills": SkillManager(agent_id, registry=registry).list()}
                )
            if len(suffix) == 2 and suffix[0] == "skills":
                from mona.agent.agent_management import SkillManager

                return _http_json_response(
                    {"skill": SkillManager(agent_id, registry=registry).read(suffix[1])}
                )
            if suffix == ["proposals"]:
                from mona.agent.agent_management import list_change_proposals

                return _http_json_response({"proposals": list_change_proposals(agent_id)})
        except ValueError as exc:
            return _http_error(400, str(exc))
        return _http_error(404, "Not Found")

    def _handle_agent_change_proposal_get(self, request: WsRequest, path: str) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        proposal_id = path.rsplit("/", 1)[-1]
        agent_id = _query_first(_parse_query(request.path), "agent_id")
        if not agent_id:
            return _http_error(400, "agent_id is required")
        try:
            from mona.agent.agent_management import get_change_proposal

            return _http_json_response({"proposal": get_change_proposal(agent_id, proposal_id)})
        except ValueError as exc:
            return _http_error(400, str(exc))

    def _handle_settings(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response(self._with_settings_restart_state(settings_payload()))

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
        # Seed data for the one-time sidebar-state migration: existing
        # sessions start read at their current preview while genuine markers
        # remain untouched.
        return _http_json_response(
            read_webui_sidebar_state(session_preview_at=self._session_preview_at_by_key())
        )

    def _session_preview_at_by_key(self) -> dict[str, str]:
        if self._session_manager is None:
            return {}
        try:
            rows = self._session_manager.list_sessions()
        except Exception:
            self.logger.exception("failed to list sessions for sidebar state migration")
            return {}
        out: dict[str, str] = {}
        for row in rows:
            key = row.get("key")
            preview_at = row.get("preview_at")
            if isinstance(key, str) and isinstance(preview_at, str) and preview_at:
                out[key] = preview_at
        return out

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
        return _http_json_response(self._with_settings_restart_state(payload, section="runtime"))

    def _handle_settings_provider_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        provider_key = request.headers.get("X-Mona-Provider-Key")
        if provider_key is not None:
            # Header wins for new clients; query remains a compatibility path
            # for older WebUI builds and is never used by the current client.
            query["api_key"] = [provider_key]
        try:
            payload = update_provider_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="providers"))

    async def _handle_settings_provider_models(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        provider_name = (_query_first(query, "provider") or "").strip()
        if not provider_name:
            return _http_error(400, "provider is required")
        # Allow callers to override api_key / api_base (e.g. when the user is
        # editing the form but hasn't saved yet). Fall back to saved config.
        api_key = request.headers.get("X-Mona-Provider-Key")
        if api_key is None:
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
        return _http_json_response(self._with_settings_restart_state(payload, section="providers"))

    def _handle_settings_video_generation_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_video_generation_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload, section="providers"))

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

    def _handle_settings_stock_update(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        # The review cron lives on the agent runtime's CronService, reached
        # through the subagent manager (cli/commands.py wires it there).
        cron_service = (
            getattr(self._subagent_manager, "cron_service", None)
            if self._subagent_manager is not None
            else None
        )

        def _bootstrap(stock) -> None:
            """Idempotent pack bootstrap on enable (stock-module T21)."""
            if self._session_manager is None or self._subagent_manager is None:
                return
            try:
                from mona.agent.pack_bootstrap import STOCK_ROOM_ID, ensure_stock_pack
                from mona.agent.partners import AgentRegistry

                ensure_stock_pack(
                    self._session_manager,
                    self._subagent_manager.workflow_store_for_room(STOCK_ROOM_ID),
                    cron_service,
                    AgentRegistry(),
                    review_time=stock.review_time,
                    enabled=True,
                    auto_review_enabled=stock.auto_review_enabled,
                )
            except Exception:
                logger.exception("Stock pack bootstrap failed")

        try:
            payload = update_stock_settings(query, cron_service=cron_service, bootstrap=_bootstrap)
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

            return _http_json_response(
                {
                    "state": "idle",
                    "logged_in": WeixinLoginSession.has_saved_token(),
                }
            )
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
            brands_index = skill_dir / "scripts" / "templates_full" / "brands" / "brands_index.json"

            templates = []
            if layouts_index.exists():
                raw = json.loads(layouts_index.read_text(encoding="utf-8"))
                for key, info in raw.items():
                    templates.append(
                        {
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
                        }
                    )

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
                    templates.append(
                        {
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
                        }
                    )

            # --- Native templates ---
            native_index = skill_dir / "scripts" / "templates_full" / "native" / "native_index.json"
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
                    templates.append(
                        {
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
                        }
                    )

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

            return _http_json_response(
                {
                    "templates": templates,
                    "canvasFormats": canvas_formats,
                }
            )
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
                    if candidate.exists() and str(candidate).startswith(str(base_dir.resolve())):
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

    _PPT_SOURCE_SUFFIXES = frozenset(
        {
            ".md",
            ".txt",
            ".pdf",
            ".doc",
            ".docx",
            ".pptx",
            ".csv",
            ".json",
            ".xls",
            ".xlsx",
        }
    )

    def _handle_ppt_add_sources(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            workspace = self.workspace
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
                        added.append(
                            {
                                "name": src.name,
                                "path": str(rel).replace("\\", "/"),
                            }
                        )
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
                        added.append(
                            {
                                "name": rel_src.as_posix(),
                                "path": str(rel).replace("\\", "/"),
                            }
                        )

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

            query = _parse_query(request.path)
            url = _query_first(query, "url") or ""
            project_name = _query_first(query, "project") or ""

            if not url:
                return _http_error(400, "url is required")
            if not url.startswith("http://") and not url.startswith("https://"):
                return _http_error(400, "url must start with http:// or https://")

            workspace = self.workspace
            script = BUILTIN_SKILLS_DIR / "mona-ppt" / "scripts" / "source_to_md" / "web_to_md.py"

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
                    return _http_json_response(
                        {
                            "ok": True,
                            "file": file_path,
                            "output": result.stdout.strip(),
                        }
                    )
                return _http_json_response({"ok": True, "output": result.stdout.strip()})
            else:
                return _http_json_response(
                    {
                        "ok": False,
                        "error": result.stderr.strip() or result.stdout.strip() or "fetch failed",
                    }
                )
        except subprocess.TimeoutExpired:
            return _http_json_response({"ok": False, "error": "fetch timed out"})
        except Exception as e:
            logger.exception("ppt fetch url error")
            return _http_error(500, str(e))

    def _handle_ppt_projects(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            workspace = self.workspace
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
                projects.append(
                    {
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
                    }
                )

            return _http_json_response({"projects": projects})
        except Exception as e:
            logger.exception("ppt projects error")
            return _http_error(500, str(e))

    def _handle_ppt_download(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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
            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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
            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
            projects_dir = workspace / "ppt_projects"
            project_dir = projects_dir / project_name
            if not project_dir.is_dir():
                # Fallback: prefix match for renamed directories (e.g. init
                # script appended _ppt169_YYYYMMDD to a pre-created placeholder).
                candidates = [
                    d
                    for d in projects_dir.iterdir()
                    if d.is_dir() and d.name.startswith(f"{project_name}_")
                ]
                if len(candidates) == 1:
                    project_dir = candidates[0]
                else:
                    return _http_json_response({"status": "not_found"})

            status_info = _get_ppt_project_status(project_dir)
            return _http_json_response(
                {
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
                }
            )
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
        return _http_json_response(
            {
                "ok": False,
                "code": "OFFICECLI_REMOVED",
                "error": "旧 PPT 模板编辑能力已停止分发",
            },
            status=410,
        )

    def _handle_ppt_generate_preview(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.agent.skills import BUILTIN_SKILLS_DIR

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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
                    len(list(preview_dir.glob("slide_*.png"))) if preview_dir.exists() else 0
                )
                return _http_json_response({"ok": True, "slideCount": slide_count})
            else:
                return _http_json_response(
                    {
                        "ok": False,
                        "error": result.stderr.strip() or result.stdout.strip() or "unknown error",
                    }
                )
        except subprocess.TimeoutExpired:
            return _http_json_response({"ok": False, "error": "preview generation timed out"})
        except Exception as e:
            logger.exception("ppt generate preview error")
            return _http_error(500, str(e))

    async def _push_ppt_phase_from_disk(self, project_dir: Path, project_name: str) -> None:
        """Best-effort PPT phase push derived from disk state.

        Notification must never fail the mutating request; the polling
        project-status APIs remain the fallback.
        """
        try:
            phase = str(_get_ppt_project_status(project_dir).get("phase") or "")
            if phase in _PPT_PHASES:
                await self.broadcast_ppt_phase_changed(project_name, phase)
        except Exception:
            logger.exception("ppt phase broadcast failed")

    async def _handle_ppt_broadcast_phase(self, connection: Any, request: WsRequest) -> Response:
        """Internal trigger letting the services process fan out a PPT phase change.

        Gated like ``/webui/bootstrap``: the configured shared secret when one
        is set, otherwise loopback only.
        """
        secret = self.config.token_issue_secret.strip() or self.config.token.strip()
        if secret:
            if not _issue_route_secret_matches(request.headers, secret):
                return _http_error(401, "Unauthorized")
        elif not _is_localhost(connection):
            return _http_error(403, "ppt broadcast-phase is localhost-only")
        query = _parse_query(request.path)
        project_name = _query_first(query, "project") or ""
        phase = _query_first(query, "phase") or ""
        if not project_name or "/" in project_name or "\\" in project_name or ".." in project_name:
            return _http_error(400, "invalid project name")
        if phase not in _PPT_PHASES:
            return _http_error(400, "invalid phase")
        await self.broadcast_ppt_phase_changed(project_name, phase)
        return _http_json_response({"ok": True})

    async def _handle_video_broadcast_change(self, connection: Any, request: WsRequest) -> Response:
        """Internal trigger letting the services process fan out a video project change.

        Same gating as ``/api/ppt/broadcast-phase``: shared secret when set,
        otherwise loopback only.
        """
        secret = self.config.token_issue_secret.strip() or self.config.token.strip()
        if secret:
            if not _issue_route_secret_matches(request.headers, secret):
                return _http_error(401, "Unauthorized")
        elif not _is_localhost(connection):
            return _http_error(403, "video broadcast-change is localhost-only")
        query = _parse_query(request.path)
        project_name = _query_first(query, "name") or ""
        hint = _query_first(query, "hint") or ""
        if not project_name or "/" in project_name or "\\" in project_name or ".." in project_name:
            return _http_error(400, "invalid project name")
        if hint not in ("", "scenes", "phase", "progress", "status"):
            return _http_error(400, "invalid hint")
        await self.broadcast_video_project_changed(project_name, hint)
        return _http_json_response({"ok": True})

    async def _handle_ppt_mark_generating(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
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

            workspace = self.workspace
            project_dir = workspace / "ppt_projects" / project_name
            marker = project_dir / ".generating"

            if action == "start":
                project_dir.mkdir(parents=True, exist_ok=True)
                marker.write_text("1", encoding="utf-8")
            elif action == "finish":
                marker.unlink(missing_ok=True)

            await self._push_ppt_phase_from_disk(project_dir, project_name)

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("ppt mark generating error")
            return _http_error(500, str(e))

    async def _handle_ppt_save_chat_id(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
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

            workspace = self.workspace
            project_dir = workspace / "ppt_projects" / project_name
            if not project_dir.is_dir():
                return _http_error(404, "project not found")

            chat_id_file = project_dir / ".chat_id"
            chat_id_file.write_text(chat_id, encoding="utf-8")

            await self._push_ppt_phase_from_disk(project_dir, project_name)

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("ppt save chat id error")
            return _http_error(500, str(e))

    def _handle_ppt_delete_project(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            import shutil

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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
            query = _parse_query(request.path)
            project_name = _query_first(query, "name") or _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
            project_dir = workspace / "video_projects" / project_name

            artifact = (_query_first(query, "artifact") or "mp4").strip().lower()
            artifact_files = {
                "package": ("delivery.zip", "application/zip"),
                "srt": ("subtitles.srt", "text/plain; charset=utf-8"),
                "vtt": ("subtitles.vtt", "text/vtt; charset=utf-8"),
                "cover": ("cover.png", "image/png"),
                "audio": ("audio.m4a", "audio/mp4"),
                "report": ("quality-report.json", "application/json; charset=utf-8"),
            }
            if artifact != "mp4":
                target = artifact_files.get(artifact)
                if target is None:
                    return _http_error(400, "invalid video artifact")
                chosen = project_dir / "renders" / target[0]
                if not chosen.is_file():
                    return _http_error(404, "video artifact not found")
                return _http_response(
                    chosen.read_bytes(),
                    content_type=target[1],
                    extra_headers=[
                        ("Content-Disposition", f'attachment; filename="{chosen.name}"'),
                        ("Cache-Control", "no-cache"),
                    ],
                )

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

            query = _parse_query(request.path)
            project_name = _query_first(query, "name") or _query_first(query, "project") or ""

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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
            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = self.workspace
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
                        slides.append(
                            {
                                "name": f.name,
                                "type": "image",
                                "url": (
                                    f"/api/ppt/project-file?project={quote(project_name, safe='')}"
                                    f"&path=output/preview/{quote(f.name, safe='')}"
                                ),
                            }
                        )
            # Also check output/ directly for legacy preview images
            if output_dir.is_dir():
                for f in sorted(output_dir.glob("slide_*.png")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append(
                            {
                                "name": f.name,
                                "type": "image",
                                "url": (
                                    f"/api/ppt/project-file?project={quote(project_name, safe='')}"
                                    f"&path=output/{quote(f.name, safe='')}"
                                ),
                            }
                        )

            # Legacy pipeline: svg_final (self-contained), fall back to svg_output
            svg_final_dir = project_dir / "svg_final"
            svg_output_dir = project_dir / "svg_output"

            # svg_final files first (self-contained, no external refs)
            if svg_final_dir.is_dir():
                for f in sorted(svg_final_dir.glob("*.svg")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append(
                            {
                                "name": f.name,
                                "type": "svg",
                                "url": (
                                    f"/api/ppt/project-svg?project={quote(project_name, safe='')}"
                                    f"&file={quote(f.name, safe='')}&dir=final"
                                ),
                            }
                        )

            # svg_output files not already in svg_final
            if svg_output_dir.is_dir():
                for f in sorted(svg_output_dir.glob("*.svg")):
                    if f.name not in seen:
                        seen.add(f.name)
                        slides.append(
                            {
                                "name": f.name,
                                "type": "svg",
                                "url": (
                                    f"/api/ppt/project-svg?project={quote(project_name, safe='')}"
                                    f"&file={quote(f.name, safe='')}&dir=output"
                                ),
                            }
                        )

            return _http_json_response({"slides": slides})
        except Exception:
            logger.exception("ppt project slides error")
            return _http_error(500, "internal error")

    def _handle_ppt_project_svg(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
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

            workspace = self.workspace
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
            if svg_dir == "output" or (not svg_dir and svg_path.parent.name == "svg_output"):
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
        entity_re = re.compile(r"&([A-Za-z_][A-Za-z0-9_]*|#[0-9]+|#x[0-9A-Fa-f]+);")

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

            workspace = self.workspace
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
        meta = dict(metadata or {})
        task_started = False
        if meta.get("webui"):
            raw_task_id = meta.get("task_id")
            task_id = (
                raw_task_id.strip()
                if isinstance(raw_task_id, str) and _API_KEY_RE.fullmatch(raw_task_id.strip())
                else f"task_{uuid.uuid4().hex}"
            )
            meta["task_id"] = task_id
            task_started = self._start_artifact_task(chat_id, task_id, content)
            user_obj: dict[str, Any] = {
                "event": "user",
                "chat_id": chat_id,
                "text": content,
                "task_id": task_id,
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
        if task_started:
            await self.send_artifact_task_started(chat_id, meta["task_id"])
            await self._maybe_push_task_plan(chat_id)
            await self.send_artifacts_changed(chat_id=chat_id)
        await super()._handle_message(
            sender_id,
            chat_id,
            content,
            media,
            meta,
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
        mac = hmac.new(self._media_secret, payload.encode("ascii"), hashlib.sha256).digest()[:16]
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

    @staticmethod
    def _artifact_file_payload(ref: Any, workspace: Path) -> dict[str, Any] | None:
        """Hydrate one persisted ArtifactRef into a previewable UI row."""
        from mona.agent.artifacts import coerce_artifact_ref

        artifact = coerce_artifact_ref(ref)
        if artifact is None:
            return None
        try:
            payload = artifact.as_file(workspace)
            target = artifact.resolve(workspace)
            payload["absolute_path"] = str(target)
            return payload
        except (OSError, ValueError):
            return {
                "path": artifact.relative_path,
                "absolute_path": "",
                "name": Path(artifact.relative_path).name,
                "size": artifact.size or 0,
                "size_human": "",
                "mime": artifact.mime or "application/octet-stream",
                "modified_at": artifact.modified_at.isoformat() if artifact.modified_at else None,
                "missing": True,
                "artifact_ref": artifact.model_dump(mode="json"),
            }

    def _artifact_task_state(
        self,
        session_key: str,
        task_id: str | None = None,
    ) -> dict[str, Any] | None:
        if self._session_manager is None:
            return None
        session = self._session_manager.get_or_create(session_key)
        state = session.metadata.get(_ARTIFACT_TASK_STATE_KEY)
        if not isinstance(state, dict):
            return None
        current_id = state.get("id")
        if not isinstance(current_id, str) or not current_id:
            return None
        if task_id and current_id != task_id:
            return None
        return state

    def _start_artifact_task(
        self,
        chat_id: str,
        task_id: str,
        user_message: str = "",
    ) -> bool:
        """Persist a workspace baseline for a new user-controlled task."""
        if self._session_manager is None:
            return False
        session_key = f"websocket:{chat_id}"
        session = self._session_manager.get_or_create(session_key)
        current = session.metadata.get(_ARTIFACT_TASK_STATE_KEY)
        if isinstance(current, dict) and current.get("id") == task_id:
            return False

        baseline: dict[str, list[Any]] = {}
        # Owner resolution reads persisted session metadata; materialize a
        # newly created chat before resolving its Agent output root.
        self._session_manager.save(session)
        owner = self._session_artifact_owner(session_key)
        if owner is not None:
            from mona.config.paths import get_agent_output_dir
            from mona.utils.artifact_listing import list_artifacts

            base, agent_id = owner
            try:
                listing = list_artifacts(get_agent_output_dir(base, agent_id))
                baseline = {item.path: [item.size, item.modified_at] for item in listing.files}
            except Exception:
                logger.exception("Failed to capture artifact task baseline for {}", chat_id)

        session.metadata[_ARTIFACT_TASK_STATE_KEY] = {
            "id": task_id,
            "started_at": time.time(),
            "baseline": baseline,
        }
        reset_task_plan(session.metadata, task_id, user_message)
        self._session_manager.save(session)
        return True

    def _artifact_refs_from_session(self, session_key: str) -> list[Any]:
        """Read explicit delivery references from the session projection."""
        from mona.agent.artifacts import coerce_artifact_ref
        from mona.webui.transcript import read_transcript_lines

        refs: list[Any] = []
        seen_paths: set[tuple[str, str, str]] = set()
        records = read_transcript_lines(session_key)

        def add_refs(raw_files: list[Any]) -> None:
            for item in reversed(raw_files):
                raw_ref = item.get("artifact_ref") if isinstance(item, dict) else None
                ref = coerce_artifact_ref(raw_ref)
                if ref is None and isinstance(item, dict):
                    # Existing transcripts predate ArtifactRef and only carry
                    # ``path``/``absolute_path``. Convert those records in
                    # memory, bounded by the session's resolved Agent root;
                    # never persist or trust the legacy absolute path.
                    ref = self._legacy_session_artifact_ref(session_key, item)
                if ref is None:
                    continue
                key = (ref.owner_kind, ref.owner_id, ref.relative_path)
                if key in seen_paths:
                    continue
                seen_paths.add(key)
                refs.append(ref)

        # Explicit delivery is authoritative. File edits are process records,
        # not user deliverables, so they never enter the session artifact list.
        for record in reversed(records):
            if record.get("event") != "deliver_files":
                continue
            raw_files = record.get("files")
            if isinstance(raw_files, list):
                add_refs(raw_files)

        # Recover turns where deliver_file succeeded during a streamed reply
        # but the old dispatcher dropped the final delivery-only frame.
        for record in reversed(records):
            if record.get("event") != "message":
                continue
            tool_events = record.get("tool_events")
            if not isinstance(tool_events, list):
                continue
            for event in tool_events:
                if not isinstance(event, dict) or event.get("name") != "deliver_file":
                    continue
                if event.get("phase") == "error" or event.get("error"):
                    continue
                arguments = event.get("arguments")
                paths = arguments.get("paths") if isinstance(arguments, dict) else None
                if isinstance(paths, list):
                    add_refs(
                        [
                            {
                                "path": path,
                                "absolute_path": path,
                                "name": Path(path).name,
                            }
                            for path in paths
                            if isinstance(path, str) and path
                        ]
                    )

        # Backfill old image/video transcripts that predate automatic
        # deliver_files registration, without overriding an explicit delivery.
        for record in reversed(records):
            if record.get("event") != "message":
                continue
            raw_files: list[Any] = []
            tool_events = record.get("tool_events")
            for tool_event in tool_events if isinstance(tool_events, list) else []:
                if (
                    not isinstance(tool_event, dict)
                    or tool_event.get("name") not in {"generate_image", "generate_video"}
                    or tool_event.get("error")
                ):
                    continue
                result = tool_event.get("result")
                payload = result if isinstance(result, dict) else None
                if payload is None and isinstance(result, str):
                    try:
                        payload, _ = json.JSONDecoder().raw_decode(result.lstrip())
                    except (TypeError, ValueError, json.JSONDecodeError):
                        continue
                outputs = payload.get("artifacts") if isinstance(payload, dict) else None
                for output in outputs if isinstance(outputs, list) else []:
                    if not isinstance(output, dict):
                        continue
                    path = output.get("path") or output.get("local_path") or output.get("saved_to")
                    if not isinstance(path, str) or not path:
                        continue
                    raw_files.append(
                        {
                            "path": path,
                            "absolute_path": path,
                            "name": str(output.get("name") or Path(path).name),
                            "mime": output.get("mime"),
                        }
                    )
            add_refs(raw_files)
        return refs

    def _legacy_session_artifact_ref(
        self,
        session_key: str,
        item: dict[str, Any],
    ) -> Any | None:
        """Convert one pre-ArtifactRef delivery record safely for replay.

        Old WebUI transcripts contain only a relative path and often an
        absolute path. The latter is used solely to follow the migration
        manifest when the file moved; the returned reference never stores it.
        Records that cannot be proven to belong to this session's Agent root
        are ignored rather than guessed into a different owner.
        """
        from mona.agent.artifacts import ArtifactRef
        from mona.config.paths import get_agent_output_dir

        owner = self._session_artifact_owner(session_key)
        if owner is None:
            return None
        base, agent_id = owner
        try:
            root = get_agent_output_dir(base, agent_id).resolve()
        except (OSError, ValueError):
            return None

        raw_absolute = item.get("absolute_path")
        candidate: Path | None = None
        if isinstance(raw_absolute, str) and raw_absolute.strip():
            candidate = Path(raw_absolute).expanduser()
            try:
                candidate = candidate.resolve()
            except OSError:
                candidate = None
            if candidate is not None and not candidate.is_relative_to(root):
                # A legacy loose-output path may have been moved by startup;
                # use the recorded map only when it points into this Agent.
                try:
                    from mona.config.migrate_global import resolve_legacy_path

                    migrated = resolve_legacy_path(candidate)
                    candidate = migrated.resolve() if migrated is not None else None
                except (OSError, ValueError):
                    candidate = None
        raw_relative = item.get("path")
        if candidate is None and isinstance(raw_relative, str) and raw_relative.strip():
            relative = Path(raw_relative)
            if relative.is_absolute() or ".." in relative.parts:
                return None
            try:
                candidate = (root / relative).resolve()
            except OSError:
                return None
        if candidate is None:
            return None
        try:
            relative_path = candidate.relative_to(root).as_posix()
        except ValueError:
            return None
        if not relative_path or relative_path == ".":
            return None

        room_id: str | None = None
        if self._session_manager is not None:
            try:
                session = self._session_manager.get_or_create(session_key)
                if session.conversation_metadata.type == "room":
                    room_id = session_key.removeprefix("websocket:")
            except Exception:
                logger.exception("Cannot resolve legacy artifact room for {}", session_key)
        size = item.get("size")
        if not isinstance(size, int) or size < 0:
            size = None
        modified_at: datetime | None = None
        raw_modified = item.get("modified_at")
        if isinstance(raw_modified, str) and raw_modified:
            try:
                modified_at = datetime.fromisoformat(raw_modified.replace("Z", "+00:00"))
            except ValueError:
                modified_at = None
        mime = item.get("mime") if isinstance(item.get("mime"), str) else None
        try:
            return ArtifactRef(
                id=(
                    "artifact_legacy_"
                    + uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"{session_key}\0{agent_id}\0{relative_path}",
                    ).hex
                ),
                owner_kind="agent",
                owner_id=agent_id,
                relative_path=relative_path,
                created_by_agent_id=agent_id,
                session_id=session_key,
                room_id=room_id,
                size=size,
                modified_at=modified_at,
                mime=mime,
            )
        except ValueError:
            return None

    def _session_artifact_owner(self, session_key: str) -> tuple[Path, str] | None:
        if self._session_manager is None:
            return None
        data = self._session_manager.read_session_file(session_key)
        if data is None:
            return None
        metadata = data.get("metadata") or {}
        workspace = metadata.get("workspace")
        base = (
            Path(workspace).expanduser()
            if isinstance(workspace, str) and workspace.strip()
            else None
        )
        if base is None:
            base = self.workspace
        conversation = metadata.get("conversation")
        agent_id = "mona"
        if isinstance(conversation, dict):
            direct = conversation.get("directAgentId") or conversation.get("direct_agent_id")
            if isinstance(direct, str) and direct.strip():
                agent_id = direct.strip()
        return base.resolve(), agent_id

    def _room_artifact_ref(self, room_id: str, path: str) -> Any | None:
        """Find a room-owned reference by relative path without scanning roots."""
        for ref in self._artifact_refs_for_room(room_id):
            if getattr(ref, "relative_path", None) == path:
                return ref
        return None

    def _artifact_refs_for_room(self, room_id: str) -> list[Any]:
        """Aggregate explicit room deliveries from transcript, Jobs and Runs.

        A room is only a projection. This method never walks an Agent output
        directory; it follows the structured references persisted by each
        producer and de-duplicates them by reference id.
        """
        from mona.agent.artifacts import coerce_artifact_ref
        from mona.agent.jobs import AgentJobStore
        from mona.agent.workflow import WorkflowRunStore
        from mona.config.paths import get_agent_jobs_dir, get_workflow_runs_dir

        refs: list[Any] = []
        seen: set[str] = set()

        def add(raw: Any) -> None:
            ref = coerce_artifact_ref(raw)
            if ref is None or ref.id in seen:
                return
            # A room view must never accidentally expose a reference carried
            # by a different room/run projection.
            if ref.room_id and ref.room_id != room_id:
                return
            seen.add(ref.id)
            refs.append(ref)

        for ref in self._artifact_refs_from_session(f"websocket:{room_id}"):
            add(ref)
        try:
            for job in AgentJobStore(get_agent_jobs_dir()).list_for_room(room_id):
                for raw in job.artifacts:
                    add(raw)
        except Exception:
            logger.exception("Failed to load room job artifacts for {}", room_id)
        try:
            for run in WorkflowRunStore(get_workflow_runs_dir()).list_for_room(room_id):
                for step in run.steps.values():
                    step_output = step.output or {}
                    for raw in step_output.get("artifacts", []):
                        add(raw)
        except Exception:
            logger.exception("Failed to load room workflow artifacts for {}", room_id)
        return refs

    def _handle_file_preview(
        self,
        request: WsRequest,
        *,
        scope: str,
        session_key: str,
        path: str,
        room: str = "",
        artifact_id: str = "",
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
            if not session_key:
                return _http_error(400, "missing session_key")
            decoded_key = _decode_api_key(session_key)
            if decoded_key is None or not self._is_websocket_channel_session_key(decoded_key):
                return _http_error(404, "session not found")
            owner = self._session_artifact_owner(decoded_key)
            if owner is None:
                return _http_error(404, "session not found")
            base, agent_id = owner
            if artifact_id:
                session_refs = self._artifact_refs_from_session(decoded_key)
                ref = next(
                    (item for item in session_refs if getattr(item, "id", None) == artifact_id),
                    None,
                )
                if ref is None:
                    # Historical generated-media refs used random IDs on each
                    # list request. Recover only by an exact session-owned
                    # relative path so stale UI rows remain previewable.
                    ref = next(
                        (item for item in session_refs if item.relative_path == path),
                        None,
                    )
                if ref is None or ref.owner_kind != "agent" or ref.owner_id != agent_id:
                    return _http_error(404, "artifact not found")
                path = ref.relative_path
            from mona.config.paths import get_agent_output_dir

            root = get_agent_output_dir(base, agent_id)
        elif scope == "room":
            if not room:
                return _http_error(400, "missing room id")
            ref = (
                next(
                    (
                        item
                        for item in self._artifact_refs_for_room(room)
                        if artifact_id and getattr(item, "id", None) == artifact_id
                    ),
                    None,
                )
                if artifact_id
                else self._room_artifact_ref(room, path)
            )
            if ref is None:
                return _http_error(404, "room not found")
            try:
                owner = self._session_artifact_owner(f"websocket:{room}")
                if owner is None:
                    return _http_error(404, "room not found")
                root = ref.owner_root(owner[0])
            except (OSError, ValueError):
                return _http_error(400, "invalid artifact reference")
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
                "text/plain",
                "text/html",
                "text/css",
                "text/javascript",
                "application/json",
                "application/xml",
                "text/xml",
                "text/markdown",
                "text/csv",
                "image/png",
                "image/jpeg",
                "image/gif",
                "image/webp",
                "image/svg+xml",
                "video/mp4",
                "video/webm",
                "video/quicktime",
                "video/x-msvideo",
                "video/x-matroska",
                "video/3gpp",
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
        """List explicit session/room references plus an Agent workspace scan."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.config.paths import get_agent_output_dir
        from mona.utils.artifact_listing import list_artifacts

        query = _parse_query(request.path)
        room_id = _query_first(query, "room") or ""
        session_key = _query_first(query, "session_key") or ""
        requested_task_id = _query_first(query, "task_id") or ""
        if requested_task_id and not _API_KEY_RE.fullmatch(requested_task_id):
            return _http_error(400, "invalid task_id")
        if room_id:
            owner = self._session_artifact_owner(f"websocket:{room_id}")
            if owner is None:
                return _http_error(404, "room not found")
            base = owner[0]
            refs = self._artifact_refs_for_room(room_id)
            files: list[dict[str, Any]] = []
            seen: set[str] = set()
            for ref in sorted(refs, key=lambda item: item.created_at, reverse=True):
                if ref.id in seen:
                    continue
                item = self._artifact_file_payload(ref, base)
                if item is None:
                    continue
                seen.add(ref.id)
                files.append(item)
            # A room is a flat projection of explicit references.  It has no
            # session/workspace split, so do not expose a second alias of the
            # same list to clients.
            payload = {"files": files, "truncated": False}
        else:
            if not session_key:
                return _http_error(400, "missing session_key")
            decoded_key = _decode_api_key(session_key)
            if decoded_key is None or not self._is_websocket_channel_session_key(decoded_key):
                return _http_error(404, "session not found")
            owner = self._session_artifact_owner(decoded_key)
            if owner is None:
                return _http_error(404, "session not found")
            base, agent_id = owner
            output_dir = get_agent_output_dir(base, agent_id)
            try:
                result = list_artifacts(output_dir)
            except Exception:
                logger.exception("Failed to list artifacts in {}", output_dir)
                return _http_error(500, "scan failed")
            scanned = {
                f.path: {
                    "path": f.path,
                    "absolute_path": f.absolute_path,
                    "name": f.name,
                    "size": f.size,
                    "size_human": f.size_human,
                    "mime": f.mime,
                    "modified_at": f.modified_at,
                    "missing": False,
                }
                for f in result.files
            }
            session_refs = [
                ref
                for ref in self._artifact_refs_from_session(decoded_key)
                if ref.owner_kind == "agent" and ref.owner_id == agent_id
            ]
            session_files: list[dict[str, Any]] = []
            session_paths: set[str] = set()
            for ref in sorted(session_refs, key=lambda item: item.created_at, reverse=True):
                if ref.relative_path in session_paths:
                    continue
                item = self._artifact_file_payload(ref, base)
                if item is None:
                    continue
                session_paths.add(ref.relative_path)
                if ref.relative_path in scanned:
                    item = {
                        **scanned[ref.relative_path],
                        "artifact_ref": ref.model_dump(mode="json"),
                    }
                session_files.append(item)
            task_state = self._artifact_task_state(
                decoded_key,
                requested_task_id or None,
            )
            active_task_id = (
                str(task_state.get("id")) if task_state is not None else requested_task_id or None
            )
            baseline = task_state.get("baseline") if task_state is not None else None
            baseline = baseline if isinstance(baseline, dict) else {}
            task_files: list[dict[str, Any]] = []
            task_paths: set[str] = set()
            if task_state is not None:
                for path, item in scanned.items():
                    if path in session_paths:
                        continue
                    if any(part in _ARTIFACT_TASK_SKIP_DIRS for part in Path(path).parts[:-1]):
                        continue
                    signature = [item.get("size"), item.get("modified_at")]
                    if baseline.get(path) == signature:
                        continue
                    task_paths.add(path)
                    task_files.append(item)
            payload = {
                "files": [
                    item
                    for path, item in scanned.items()
                    if path not in session_paths and path not in task_paths
                ],
                "session_files": session_files,
                "task_files": task_files,
                "task_id": active_task_id,
                "truncated": result.truncated,
            }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return _http_response(
            body,
            content_type="application/json; charset=utf-8",
            extra_headers=[("Cache-Control", "no-store")],
        )

    def _handle_artifact_rename(self, request: WsRequest) -> Response:
        """Rename one shared/project workspace entry without leaving its root."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.config.paths import get_agent_output_dir

        query = _parse_query(request.path)
        scope = _query_first(query, "scope") or ""
        session_key = _query_first(query, "session_key") or ""
        path = _query_first(query, "path") or ""
        new_name = (_query_first(query, "new_name") or "").strip()
        if (
            not path
            or not new_name
            or new_name in {".", ".."}
            or "/" in new_name
            or "\\" in new_name
        ):
            return _http_error(400, "invalid rename target")
        decoded_key = _decode_api_key(session_key)
        if decoded_key is None or not self._is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")

        agent_id: str | None = None
        if scope == "shared":
            owner = self._session_artifact_owner(decoded_key)
            if owner is None:
                return _http_error(404, "session not found")
            base, agent_id = owner
            root = get_agent_output_dir(base, agent_id)
        elif scope == "project":
            if self._session_manager is None:
                return _http_error(404, "session not found")
            data = self._session_manager.read_session_file(decoded_key)
            metadata = data.get("metadata") if isinstance(data, dict) else None
            workspace = metadata.get("workspace") if isinstance(metadata, dict) else None
            if not isinstance(workspace, str) or not workspace:
                return _http_error(404, "session not found")
            root = Path(workspace).expanduser()
        else:
            return _http_error(400, "invalid scope")

        try:
            root = root.resolve()
            source = (root / path).resolve()
            source.relative_to(root)
            destination = source.with_name(new_name)
            destination.relative_to(root)
        except (OSError, ValueError):
            return _http_error(400, "invalid path")
        if not source.exists():
            return _http_error(404, "file not found")
        if destination.exists():
            return _http_error(409, "a file with that name already exists")
        try:
            source.rename(destination)
        except OSError as exc:
            return _http_error(500, f"rename failed: {exc}")

        relative_path = destination.relative_to(root).as_posix()
        if scope == "shared" and agent_id and destination.is_file():
            from mona.agent.artifacts import ArtifactRef

            old_ref = next(
                (
                    ref
                    for ref in self._artifact_refs_from_session(decoded_key)
                    if ref.owner_kind == "agent"
                    and ref.owner_id == agent_id
                    and ref.relative_path == path.replace("\\", "/")
                ),
                None,
            )
            if old_ref is not None:
                new_ref = ArtifactRef.for_path(
                    owner_kind="agent",
                    owner_id=agent_id,
                    root=root,
                    path=destination,
                    created_by_agent_id=old_ref.created_by_agent_id,
                    session_id=decoded_key,
                    room_id=old_ref.room_id,
                    job_id=old_ref.job_id,
                    workflow_run_id=old_ref.workflow_run_id,
                    workflow_step_id=old_ref.workflow_step_id,
                )
                self._try_append_webui_transcript(
                    decoded_key.removeprefix("websocket:"),
                    {
                        "event": "deliver_files",
                        "chat_id": decoded_key.removeprefix("websocket:"),
                        "files": [
                            {
                                **new_ref.as_file(base),
                                "absolute_path": str(destination),
                            }
                        ],
                    },
                )

        return _http_json_response({"path": relative_path, "name": new_name})

    def _room_root_for_artifacts(self, room_id: str) -> Path | None:
        """Resolve a room's artifacts root: the room session's workspace
        override when bound, else the Mona workspace root. ``None`` when the
        room session does not exist."""
        if self._session_manager is None:
            return None
        decoded = _decode_api_key(f"websocket:{room_id}")
        if decoded is None:
            return None
        data = self._session_manager.read_session_file(decoded)
        if data is None:
            return None
        metadata = data.get("metadata") or {}
        workspace = metadata.get("workspace")
        if isinstance(workspace, str) and workspace.strip():
            return Path(workspace).expanduser()
        return self.workspace

    def _handle_stock_reports(self, request: WsRequest) -> Response:
        """List stock reports/digests under ``<workspace>/stock_projects``.

        Requires API token. Empty/missing directory yields an empty list.
        """
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.config.paths import get_stock_projects_dir
        from mona.services.stock.reports import scan_reports

        stock_dir = get_stock_projects_dir(self.workspace)
        try:
            reports = scan_reports(stock_dir)
        except Exception:
            logger.exception("Failed to scan stock reports in {}", stock_dir)
            return _http_error(500, "scan failed")
        return _http_json_response({"reports": reports})

    def _handle_stock_report_detail(self, request: WsRequest, report_id: str) -> Response:
        """Return one report's JSON document plus its markdown rendering."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.services.stock.reports import (
            load_report,
            public_report_detail,
            valid_report_id,
        )

        # The id is matched against document content (never joined into a
        # path), but reject anything outside the id alphabet anyway.
        if not valid_report_id(report_id):
            return _http_error(400, "invalid report id")
        from mona.config.paths import get_stock_projects_dir

        stock_dir = get_stock_projects_dir(self.workspace)
        result = load_report(stock_dir, report_id)
        if result is None:
            return _http_error(404, "report not found")
        doc, markdown = result
        return _http_json_response(public_report_detail(doc, markdown))

    def _handle_stock_report_delete(self, request: WsRequest) -> Response:
        """Delete one report's run directory (manual cleanup, design §9)."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.services.stock.reports import delete_report, valid_report_id

        report_id = _query_first(_parse_query(request.path), "id") or ""
        if not valid_report_id(report_id):
            return _http_error(400, "invalid report id")
        from mona.config.paths import get_stock_projects_dir

        stock_dir = get_stock_projects_dir(self.workspace)
        if not delete_report(stock_dir, report_id):
            return _http_error(404, "report not found")
        return _http_json_response({"deleted": True})

    def _handle_stock_dashboard(self, request: WsRequest) -> Response:
        """Global watchlist × latest report in the current workspace."""
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        from mona.config.paths import get_stock_projects_dir
        from mona.services.stock import reports as stock_reports
        from mona.services.stock.storage import WatchlistCorruptError

        try:
            watchlist = stock_reports.default_watchlist()
        except WatchlistCorruptError as exc:
            return _http_json_response(
                {"error": {"code": "watchlist_corrupt", "message": str(exc)}},
                status=500,
            )
        stock_dir = get_stock_projects_dir(self.workspace)
        return _http_json_response({"items": stock_reports.build_dashboard(stock_dir, watchlist)})

    def _handle_project_files_list(self, request: WsRequest, key: str) -> Response:
        """List all files of a project session's bound workspace directory.

        Requires API token. The root is resolved from the session's
        ``metadata.workspace`` — clients cannot pass an arbitrary root.
        Session resolution mirrors ``_handle_file_preview`` (project scope).
        """
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        if not key:
            return _http_error(400, "missing key")
        if self._session_manager is None:
            return _http_error(404, "session not found")
        decoded_key = _decode_api_key(key)
        if decoded_key is None or not self._is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        data = self._session_manager.read_session_file(decoded_key)
        if data is None:
            return _http_error(404, "session not found")
        metadata = data.get("metadata") or {}
        workspace = metadata.get("workspace")
        if not workspace:
            return _http_error(404, "session not found")

        from mona.utils.artifact_listing import list_project_files

        try:
            result = list_project_files(Path(workspace).expanduser())
        except Exception:
            logger.exception("Failed to list project files in {}", workspace)
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
        # Hidden rooms (stock-module design §4.4) are system-managed execution
        # containers — deletion from the UI surface is rejected.
        data = self._session_manager.read_session_file(decoded_key)
        if data is not None:
            metadata = data.get("metadata") or {}
            conversation = metadata.get("conversation")
            if isinstance(conversation, dict) and conversation.get("hidden") is True:
                return _http_error(403, "hidden rooms are system-managed")
        deleted = self._session_manager.delete_session(decoded_key)
        delete_webui_thread(decoded_key)
        # IM sidebar state (IM plan 12.4): drop the deleted session's pin /
        # archive / title override / last-read marker alongside the session.
        remove_webui_sidebar_session(decoded_key)
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
        self._ppt_watch_task = asyncio.create_task(self._watch_ppt_projects())
        await self._server_task

    async def _watch_artifacts(self) -> None:
        """Poll Agent output signatures; broadcast on change.

        Runs only while at least one websocket connection is open; the
        scan is a metadata-only aggregate hash (no file content reads).
        The first observation after startup (or after all clients went
        away) becomes the baseline and is not broadcast.
        """
        from mona.utils.artifact_listing import artifact_signature

        last: str | None = None
        while True:
            await asyncio.sleep(_ARTIFACT_WATCH_INTERVAL_S)
            if not self._conn_chats:
                continue
            try:
                workspace = self.workspace

                def _agent_outputs_signature() -> str:
                    roots = [workspace / "agent-workspaces" / "mona" / "output"]
                    agents_root = workspace / "agent-workspaces"
                    if agents_root.is_dir():
                        for agent_dir in agents_root.iterdir():
                            if agent_dir.is_dir() and agent_dir.name != "mona":
                                roots.append(agent_dir / "output")
                    parts = [f"{root}:{artifact_signature(root)}" for root in sorted(roots)]
                    return "|".join(parts)

                signature = await asyncio.to_thread(_agent_outputs_signature)
            except Exception:
                logger.exception("artifact watch scan failed")
                continue
            if last is None:
                last = signature
                continue
            if signature != last:
                last = signature
                await self.send_artifacts_changed()

    async def _watch_ppt_projects(self) -> None:
        """Poll ppt_projects dir; broadcast phase changes per project.

        Covers generating → outline (page_visual_plan.json) and other
        transitions that lack an explicit server-side push source.
        """
        from mona.utils.artifact_listing import artifact_signature

        last: str | None = None
        while True:
            await asyncio.sleep(_ARTIFACT_WATCH_INTERVAL_S)
            if not self._conn_chats:
                continue
            try:
                projects_dir = self.workspace / "ppt_projects"
                if not projects_dir.is_dir():
                    continue
                signature = await asyncio.to_thread(
                    artifact_signature,
                    projects_dir,
                )
                if last is None:
                    last = signature
                    continue
                if signature != last:
                    last = signature
                    for d in projects_dir.iterdir():
                        if not d.is_dir():
                            continue
                        if d.name.startswith("_"):
                            continue
                        phase = str(_get_ppt_project_status(d).get("phase") or "")
                        if phase in _PPT_PHASES:
                            await self.broadcast_ppt_phase_changed(d.name, phase)
            except Exception:
                logger.exception("ppt project watch failed")

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
            mime = (
                _extract_data_url_mime(item.get("data_url", "")) if isinstance(item, dict) else None
            )
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
                    self.logger.warning("failed to unlink partial media {}: {}", p, exc)
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
                    data_url,
                    media_dir,
                    max_bytes=max_bytes,
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
                connection,
                "ppt_import_native_result",
                ok=False,
                error="no file",
            )
            return
        name = file_info.get("name", "")
        data_url = file_info.get("data_url", "")
        mime = _extract_data_url_mime(data_url)
        if mime != "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            await self._send_event(
                connection,
                "ppt_import_native_result",
                ok=False,
                error="not a pptx file",
            )
            return

        try:
            raw = _decode_data_url_payload(data_url, _PPT_DOC_MAX_BYTES)
        except FileSizeExceeded:
            await self._send_event(
                connection,
                "ppt_import_native_result",
                ok=False,
                error="file too large",
            )
            return
        except Exception:
            await self._send_event(
                connection,
                "ppt_import_native_result",
                ok=False,
                error="decode failed",
            )
            return
        if raw is None:
            await self._send_event(
                connection,
                "ppt_import_native_result",
                ok=False,
                error="decode failed",
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
                        "python",
                        str(inspect_script),
                        str(tmp_path),
                        "-o",
                        str(output_dir),
                        "--name",
                        Path(name).stem if name else "template",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=120,
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
                connection,
                "ppt_delete_native_result",
                ok=False,
                error="invalid templateId",
            )
            return

        from mona.agent.skills import BUILTIN_SKILLS_DIR

        skill_dir = BUILTIN_SKILLS_DIR / "mona-ppt"
        primary_index = skill_dir / "scripts" / "templates_full" / "native" / "native_index.json"
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
                connection,
                "ppt_delete_native_result",
                ok=False,
                error="template not found",
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
            connection,
            "ppt_delete_native_result",
            ok=True,
            templateId=template_id,
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
            workspace = self.workspace
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
                connection,
                "ppt_upload_result",
                ok=len(added) > 0,
                files=added,
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

        Envelope shape: {type: "doc_upload", chat_id: str,
        files: [{name, data_url} | {name, local_path}]}
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
            await self._send_event(
                connection, "doc_upload_result", ok=False, error="invalid chat_id"
            )
            return
        try:
            workspace = self.workspace
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
                local_path = item.get("local_path")
                if not isinstance(name, str):
                    continue
                safe_name = safe_filename(name)
                # Prefix with a short uuid to avoid collisions when the same
                # filename is uploaded twice in the same chat session.
                short_id = uuid.uuid4().hex[:8]
                dest = uploads_dir / f"{short_id}-{safe_name}"
                if isinstance(local_path, str) and local_path:
                    source = Path(local_path).expanduser()
                    if not source.is_absolute() or not source.is_file():
                        continue
                    try:
                        shutil.copy2(source, dest)
                    except OSError:
                        continue
                    raw_size = dest.stat().st_size
                    mime = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
                else:
                    if not isinstance(data_url, str):
                        continue
                    mime = _extract_data_url_mime(data_url)
                    if mime is None:
                        continue
                    try:
                        raw = _decode_data_url_payload(data_url, _DOC_MAX_BYTES)
                    except FileSizeExceeded:
                        continue
                    except Exception:
                        continue
                    if raw is None:
                        continue
                    dest.write_bytes(raw)
                    raw_size = len(raw)
                rel = dest.relative_to(workspace)
                added.append(
                    {
                        "name": safe_name,
                        "path": str(rel).replace("\\", "/"),
                        "size": raw_size,
                        "mime": mime,
                    }
                )

            await self._send_event(
                connection,
                "doc_upload_result",
                ok=len(added) > 0,
                files=added,
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

    def _validate_room_agent_ids(self, raw: Any) -> tuple[list[str] | None, str | None, str | None]:
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
        from mona.agent.user_config import load_agent_user_config

        disabled = [a for a in normalized if not load_agent_user_config(a).enabled]
        if disabled:
            return None, "agent_disabled", f"disabled agents cannot be added: {', '.join(disabled)}"
        return normalized, None, None

    def _room_state_payload(self, conversation: Any) -> dict[str, Any]:
        registry = self._room_agent_registry()
        agents = []
        for agent_id in conversation.agent_ids:
            definition = registry.get(agent_id)
            summary = self._agent_summary(definition) if definition else None
            agents.append(
                {
                    "id": agent_id,
                    "displayName": summary["displayName"] if summary else agent_id,
                }
            )
        return {
            "conversation": conversation.to_session_metadata(),
            "agents": agents,
        }

    @staticmethod
    def _room_request_id(envelope: dict[str, Any]) -> str | None:
        request_id = envelope.get("request_id")
        return request_id if isinstance(request_id, str) and request_id else None

    async def _handle_create_room_envelope(self, connection: Any, envelope: dict[str, Any]) -> None:
        from mona.agent.partners import CONVERSATION_METADATA_KEY, ConversationMetadata

        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection,
                "create_room_result",
                ok=False,
                code="invalid_chat_id",
                detail="invalid chat_id",
                request_id=request_id,
            )
            return
        agent_ids, code, detail = self._validate_room_agent_ids(envelope.get("agent_ids"))
        if agent_ids is None:
            await self._send_event(
                connection,
                "create_room_result",
                ok=False,
                code=code,
                detail=detail,
                chat_id=chat_id,
                request_id=request_id,
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
                connection,
                "create_room_result",
                ok=False,
                code="unavailable",
                detail="session manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        if session.conversation_metadata.type == "room":
            await self._send_event(
                connection,
                "create_room_result",
                ok=False,
                code="already_a_room",
                detail="chat is already a collaboration room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        conversation = ConversationMetadata.room(agent_ids, title=title.strip(), goal=goal)
        session.metadata[CONVERSATION_METADATA_KEY] = conversation.to_session_metadata()
        self._session_manager.save(session)
        await self._send_event(
            connection,
            "create_room_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            **self._room_state_payload(conversation),
        )
        await self.send_room_updated(chat_id, self._room_state_payload(conversation))

    async def _handle_create_direct_conversation_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        """Mark a chat as a direct conversation with a named agent (shell phase).

        Mirrors ``create_room``: the client creates the chat first
        (``new_chat``), then stamps the conversation metadata. Idempotent for
        the same agent; converting a room back to a direct chat is rejected.
        """
        from mona.agent.partners import (
            CONVERSATION_METADATA_KEY,
            MONA_AGENT_ID,
            ConversationMetadata,
            normalize_agent_id,
        )

        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection,
                "create_direct_conversation_result",
                ok=False,
                code="invalid_chat_id",
                detail="invalid chat_id",
                request_id=request_id,
            )
            return
        raw_agent_id = envelope.get("agent_id")
        try:
            agent_id = normalize_agent_id(raw_agent_id) if isinstance(raw_agent_id, str) else None
        except ValueError:
            agent_id = None
        registry = self._room_agent_registry()
        if agent_id is None or registry.get(agent_id) is None:
            await self._send_event(
                connection,
                "create_direct_conversation_result",
                ok=False,
                code="unknown_agent",
                detail="agent is not installed",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        from mona.agent.user_config import load_agent_user_config

        if not load_agent_user_config(agent_id).enabled:
            await self._send_event(
                connection,
                "create_direct_conversation_result",
                ok=False,
                code="agent_disabled",
                detail="agent is disabled",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection,
                "create_direct_conversation_result",
                ok=False,
                code="unavailable",
                detail="session manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        existing = session.conversation_metadata
        if existing.type == "room":
            await self._send_event(
                connection,
                "create_direct_conversation_result",
                ok=False,
                code="already_a_room",
                detail="chat is already a collaboration room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        # Idempotent only for the same agent: rebinding an existing partner
        # direct chat to a different partner would mix its history across
        # identities. Binding a fresh (default Mona) chat to a partner is the
        # normal creation flow and stays allowed.
        if existing.direct_agent_id not in (None, MONA_AGENT_ID) and (
            existing.direct_agent_id != agent_id
        ):
            await self._send_event(
                connection,
                "create_direct_conversation_result",
                ok=False,
                code="agent_mismatch",
                detail="chat is already a direct conversation with another agent",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        definition = registry.get(agent_id)
        title = envelope.get("title")
        if not isinstance(title, str) or not title.strip():
            title = definition.display_name if definition is not None else agent_id
        conversation = ConversationMetadata.direct(agent_id, title=title.strip())
        session.metadata[CONVERSATION_METADATA_KEY] = conversation.to_session_metadata()
        self._session_manager.save(session)
        await self._send_event(
            connection,
            "create_direct_conversation_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            conversation=conversation.to_session_metadata(),
        )

    async def _broadcast_agent_event(self, event: str, *, agent_id: str, **fields: Any) -> None:
        """Broadcast small cache-invalidation events to all open WebUI clients."""
        conns = list(self._conn_chats)
        if not conns:
            return
        raw = json.dumps({"event": event, "agent_id": agent_id, **fields}, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=f" {event} ")

    async def _handle_agent_config_update_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.partners import normalize_agent_id
            from mona.agent.user_config import save_agent_user_config

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            definition = self._room_agent_registry().get(agent_id)
            if definition is None:
                raise ValueError("agent is not installed")
            update = envelope.get("config")
            if not isinstance(update, dict):
                raise ValueError("config must be an object")
            if definition.id == MONA_AGENT_ID and update.get("enabled") is False:
                raise ValueError("Mona cannot be disabled")
            if "script_enabled_skills" in update:
                raise ValueError("script permissions must be changed from a skill action")
            granted = update.get("granted_tools")
            if definition.id != MONA_AGENT_ID and isinstance(granted, list):
                from mona.agent.user_config import configurable_agent_tools

                configurable = configurable_agent_tools(definition) or []
                unknown = sorted(set(granted) - set(configurable))
                if unknown:
                    raise ValueError(
                        "tools exceed the configurable agent boundary: " + ", ".join(unknown)
                    )
            preset = update.get("model_preset")
            if isinstance(preset, str) and preset.strip():
                from mona.agent import model_presets
                from mona.config.loader import load_config

                if preset.strip() not in model_presets.configured_model_presets(load_config()):
                    raise ValueError("model preset is not configured")
            expected = envelope.get("expected_revision")
            if expected is not None and not isinstance(expected, int):
                raise ValueError("expected_revision must be an integer")
            saved = save_agent_user_config(agent_id, update, expected_revision=expected)
            await self._send_event(
                connection,
                "agent_config_update_result",
                ok=True,
                agent_id=agent_id,
                request_id=request_id,
                config=saved.model_dump(by_alias=True),
                agent=self._agent_summary(definition),
            )
            await self._broadcast_agent_event("agents_updated", agent_id=agent_id)
        except Exception as exc:
            await self._send_event(
                connection,
                "agent_config_update_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_custom_agent_create_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import create_custom_agent

            name = envelope.get("display_name")
            description = envelope.get("description", "")
            instructions = envelope.get("instructions", "")
            if not all(isinstance(value, str) for value in (name, description, instructions)):
                raise ValueError("display_name, description, and instructions must be text")
            definition = create_custom_agent(
                name,
                description=description,
                instructions=instructions,
            )
            registry = self._room_agent_registry()
            registry.reload()
            installed = registry.require(definition.id)
            await self._send_event(
                connection,
                "custom_agent_create_result",
                ok=True,
                request_id=request_id,
                agent_id=installed.id,
                agent=self._agent_summary(installed),
            )
            await self._broadcast_agent_event("agents_updated", agent_id=installed.id)
        except Exception as exc:
            await self._send_event(
                connection,
                "custom_agent_create_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_agent_instruction_save_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import write_instruction
            from mona.agent.partners import normalize_agent_id

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            if self._room_agent_registry().get(agent_id) is None:
                raise ValueError("agent is not installed")
            key = envelope.get("key")
            content = envelope.get("content")
            if not isinstance(key, str) or not isinstance(content, str):
                raise ValueError("key and content are required")
            instruction = write_instruction(agent_id, key, content, message=f"manual edit: {key}")
            await self._send_event(
                connection,
                "agent_instruction_save_result",
                ok=True,
                agent_id=agent_id,
                instruction=instruction,
                request_id=request_id,
            )
            await self._broadcast_agent_event(
                "agent_instructions_updated", agent_id=agent_id, key=key
            )
        except Exception as exc:
            await self._send_event(
                connection,
                "agent_instruction_save_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_agent_instruction_restore_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import restore_instruction
            from mona.agent.partners import normalize_agent_id

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            key = envelope.get("key")
            commit = envelope.get("commit")
            if self._room_agent_registry().get(agent_id) is None:
                raise ValueError("agent is not installed")
            if not isinstance(key, str) or not isinstance(commit, str):
                raise ValueError("key and commit are required")
            instruction = restore_instruction(agent_id, key, commit)
            await self._send_event(
                connection,
                "agent_instruction_restore_result",
                ok=True,
                agent_id=agent_id,
                instruction=instruction,
                request_id=request_id,
            )
            await self._broadcast_agent_event(
                "agent_instructions_updated", agent_id=agent_id, key=key
            )
        except Exception as exc:
            await self._send_event(
                connection,
                "agent_instruction_restore_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_agent_skill_stage_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import SkillManager
            from mona.agent.partners import normalize_agent_id

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            registry = self._room_agent_registry()
            if registry.get(agent_id) is None:
                raise ValueError("agent is not installed")
            name = envelope.get("name")
            files = envelope.get("files")
            content = envelope.get("content")
            if not isinstance(name, str):
                raise ValueError("skill name is required")
            if files is None:
                if not isinstance(content, str):
                    raise ValueError("skill content is required")
                files = {"SKILL.md": content}
            if not isinstance(files, dict):
                raise ValueError("skill files must be an object")
            if not all(
                isinstance(path, str) and isinstance(text, str) for path, text in files.items()
            ):
                raise ValueError("skill files must contain text values")
            proposal = SkillManager(agent_id, registry=registry).stage(
                name=name,
                files=files,
                source="user:webui",
            )
            await self._send_event(
                connection,
                "agent_skill_stage_result",
                ok=True,
                agent_id=agent_id,
                proposal=proposal,
                request_id=request_id,
            )
            await self._broadcast_agent_event(
                "agent_change_proposal_created",
                agent_id=agent_id,
                proposal_id=proposal["id"],
                kind="skill_install",
            )
        except Exception as exc:
            await self._send_event(
                connection,
                "agent_skill_stage_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_agent_skill_action_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import SkillManager
            from mona.agent.partners import normalize_agent_id

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            name = envelope.get("name")
            action = envelope.get("action")
            if not isinstance(name, str) or not isinstance(action, str):
                raise ValueError("skill name and action are required")
            manager = SkillManager(agent_id, registry=self._room_agent_registry())
            if action == "enable_scripts":
                from mona.config.paths import (
                    get_agent_skills_dir,
                    get_managed_runtimes_dir,
                )
                from mona.runtime.agent_env import AgentEnvironmentManager
                from mona.runtime.skill_env import runtime_spec_from_skill_markdown

                skill_dir = get_agent_skills_dir(agent_id) / name
                skill_content = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
                await AgentEnvironmentManager(get_managed_runtimes_dir()).prepare_all(
                    skill_dir,
                    runtime_spec_from_skill_markdown(skill_content),
                )
            manager.action(name, action)
            await self._send_event(
                connection,
                "agent_skill_action_result",
                ok=True,
                agent_id=agent_id,
                name=name,
                action=action,
                request_id=request_id,
            )
            await self._broadcast_agent_event("agent_skills_updated", agent_id=agent_id)
        except Exception as exc:
            await self._send_event(
                connection,
                "agent_skill_action_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_agent_skill_update_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import SkillManager
            from mona.agent.partners import normalize_agent_id

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            name = envelope.get("name")
            content = envelope.get("content")
            expected_hash = envelope.get("expected_hash")
            if not isinstance(name, str) or not isinstance(content, str):
                raise ValueError("skill name and content are required")
            if expected_hash is not None and not isinstance(expected_hash, str):
                raise ValueError("expected_hash must be text")
            from mona.config.paths import (
                get_agent_skills_dir,
                get_managed_runtimes_dir,
            )
            from mona.runtime.agent_env import AgentEnvironmentManager
            from mona.runtime.skill_env import runtime_spec_from_skill_markdown

            skill_dir = get_agent_skills_dir(agent_id) / name
            await AgentEnvironmentManager(get_managed_runtimes_dir()).prepare_all(
                skill_dir,
                runtime_spec_from_skill_markdown(content),
            )
            skill = SkillManager(agent_id, registry=self._room_agent_registry()).update_private(
                name,
                content,
                expected_hash=expected_hash,
            )
            await self._send_event(
                connection,
                "agent_skill_update_result",
                ok=True,
                agent_id=agent_id,
                skill=skill,
                request_id=request_id,
            )
            await self._broadcast_agent_event("agent_skills_updated", agent_id=agent_id)
        except Exception as exc:
            await self._send_event(
                connection,
                "agent_skill_update_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_resolve_agent_change_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        try:
            from mona.agent.agent_management import (
                get_staged_skill_for_approval,
                resolve_change_proposal,
            )
            from mona.agent.partners import normalize_agent_id

            agent_id = normalize_agent_id(str(envelope.get("agent_id", "")))
            proposal_id = envelope.get("proposal_id")
            token = envelope.get("token")
            approve = envelope.get("approve")
            if (
                not isinstance(proposal_id, str)
                or not isinstance(token, str)
                or not isinstance(approve, bool)
            ):
                raise ValueError("proposal_id, token and approve are required")
            if approve:
                staged = get_staged_skill_for_approval(
                    agent_id,
                    proposal_id,
                    token=token,
                )
                if staged is not None:
                    from mona.config.paths import get_managed_runtimes_dir
                    from mona.runtime.agent_env import AgentEnvironmentManager

                    skill_dir, runtime_spec = staged
                    await AgentEnvironmentManager(get_managed_runtimes_dir()).prepare_all(
                        skill_dir, runtime_spec
                    )
            proposal = resolve_change_proposal(
                agent_id,
                proposal_id,
                token=token,
                approve=approve,
            )
            await self._send_event(
                connection,
                "resolve_agent_change_result",
                ok=True,
                agent_id=agent_id,
                proposal=proposal,
                request_id=request_id,
            )
            event = (
                "agent_instructions_updated"
                if proposal.get("kind") == "instruction_patch"
                else "agent_skills_updated"
            )
            await self._broadcast_agent_event(event, agent_id=agent_id)
            await self._broadcast_agent_event(
                "agent_change_proposal_resolved",
                agent_id=agent_id,
                proposal_id=proposal_id,
                status=proposal.get("status"),
            )
        except Exception as exc:
            await self._send_event(
                connection,
                "resolve_agent_change_result",
                ok=False,
                request_id=request_id,
                detail=str(exc),
            )

    async def _handle_update_room_envelope(self, connection: Any, envelope: dict[str, Any]) -> None:
        from mona.agent.partners import CONVERSATION_METADATA_KEY

        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection,
                "update_room_result",
                ok=False,
                code="invalid_chat_id",
                detail="invalid chat_id",
                request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection,
                "update_room_result",
                ok=False,
                code="unavailable",
                detail="session manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection,
                "update_room_result",
                ok=False,
                code="not_a_room",
                detail="chat is not a collaboration room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        # Hidden rooms (stock-module design §4.4) are system-managed execution
        # containers — the UI must not rename/re-member them.
        if conversation.hidden:
            await self._send_event(
                connection,
                "update_room_result",
                ok=False,
                code="hidden_room",
                detail="hidden rooms are system-managed",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        raw_agents = envelope.get("agent_ids")
        if raw_agents is not None:
            agent_ids, code, detail = self._validate_room_agent_ids(raw_agents)
            if agent_ids is None:
                await self._send_event(
                    connection,
                    "update_room_result",
                    ok=False,
                    code=code,
                    detail=detail,
                    chat_id=chat_id,
                    request_id=request_id,
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
            connection,
            "update_room_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            **self._room_state_payload(conversation),
        )
        await self.send_room_updated(chat_id, self._room_state_payload(conversation))

    async def _handle_get_room_state_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection,
                "room_state_result",
                ok=False,
                code="invalid_chat_id",
                detail="invalid chat_id",
                request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection,
                "room_state_result",
                ok=False,
                code="unavailable",
                detail="session manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection,
                "room_state_result",
                ok=False,
                code="not_a_room",
                detail="chat is not a collaboration room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        await self._send_event(
            connection,
            "room_state_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            **self._room_state_payload(conversation),
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
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="invalid_chat_id",
                detail="invalid chat_id",
                request_id=request_id,
            )
            return
        job_id = envelope.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="invalid_job_id",
                detail="invalid job_id",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if self._session_manager is None:
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="unavailable",
                detail="session manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="not_a_room",
                detail="chat is not a collaboration room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        requester = envelope.get("agent_id")
        if requester is not None:
            if not isinstance(requester, str):
                await self._send_event(
                    connection,
                    "cancel_agent_job_result",
                    ok=False,
                    code="invalid_agent_id",
                    detail="invalid agent_id",
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
            try:
                requester = normalize_agent_id(requester)
            except ValueError:
                await self._send_event(
                    connection,
                    "cancel_agent_job_result",
                    ok=False,
                    code="invalid_agent_id",
                    detail="invalid agent_id",
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
            if requester not in conversation.agent_ids:
                await self._send_event(
                    connection,
                    "cancel_agent_job_result",
                    ok=False,
                    code="not_a_member",
                    detail=f"agent {requester!r} is not a room member",
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
        if self._subagent_manager is None:
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="unavailable",
                detail="subagent manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        reason = envelope.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            reason = None
        try:
            job = await self._subagent_manager.cancel_job(job_id, room_id=chat_id, reason=reason)
        except JobNotFoundError:
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="job_not_found",
                detail="job not found in this room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        except JobTransitionError:
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="job_not_cancellable",
                detail="job is already in a terminal state",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        except ValueError:
            await self._send_event(
                connection,
                "cancel_agent_job_result",
                ok=False,
                code="invalid_job_id",
                detail="invalid job_id",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        await self._send_event(
            connection,
            "cancel_agent_job_result",
            ok=True,
            chat_id=chat_id,
            job_id=job.id,
            request_id=request_id,
            job=serialize_job(job),
        )

    async def _handle_start_discussion_envelope(
        self,
        connection: Any,
        *,
        sender_id: str,
        envelope: dict[str, Any],
    ) -> None:
        """Start a topic discussion through its dedicated wire command."""
        chat_id = envelope.get("chat_id")
        content = envelope.get("content")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(connection, "error", detail="invalid chat_id")
            return
        if not isinstance(content, str) or not content.strip():
            await self._send_event(connection, "error", detail="discussion topic is required")
            return
        metadata: dict[str, Any] = {"webui": envelope.get("webui") is True}
        display_content = envelope.get("display_content")
        if isinstance(display_content, str) and display_content:
            metadata["display_content"] = display_content
        routed = await self._route_room_agent_mentions(
            connection,
            sender_id=sender_id,
            chat_id=chat_id,
            content=content,
            media_paths=[],
            metadata=metadata,
            raw_targets=envelope.get("target_agent_ids"),
            raw_discussion=envelope.get("discussion"),
        )
        if not routed:
            await self._send_event(
                connection,
                "error",
                detail="discussion requires at least two room Agent participants",
            )

    async def _route_room_agent_mentions(
        self,
        connection: Any,
        *,
        sender_id: str,
        chat_id: str,
        content: str,
        media_paths: list[str],
        metadata: dict[str, Any],
        raw_targets: Any,
        raw_discussion: Any = None,
    ) -> bool:
        """Route structured ``@Agent`` targets in a room to AgentJobs (guide 7.5).

        Returns True when the envelope was fully handled here: every targeted
        partner agent runs as a tracked job and the user message is persisted
        once. Returns False to fall through to the normal message flow (no
        partner targets — e.g. only Mona was mentioned, so she also answers).
        """
        from mona.agent.partners import MONA_AGENT_ID
        from mona.agent.room import RoomError, require_room_member, resolve_target_agents

        if not isinstance(raw_targets, list) or any(not isinstance(t, str) for t in raw_targets):
            await self._send_event(connection, "error", detail="invalid target_agent_ids")
            return True
        if not raw_targets:
            return False
        if self._session_manager is None:
            await self._send_event(connection, "error", detail="session manager unavailable")
            return True
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        try:
            targets = resolve_target_agents(conversation, raw_targets)
        except RoomError as exc:
            await self._send_event(connection, "error", detail=str(exc))
            return True
        # Keep the structured target order stable even if a resolver or a
        # legacy caller returns duplicates.  The UI uses this order for
        # deterministic result placement and the same target must never get
        # two jobs from one user turn.
        targets = list(dict.fromkeys(targets))
        partner_targets = [t for t in targets if t != MONA_AGENT_ID]
        mona_targeted = MONA_AGENT_ID in targets
        from mona.agent import collaboration

        discussion_payload: dict[str, Any] | None = None
        discussion_mode: collaboration.DiscussionMode | None = None
        if raw_discussion is not None:
            if not isinstance(raw_discussion, dict):
                await self._send_event(connection, "error", detail="discussion must be an object")
                return True
            discussion_payload = raw_discussion
            try:
                discussion_mode = collaboration.DiscussionMode(
                    str(discussion_payload.get("mode", "discussion")).strip().lower()
                )
            except ValueError as exc:
                await self._send_event(connection, "error", detail=str(exc))
                return True
            collaboration_mode = collaboration.CollaborationMode.PARALLEL
        # A single direct mention keeps the legacy direct-job path.  Natural
        # language collaboration modes require at least two structured
        # targets; the collaboration planner owns that bound and validation.
        elif len(targets) >= 2:
            try:
                collaboration_mode = collaboration.infer_collaboration_mode(content, targets)
            except ValueError as exc:
                await self._send_event(connection, "error", detail=str(exc))
                return True
        else:
            collaboration_mode = collaboration.CollaborationMode.PARALLEL

        # A summary is a coordinated Mona turn.  Without Mona explicitly
        # targeted, keep the existing independent partner fan-out semantics;
        # words such as "总结" in a partner-only request must not change it.
        if collaboration_mode is collaboration.CollaborationMode.SUMMARY and not mona_targeted:
            collaboration_mode = collaboration.CollaborationMode.PARALLEL

        if (
            discussion_payload is not None
            or collaboration_mode is not collaboration.CollaborationMode.PARALLEL
        ):
            if self._subagent_manager is None:
                await self._send_event(connection, "error", detail="agent routing unavailable")
                return True

            # Collaboration workflows receive the same room message snapshot
            # as every other routed turn.  Attachments are included in the
            # transient goal/task while the original user message is stored
            # once below and remains the UI-visible representation.
            collaboration_content = content.strip()
            if media_paths:
                attachments = "\n".join(f"- {p}" for p in media_paths)
                collaboration_content = (
                    f"{collaboration_content}\n\n[Attachments]\n{attachments}"
                    if collaboration_content
                    else f"[Attachments]\n{attachments}"
                )

            display_content = metadata.get("display_content")
            if metadata.get("webui"):
                user_obj: dict[str, Any] = {
                    "event": "user",
                    "chat_id": chat_id,
                    "text": content,
                }
                if isinstance(display_content, str) and display_content:
                    user_obj["display_content"] = display_content
                if media_paths:
                    user_obj["media_paths"] = list(media_paths)
                self._try_append_webui_transcript(chat_id, user_obj)

            extra: dict[str, Any] = {}
            if media_paths:
                extra["media"] = list(media_paths)
            if isinstance(display_content, str) and display_content:
                extra["display_content"] = display_content
            if sender_id:
                extra["sender_id"] = sender_id
            session.add_message("user", content, **extra)
            self._session_manager.save(session)

            registry = self._room_agent_registry()
            from mona.agent.workflow import RunConflictError, WorkflowValidationError

            try:
                routed_mode = collaboration_mode.value
                if discussion_payload is not None and discussion_mode is not None:
                    raw_summary_agent = discussion_payload.get(
                        "summary_agent_id", MONA_AGENT_ID
                    )
                    if raw_summary_agent is None:
                        summary_agent = None
                    elif isinstance(raw_summary_agent, str):
                        summary_agent = require_room_member(conversation, raw_summary_agent)
                    else:
                        raise ValueError("summary_agent_id must be a string or null")
                    workflow = collaboration.build_discussion_workflow(
                        room_id=chat_id,
                        topic=collaboration_content,
                        ordered_target_ids=targets,
                        mode=discussion_mode,
                        max_rounds=discussion_payload.get("max_rounds"),
                        positions=discussion_payload.get("positions"),
                        styles=discussion_payload.get("styles"),
                        summary_agent_id=summary_agent,
                    )
                    routed_mode = discussion_mode.value
                else:
                    workflow = collaboration.build_collaboration_workflow(
                        room_id=chat_id,
                        content=collaboration_content,
                        ordered_target_ids=targets,
                        mode=collaboration_mode,
                    )
                launch_id = await self._subagent_manager.launch_collaboration(
                    room_id=chat_id,
                    goal=collaboration_content,
                    workflow=workflow,
                    conversation=conversation,
                    registry=registry,
                    started_by="user",
                    inputs=(
                        {
                            "discussion": {
                                "mode": discussion_mode.value,
                                "maxRounds": discussion_payload.get("max_rounds"),
                                "participantIds": list(targets),
                                "positions": discussion_payload.get("positions") or {},
                                "styles": discussion_payload.get("styles") or {},
                                "summaryAgentId": summary_agent,
                            }
                        }
                        if discussion_payload is not None and discussion_mode is not None
                        else None
                    ),
                )
            except (RunConflictError, WorkflowValidationError, ValueError) as exc:
                # Startup validation/conflict is a handled routing result. Do
                # not fall through to the legacy path, which would duplicate
                # jobs or start Mona a second time.
                await self._send_event(connection, "error", detail=str(exc))
                return True

            await self._send_event(
                connection,
                "agent_mentions_routed",
                chat_id=chat_id,
                agents=list(targets),
                failures=None,
                mode=routed_mode,
                collaboration_id=launch_id,
            )
            return True

        if mona_targeted:
            metadata["_direct_target_agent_ids"] = list(targets)
            metadata["_partner_jobs_dispatched"] = []
        if not partner_targets:
            return False
        if self._subagent_manager is None:
            await self._send_event(connection, "error", detail="agent routing unavailable")
            # Mona can still answer its direct mention through the normal
            # flow; only partner dispatch is unavailable.
            return not mona_targeted

        # Live-echo the user message for webui clients.
        # When Mona is also targeted the normal flow persists and echoes it,
        # so skip here to avoid a duplicate transcript entry.
        display_content = metadata.get("display_content")
        if metadata.get("webui") and not mona_targeted:
            user_obj: dict[str, Any] = {
                "event": "user",
                "chat_id": chat_id,
                "text": content,
            }
            if isinstance(display_content, str) and display_content:
                user_obj["display_content"] = display_content
            if media_paths:
                user_obj["media_paths"] = list(media_paths)
            self._try_append_webui_transcript(chat_id, user_obj)

        # Persist the user message once. When Mona is also targeted the
        # normal flow persists it, so skip here to avoid a duplicate.
        if not mona_targeted:
            extra: dict[str, Any] = {}
            if media_paths:
                extra["media"] = list(media_paths)
            if isinstance(display_content, str) and display_content:
                extra["display_content"] = display_content
            if sender_id:
                extra["sender_id"] = sender_id
            session.add_message("user", content, **extra)
            self._session_manager.save(session)

        task_text = content.strip()
        if media_paths:
            attachments = "\n".join(f"- {p}" for p in media_paths)
            task_text = (
                f"{task_text}\n\n[Attachments]\n{attachments}"
                if task_text
                else f"[Attachments]\n{attachments}"
            )
        job_store = self._subagent_manager.job_store_for_room(chat_id)
        registry = self._room_agent_registry()
        # Capture the room once before launching this @ batch. Each target
        # receives the same start-of-message snapshot, so a fast Agent A
        # cannot become an implicit dependency for sibling Agent B.
        batch_context: str | None = None
        capture_context = getattr(self._subagent_manager, "capture_room_context_snapshot", None)
        if callable(capture_context):
            captured = capture_context(chat_id, registry)
            if isinstance(captured, str):
                batch_context = captured
        delegated: list[str] = []
        failures: list[str] = []
        for target in partner_targets:
            partner_task = (
                f"{task_text}\n\n[Direct mention scope]\n"
                f"你是本次被直接 @ 的成员（{target}）。"
                "只以自己的身份回答分配给你的部分；不要代表、介绍或代答其他被 @ 的成员；"
                "不要再次委派已经被用户直接 @ 的成员。"
            )
            delegate_kwargs: dict[str, Any] = {
                "agent_id": target,
                "task": partner_task,
                "success_criteria": "Address the user's request and report the outcome.",
                "room_id": chat_id,
                "requested_by": "user",
                "origin_channel": "websocket",
                "origin_chat_id": chat_id,
                "session_key": f"websocket:{chat_id}",
                "room_context_snapshot": batch_context,
                "job_store": job_store,
                "registry": registry,
            }
            # Preserve a caller-provided stable message identity for job
            # correlation.  Never synthesize one in the routing layer.
            origin_message_id = metadata.get("origin_message_id")
            if not isinstance(origin_message_id, str) or not origin_message_id.strip():
                origin_message_id = metadata.get("message_id")
            if isinstance(origin_message_id, str) and origin_message_id.strip():
                delegate_kwargs["origin_message_id"] = origin_message_id
            result = await self._subagent_manager.delegate(
                **delegate_kwargs,
            )
            if result.startswith("Cannot delegate"):
                failures.append(result)
            else:
                delegated.append(target)
        if mona_targeted:
            metadata["_direct_target_agent_ids"] = list(targets)
            metadata["_partner_jobs_dispatched"] = list(delegated)
        if failures and not delegated:
            await self._send_event(connection, "error", detail="; ".join(failures))
            return not mona_targeted
        await self._send_event(
            connection,
            "agent_mentions_routed",
            chat_id=chat_id,
            agents=delegated,
            failures=failures or None,
        )
        # When Mona is also a target the normal flow runs too, so she answers
        # alongside the delegated partner jobs.
        return not mona_targeted

    # ------------------------------------------------------------------
    # Workflow commands (multi-agent phase 3, guide 8.2)
    # ------------------------------------------------------------------

    def _on_workflow_draft_proposed(self, chat_id: str, workflow: dict[str, Any]) -> None:
        """SubagentManager hook: broadcast a propose_workflow draft (phase 3)."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        asyncio.create_task(
            self.send_workflow_updated(chat_id, {"workflow": workflow, "draft": True})
        )

    def _workflow_runner_for(self, chat_id: str) -> Any:
        """Return the process-wide WorkflowRunner bound to a room.

        Runners live on the SubagentManager so the WebSocket channel and the
        cron callback share the same per-room run lock (phase 4).
        """
        return self._subagent_manager.workflow_runner_for_room(chat_id)

    def _on_workflow_run_updated(self, chat_id: str, payload: dict[str, Any]) -> None:
        """SubagentManager hook: broadcast run state; emit approval_requested.

        ``approval_requested`` fires once per distinct set of waiting steps
        per run, so observer replays of the same paused state do not spam
        clients (the run card itself refreshes via workflow_run_updated).
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        workflow = payload.get("workflow")
        workflow_id = workflow.get("id") if isinstance(workflow, dict) else None
        is_discussion = isinstance(workflow_id, str) and workflow_id.startswith("discussion-")
        if is_discussion:
            asyncio.create_task(self.send_discussion_updated(chat_id, payload))
        else:
            asyncio.create_task(self.send_workflow_run_updated(chat_id, payload))
        run_id = payload.get("id")
        if not isinstance(run_id, str) or not run_id:
            return
        # Project the run into the room conversation (IM group-chat parity):
        # the snapshot lands in the webui transcript as a status card and
        # each agent step's final summary/error posts as that agent's
        # message. Transcript appends are unconditional — runs triggered by
        # cron or finished while the room is closed still leave a record.
        self._try_append_webui_transcript(
            chat_id,
            {
                "event": "discussion_updated" if is_discussion else "workflow_run_updated",
                "chat_id": chat_id,
                **payload,
            },
        )
        self._post_workflow_step_messages(chat_id, run_id, payload)
        status = payload.get("status")
        # IM list contract (plan 11.5/12.1): run-level status changes move the
        # sessions-list attention state (running / waiting_approval / failed /
        # ...), so push a session refresh once per distinct status per run.
        # Step-level observer replays share the same status and are deduped.
        if isinstance(status, str) and self._run_status_notified.get(run_id) != status:
            self._run_status_notified[run_id] = status
            asyncio.create_task(self.send_session_updated(chat_id, scope="workflow"))
            if status in ("succeeded", "failed", "cancelled"):
                self._run_status_notified.pop(run_id, None)
        if status == "waiting_approval":
            steps = payload.get("steps")
            waiting = sorted(
                sid
                for sid, step in (steps.items() if isinstance(steps, dict) else [])
                if isinstance(step, dict) and step.get("status") == "waiting_approval"
            )
            signature = ",".join(waiting)
            if waiting and self._approval_notified.get(run_id) != signature:
                self._approval_notified[run_id] = signature
                asyncio.create_task(self.send_approval_requested(chat_id, payload, waiting))
        elif status in ("succeeded", "failed", "cancelled"):
            self._approval_notified.pop(run_id, None)
            self._run_step_message_state.pop(run_id, None)

    def _post_workflow_step_messages(
        self, chat_id: str, run_id: str, payload: dict[str, Any]
    ) -> None:
        """Post one room-conversation message per newly terminal agent step.

        The observer fires on every run transition; a step's summary (or
        error) is posted exactly once, authored by the step's agent, so the
        room reads like an IM group chat (guide 5.3). The per-run state map
        is seeded on first observation, which keeps steps that finished
        before a gateway restart from posting twice on resume.
        """
        steps = payload.get("steps")
        if not isinstance(steps, dict):
            return
        workflow = payload.get("workflow")
        step_defs = {
            step.get("id"): step
            for step in (workflow.get("steps", []) if isinstance(workflow, dict) else [])
            if isinstance(step, dict)
        }
        seen = self._run_step_message_state.get(run_id)
        if seen is None:
            # First observation of this run in-process: seed the tracker and
            # post nothing. A fresh run is always first seen with every step
            # queued (the create notify fires before any step executes), so
            # anything already terminal here finished before a gateway
            # restart and must never re-post its conversation message.
            self._run_step_message_state[run_id] = {
                sid: (state.get("status") if isinstance(state, dict) else None)
                for sid, state in steps.items()
            }
            return
        for step_id, step_state in steps.items():
            status = step_state.get("status") if isinstance(step_state, dict) else None
            previous = seen.get(step_id)
            seen[step_id] = status
            if status not in ("succeeded", "failed"):
                continue
            if previous in ("succeeded", "failed"):
                continue
            step_def = step_defs.get(step_id) or {}
            if step_def.get("type") != "agent":
                continue
            if status == "succeeded":
                output = step_state.get("output")
                text = output.get("summary") if isinstance(output, dict) else None
            else:
                text = step_state.get("error")
            if not isinstance(text, str) or not text.strip():
                continue
            agent_id = step_def.get("agentId")
            tool_events: list[dict[str, Any]] = []
            if self._subagent_manager is not None:
                pop = getattr(self._subagent_manager, "pop_step_tool_events", None)
                if callable(pop):
                    tool_events = pop(run_id, step_id) or []
            asyncio.create_task(
                self._broadcast_workflow_step_message(
                    chat_id,
                    run_id,
                    agent_id if isinstance(agent_id, str) and agent_id else MONA_AGENT_ID,
                    text,
                    tool_events=tool_events,
                )
            )

    async def _broadcast_workflow_step_message(
        self,
        chat_id: str,
        run_id: str,
        author_id: str,
        text: str,
        tool_events: list[dict[str, Any]] | None = None,
    ) -> None:
        """Append a workflow step result to the room transcript and broadcast it."""
        body: dict[str, Any] = {
            "event": "message",
            "chat_id": chat_id,
            "text": text,
            "author_id": author_id,
            "message_type": "message",
            "workflow_run_id": run_id,
        }
        if tool_events:
            body["tool_events"] = tool_events
        self._try_append_webui_transcript(chat_id, body)
        raw = json.dumps(body, ensure_ascii=False)
        for connection in list(self._subs.get(chat_id, ())):
            await self._safe_send_to(connection, raw, label=" workflow step ")

    async def send_approval_requested(
        self, chat_id: str, run: dict[str, Any], step_ids: list[str]
    ) -> None:
        """Broadcast approval_requested to the room's subscribers (guide 8.3)."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        steps = run.get("steps") if isinstance(run.get("steps"), dict) else {}
        workflow = run.get("workflow") if isinstance(run.get("workflow"), dict) else {}
        step_defs = {
            step.get("id"): step for step in workflow.get("steps", []) if isinstance(step, dict)
        }
        approvals = [
            {
                "stepId": sid,
                "message": step_defs.get(sid, {}).get("message", ""),
                "token": (steps.get(sid) or {}).get("approvalToken"),
            }
            for sid in step_ids
        ]
        body: dict[str, Any] = {
            "event": "approval_requested",
            "chat_id": chat_id,
            "run_id": run.get("id"),
            "approvals": approvals,
        }
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" approval_requested ")

    async def _workflow_room_context(
        self,
        connection: Any,
        envelope: dict[str, Any],
        *,
        result_event: str,
    ) -> tuple[str, Any, Any] | None:
        """Shared prelude: validate chat_id + room, return (chat_id, conversation, request_id)."""
        request_id = self._room_request_id(envelope)
        chat_id = envelope.get("chat_id")
        if not _is_valid_chat_id(chat_id):
            await self._send_event(
                connection,
                result_event,
                ok=False,
                code="invalid_chat_id",
                detail="invalid chat_id",
                request_id=request_id,
            )
            return None
        if self._session_manager is None:
            await self._send_event(
                connection,
                result_event,
                ok=False,
                code="unavailable",
                detail="session manager unavailable",
                chat_id=chat_id,
                request_id=request_id,
            )
            return None
        from mona.agent.pack_bootstrap import STOCK_DIAGNOSIS_ROOM_ID

        if chat_id == STOCK_DIAGNOSIS_ROOM_ID and not await _has_subscription_access():
            await self._send_event(
                connection,
                result_event,
                ok=False,
                code="membership_required",
                detail="AI诊股需要有效的 Mona Pro 订阅或试用",
                chat_id=chat_id,
                request_id=request_id,
            )
            return None
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        conversation = session.conversation_metadata
        if conversation.type != "room":
            await self._send_event(
                connection,
                result_event,
                ok=False,
                code="not_a_room",
                detail="chat is not a collaboration room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return None
        return chat_id, conversation, request_id

    async def _handle_save_workflow_draft_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.workflow import (
            WorkflowStep,
            WorkflowTrigger,
            WorkflowValidationError,
            serialize_workflow,
        )

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="workflow_draft_ready"
        )
        if ctx is None:
            return
        chat_id, conversation, request_id = ctx
        goal = envelope.get("goal")
        if not isinstance(goal, str):
            goal = ""
        trigger_raw = envelope.get("trigger")
        steps_raw = envelope.get("steps")
        if not isinstance(steps_raw, list) or not steps_raw:
            await self._send_event(
                connection,
                "workflow_draft_ready",
                ok=False,
                code="invalid_workflow",
                detail="steps must be a non-empty list",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        try:
            steps = [WorkflowStep.model_validate(s) for s in steps_raw]
            trigger = (
                WorkflowTrigger.model_validate(trigger_raw)
                if isinstance(trigger_raw, dict)
                else None
            )
        except Exception as exc:
            await self._send_event(
                connection,
                "workflow_draft_ready",
                ok=False,
                code="invalid_workflow",
                detail=str(exc),
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        store = self._subagent_manager.workflow_store_for_room(chat_id)
        try:
            draft = store.save_draft(
                chat_id,
                goal=goal,
                trigger=trigger,
                steps=steps,
                conversation=conversation,
                registry=self._room_agent_registry(),
            )
        except WorkflowValidationError as exc:
            await self._send_event(
                connection,
                "workflow_draft_ready",
                ok=False,
                code="invalid_workflow",
                detail=str(exc),
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        payload = {"workflow": serialize_workflow(draft)}
        await self._send_event(
            connection,
            "workflow_draft_ready",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            **payload,
        )
        await self.send_workflow_updated(chat_id, {**payload, "draft": True})

    async def _handle_activate_workflow_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.partners import CONVERSATION_METADATA_KEY
        from mona.agent.workflow import WorkflowNotFoundError, serialize_workflow

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="activate_workflow_result"
        )
        if ctx is None:
            return
        chat_id, conversation, request_id = ctx
        store = self._subagent_manager.workflow_store_for_room(chat_id)
        try:
            promoted = store.activate(chat_id)
        except WorkflowNotFoundError:
            await self._send_event(
                connection,
                "activate_workflow_result",
                ok=False,
                code="no_draft",
                detail="room has no workflow draft",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        # Record the active pointer on the conversation metadata (guide 5.2).
        conversation.active_workflow_id = promoted.id
        conversation.active_workflow_revision = promoted.revision
        session = self._session_manager.get_or_create(f"websocket:{chat_id}")
        session.metadata[CONVERSATION_METADATA_KEY] = conversation.to_session_metadata()
        self._session_manager.save(session)
        # Sync the room's cron entry with the new active revision (guide
        # 7.7): one deterministic job per room, replaced on every activation,
        # removed when the trigger is manual.
        self._subagent_manager.sync_workflow_cron(chat_id, promoted)
        payload = {
            "workflow": serialize_workflow(promoted),
            "activeRevision": promoted.revision,
        }
        await self._send_event(
            connection,
            "activate_workflow_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            **payload,
        )
        await self.send_workflow_updated(chat_id, {**payload, "draft": False})
        # Activation can flip the IM list ``scheduled`` flag (cron trigger).
        await self.send_session_updated(chat_id, scope="workflow")

    async def _handle_get_workflow_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.workflow import serialize_workflow

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="workflow_state_result"
        )
        if ctx is None:
            return
        chat_id, _conversation, request_id = ctx
        store = self._subagent_manager.workflow_store_for_room(chat_id)
        state = store.load(chat_id)
        active = state.active()
        await self._send_event(
            connection,
            "workflow_state_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            draft=serialize_workflow(state.draft) if state.draft is not None else None,
            active=serialize_workflow(active) if active is not None else None,
            activeRevision=state.active_revision,
            revisions=[v.revision for v in state.versions],
        )

    async def _handle_run_workflow_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.workflow import RunConflictError, validate_run_inputs

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="run_workflow_result"
        )
        if ctx is None:
            return
        chat_id, conversation, request_id = ctx
        store = self._subagent_manager.workflow_store_for_room(chat_id)
        template_ref = envelope.get("template_ref")
        if template_ref is not None and not isinstance(template_ref, str):
            await self._send_event(
                connection,
                "run_workflow_result",
                ok=False,
                code="invalid_template_ref",
                detail="template_ref must be a string",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if isinstance(template_ref, str) and template_ref.strip():
            # Packaged templates are read-only resources. The loader validates
            # the package URI and rejects path traversal; room membership is
            # still checked by WorkflowRunner against the current conversation.
            try:
                from mona.agent.pack_templates import load_pack_template

                active = load_pack_template(template_ref)
            except Exception as exc:
                await self._send_event(
                    connection,
                    "run_workflow_result",
                    ok=False,
                    code="invalid_template",
                    detail=str(exc),
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
            if active.room_id != chat_id:
                await self._send_event(
                    connection,
                    "run_workflow_result",
                    ok=False,
                    code="template_room_mismatch",
                    detail="template does not belong to this room",
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
        else:
            # Backward-compatible path: ordinary rooms still run their active
            # revision exactly as before.
            active = store.get_active(chat_id)
        if active is None:
            await self._send_event(
                connection,
                "run_workflow_result",
                ok=False,
                code="no_active_workflow",
                detail="room has no active workflow; activate a draft first",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        try:
            inputs = validate_run_inputs(envelope.get("inputs"))
        except ValueError as exc:
            await self._send_event(
                connection,
                "run_workflow_result",
                ok=False,
                code="invalid_inputs",
                detail=str(exc),
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        runner = self._workflow_runner_for(chat_id)
        if runner.active_run_for_room(chat_id) is not None:
            await self._send_event(
                connection,
                "run_workflow_result",
                ok=False,
                code="run_conflict",
                detail="room already has an active run",
                chat_id=chat_id,
                request_id=request_id,
            )
            return

        async def _drive() -> None:
            try:
                await runner.run(
                    room_id=chat_id,
                    workflow=active,
                    conversation=conversation,
                    registry=self._room_agent_registry(),
                    inputs=inputs,
                )
            except RunConflictError:
                await self.send_workflow_run_updated(
                    chat_id,
                    {
                        "error": "run_conflict",
                        "detail": "room already has an active run",
                    },
                )
            except Exception as exc:
                # Validation failures land here (the run is never created);
                # executor crashes additionally flip the persisted run to
                # failed inside ``WorkflowRunner.run``. Either way the room
                # must see the failure — a silent log line leaves the panel
                # showing a phantom "running" state.
                logger.exception("Workflow run failed for room {}", chat_id)
                await self.send_workflow_run_updated(
                    chat_id,
                    {
                        "error": "run_failed",
                        "detail": str(exc),
                    },
                )

        task = asyncio.create_task(_drive())
        self._workflow_tasks[chat_id] = task
        task.add_done_callback(lambda _t: self._workflow_tasks.pop(chat_id, None))
        await self._send_event(
            connection,
            "run_workflow_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
        )

    async def _handle_sync_stock_selection_schedule_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        """Sync a persisted SelectionStrategy schedule into the shared cron.

        The browser may request a strategy id, but schedule fields are read
        from the durable service record so a client cannot smuggle arbitrary
        cron expressions into the system.  Only the hidden stock room can
        address this command.
        """
        from mona.agent.pack_bootstrap import STOCK_ROOM_ID, sync_stock_selection_cron

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="sync_stock_selection_schedule_result"
        )
        if ctx is None:
            return
        chat_id, _conversation, request_id = ctx
        if chat_id != STOCK_ROOM_ID:
            await self._send_event(
                connection,
                "sync_stock_selection_schedule_result",
                ok=False,
                code="invalid_room",
                detail="stock selection schedules must use the hidden stock room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        strategy_id = envelope.get("strategy_id")
        if not isinstance(strategy_id, str) or not re.fullmatch(
            r"^[a-z][a-z0-9_-]{1,63}$", strategy_id.strip()
        ):
            await self._send_event(
                connection,
                "sync_stock_selection_schedule_result",
                ok=False,
                code="invalid_strategy_id",
                detail="malformed strategy_id",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        strategy_id = strategy_id.strip()
        try:
            from mona.services.stock.api import _provider
            from mona.services.stock.screening import default_screening_service

            service = default_screening_service(provider=_provider(), workspace=self.workspace)
            strategy = next(
                (item for item in service.strategies() if item.strategy_id == strategy_id),
                None,
            )
        except Exception as exc:
            await self._send_event(
                connection,
                "sync_stock_selection_schedule_result",
                ok=False,
                code="service_unavailable",
                detail=str(exc),
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if strategy is None:
            await self._send_event(
                connection,
                "sync_stock_selection_schedule_result",
                ok=False,
                code="strategy_not_found",
                detail="saved strategy not found",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        cron_service = getattr(self._subagent_manager, "cron_service", None)
        schedule = strategy.schedule.model_dump(mode="json")
        result = sync_stock_selection_cron(cron_service, strategy_id, schedule)
        ok = result.get("status") in {"registered", "disabled"}
        payload = dict(result)
        payload.update(
            {
                "ok": ok,
                "code": result.get("code") if not ok else None,
                "detail": (
                    "selection schedule synchronized" if ok else "selection schedule unavailable"
                ),
                "chat_id": chat_id,
                "request_id": request_id,
                "strategy_id": strategy_id,
            }
        )
        await self._send_event(
            connection,
            "sync_stock_selection_schedule_result",
            **payload,
        )

    async def _handle_cancel_workflow_run_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.jobs import JobNotFoundError, JobTransitionError
        from mona.agent.workflow import (
            TERMINAL_RUN_STATUSES,
            TERMINAL_STEP_STATUSES,
            WorkflowNotFoundError,
            WorkflowTransitionError,
            serialize_run,
        )

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="cancel_workflow_run_result"
        )
        if ctx is None:
            return
        chat_id, _conversation, request_id = ctx
        run_id = envelope.get("run_id")
        run_store = self._subagent_manager.run_store_for_room(chat_id)
        if not isinstance(run_id, str) or not run_id:
            # Default: cancel the room's active run (if any).
            runner = self._workflow_runner_for(chat_id)
            run_id = runner.active_run_for_room(chat_id)
            if run_id is None:
                latest = run_store.list_for_room(chat_id, limit=1)
                run_id = latest[0].id if latest else None
            if run_id is None:
                await self._send_event(
                    connection,
                    "cancel_workflow_run_result",
                    ok=False,
                    code="run_not_found",
                    detail="no run to cancel",
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
        try:
            run = run_store.load(run_id)
        except (WorkflowNotFoundError, ValueError):
            await self._send_event(
                connection,
                "cancel_workflow_run_result",
                ok=False,
                code="run_not_found",
                detail="run not found in this room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if run.room_id != chat_id:
            await self._send_event(
                connection,
                "cancel_workflow_run_result",
                ok=False,
                code="run_not_found",
                detail="run not found in this room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if run.status in TERMINAL_RUN_STATUSES:
            await self._send_event(
                connection,
                "cancel_workflow_run_result",
                ok=False,
                code="run_not_cancellable",
                detail="run is already terminal",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        runner = self._workflow_runner_for(chat_id)
        if runner.active_run_for_room(chat_id) == run_id:
            # Live loop: signal first, then cancel every currently linked
            # AgentJob.  The signal makes the runner own the run-level CAS;
            # cancelling the jobs makes an in-flight LLM task stop promptly.
            runner.cancel_run(run_id)
            job_ids = list(
                dict.fromkeys(
                    step.job_id
                    for step in run.steps.values()
                    if step.status not in TERMINAL_STEP_STATUSES
                    and isinstance(step.job_id, str)
                    and step.job_id
                )
            )

            async def _cancel_job(job_id: str) -> None:
                try:
                    await self._subagent_manager.cancel_job(
                        job_id,
                        room_id=chat_id,
                        reason="Cancelled by user.",
                    )
                except (JobNotFoundError, JobTransitionError, ValueError):
                    # Missing/terminal jobs are normal completion races.  The
                    # room id check in cancel_job also prevents cross-room
                    # job ids from being touched.
                    return
                except Exception:
                    logger.exception(
                        "Workflow run {}: unable to cancel job {}",
                        run_id,
                        job_id,
                    )

            if job_ids:
                await asyncio.gather(*(_cancel_job(job_id) for job_id in job_ids))

            # Let the runner observe the event and finish its CAS transitions
            # without a wall-clock sleep.  Several turns cover a TaskGroup
            # cancellation plus the observer callback, while the push below
            # remains authoritative if the runner is still unwinding.
            for _ in range(4):
                await asyncio.sleep(0)
                run = run_store.load(run_id)
                if run.status in TERMINAL_RUN_STATUSES:
                    break
        else:
            # Paused (waiting_approval) or orphaned run: CAS directly.
            reason = "Cancelled by user."
            for step_id, step in run.steps.items():
                if step.status in TERMINAL_STEP_STATUSES:
                    continue
                try:
                    run_store.transition_step(run_id, step_id, "cancelled", error=reason)
                except WorkflowTransitionError:
                    pass
            try:
                run = run_store.transition(run_id, "cancelled")
            except WorkflowTransitionError:
                pass
            run = run_store.load(run_id)
        await self._send_event(
            connection,
            "cancel_workflow_run_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            run_id=run_id,
            run=serialize_run(run),
        )
        current_payload = serialize_run(run_store.load(run_id))
        current_workflow = current_payload.get("workflow")
        current_workflow_id = (
            current_workflow.get("id") if isinstance(current_workflow, dict) else None
        )
        if isinstance(current_workflow_id, str) and current_workflow_id.startswith("discussion-"):
            await self.send_discussion_updated(chat_id, current_payload)
        else:
            await self.send_workflow_run_updated(chat_id, current_payload)

    async def _handle_retry_workflow_step_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        """Retry one failed agent step and resume the run in the background."""
        from mona.agent.workflow import (
            WorkflowNotFoundError,
            WorkflowRetryError,
            serialize_run,
        )

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="retry_workflow_step_result"
        )
        if ctx is None:
            return
        chat_id, _conversation, request_id = ctx
        run_id = envelope.get("run_id")
        step_id = envelope.get("step_id")
        if not isinstance(run_id, str) or not run_id or not isinstance(step_id, str) or not step_id:
            await self._send_event(
                connection,
                "retry_workflow_step_result",
                ok=False,
                code="invalid_request",
                detail="run_id and step_id are required",
                chat_id=chat_id,
                request_id=request_id,
            )
            return

        run_store = self._subagent_manager.run_store_for_room(chat_id)
        try:
            current = run_store.load(run_id)
        except (WorkflowNotFoundError, ValueError):
            current = None
        if current is None or current.room_id != chat_id:
            await self._send_event(
                connection,
                "retry_workflow_step_result",
                ok=False,
                code="run_not_found",
                detail="run not found in this room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        if step_id not in current.steps:
            await self._send_event(
                connection,
                "retry_workflow_step_result",
                ok=False,
                code="step_not_found",
                detail="step not found in this run",
                chat_id=chat_id,
                request_id=request_id,
            )
            return

        runner = self._workflow_runner_for(chat_id)
        if runner.active_run_for_room(chat_id) is not None:
            await self._send_event(
                connection,
                "retry_workflow_step_result",
                ok=False,
                code="run_active",
                detail="room already has an active workflow run",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        try:
            run = run_store.retry_step(run_id, step_id)
        except WorkflowNotFoundError:
            await self._send_event(
                connection,
                "retry_workflow_step_result",
                ok=False,
                code="step_not_found",
                detail="step not found in this run",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        except WorkflowRetryError as exc:
            await self._send_event(
                connection,
                "retry_workflow_step_result",
                ok=False,
                code=exc.code,
                detail=exc.detail,
                chat_id=chat_id,
                request_id=request_id,
            )
            return

        # Acknowledge the durable reset before starting LLM work.  The queued
        # snapshot is also pushed immediately so every client can render the
        # retry attempt without waiting for the first step transition.
        await self._send_event(
            connection,
            "retry_workflow_step_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            run_id=run_id,
            step_id=step_id,
        )
        await self.send_workflow_run_updated(chat_id, serialize_run(run))

        async def _resume() -> None:
            try:
                await runner.resume(run_id)
            except Exception:
                logger.exception(
                    "Workflow retry resume failed for run {} step {}",
                    run_id,
                    step_id,
                )

        task = asyncio.create_task(_resume())
        self._workflow_tasks[chat_id] = task
        task.add_done_callback(lambda _t: self._workflow_tasks.pop(chat_id, None))

    async def _handle_resolve_workflow_approval_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.workflow import (
            WorkflowApprovalError,
            WorkflowNotFoundError,
            serialize_run,
        )

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="resolve_workflow_approval_result"
        )
        if ctx is None:
            return
        chat_id, _conversation, request_id = ctx
        run_id = envelope.get("run_id")
        step_id = envelope.get("step_id")
        token = envelope.get("token")
        approve = envelope.get("approve")
        if (
            not isinstance(run_id, str)
            or not run_id
            or not isinstance(step_id, str)
            or not step_id
            or not isinstance(token, str)
            or not isinstance(approve, bool)
        ):
            await self._send_event(
                connection,
                "resolve_workflow_approval_result",
                ok=False,
                code="invalid_request",
                detail="run_id, step_id, token and a boolean approve are required",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        run_store = self._subagent_manager.run_store_for_room(chat_id)
        try:
            run = run_store.load(run_id)
        except (WorkflowNotFoundError, ValueError):
            run = None
        if run is None or run.room_id != chat_id:
            await self._send_event(
                connection,
                "resolve_workflow_approval_result",
                ok=False,
                code="run_not_found",
                detail="run not found in this room",
                chat_id=chat_id,
                request_id=request_id,
            )
            return
        runner = self._workflow_runner_for(chat_id)
        try:
            runner.resolve_approval(
                run_id=run_id,
                step_id=step_id,
                token=token,
                approve=approve,
            )
        except WorkflowApprovalError as exc:
            # State conflict / expired / bad token: push the authoritative
            # run state so the client refreshes instead of trusting its card.
            await self._send_event(
                connection,
                "resolve_workflow_approval_result",
                ok=False,
                code=exc.code,
                detail=exc.detail,
                chat_id=chat_id,
                request_id=request_id,
            )
            await self.send_workflow_run_updated(chat_id, serialize_run(run_store.load(run_id)))
            return
        await self._send_event(
            connection,
            "resolve_workflow_approval_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            run_id=run_id,
            step_id=step_id,
        )
        await self.send_workflow_run_updated(chat_id, serialize_run(run_store.load(run_id)))
        if approve:
            # Resume in the background: the run continues from the persisted
            # state with every downstream step still queued (guide 7.6).
            async def _resume() -> None:
                try:
                    await runner.resume(run_id)
                except Exception:
                    logger.exception("Workflow resume after approval failed for run {}", run_id)

            task = asyncio.create_task(_resume())
            self._workflow_tasks[chat_id] = task
            task.add_done_callback(lambda _t: self._workflow_tasks.pop(chat_id, None))

    async def _handle_get_workflow_run_envelope(
        self, connection: Any, envelope: dict[str, Any]
    ) -> None:
        from mona.agent.workflow import WorkflowNotFoundError, serialize_run

        ctx = await self._workflow_room_context(
            connection, envelope, result_event="workflow_run_state_result"
        )
        if ctx is None:
            return
        chat_id, _conversation, request_id = ctx
        run_id = envelope.get("run_id")
        run_store = self._subagent_manager.run_store_for_room(chat_id)
        run = None
        if isinstance(run_id, str) and run_id:
            try:
                run = run_store.load(run_id)
            except (WorkflowNotFoundError, ValueError):
                run = None
            if run is None or run.room_id != chat_id:
                await self._send_event(
                    connection,
                    "workflow_run_state_result",
                    ok=False,
                    code="run_not_found",
                    detail="run not found in this room",
                    chat_id=chat_id,
                    request_id=request_id,
                )
                return
        else:
            recent = run_store.list_for_room(chat_id, limit=50)
            run = next(
                (
                    candidate
                    for candidate in recent
                    if not candidate.workflow.id.startswith("discussion-")
                ),
                None,
            )
        await self._send_event(
            connection,
            "workflow_run_state_result",
            ok=True,
            chat_id=chat_id,
            request_id=request_id,
            run=serialize_run(run) if run is not None else None,
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
            if agent_kind is not None and not await _has_subscription_access():
                await self._send_event(
                    connection,
                    "error",
                    detail="membership_required",
                    reason="AI文档需要有效的 Mona Pro 订阅或试用",
                )
                return
            self._attach(connection, new_id)
            if (
                workspace is not None or agent_kind is not None
            ) and self._session_manager is not None:
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
            from mona.agent.pack_bootstrap import STOCK_DIAGNOSIS_ROOM_ID

            if cid == STOCK_DIAGNOSIS_ROOM_ID and not await _has_subscription_access():
                await self._send_event(connection, "error", detail="membership_required")
                return
            self._attach(connection, cid)
            await self._send_event(connection, "attached", chat_id=cid)
            await self._hydrate_after_subscribe(cid)
            return
        if t in {"ppt_upload", "doc_upload", "ppt_import_native", "ppt_delete_native"}:
            if not await _has_subscription_access():
                await self._send_event(connection, "error", detail="membership_required")
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
        if t == "create_direct_conversation":
            await self._handle_create_direct_conversation_envelope(connection, envelope)
            return
        if t == "agent_config_update":
            await self._handle_agent_config_update_envelope(connection, envelope)
            return
        if t == "custom_agent_create":
            await self._handle_custom_agent_create_envelope(connection, envelope)
            return
        if t == "agent_instruction_save":
            await self._handle_agent_instruction_save_envelope(connection, envelope)
            return
        if t == "agent_instruction_restore":
            await self._handle_agent_instruction_restore_envelope(connection, envelope)
            return
        if t == "agent_skill_stage":
            await self._handle_agent_skill_stage_envelope(connection, envelope)
            return
        if t == "agent_skill_action":
            await self._handle_agent_skill_action_envelope(connection, envelope)
            return
        if t == "agent_skill_update":
            await self._handle_agent_skill_update_envelope(connection, envelope)
            return
        if t == "resolve_agent_change":
            await self._handle_resolve_agent_change_envelope(connection, envelope)
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
        if t == "save_workflow_draft":
            await self._handle_save_workflow_draft_envelope(connection, envelope)
            return
        if t == "activate_workflow":
            await self._handle_activate_workflow_envelope(connection, envelope)
            return
        if t == "get_workflow":
            await self._handle_get_workflow_envelope(connection, envelope)
            return
        if t == "run_workflow":
            await self._handle_run_workflow_envelope(connection, envelope)
            return
        if t == "sync_stock_selection_schedule":
            await self._handle_sync_stock_selection_schedule_envelope(connection, envelope)
            return
        if t == "cancel_workflow_run":
            await self._handle_cancel_workflow_run_envelope(connection, envelope)
            return
        if t == "retry_workflow_step":
            await self._handle_retry_workflow_step_envelope(connection, envelope)
            return
        if t == "resolve_workflow_approval":
            await self._handle_resolve_workflow_approval_envelope(connection, envelope)
            return
        if t == "get_workflow_run":
            await self._handle_get_workflow_run_envelope(connection, envelope)
            return
        if t == "start_discussion":
            await self._handle_start_discussion_envelope(
                connection,
                sender_id=client_id,
                envelope=envelope,
            )
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
            from mona.agent.document_loop import DOCUMENT_PROFILES

            message_agent_kind = envelope.get("agent_kind")
            if message_agent_kind is not None:
                if not isinstance(message_agent_kind, str):
                    await self._send_event(connection, "error", detail="invalid agent_kind")
                    return
                message_agent_kind = message_agent_kind.strip()
                if message_agent_kind not in DOCUMENT_PROFILES:
                    await self._send_event(connection, "error", detail="invalid agent_kind")
                    return
                if not await _has_subscription_access():
                    await self._send_event(connection, "error", detail="membership_required")
                    return
            if self._session_manager is not None:
                session = self._session_manager.get_or_create(f"websocket:{cid}")
                if session.metadata.get("agent_kind") and not await _has_subscription_access():
                    await self._send_event(connection, "error", detail="membership_required")
                    return

            raw_media = envelope.get("media")
            media_paths: list[str] = []
            if raw_media is not None:
                if not isinstance(raw_media, list):
                    await self._send_event(
                        connection,
                        "error",
                        detail="image_rejected",
                        reason="malformed",
                    )
                    return
                media_paths, reason = self._save_envelope_media(raw_media)
                if reason is not None:
                    await self._send_event(
                        connection,
                        "error",
                        detail="image_rejected",
                        reason=reason,
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
                workspace = self.workspace
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
            if message_agent_kind is not None:
                metadata["agent_kind"] = message_agent_kind
            task_id = envelope.get("task_id")
            if isinstance(task_id, str) and _API_KEY_RE.fullmatch(task_id.strip()):
                metadata["task_id"] = task_id.strip()
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
            browser_tab_id = envelope.get("browser_tab_id")
            if isinstance(browser_tab_id, str) and browser_tab_id:
                metadata["browser_tab_id"] = browser_tab_id
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
                ws = self.workspace
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
            target_agent_ids = envelope.get("target_agent_ids")
            if target_agent_ids is not None:
                routed = await self._route_room_agent_mentions(
                    connection,
                    sender_id=client_id,
                    chat_id=cid,
                    content=content,
                    media_paths=media_paths,
                    metadata=metadata,
                    raw_targets=target_agent_ids,
                    raw_discussion=envelope.get("discussion"),
                )
                if routed:
                    return
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
        *,
        include_media: bool = True,
    ) -> None:
        payload: dict[str, Any] = {
            "event": "deliver_files",
            "chat_id": chat_id,
            "files": files,
        }
        if not include_media:
            payload["inline_media"] = False
        self._try_append_webui_transcript(chat_id, dict(payload))
        if include_media:
            media_urls = self._delivered_file_media(files)
            if media_urls:
                payload["media_urls"] = media_urls
        # The room panel is a reference projection rather than a filesystem
        # scan. Carry the source chat id so it can refresh only when this room
        # receives an explicit delivery; ordinary global watcher hints remain
        # chat-less and continue to refresh all Agent panels.
        await self.send_artifacts_changed(chat_id=chat_id)
        raw = json.dumps(payload, ensure_ascii=False)
        self.logger.debug(
            "deliver_files: sending to {} subscribers for chat_id={}, files={}",
            len(conns),
            chat_id,
            [f.get("name") for f in files],
        )
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" ")

    def _delivered_file_media(self, files: list[dict[str, Any]]) -> list[dict[str, str]]:
        media: list[dict[str, str]] = []
        for file in files:
            if not isinstance(file, dict):
                continue
            path_value = file.get("absolute_path")
            if not isinstance(path_value, str) or not path_value:
                continue
            path = Path(path_value)
            mime = str(file.get("mime") or mimetypes.guess_type(path.name)[0] or "")
            kind = (
                "video"
                if mime.startswith("video/")
                else "image"
                if mime.startswith("image/")
                else ""
            )
            if not kind:
                continue
            attachment = self._sign_or_stage_media_path(path)
            if attachment is not None:
                media.append({**attachment, "kind": kind})
        return media

    def _attach_file_edit_artifact_refs(
        self,
        chat_id: str,
        edits: list[Any],
        metadata: dict[str, Any],
    ) -> bool:
        """Attach ownership refs to successful edit traces, not deliveries."""
        if chat_id.startswith("ephemeral:"):
            return False
        from mona.agent.artifacts import ArtifactRef
        from mona.config.paths import get_agent_output_dir

        owner = self._session_artifact_owner(f"websocket:{chat_id}")
        if owner is None:
            return False
        base, default_agent_id = owner
        agent_id = str(metadata.get("_artifact_agent_id") or default_agent_id)
        try:
            root = get_agent_output_dir(base, agent_id).resolve()
        except (OSError, ValueError):
            return False
        room_id: str | None = None
        if self._session_manager is not None:
            try:
                session = self._session_manager.get_or_create(f"websocket:{chat_id}")
                if session.conversation_metadata.type == "room":
                    room_id = chat_id
            except Exception:
                logger.exception("Cannot resolve file-edit room owner for {}", chat_id)
        attached = False
        for item in edits:
            if not isinstance(item, dict) or item.get("status") != "done":
                continue
            if item.get("artifact_ref"):
                continue
            raw_path = item.get("absolute_path")
            if not isinstance(raw_path, str) or not raw_path:
                continue
            try:
                ref = ArtifactRef.for_path(
                    owner_kind="agent",
                    owner_id=agent_id,
                    root=root,
                    path=Path(raw_path),
                    created_by_agent_id=agent_id,
                    session_id=f"websocket:{chat_id}",
                    room_id=room_id,
                    job_id=metadata.get("job_id"),
                )
            except (OSError, ValueError):
                # Project sessions and edits outside the owner output are not
                # session artifacts; their project scan remains authoritative.
                continue
            item["artifact_ref"] = ref.model_dump(mode="json")
            attached = True
        return attached

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
            # Durable branches below still append their canonical transcript
            # records; only the final socket fan-out becomes a no-op.
            self.logger.debug("no active subscribers for chat_id={}", msg.chat_id)
        if msg.metadata.get("_workflow_step_activity"):
            # Live tool-activity stream of a workflow step job. Fanned out to
            # room subscribers only — persistence happens when the step's
            # result message is posted (it carries the same payloads).
            payload: dict[str, Any] = {
                "event": "workflow_step_activity",
                "chat_id": msg.chat_id,
                "run_id": msg.metadata.get("workflow_run_id"),
                "step_id": msg.metadata.get("workflow_step_id"),
                "job_id": msg.metadata.get("job_id"),
                "author_id": msg.metadata.get("author_id") or MONA_AGENT_ID,
                "tool_events": msg.metadata.get("tool_events") or [],
            }
            raw = json.dumps(payload, ensure_ascii=False)
            for connection in conns:
                await self._safe_send_to(connection, raw, label=" ")
            return
        if msg.metadata.get("_goal_state_sync"):
            blob = msg.metadata.get("goal_state")
            await self.send_goal_state(
                msg.chat_id, blob if isinstance(blob, dict) else {"active": False}
            )
            return
        if msg.metadata.get("_task_plan_sync"):
            blob = msg.metadata.get("task_plan")
            if isinstance(blob, dict):
                await self.send_task_plan(msg.chat_id, blob)
            return
        if msg.metadata.get("_goal_status"):
            status = msg.metadata.get("goal_status")
            if status in ("running", "idle"):
                started_raw = msg.metadata.get("started_at", msg.metadata.get("goal_started_at"))
                await self._send_combined_goal_status(
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
            get_count = getattr(self._subagent_manager, "get_running_count_by_session", None)
            if callable(get_count) and get_count(f"websocket:{msg.chat_id}") > 0:
                await self._send_combined_goal_status(msg.chat_id, "running")
            return
        if msg.metadata.get("_session_updated"):
            scope = msg.metadata.get("_session_update_scope")
            await self.send_session_updated(
                msg.chat_id,
                scope=scope if isinstance(scope, str) else None,
            )
            return
        if msg.metadata.get("_file_edit_events"):
            edits = msg.metadata["_file_edit_events"]
            attached = self._attach_file_edit_artifact_refs(
                msg.chat_id,
                edits if isinstance(edits, list) else [],
                msg.metadata,
            )
            payload: dict[str, Any] = {
                "event": "file_edit",
                "chat_id": msg.chat_id,
                "edits": edits,
            }
            self._try_append_webui_transcript(msg.chat_id, payload)
            if attached:
                await self.send_artifacts_changed(chat_id=msg.chat_id)
            raw = json.dumps(payload, ensure_ascii=False)
            for connection in conns:
                await self._safe_send_to(connection, raw, label=" ")
            return
        deliver_files_raw = msg.metadata.get("_deliver_files")
        deliver_files = deliver_files_raw if isinstance(deliver_files_raw, list) else []
        if deliver_files and not msg.content and not msg.media:
            await self._send_deliver_files_event(
                msg.chat_id,
                deliver_files,
                conns,
                include_media=not bool(msg.media),
            )
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
        job_id = msg.metadata.get("job_id")
        if isinstance(job_id, str) and job_id:
            payload["job_id"] = job_id
        workflow_run_id = msg.metadata.get("workflow_run_id")
        if isinstance(workflow_run_id, str) and workflow_run_id:
            payload["workflow_run_id"] = workflow_run_id
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
        task_plan = msg.metadata.get("task_plan")
        if isinstance(task_plan, dict):
            payload["task_plan"] = task_plan
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
            await self._send_deliver_files_event(
                msg.chat_id,
                deliver_files,
                conns,
                include_media=not bool(msg.media),
            )

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

    async def send_task_plan(self, chat_id: str, blob: dict[str, Any]) -> None:
        """Push the authoritative current-task plan snapshot."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body = {"event": "task_plan", "chat_id": chat_id, "task_plan": blob}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" task_plan ")

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

    async def send_workflow_updated(self, chat_id: str, payload: dict[str, Any]) -> None:
        """Broadcast a workflow definition/draft change to room subscribers."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "workflow_updated", "chat_id": chat_id, **payload}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" workflow_updated ")

    async def send_workflow_run_updated(self, chat_id: str, payload: dict[str, Any]) -> None:
        """Broadcast a workflow run state change to room subscribers."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "workflow_run_updated", "chat_id": chat_id, **payload}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" workflow_run_updated ")

    async def send_discussion_updated(self, chat_id: str, payload: dict[str, Any]) -> None:
        """Broadcast a topic discussion without exposing workflow UI semantics."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "discussion_updated", "chat_id": chat_id, **payload}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" discussion_updated ")

    async def send_artifacts_changed(self, *, chat_id: str | None = None) -> None:
        """Broadcast an artifact change hint to every open websocket connection.

        ``chat_id`` is attached to explicit delivery events. A missing id is a
        global filesystem watcher hint and is intentionally broader.
        """
        conns = list(self._conn_chats)
        if not conns:
            return
        payload: dict[str, Any] = {"event": "artifacts_changed"}
        if chat_id:
            payload["chat_id"] = chat_id
        raw = json.dumps(payload, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" artifacts_changed ")

    async def send_artifact_task_started(self, chat_id: str, task_id: str) -> None:
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        raw = json.dumps(
            {
                "event": "artifact_task_started",
                "chat_id": chat_id,
                "task_id": task_id,
            },
            ensure_ascii=False,
        )
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" artifact_task_started ")

    async def broadcast_ppt_phase_changed(self, project_name: str, phase: str) -> None:
        """Broadcast a PPT project phase change to every open websocket connection."""
        conns = list(self._conn_chats)
        if not conns:
            return
        raw = json.dumps(
            {
                "type": "ppt_phase_changed",
                "project_name": project_name,
                "phase": phase,
            },
            ensure_ascii=False,
        )
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" ppt_phase_changed ")

    async def broadcast_video_project_changed(self, project_name: str, hint: str = "") -> None:
        """Broadcast a video project state change to every open websocket connection.

        hint 语义：scenes（分镜/场景内容）、phase（阶段迁移）、
        progress（渲染进度高频）、status（其他元数据）。前端按 name 过滤、
        按 hint 决定刷新粒度。
        """
        conns = list(self._conn_chats)
        if not conns:
            return
        body: dict[str, Any] = {"event": "video_project_changed", "name": project_name}
        if hint:
            body["hint"] = hint
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" video_project_changed ")

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
