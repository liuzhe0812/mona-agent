"""Notes agent tools.

Provides the agent with the ability to create notes, search notes, read note
content, and save images to the vault. All operations go through the Tauri IPC
bridge, which calls the Rust-side notes commands.

Design notes:
- No delete/modify capability: agent can only create new notes, never destroy
  existing ones (avoids accidental data loss and concurrent-edit races).
- Image saving reuses the existing `notes_save_image` Tauri command so that
  vault/assets layout and orphan cleanup stay consistent.
- notes_search uses Rust-side substring search via Tauri IPC.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke, tauri_invoke_async


def _notes_config(ctx: Any) -> Any:
    return getattr(ctx.config, "notes_tools", None)


def _get_vault_path() -> Path | None:
    """Return the configured vault path, or None if not configured."""
    try:
        result = tauri_invoke("notes_vault_get_path")
    except RuntimeError:
        return None
    if result is None:
        return None
    if isinstance(result, str) and result.strip():
        return Path(result.strip())
    if isinstance(result, dict):
        v = result.get("path") or result.get("result")
        if isinstance(v, str) and v.strip():
            return Path(v.strip())
    return None


async def _get_vault_path_async() -> Path | None:
    """Async counterpart that keeps IPC off the agent event loop."""
    try:
        result = await tauri_invoke_async("notes_vault_get_path")
    except RuntimeError:
        return None
    if result is None:
        return None
    if isinstance(result, str) and result.strip():
        return Path(result.strip())
    if isinstance(result, dict):
        v = result.get("path") or result.get("result")
        if isinstance(v, str) and v.strip():
            return Path(v.strip())
    return None


def _vault_ready() -> bool:
    """Check whether the notes vault is configured."""
    return _get_vault_path() is not None


async def _vault_ready_async() -> bool:
    return await _get_vault_path_async() is not None


# 剥离常见 Markdown 语法，用于从首行生成干净的标题。需与前端实现保持一致。
_MARKDOWN_STRIP_PATTERNS = [
    (re.compile(r"^#{1,6}\s+"), ""),  # heading
    (re.compile(r"^([-*+]|\d+\.)\s+"), ""),  # list
    (re.compile(r"^>\s*"), ""),  # blockquote
    (re.compile(r"^!\[([^\]]*)\]\([^)]*\).*"), r"\1"),  # leading image → alt
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),  # link → text
    (re.compile(r"\*\*([^*]+)\*\*"), r"\1"),  # bold
    (re.compile(r"__([^_]+)__"), r"\1"),
    (re.compile(r"\*([^*]+)\*"), r"\1"),  # italic
    (re.compile(r"_([^_]+)_"), r"\1"),
    (re.compile(r"~~([^~]+)~~"), r"\1"),  # strikethrough
    (re.compile(r"`([^`]+)`"), r"\1"),  # inline code
]


def _strip_markdown_for_title(text: str) -> str:
    s = text.strip()
    for pattern, repl in _MARKDOWN_STRIP_PATTERNS:
        s = pattern.sub(repl, s)
    return s.strip()


# ---------------------------------------------------------------------------
# notes_create
# ---------------------------------------------------------------------------

_CREATE_PARAMETERS = tool_parameters_schema(
    title=StringSchema(
        "Note title. If omitted, the first non-empty line of content_markdown is used "
        "as the title (body content is preserved unchanged)."
    ),
    content_markdown=StringSchema(
        "Note body in Markdown. Supports images via `![alt](assets/xxx.png)` references "
        "produced by notes_save_image."
    ),
    notebook_name=StringSchema(
        "Notebook (folder) name to place the note in. Defaults to '笔记转存' "
        "when omitted. The folder is created if it does not exist."
    ),
    required=["content_markdown"],
)


@tool_parameters(_CREATE_PARAMETERS)
class NotesCreateTool(Tool):
    """Create a new note in the vault."""

    _scopes = {"core", "subagent"}
    _plugin_discoverable = True

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = _notes_config(ctx)
        if cfg is None:
            return True
        return bool(getattr(cfg, "enabled", True)) and bool(
            getattr(cfg, "allow_create", True)
        )

    @property
    def name(self) -> str:
        return "notes_create"

    @property
    def description(self) -> str:
        return (
            "Create a new note in the user's notes vault. The note is stored as a "
            "Markdown file with YAML frontmatter. Use this to record information "
            "the user asks to save, or to produce图文笔记 by combining with "
            "notes_save_image for screenshots."
        )

    async def execute(self, **kwargs: Any) -> Any:
        title = _strip_markdown_for_title(str(kwargs.get("title", "")))[:40]
        content = str(kwargs.get("content_markdown", ""))
        if not content.strip():
            return "Error: content_markdown is required."
        # 标题未提供时，从正文第一个非空行提取并剥离 Markdown 语法（正文保持原样）。
        if not title:
            first_line = next(
                (line.strip() for line in content.splitlines() if line.strip()),
                "",
            )
            cleaned = _strip_markdown_for_title(first_line)
            if cleaned:
                title = cleaned[:40]
            else:
                return "Error: unable to derive a title from content. Please provide a title."
        notebook_name = kwargs.get("notebook_name")

        if not await _vault_ready_async():
            return "Error: Notes vault is not configured. Ask the user to set up a vault first."

        args: dict[str, Any] = {
            "title": title,
            "contentMarkdown": content,
        }
        if notebook_name:
            args["notebookId"] = str(notebook_name)

        try:
            note_id = await tauri_invoke_async("notes_create_from_chat", args)
        except RuntimeError as e:
            return f"Error creating note: {e}"
        return f"Created note with id={note_id} in notebook '{notebook_name or '笔记转存'}'."


# ---------------------------------------------------------------------------
# notes_read
# ---------------------------------------------------------------------------

_READ_PARAMETERS = tool_parameters_schema(
    note_id=StringSchema("The note ID returned by notes_search."),
    required=["note_id"],
)


@tool_parameters(_READ_PARAMETERS)
class NotesReadTool(Tool):
    """Read the full content of a note by ID."""

    _scopes = {"core", "subagent"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = _notes_config(ctx)
        return cfg is None or bool(getattr(cfg, "enabled", True))

    @property
    def name(self) -> str:
        return "notes_read"

    @property
    def description(self) -> str:
        return (
            "Read the full Markdown content of a note by its ID. Respects the note's "
            "contextLevel: 'none' notes are unavailable, 'summary' notes return only "
            "the preview, 'full' notes return the complete content."
        )

    async def execute(self, **kwargs: Any) -> Any:
        note_id = str(kwargs.get("note_id", "")).strip()
        if not note_id:
            return "Error: note_id is required."
        if not await _vault_ready_async():
            return "Error: Notes vault is not configured."

        try:
            result = await tauri_invoke_async(
                "notes_read_note_content", {"noteId": note_id}
            )
        except RuntimeError as e:
            return f"Error reading note: {e}"

        if not isinstance(result, dict):
            return f"Unexpected response: {result}"

        title = result.get("title", "(untitled)")
        content = result.get("contentMarkdown", "")
        notebook = result.get("notebookName", "")
        updated = result.get("updatedAt", "")
        context_level = result.get("contextLevel", "full")

        lines = [f"# {title}"]
        meta_parts = [f"id={note_id}"]
        if notebook:
            meta_parts.append(f"notebook={notebook}")
        if updated:
            meta_parts.append(f"updated={updated}")
        meta_parts.append(f"contextLevel={context_level}")
        lines.append(f"({'; '.join(meta_parts)})")
        lines.append("")
        lines.append(content)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# notes_save_image
# ---------------------------------------------------------------------------

_SAVE_IMAGE_PARAMETERS = tool_parameters_schema(
    file_path=StringSchema(
        "Absolute path to the source image file on disk (e.g. the temp file "
        "path returned by browser_screenshot). The file is copied into the "
        "vault's assets/ directory."
    ),
    file_name=StringSchema(
        "Optional file name to use in the vault, e.g. 'screenshot.png'. "
        "If omitted, derived from file_path."
    ),
    required=["file_path"],
)


@tool_parameters(_SAVE_IMAGE_PARAMETERS)
class NotesSaveImageTool(Tool):
    """Save an image to the vault's assets directory."""

    _scopes = {"core", "subagent"}
    _plugin_discoverable = True
    subscription_required = True

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = _notes_config(ctx)
        if cfg is None:
            return True
        return bool(getattr(cfg, "enabled", True)) and bool(
            getattr(cfg, "allow_create", True)
        )

    @property
    def name(self) -> str:
        return "notes_save_image"

    @property
    def description(self) -> str:
        return (
            "Copy an image file into the notes vault's assets directory and return "
            "a Markdown reference path like 'assets/abc123.png'. Use after "
            "browser_screenshot: pass the returned temp file path here, then embed "
            "the result in notes_create as `![description](assets/abc123.png)`."
        )

    async def execute(self, **kwargs: Any) -> Any:
        file_path = str(kwargs.get("file_path", "")).strip()
        if not file_path:
            return "Error: file_path is required."

        if not await _vault_ready_async():
            return "Error: Notes vault is not configured."

        args: dict[str, Any] = {"filePath": file_path}
        file_name = kwargs.get("file_name")
        if file_name:
            args["fileName"] = str(file_name)

        try:
            rel_path = await tauri_invoke_async("notes_save_image", args)
        except RuntimeError as e:
            return f"Error saving image: {e}"

        return (
            f"Saved image. Use this Markdown reference in notes: `![image]({rel_path})`."
        )
