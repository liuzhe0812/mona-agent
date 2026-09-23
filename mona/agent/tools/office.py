"""Agent tool for live Mona Office sessions and legacy OfficeCLI reads."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import Field

from mona.agent.artifacts import ArtifactRef
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import (
    ArraySchema,
    BooleanSchema,
    IntegerSchema,
    NumberSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.bus.events import OUTBOUND_META_AGENT_UI, OutboundMessage
from mona.config.schema import Base
from mona.office.capabilities import get_capabilities
from mona.office.client import OfficeServiceClient
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.schemas import (
    OfficeApplyCommand,
    OfficeInspectRequest,
    OfficeInspectSuccess,
)

__all__ = ("OfficeTool", "OfficeToolConfig")

_MAX_OUTPUT_CHARS = 50_000
_MAX_BATCH_ITEMS = 50
_OFFICE_EXTS = {".docx", ".xlsx", ".pptx"}
_IMAGE_EXT_TO_MIME = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024


class OfficeToolConfig(Base):
    """Office document tool configuration."""

    enable: bool = True
    restrict_to_workspace: bool = False
    # Maximum output characters returned per call (protects context window).
    max_output_chars: int = Field(default=_MAX_OUTPUT_CHARS, ge=1000)
    # Timeout for a single officecli invocation.
    timeout_seconds: float = Field(default=60.0, ge=5.0, le=300.0)


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n[... truncated]"


def _asset_data_url(asset_path: object, workspace: Path) -> str:
    if not isinstance(asset_path, str) or not asset_path.strip():
        raise ValueError("assetPath must be a non-empty workspace path")
    try:
        resolved = resolve_workspace_path(asset_path, workspace, workspace)
    except (OSError, PermissionError, ValueError) as exc:
        raise ValueError(f"assetPath is not allowed: {exc}") from exc

    workspace = workspace.resolve()
    try:
        resolved.relative_to(workspace)
    except ValueError as exc:
        raise ValueError("assetPath must resolve inside the current workspace") from exc
    extension = resolved.suffix.lower()
    mime = _IMAGE_EXT_TO_MIME.get(extension)
    if mime is None:
        raise ValueError(
            "assetPath must use one of .jpg, .png, .webp, .gif, .bmp, or .svg"
        )
    if not resolved.is_file():
        raise ValueError(f"assetPath file not found: {asset_path}")
    size = resolved.stat().st_size
    if size > _MAX_IMAGE_BYTES:
        raise ValueError("assetPath image exceeds the 10 MB limit")
    encoded = base64.b64encode(resolved.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Operation: list | open | inspect | apply | save | export | close. close only when the user asks to close; never use it as edit/error recovery.",
            enum=[
                "list",
                "open",
                "inspect",
                "apply",
                "save",
                "export",
                "close",
            ],
        ),
        path=StringSchema("Workspace-relative Office file path for open", nullable=True),
        session_id=StringSchema(
            "Mona Office session ID; omit to use the active Office document from runtime context",
            nullable=True,
        ),
        document_type=StringSchema(
            "Document type for a new file: docs | sheets | slides",
            enum=["docs", "sheets", "slides"],
            nullable=True,
        ),
        new_document=BooleanSchema(description="For open only: explicitly create an additional blank document when the user requests a NEW document. Default false reuses the active session even when document_type is supplied. Not for recoloring or other edits."),
        display_name=StringSchema("Visible file name for a new Office document", nullable=True),
        query=ObjectSchema(
            {
                "mode": StringSchema(
                    "Inspect mode",
                    enum=[
                        "summary",
                        "range",
                        "outline",
                        "search",
                        "blocks",
                        "slides",
                        "capabilities",
                        "palette",
                        "selection",
                        "visual",
                        "review",
                        "changed_since",
                    ],
                ),
                "documentType": StringSchema(
                    "Optional capability document type; the live session type is authoritative",
                    enum=["docs", "sheets", "slides"],
                    nullable=True,
                ),
                "elementType": StringSchema(
                    "Optional capability element type filter",
                    min_length=1,
                    nullable=True,
                ),
                "operations": ArraySchema(
                    StringSchema("Capability operation name"),
                    description="For slides: omit for a compact operation directory; request actual names for full schemas (3 per response; nextOperations continues). Unknown names are reported alongside known operations.",
                    max_items=20,
                ),
                "includeData": BooleanSchema(description="For slides, false returns chart text style without categories and series; default true"),
                "presetId": StringSchema("For visual: render this preset in an isolated copy; does not change or review the live deck", nullable=True),
                "presetContent": ObjectSchema({}, description="Real preset content for capacity matching or visual preview; image.assetPath uses the workspace", additional_properties=True),
                "presetRole": StringSchema("For capabilities: optional preset role filter", nullable=True),
                "presetRelation": StringSchema(
                    "For capabilities: optional preset relation filter",
                    enum=["none", "parallel", "sequence", "hierarchy", "matrix", "cycle", "network"],
                    nullable=True,
                ),
                "usedPresetIds": ArraySchema(
                    StringSchema("Previously used preset ID"),
                    description="For capabilities: preset IDs already used in this deck, up to 100",
                    max_items=100,
                ),
                "presetLimit": IntegerSchema(
                    description="For capabilities: maximum matching presets to return",
                    minimum=1,
                    maximum=5,
                ),
                "presetContentRef": StringSchema(
                    "For capabilities or visual: reference to previously registered preset content",
                    nullable=True,
                ),
                "presetFamily": StringSchema("For capabilities: optional preset family filter", nullable=True),
                "presetTheme": StringSchema("For capabilities: dark-product or light-editorial", nullable=True),
                "slideIds": ArraySchema(
                    StringSchema("Stable slide ID"),
                    description="Slides to inspect, up to 50",
                    max_items=50,
                ),
                "elementIds": ArraySchema(
                    StringSchema("Stable slide element ID"),
                    description="Slide elements to inspect or capture, up to 50",
                    max_items=50,
                ),
                "pageIndex": IntegerSchema(
                    description="Zero-based Word page index for visual inspection",
                    minimum=0,
                    nullable=True,
                ),
                "slideId": StringSchema("Stable slide ID for visual inspection", nullable=True),
                "region": ObjectSchema(
                    {
                        "x": NumberSchema(
                            description="Non-negative region x coordinate", minimum=0
                        ),
                        "y": NumberSchema(
                            description="Non-negative region y coordinate", minimum=0
                        ),
                        "width": {
                            "type": "number",
                            "exclusiveMinimum": 0,
                            "description": "Positive region width",
                        },
                        "height": {
                            "type": "number",
                            "exclusiveMinimum": 0,
                            "description": "Positive region height",
                        },
                    },
                    required=["x", "y", "width", "height"],
                    description="Optional PPT region to capture",
                    additional_properties=False,
                    nullable=True,
                ),
                "padding": NumberSchema(
                    description="PPT region padding in pixels, from 0 to 100",
                    minimum=0,
                    maximum=100,
                ),
                "acceptWarnings": BooleanSchema(
                    description="Accept non-blocking slide warnings only after a prior full-slide visual inspection at the same version; requires reviewReason",
                ),
                "reviewReason": StringSchema("Specific reason for retaining the reported slide design issues after viewing the current full-slide image", nullable=True),
            },
            required=["mode"],
            description=(
                "Inspect query. Modes include summary, range, outline, search, blocks, slides, "
                "capabilities, selection, visual, and changed_since. Use capabilities for the "
                "current operation fields and selection for stable user targets."
            ),
            additional_properties=True,
            nullable=True,
        ),
        expected_version=ObjectSchema(
            {},
            description="Version returned by the latest inspect: editorEpoch and modelRevision",
            additional_properties=True,
            nullable=True,
        ),
        operations=ArraySchema(
            ObjectSchema({}, additional_properties=True),
            description=(
                "Atomic operations, up to 50 per apply. Use the relevant Office Skill for known "
                "fields; inspect capabilities with operations when a field schema is unknown. "
                "Use selection and slides inspection for stable target IDs. For slide_add_image, "
                "slide_compose image items and slide_add_preset content.image/content.images items, assetPath "
                "may reference an image in the current workspace; the tool converts it to dataUrl. Detailed examples are "
                "in the specialist Skill references."
            ),
            max_items=_MAX_BATCH_ITEMS,
            nullable=True,
        ),
        output=StringSchema("Workspace-relative native Office export path", nullable=True),
        overwrite_source=BooleanSchema(description="Explicitly overwrite the unchanged source file"),
        allow_unreviewed=BooleanSchema(description="Legacy draft option for non-slide documents. PPT agents cannot self-authorize bypassing review; save progress or let the user export directly in the editor."),
        required=["action"],
    )
)
class OfficeTool(Tool, ContextAware):
    """Inspect and modify Office documents through Mona Office sessions."""

    _scopes = {"core", "subagent"}
    config_key = "office"

    name = "office"
    description = (
        "Open and edit .docx, .xlsx, and .pptx files in Mona's live Office editor. "
        "Continue edits in the active session: brand color, fonts, layout and text changes NEVER require close/new/rebuilding. "
        "Inspect palette then use slide_replace_colors for exact in-place color changes. "
        "open(session_id) resumes; open(document_type) reuses an active document; new_document=true explicitly creates a new one. "
        "On an unknown operation inspect the compact capability directory, not close/recreate. "
        "Create presentations progressively with native text, shapes, images, charts and grid "
        "composition. slide_add_design creates polished, adjustable native designs (metric, evidence, "
        "waterfall, sankey, agenda, comparison, roadmap, matrix, image, items, statement); "
        "whole pages and explicit regions share the same components. Designs are starting points, not gates. "
        "Inspect reads the current in-memory document; open returns its latest version and "
        "connected selection. Use that version for apply. Follow the relevant Office Skill; "
        "inspect capabilities with operations only when a field schema is unknown. "
        "Save or export after applying structured operations. Version conflicts never overwrite "
        "newer user edits."
    )

    @classmethod
    def config_cls(cls):
        return OfficeToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.office.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        tool = cls(
            workspace=ctx.workspace,
            config=ctx.config.office,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
            services_port=ctx.services_port,
            bus=ctx.bus,
        )
        tool._agent_id = str(getattr(ctx, "agent_id", "mona") or "mona")
        return tool

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        config: OfficeToolConfig | None = None,
        restrict_to_workspace: bool = False,
        services_port: int = 17174,
        bus: Any | None = None,
    ) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()
        self.config = config or OfficeToolConfig()
        self._restrict = restrict_to_workspace or self.config.restrict_to_workspace
        self._services_port = services_port
        self._bus = bus
        self._owner_session_key = "cli:direct"
        self._active_session_id: str | None = None
        self._request_ctx: RequestContext | None = None
        self._agent_id = "mona"
        # source_path -> working_copy_path (accumulates edits across turns)
        self._working_copies: dict[str, Path] = {}
        # working_copy_path -> last known mtime (conflict detection: if the
        # user opened the working copy in system Office and saved changes, the
        # mtime will differ and we refuse the next batch to avoid clobbering).
        self._working_copy_mtimes: dict[str, float] = {}

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx
        self._owner_session_key = ctx.session_key or f"{ctx.channel}:{ctx.chat_id}"
        active_session_id = ctx.metadata.get("office_session_id")
        self._active_session_id = (
            active_session_id.strip()
            if isinstance(active_session_id, str) and active_session_id.strip()
            else None
        )

    def _active_workspace(self) -> Path:
        ws = get_current_workspace(self._workspace)
        return ws if ws is not None else self._workspace

    def _resolve(self, path: str) -> Path:
        ws = self._active_workspace()
        if self._restrict:
            try:
                return resolve_workspace_path(path, ws, ws)
            except (OSError, PermissionError, ValueError) as e:
                raise ValueError(f"path not allowed: {e}") from e
        p = Path(path).expanduser()
        return p if p.is_absolute() else ws / p

    def _ensure_office_ext(self, path: Path) -> None:
        if path.suffix.lower() not in _OFFICE_EXTS:
            raise ValueError(
                f"unsupported file type '{path.suffix}'. Supported: {sorted(_OFFICE_EXTS)}"
            )

    def _get_or_create_working_copy(self, source: Path) -> Path:
        """Return the working copy path for *source*, creating it on first use."""
        key = str(source.resolve())
        cached = self._working_copies.get(key)
        if cached and cached.is_file():
            return cached

        ws = self._active_workspace()
        copies_dir = ws / "uploads" / "office"
        copies_dir.mkdir(parents=True, exist_ok=True)
        short_id = uuid.uuid4().hex[:8]
        dest = copies_dir / f"{short_id}-{source.name}"
        shutil.copy2(source, dest)
        self._working_copies[key] = dest
        self._working_copy_mtimes[str(dest)] = dest.stat().st_mtime
        logger.info("office: created working copy for {}", source.name)
        return dest

    def _check_working_copy_fresh(self, working_copy: Path) -> bool:
        """Return True if the working copy's mtime matches the last recorded value.

        A mismatch means the user opened the working copy in system Office and
        saved external changes. We refuse the next batch to avoid clobbering.
        After this check, the mtime is refreshed so the agent's own batch writes
        don't trigger a false positive on the next turn.
        """
        key = str(working_copy)
        if not working_copy.is_file():
            return False
        current = working_copy.stat().st_mtime
        recorded = self._working_copy_mtimes.get(key)
        if recorded is None:
            # First observed mutation on a working copy we didn't create
            # (e.g. agent was reloaded). Trust the current mtime.
            self._working_copy_mtimes[key] = current
            return True
        return abs(current - recorded) < 0.001

    def _prepare_slide_assets(
        self,
        operations: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        workspace = self._active_workspace().resolve()
        prepared: list[dict[str, Any]] = []
        for operation in operations:
            copied_operation = dict(operation)
            payload = operation.get("payload")
            if not isinstance(payload, dict):
                prepared.append(copied_operation)
                continue

            copied_payload = dict(payload)
            if operation.get("op") == "slide_add_image" and "assetPath" in payload:
                copied_payload["dataUrl"] = _asset_data_url(payload["assetPath"], workspace)
                copied_payload.pop("assetPath", None)
            elif operation.get("op") == "slide_compose":
                items = payload.get("items")
                if isinstance(items, list):
                    copied_items: list[object] = []
                    for item in items:
                        if (
                            isinstance(item, dict)
                            and item.get("type") == "image"
                            and "assetPath" in item
                        ):
                            copied_item = dict(item)
                            copied_item["dataUrl"] = _asset_data_url(
                                item["assetPath"], workspace
                            )
                            copied_item.pop("assetPath", None)
                            copied_items.append(copied_item)
                        else:
                            copied_items.append(item)
                    copied_payload["items"] = copied_items
            elif operation.get("op") in {"slide_add_preset", "slide_add_design"}:
                content = payload.get("content")
                if isinstance(content, dict):
                    copied_content = dict(content)
                    image = content.get("image")
                    if isinstance(image, dict) and "assetPath" in image:
                        copied_image = dict(image)
                        copied_image["dataUrl"] = _asset_data_url(image["assetPath"], workspace)
                        copied_image.pop("assetPath", None)
                        copied_content["image"] = copied_image
                    images = content.get("images")
                    if isinstance(images, list):
                        copied_images: list[object] = []
                        for item in images:
                            if isinstance(item, dict) and "assetPath" in item:
                                copied_item = dict(item)
                                copied_item["dataUrl"] = _asset_data_url(
                                    item["assetPath"], workspace
                                )
                                copied_item.pop("assetPath", None)
                                copied_images.append(copied_item)
                            else:
                                copied_images.append(item)
                        copied_content["images"] = copied_images
                    copied_payload["content"] = copied_content
            copied_operation["payload"] = copied_payload
            prepared.append(copied_operation)
        return prepared

    @property
    def read_only(self) -> bool:
        return False

    @staticmethod
    def _session_error_json(
        error: OfficeError,
        *,
        recovery_session_id: str | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "ok": False,
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
            },
        }
        if error.code == OfficeErrorCode.EDITOR_UNAVAILABLE and recovery_session_id:
            payload["recovery"] = {
                "action": "open",
                "session_id": recovery_session_id,
            }
        return json.dumps(payload, ensure_ascii=False)

    @staticmethod
    def _add_session_recovery(
        payload: dict[str, Any],
        *,
        session_id: str,
    ) -> dict[str, Any]:
        error = payload.get("error")
        if (
            payload.get("ok") is False
            and isinstance(error, dict)
            and error.get("code") == OfficeErrorCode.EDITOR_UNAVAILABLE
        ):
            payload["recovery"] = {"action": "open", "session_id": session_id}
        return payload

    async def execute(
        self,
        action: str,
        path: str | None = None,
        session_id: str | None = None,
        document_type: str | None = None,
        display_name: str | None = None,
        query: dict[str, Any] | None = None,
        expected_version: dict[str, Any] | None = None,
        operations: list[dict[str, Any]] | None = None,
        output: str | None = None,
        overwrite_source: bool = False,
        allow_unreviewed: bool = False,
        new_document: bool = False,
        selector: str | None = None,
        node_path: str | None = None,
        mode: str | None = None,
        commands: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> str | list[dict[str, Any]]:
        from mona.api.office_cli import OfficeCliClient, OfficeCliError

        if action in {"list", "open", "inspect", "apply", "save", "export", "close"} or session_id:
            recovery_session_id = session_id
            if recovery_session_id is None and (
                action != "open" or (not path and not new_document)
            ):
                recovery_session_id = self._active_session_id
            try:
                return await self._execute_session_action(
                    action=action,
                    path=path,
                    session_id=session_id,
                    document_type=document_type,
                    display_name=display_name,
                    query=query,
                    expected_version=expected_version,
                    operations=operations,
                    output=output,
                    overwrite_source=overwrite_source,
                    allow_unreviewed=allow_unreviewed,
                    new_document=new_document,
                )
            except OfficeError as exc:
                return self._session_error_json(
                    exc,
                    recovery_session_id=recovery_session_id,
                )

        if not path:
            return "Error: 'path' is required for legacy OfficeCLI actions"

        try:
            resolved = self._resolve(path)
        except ValueError as e:
            return f"Error: {e}"

        if not resolved.is_file():
            return f"Error: file not found: {path}"

        try:
            self._ensure_office_ext(resolved)
        except ValueError as e:
            return f"Error: {e}"

        client = OfficeCliClient(
            workspace=self._active_workspace(),
            timeout=self.config.timeout_seconds,
        )
        if not client.available:
            return (
                "Error: the legacy OfficeCLI editor is unavailable and is no longer "
                "distributed by Mona."
            )

        # For mutating actions, operate on a working copy.
        target_path = str(resolved)
        working_copy_rel: str | None = None
        working_copy_abs: Path | None = None
        if action == "batch":
            if not commands:
                return "Error: 'commands' is required for the 'batch' action"
            try:
                working_copy = self._get_or_create_working_copy(resolved)
            except Exception as e:
                return f"Error: failed to create working copy: {e}"
            # Conflict detection: refuse to batch if the working copy was
            # modified externally (user opened it in system Office and saved).
            if not self._check_working_copy_fresh(working_copy):
                return (
                    "Error: working copy was modified externally since the last batch. "
                    "The user likely opened it in system Office and saved changes. "
                    "Refusing to batch to avoid clobbering those edits. "
                    "Ask the user how to proceed: either re-import the original file "
                    "to start fresh, or describe the external changes so they can be "
                    "re-applied on top of the current state."
                )
            working_copy_abs = working_copy
            working_copy_rel = str(working_copy.relative_to(self._active_workspace())).replace("\\", "/")
            target_path = working_copy_rel

        try:
            if action == "inspect":
                result = await client.inspect(target_path)
            elif action == "query":
                if not selector:
                    return "Error: 'selector' is required for the 'query' action"
                result = await client.query(target_path, selector)
            elif action == "view":
                result = await client.view(target_path, mode or "outline")
            elif action == "get":
                result = await client.get_node(target_path, node_path or "/")
            elif action == "validate":
                result = await client.validate(target_path)
            elif action == "batch":
                result = await client.batch(target_path, commands)
            else:
                return f"Error: unknown action '{action}'"
        except OfficeCliError as e:
            return f"Error: {e}"
        except Exception as e:
            logger.exception("office tool error")
            return f"Error: {type(e).__name__}: {e}"

        # Build the text response.
        parts: list[str] = []
        if not result.ok:
            parts.append(f"officecli exited with code {result.exit_code}")
            if result.stderr.strip():
                parts.append(f"stderr: {result.stderr.strip()}")
            return "\n".join(parts)

        # Prefer parsed JSON; fall back to raw stdout.
        if result.json is not None:
            import json as _json
            body = _json.dumps(result.json, ensure_ascii=False, indent=2)
        else:
            body = result.stdout.strip()

        if working_copy_rel:
            parts.append(f"<!-- working_copy: {working_copy_rel} -->")
        parts.append(_truncate(body, self.config.max_output_chars))

        # For batch operations, run validation on the modified working copy
        # so the agent gets immediate feedback on whether the edits broke
        # the document structure.
        if action == "batch" and working_copy_rel:
            # Refresh recorded mtime so our own batch write doesn't trigger a
            # false-positive conflict on the next turn.
            if working_copy_abs is not None:
                self._working_copy_mtimes[str(working_copy_abs)] = working_copy_abs.stat().st_mtime
            try:
                vresult = await client.validate(working_copy_rel)
                if vresult.ok:
                    parts.append("\n✓ validate: document is well-formed")
                else:
                    parts.append(
                        f"\n⚠ validate: document may have issues "
                        f"(exit {vresult.exit_code}): {vresult.stderr.strip()}"
                    )
            except Exception as e:
                parts.append(f"\n⚠ validate skipped: {e}")

        return "\n".join(parts)

    async def _execute_session_action(
        self,
        *,
        action: str,
        path: str | None,
        session_id: str | None,
        document_type: str | None,
        display_name: str | None,
        query: dict[str, Any] | None,
        expected_version: dict[str, Any] | None,
        operations: list[dict[str, Any]] | None,
        output: str | None,
        overwrite_source: bool,
        allow_unreviewed: bool = False,
        new_document: bool = False,
    ) -> str | list[dict[str, Any]]:
        client = OfficeServiceClient.from_port(self._services_port)
        owner = self._owner_session_key
        if not isinstance(new_document, bool):
            return "Error: new_document must be a boolean"
        if new_document and (action != "open" or session_id or path or document_type is None):
            return "Error: new_document requires open + document_type, without session_id or path"
        if not session_id and action != "list" and not new_document:
            session_id = self._active_session_id
        if action == "list":
            sessions = await client.list(owner_session_key=owner)
            return json.dumps(
                {
                    "sessions": [
                        session.model_dump(by_alias=True, mode="json") for session in sessions
                    ]
                },
                ensure_ascii=False,
                indent=2,
            )
        if action == "open":
            if session_id and not path and not new_document:
                result = await client.get(session_id, owner_session_key=owner)
                if document_type is not None and document_type != result.type:
                    return "Error: active document type differs; use its session_id to edit, or new_document=true only for an explicitly requested new file"
                await self._publish_session_open(result.model_dump(by_alias=True, mode="json"))
            else:
                resolved: Path | None = None
                workspace = self._active_workspace()
                if document_type not in {None, "docs", "sheets", "slides"}:
                    return "Error: document_type must be docs, sheets, or slides"
                if path:
                    try:
                        resolved = resolve_workspace_path(path, workspace, workspace)
                    except (OSError, PermissionError, ValueError) as exc:
                        return f"Error: path not allowed: {exc}"
                    if resolved.suffix.lower() not in _OFFICE_EXTS:
                        return "Error: the live editor supports .docx, .xlsx, and .pptx files only"
                elif document_type is None:
                    return "Error: 'path', 'document_type', or a recoverable 'session_id' is required for 'open'"
                result = await client.open(
                    owner_session_key=owner,
                    path=resolved,
                    document_type=document_type,
                    display_name=display_name,
                )
                await self._publish_session_open(result.model_dump(by_alias=True, mode="json"))

            self._active_session_id = result.session_id
            if (not result.editor_connected and self._bus is not None and self._request_ctx is not None
                and self._request_ctx.channel == "websocket"):
                for _ in range(40):
                    await asyncio.sleep(0.2)
                    result = await client.get(result.session_id, owner_session_key=owner)
                    if result.editor_connected:
                        break
            if not result.editor_connected:
                payload = result.model_dump(
                    by_alias=True,
                    mode="json",
                    exclude_none=True,
                )
                payload["recovery"] = {
                    "action": "open",
                    "session_id": result.session_id,
                }
                return json.dumps(payload, ensure_ascii=False, indent=2)
            try:
                selection_result = await client.inspect(
                    OfficeInspectRequest(
                        session_id=result.session_id,
                        query={"mode": "selection"},
                    ),
                    owner_session_key=owner,
                )
            except OfficeError as exc:
                return self._session_error_json(
                    exc,
                    recovery_session_id=result.session_id,
                )
            if not selection_result.ok:
                payload = selection_result.model_dump(
                    by_alias=True,
                    mode="json",
                    exclude_none=True,
                )
                self._add_session_recovery(payload, session_id=result.session_id)
                return json.dumps(payload, ensure_ascii=False, indent=2)
            if selection_result.result.mode != "selection":
                raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "编辑器未返回当前选区信息。")
            payload = result.model_dump(
                by_alias=True,
                mode="json",
                exclude_none=True,
            )
            payload["version"] = selection_result.version.model_dump(
                by_alias=True,
                mode="json",
            )
            payload["selection"] = selection_result.result.model_dump(
                by_alias=True,
                mode="json",
                exclude_none=True,
            )
            return json.dumps(payload, ensure_ascii=False, indent=2)
        if not session_id:
            return f"Error: 'session_id' is required for '{action}'"
        if action == "inspect":
            if query is None:
                return "Error: 'query' is required for 'inspect'"
            if isinstance(query.get("presetContent"), dict):
                prepared = self._prepare_slide_assets([{
                    "op": "slide_add_preset", "payload": {"content": query["presetContent"]},
                }])
                query = {**query, "presetContent": prepared[0]["payload"]["content"]}
            request = OfficeInspectRequest(session_id=session_id, query=query)
            if request.query.mode == "capabilities":
                session = await client.get(session_id, owner_session_key=owner)
                session_type = getattr(session, "document_type", None) or getattr(
                    session, "type", None
                )
                if session_type in {"docs", "sheets"}:
                    try:
                        capabilities = get_capabilities(
                            session_type,
                            getattr(request.query, "element_type", None),
                            request.query.operations,
                        )
                    except ValueError as exc:
                        return f"Error: {exc}"
                    result = OfficeInspectSuccess(
                        ok=True,
                        request_id=f"inspect_{uuid.uuid4().hex}",
                        session_id=session_id,
                        version=session.version,
                        result={
                            "mode": "capabilities",
                            "document_type": session_type,
                            "operations": capabilities,
                        },
                    )
                else:
                    result = await client.inspect(request, owner_session_key=owner)
            else:
                result = await client.inspect(request, owner_session_key=owner)
            if not result.ok:
                payload = result.model_dump(
                    by_alias=True,
                    mode="json",
                    exclude_none=True,
                )
                self._add_session_recovery(payload, session_id=session_id)
                return json.dumps(payload, ensure_ascii=False, indent=2)
            if result.result.mode == "visual":
                payload = result.model_dump(by_alias=True, mode="json")
                data_url = payload["result"].pop("dataUrl")
                return [
                    {"type": "text", "text": json.dumps(payload, ensure_ascii=False)},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]
            return result.model_dump_json(by_alias=True, indent=2)
        if action in {"apply", "batch"}:
            if expected_version is None or not operations:
                return "Error: 'expected_version' and 'operations' are required for 'apply'"
            try:
                prepared_operations = self._prepare_slide_assets(operations)
                command = OfficeApplyCommand(
                    session_id=session_id,
                    operation_id=f"op_{uuid.uuid4().hex}",
                    expected_version=expected_version,
                    operations=prepared_operations,
                )
            except ValueError as exc:
                return f"Error: {exc}"
            result = await client.apply(command, owner_session_key=owner)
            payload = result.model_dump(
                by_alias=True,
                mode="json",
                exclude_none=True,
                exclude_unset=True,
            )
            self._add_session_recovery(payload, session_id=session_id)
            return json.dumps(payload, ensure_ascii=False, indent=2)
        if action == "save":
            result = await client.save(
                session_id,
                owner_session_key=owner,
                overwrite_source=overwrite_source,
                version=expected_version,
            )
            return json.dumps(result, ensure_ascii=False, indent=2)
        if action == "export":
            if not output:
                return "Error: 'output' is required for 'export'"
            workspace = self._active_workspace()
            try:
                exported = resolve_workspace_path(output, workspace, workspace)
            except (OSError, PermissionError, ValueError) as exc:
                return f"Error: path not allowed: {exc}"
            session = await client.get(session_id, owner_session_key=owner)
            review_payload = None
            if session.type == 'slides' and allow_unreviewed:
                return json.dumps({'ok': False, 'error': {
                    'code': OfficeErrorCode.REVIEW_REQUIRED, 'retryable': False,
                    'message': 'Agent 不能自行跳过 PPT 验收。可 save 保存进度；用户可在编辑器中直接导出草稿，或继续检查并修复后正常导出。',
                }}, ensure_ascii=False)
            export_version = expected_version
            if session.type in {"docs", "sheets", "slides"}:
                review = await client.inspect(
                    OfficeInspectRequest(session_id=session_id, query={"mode": "review"}),
                    owner_session_key=owner,
                )
                if not review.ok:
                    return review.model_dump_json(by_alias=True, exclude_none=True)
                if review.result.mode != "review":
                    raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "编辑器未返回有效的审阅状态，请重新打开编辑器。")
                review_payload = review.result.model_dump(by_alias=True, mode="json")
                current = review.version.model_dump(by_alias=True, mode="json")
                if expected_version is not None and expected_version != current:
                    return json.dumps({"ok": False, "currentVersion": current, "error": {
                        "code": OfficeErrorCode.VERSION_CONFLICT,
                        "message": "文档在审阅前已变化，请按当前版本检查后再导出。", "retryable": True,
                    }}, ensure_ascii=False)
                export_version = current
                blocking_warnings = [
                    warning for warning in review.result.warnings
                    if warning.startswith("[错误]")
                    or "文字可能溢出" in warning
                    or "文字溢出" in warning
                    or "文字相互重叠" in warning
                    or "超出页面边界" in warning
                ]
                pending_slides = list(review.result.pending_slide_ids)
                pending_targets = list(review.result.pending_targets)
                pending = pending_slides or pending_targets
                if (pending or blocking_warnings) and not allow_unreviewed:
                    if session.type == "slides":
                        next_queries = [{"mode": "visual", "slideId": page} for page in pending_slides]
                    elif session.type == "docs":
                        next_queries = [{"mode": "visual", "pageIndex": 0}]
                    else:
                        next_queries = []
                        for target in pending_targets:
                            sheet, separator, cell_range = target.partition("!")
                            next_queries.append(
                                {"mode": "range", "sheet": sheet, "range": cell_range,
                                 "includeFormula": True, "includeStyle": True}
                                if separator and re.fullmatch(r"[A-Za-z]+[1-9]\d*(?::[A-Za-z]+[1-9]\d*)?", cell_range)
                                else {"mode": "summary"}
                            )
                    return json.dumps({"ok": False, "sessionId": session_id, "currentVersion": current,
                        "error": {"code": OfficeErrorCode.REVIEW_REQUIRED, "retryable": True,
                            "message": "Office 文件仍有未完成的质量验收。请按建议查询核对并修复错误后再导出；保存草稿不受影响。"},
                        "review": review_payload,
                        "blockingWarnings": blocking_warnings,
                        "nextQueries": next_queries,
                    }, ensure_ascii=False)
            result = await client.export(
                session_id,
                owner_session_key=owner,
                output=str(exported),
                version=export_version,
            )
            if review_payload is not None:
                result = {**result, "review": {**review_payload,
                    "status": "draft" if allow_unreviewed else "no_pending_quality_review",
                    "note": "视觉观察记录不等于自动证明设计合格或原文内容完整。",
                }}
            await self._publish_export(exported)
            return json.dumps(result, ensure_ascii=False, indent=2)
        if action == "close":
            await client.close(session_id, owner_session_key=owner)
            return json.dumps({"ok": True, "sessionId": session_id}, ensure_ascii=False)
        return f"Error: unknown session action '{action}'"

    async def _publish_session_open(self, session: dict[str, Any]) -> None:
        if self._bus is None or self._request_ctx is None:
            return
        await self._bus.publish_outbound(
            OutboundMessage(
                channel=self._request_ctx.channel,
                chat_id=self._request_ctx.chat_id,
                content="",
                metadata={
                    "_progress": True,
                    OUTBOUND_META_AGENT_UI: {
                        "kind": "office_session",
                        "data": {"version": 1, "action": "open", "session": session},
                    },
                },
            )
        )

    async def _publish_export(self, path: Path) -> None:
        if self._bus is None or self._request_ctx is None or not path.is_file():
            return
        workspace = self._active_workspace().resolve()
        ref = ArtifactRef.for_path(
            owner_kind="agent",
            owner_id=self._agent_id,
            root=workspace,
            path=path,
            created_by_agent_id=self._agent_id,
            session_id=self._request_ctx.session_key,
            room_id=str(self._request_ctx.metadata.get("room_id") or "") or None,
        )
        stat = path.stat()
        await self._bus.publish_outbound(
            OutboundMessage(
                channel=self._request_ctx.channel,
                chat_id=self._request_ctx.chat_id,
                content="",
                metadata={
                    "_deliver_files": [
                        {
                            "path": path.relative_to(workspace).as_posix(),
                            "absolute_path": str(path),
                            "name": path.name,
                            "size": stat.st_size,
                            "size_human": f"{stat.st_size / 1024:.1f} KB",
                            "mime": mimetypes.guess_type(path.name)[0]
                            or "application/octet-stream",
                            "summary": "Office 文档已导出",
                            "artifact_ref": ref.model_dump(mode="json"),
                        }
                    ]
                },
            )
        )
