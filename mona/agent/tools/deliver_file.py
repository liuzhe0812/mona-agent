"""Deliver file tool for submitting generated files as deliverables."""

from contextvars import ContextVar
from pathlib import Path
from typing import Any, Awaitable, Callable

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import ArraySchema, StringSchema, tool_parameters_schema
from mona.bus.events import OutboundMessage
from mona.config.paths import get_workspace_path

DELIVER_FILES_PENDING_META = "_pending_deliver_files"


def _human_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    if size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"


def _mime_from_ext(path: Path) -> str:
    import mimetypes

    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


@tool_parameters(
    tool_parameters_schema(
        paths=ArraySchema(
            StringSchema("Absolute or workspace-relative file path"),
            description="File paths to deliver to the user as deliverables.",
        ),
        summary=StringSchema(
            "Optional brief description of what was created.",
        ),
        required=["paths"],
    )
)
class DeliverFileTool(Tool, ContextAware):
    """Submit generated files as deliverables shown prominently in chat."""

    _scopes = {"core", "subagent"}

    def __init__(
        self,
        send_callback: Callable[[OutboundMessage], Awaitable[None]] | None = None,
        workspace: str | Path | None = None,
        restrict_to_workspace: bool = False,
    ):
        self._send_callback = send_callback
        self._workspace = (
            Path(workspace).expanduser() if workspace is not None else get_workspace_path()
        )
        self._restrict_to_workspace = restrict_to_workspace
        self._default_channel: ContextVar[str] = ContextVar(
            "deliver_file_default_channel", default=""
        )
        self._default_chat_id: ContextVar[str] = ContextVar(
            "deliver_file_default_chat_id", default=""
        )
        self._pending_files: ContextVar[list[dict[str, Any]] | None] = ContextVar(
            "deliver_file_pending_files", default=None
        )

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        send_callback = ctx.bus.publish_outbound if ctx.bus else None
        return cls(
            send_callback=send_callback,
            workspace=ctx.workspace,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
        )

    def set_context(self, ctx: RequestContext) -> None:
        self._default_channel.set(ctx.channel)
        self._default_chat_id.set(ctx.chat_id)
        pending_files = ctx.metadata.get(DELIVER_FILES_PENDING_META)
        self._pending_files.set(pending_files if isinstance(pending_files, list) else None)

    @property
    def name(self) -> str:
        return "deliver_file"

    @property
    def description(self) -> str:
        return (
            "Submit generated files as deliverables shown prominently in chat. "
            "Call this after creating new files (reports, images, data exports, etc.) "
            "that the user should be aware of. Do NOT call this for temporary or "
            "intermediate files. The files will appear as clickable cards in the "
            "conversation that the user can preview or open."
        )

    async def execute(
        self,
        paths: list[str],
        summary: str = "",
        **kwargs: Any,
    ) -> str:
        if not self._send_callback:
            return "Error: Message sending not configured"
        default_channel = self._default_channel.get()
        default_chat_id = self._default_chat_id.get()
        if not default_channel or not default_chat_id:
            return "Error: No active chat context"

        files: list[dict[str, Any]] = []
        # Use session workspace from contextvar (set per-task by AgentLoop),
        # falling back to the tool's configured workspace.
        active_workspace = get_current_workspace(self._workspace)
        allowed_dir = active_workspace if self._restrict_to_workspace else None

        for raw_path in paths:
            if self._restrict_to_workspace:
                try:
                    resolved = resolve_workspace_path(raw_path, active_workspace, allowed_dir)
                except (OSError, PermissionError, ValueError) as e:
                    return f"Error: path not allowed: {e}"
            else:
                p = Path(raw_path).expanduser()
                resolved = p if p.is_absolute() else active_workspace / p

            if not resolved.is_file():
                return f"Error: file not found: {resolved}"

            try:
                size = resolved.stat().st_size
            except OSError:
                size = 0

            try:
                display_path = resolved.relative_to(active_workspace).as_posix()
            except ValueError:
                display_path = resolved.as_posix()

            files.append({
                "path": display_path,
                "absolute_path": str(resolved),
                "name": resolved.name,
                "size": size,
                "size_human": _human_size(size),
                "mime": _mime_from_ext(resolved),
                "summary": summary,
            })

        if not files:
            return "Error: no valid files to deliver"

        pending_files = self._pending_files.get()
        if pending_files is not None:
            existing_paths = {
                str(item.get("absolute_path"))
                for item in pending_files
                if isinstance(item, dict) and item.get("absolute_path")
            }
            added = 0
            for item in files:
                absolute_path = str(item.get("absolute_path") or "")
                if absolute_path in existing_paths:
                    continue
                pending_files.append(item)
                existing_paths.add(absolute_path)
                added += 1
            return f"Prepared {added} file(s) for final delivery"

        msg = OutboundMessage(
            channel=default_channel,
            chat_id=default_chat_id,
            content="",
            metadata={"_deliver_files": files},
        )

        try:
            logger.debug(
                "deliver_file: sending _deliver_files event channel={} chat_id={} files={}",
                default_channel, default_chat_id, [f["name"] for f in files],
            )
            await self._send_callback(msg)
            logger.debug("deliver_file: _deliver_files event sent successfully")
            return f"Delivered {len(files)} file(s) to user"
        except Exception as e:
            logger.exception("deliver_file: error sending _deliver_files event: {}", e)
            return f"Error delivering files: {e}"
