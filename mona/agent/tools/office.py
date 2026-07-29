"""Agent tool for AI-driven Office document inspection and modification.

Wraps :class:`mona.api.office_cli.OfficeCliClient` to expose a narrow,
safe interface to the agent loop. Read-only actions (inspect/query/view/
get/validate) operate on the original file; mutating actions (batch) are
executed on a working copy so the user's original file is never touched.

Working copy management:
- The first mutating action on a given source file copies it to
  ``workspace/uploads/office/<uuid>-<name>`` and records the mapping.
- Subsequent mutating actions reuse the same working copy so edits
  accumulate across turns.
- The working copy path is returned to the agent so it can be delivered
  to the user via ``deliver_file`` when the edit session is complete.
"""

from __future__ import annotations

import hashlib
import shutil
import uuid
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import ArraySchema, ObjectSchema, StringSchema, tool_parameters_schema
from mona.config.schema import Base

__all__ = ("OfficeTool", "OfficeToolConfig")

_MAX_OUTPUT_CHARS = 50_000
_MAX_BATCH_ITEMS = 50
_OFFICE_EXTS = {".docx", ".xlsx", ".pptx"}


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


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Operation to perform: inspect | query | view | get | validate | batch",
            enum=["inspect", "query", "view", "get", "validate", "batch"],
        ),
        path=StringSchema("Workspace-relative path to the .docx/.xlsx/.pptx file"),
        selector=StringSchema("CSS-like selector for the 'query' action (e.g. 'p', 'slide[1] shape')"),
        node_path=StringSchema("Document node path for the 'get' action (e.g. '/body/p[1]')"),
        mode=StringSchema("View mode for the 'view' action: outline | content | raw", enum=["outline", "content", "raw"]),
        commands=ArraySchema(
            ObjectSchema(
                properties={
                    "command": StringSchema("The verb: add | set | remove | move | swap"),
                    "path": StringSchema("Target node path (for set/remove/get)"),
                    "parent": StringSchema("Parent path (for add)"),
                    "selector": StringSchema("Selector (for query, alias of path)"),
                    "type": StringSchema("Element type (for add, e.g. 'shape', 'paragraph')"),
                    "props": ObjectSchema(
                        {},
                        description="Key-value map of property names to string values (e.g. {\"text\":\"Hi\",\"bold\":\"true\"})",
                        additional_properties=True,
                    ),
                    "to": StringSchema("Destination path (for move)"),
                    "path2": StringSchema("Second path (for swap)"),
                },
            ),
            description="Batch commands for the 'batch' action (max 50 items)",
            max_items=_MAX_BATCH_ITEMS,
        ),
        required=["action", "path"],
    )
)
class OfficeTool(Tool):
    """Inspect and modify Office documents (.docx/.xlsx/.pptx) via OfficeCLI."""

    _scopes = {"core", "subagent"}
    config_key = "office"

    name = "office"
    description = (
        "Inspect, query, and modify Office documents (.docx, .xlsx, .pptx) via a structured "
        "command set backed by OfficeCLI. Read-only actions (inspect/query/view/get/validate) "
        "operate on the original file; the 'batch' action executes a list of mutating commands "
        "(add/set/remove/move/swap) on a working copy so the original file is never modified. "
        "Use 'inspect' first to understand the document structure, then 'batch' to apply edits, "
        "then 'validate' to check the result. After editing, call deliver_file on the returned "
        "working_copy path so the user can download the modified document."
    )

    @classmethod
    def config_cls(cls):
        return OfficeToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.office.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.office,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
        )

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        config: OfficeToolConfig | None = None,
        restrict_to_workspace: bool = False,
    ) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()
        self.config = config or OfficeToolConfig()
        self._restrict = restrict_to_workspace or self.config.restrict_to_workspace
        # source_path -> working_copy_path (accumulates edits across turns)
        self._working_copies: dict[str, Path] = {}
        # working_copy_path -> last known mtime (conflict detection: if the
        # user opened the working copy in system Office and saved changes, the
        # mtime will differ and we refuse the next batch to avoid clobbering).
        self._working_copy_mtimes: dict[str, float] = {}

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
        logger.info("office: created working copy {} -> {}", source.name, dest)
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

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        action: str,
        path: str,
        selector: str | None = None,
        node_path: str | None = None,
        mode: str | None = None,
        commands: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> str:
        from mona.api.office_cli import OfficeCliClient, OfficeCliError

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
                "Error: OfficeCLI binary not found. The user can install it from the "
                "PPT module runtime dialog or the settings page."
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
