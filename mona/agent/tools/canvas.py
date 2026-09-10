"""Agent tool for the active Mona flowchart canvas."""

from __future__ import annotations

import base64
import json
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import (
    ArraySchema,
    BooleanSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke_async
from mona.config.schema import Base

__all__ = ("CanvasTool", "CanvasToolConfig")


class CanvasToolConfig(Base):
    """Configuration for live Mona canvas control."""

    enable: bool = True


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Operation: open | inspect | apply | export",
            enum=["open", "inspect", "apply", "export"],
        ),
        canvas_id=StringSchema(
            "Active canvas ID. Omit to use the canvas attached to this conversation.",
            nullable=True,
        ),
        path=StringSchema(
            "Workspace-relative .mona-canvas path used to reactivate an unmounted canvas",
            nullable=True,
        ),
        patch=ObjectSchema(
            {
                "baseHash": StringSchema("semanticHash from the latest canvas response"),
                "baseDocumentHash": StringSchema("documentHash from the latest canvas response"),
                "ops": ArraySchema(ObjectSchema({}, additional_properties=True), max_items=50),
            },
            description=(
                "Validated Mona flowchart patch with baseHash, baseDocumentHash, and ops. "
                "Required for apply. Send an object, not a JSON string."
            ),
            required=["ops"],
            additional_properties=False,
            nullable=True,
        ),
        patch_path=StringSchema(
            "Workspace-relative JSON patch file copied from a Skill asset or created for this task",
            nullable=True,
        ),
        base_hash=StringSchema("Current semanticHash, if not included in patch or patch_path", nullable=True),
        base_document_hash=StringSchema("Current documentHash, if not included in patch or patch_path", nullable=True),
        include_visual=BooleanSchema(
            description="For inspect, include a current rendered canvas image for visual review."
        ),
        format=StringSchema(
            "Export format",
            enum=["png", "svg"],
            nullable=True,
        ),
        output=StringSchema(
            "Workspace-relative output path for export",
            nullable=True,
        ),
        required=["action"],
    )
)
class CanvasTool(Tool, ContextAware):
    """Inspect and edit the active Mona canvas through the mounted editor."""

    _scopes = {"core", "subagent"}
    config_key = "canvas"

    name = "canvas"
    description = (
        "Open, inspect, edit, and export the active Mona flowchart canvas. "
        "Use open once to obtain stable object IDs and both hashes, then apply a minimal patch. "
        "For a complex new diagram, submit complete module batches with the latest hashes "
        "so each real edit is visible in the conversation sidebar. "
        "Inspect with include_visual after generation or layout changes so the actual rendered canvas "
        "is reviewed. The editor rejects stale hashes and returns exact quality issues."
    )

    @classmethod
    def config_cls(cls):
        return CanvasToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.canvas.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, config=ctx.config.canvas)

    def __init__(
        self,
        *,
        workspace: str | Path,
        config: CanvasToolConfig | None = None,
    ) -> None:
        self._workspace = Path(workspace).expanduser()
        self.config = config or CanvasToolConfig()
        self._active_canvas_id: str | None = None
        self._active_canvas_path: str | None = None
        self._active_session_key: str | None = None
        self.is_available = False

    def set_context(self, ctx: RequestContext) -> None:
        session_key = str(ctx.session_key or ctx.chat_id or "").strip() or None
        canvas_id = ctx.metadata.get("canvas_id")
        next_canvas_id = (
            canvas_id.strip()
            if isinstance(canvas_id, str) and canvas_id.strip()
            else None
        )
        if next_canvas_id:
            if session_key != self._active_session_key or next_canvas_id != self._active_canvas_id:
                self._active_canvas_path = None
            self._active_canvas_id = next_canvas_id
            self._active_session_key = session_key
        elif session_key != self._active_session_key:
            self._active_canvas_id = None
            self._active_canvas_path = None
            self._active_session_key = session_key
            restored = self._find_canvas_for_chat(ctx.chat_id)
            if restored:
                self._active_canvas_id, self._active_canvas_path = restored
        self.is_available = self._active_canvas_id is not None
        canvas_path = ctx.metadata.get("canvas_path")
        if isinstance(canvas_path, str) and canvas_path.strip():
            self._active_canvas_path = canvas_path.strip()

    def _active_workspace(self) -> Path:
        return get_current_workspace(self._workspace) or self._workspace

    def _find_canvas_for_chat(self, chat_id: str) -> tuple[str, str] | None:
        canvas_dir = self._active_workspace().resolve() / "canvases"
        latest: tuple[int, str, str] | None = None
        try:
            paths = list(canvas_dir.glob("*.mona-canvas"))
        except OSError:
            return None
        for candidate in paths:
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
                canvas_id = payload.get("id") if isinstance(payload, dict) else None
                origin_chat_id = payload.get("originChatId") if isinstance(payload, dict) else None
                if origin_chat_id != chat_id or not isinstance(canvas_id, str) or not canvas_id:
                    continue
                modified = candidate.stat().st_mtime_ns
                resolved = str(candidate.resolve())
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            item = (modified, canvas_id, resolved)
            if latest is None or item[0] > latest[0]:
                latest = item
        return (latest[1], latest[2]) if latest else None

    def _write_export(self, output: str, format_name: str, data: str) -> Path:
        workspace = self._active_workspace().resolve()
        path = resolve_workspace_path(output, workspace, workspace)
        path.parent.mkdir(parents=True, exist_ok=True)
        if format_name == "png":
            prefix = "data:image/png;base64,"
            if not data.startswith(prefix):
                raise ValueError("canvas export did not return PNG data")
            path.write_bytes(base64.b64decode(data[len(prefix) :], validate=True))
        else:
            svg = urllib.parse.unquote(data.split(",", 1)[1]) if data.startswith("data:image/svg+xml") else data
            path.write_text(svg, encoding="utf-8")
        return path

    async def execute(
        self,
        action: str,
        canvas_id: str | None = None,
        path: str | None = None,
        patch: dict[str, Any] | None = None,
        patch_path: str | None = None,
        base_hash: str | None = None,
        base_document_hash: str | None = None,
        include_visual: bool = False,
        format: str | None = None,
        output: str | None = None,
        **_: Any,
    ) -> str | list[dict[str, Any]]:
        if action == "apply" and patch is None and not patch_path:
            return "Error: 'patch' or 'patch_path' is required for apply"
        if action == "apply" and patch is None and patch_path:
            try:
                workspace = self._active_workspace().resolve()
                source = resolve_workspace_path(patch_path, workspace, workspace)
                if source.stat().st_size > 64 * 1024:
                    return "Error: patch_path exceeds the 64 KiB patch limit"
                loaded = json.loads(source.read_text(encoding="utf-8"))
                if not isinstance(loaded, dict):
                    return "Error: patch_path must contain a JSON object"
                patch = loaded
            except (OSError, ValueError, json.JSONDecodeError) as error:
                return f"Error: invalid patch_path: {error}"
        if action == "apply":
            if not isinstance(patch, dict):
                return "Error: patch must be an object"
            patch = dict(patch)
            for key, value in (("baseHash", base_hash), ("baseDocumentHash", base_document_hash)):
                if value is not None:
                    if key in patch and patch[key] != value and not (
                        isinstance(patch[key], str) and patch[key].startswith("<")
                    ):
                        return f"Error: {key} conflicts with the top-level hash"
                    patch[key] = value
                if not isinstance(patch.get(key), str) or not patch[key] or patch[key].startswith("<"):
                    return f"Error: {key} from canvas.open is required"
            if not isinstance(patch.get("ops"), list) or len(patch["ops"]) > 50:
                return "Error: patch.ops must be an array of at most 50 operations"
            if len(json.dumps(patch, ensure_ascii=False).encode("utf-8")) > 64 * 1024:
                return "Error: patch exceeds the 64 KiB limit"
        if action == "export" and format not in {"png", "svg"}:
            return "Error: export requires format 'png' or 'svg'"

        request: dict[str, Any] = {
            "requestId": f"canvas_{uuid.uuid4().hex}",
            "action": action,
        }
        target = canvas_id or self._active_canvas_id
        target_path = path or (self._active_canvas_path if target == self._active_canvas_id else None)
        if target_path:
            try:
                workspace = self._active_workspace().resolve()
                target_path = str(resolve_workspace_path(target_path, workspace, workspace))
            except (OSError, ValueError) as error:
                return f"Error: invalid canvas path: {error}"
        if target:
            request["canvasId"] = target
        if target_path:
            request["path"] = target_path
        request["timeoutMs"] = 8_000 if action in {"open", "apply"} else 25_000
        if patch is not None:
            request["patch"] = patch
        if include_visual:
            request["includeVisual"] = True
        if format:
            request["format"] = format

        stage = "activate"
        try:
            if not target:
                return "Error: no canvas is attached to this conversation"
            activation: dict[str, Any] = {"canvasId": target, "focus": action == "open"}
            if target_path:
                activation["path"] = target_path
            await tauri_invoke_async("canvas_activate_sidebar", activation)
            stage = "ready"
            if action != "open":
                ready = await tauri_invoke_async("canvas_agent_request", {
                    "requestId": f"canvas_{uuid.uuid4().hex}",
                    "canvasId": target,
                    "action": "open",
                    "timeoutMs": 8_000,
                })
                if not isinstance(ready, dict) or ready.get("ok") is not True:
                    return json.dumps({
                        "ok": False, "status": "unavailable", "stage": stage,
                        "message": "画布编辑器未就绪，本次操作未发送。",
                    }, ensure_ascii=False)
            stage = action
            result = await tauri_invoke_async("canvas_agent_request", request)
        except (OSError, ValueError, RuntimeError) as error:
            return json.dumps({
                "ok": False,
                "status": "outcome_unknown" if stage == "apply" else "unavailable",
                "stage": stage,
                "requestId": request["requestId"],
                "message": str(error),
                "recovery": (
                    "写入结果尚未确认；恢复连接后先读取当前内容，不要重放旧修改。"
                    if stage == "apply" else "自动打开画布未完成；停止重复连接并报告此阶段错误。"
                ),
            }, ensure_ascii=False)
        if not isinstance(result, dict):
            return json.dumps({"ok": False, "status": "invalid_response"})

        data = result.pop("data", None)
        visual_data = result.pop("visualData", None)
        valid_visual = (
            isinstance(visual_data, str)
            and visual_data.startswith("data:image/")
            and len(visual_data) > len("data:image/png;base64,")
        )
        if action == "inspect" and include_visual:
            rendered_quality = result.get("renderedQuality")
            rendered_ready = (
                isinstance(rendered_quality, dict)
                and rendered_quality.get("status") == "ready"
            )
            if not rendered_ready or not valid_visual:
                message = (
                    rendered_quality.get("message")
                    if isinstance(rendered_quality, dict)
                    else result.get("message")
                )
                result["ok"] = False
                if result.get("status") in {None, "ready"}:
                    result["status"] = "unavailable"
                result["message"] = (
                    f"{message or 'Canvas visual inspection is unavailable'}；"
                    "真实视觉验收未完成，不要向用户声称画布已经完成"
                )
                visual_data = None
        if action == "export" and output and isinstance(data, str):
            try:
                written = self._write_export(output, format or "png", data)
            except (OSError, ValueError) as error:
                return f"Error: {error}"
            result["output"] = str(written)
            result["bytes"] = written.stat().st_size
            data = None

        text_result = {"requestId": request["requestId"], **result}
        image_data = visual_data if valid_visual and isinstance(visual_data, str) else None
        if image_data is None and action == "export" and format == "png" and isinstance(data, str):
            image_data = data
        if image_data:
            return [
                {"type": "text", "text": json.dumps(text_result, ensure_ascii=False)},
                {"type": "image_url", "image_url": {"url": image_data}},
            ]
        if action == "export" and format == "svg" and isinstance(data, str):
            text_result["svg"] = data
        return json.dumps(text_result, ensure_ascii=False)
