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

from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke


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


def _vault_ready() -> bool:
    """Check whether the notes vault is configured."""
    return _get_vault_path() is not None


# ---------------------------------------------------------------------------
# notes_create
# ---------------------------------------------------------------------------

_CREATE_PARAMETERS = tool_parameters_schema(
    title=StringSchema("Note title (required)."),
    content_markdown=StringSchema(
        "Note body in Markdown. Supports images via `![alt](assets/xxx.png)` references "
        "produced by notes_save_image."
    ),
    notebook_name=StringSchema(
        "Notebook (folder) name to place the note in. Defaults to the vault root "
        "when omitted. The folder is created if it does not exist."
    ),
    tags=ArraySchema(StringSchema(""), description="Optional list of tags."),
    required=["title", "content_markdown"],
)


@tool_parameters(_CREATE_PARAMETERS)
class NotesCreateTool(Tool):
    """Create a new note in the vault."""

    _scopes = {"core"}
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
        title = str(kwargs.get("title", "")).strip()
        if not title:
            return "Error: title is required."
        content = str(kwargs.get("content_markdown", ""))
        if not content.strip():
            return "Error: content_markdown is required."
        notebook_name = kwargs.get("notebook_name")
        tags = kwargs.get("tags") or []

        if not _vault_ready():
            return "Error: Notes vault is not configured. Ask the user to set up a vault first."

        args: dict[str, Any] = {
            "title": title,
            "contentMarkdown": content,
        }
        if notebook_name:
            args["notebookId"] = str(notebook_name)
        if tags:
            args["tags"] = [str(t) for t in tags]

        try:
            note_id = tauri_invoke("notes_create_from_chat", args)
        except RuntimeError as e:
            return f"Error creating note: {e}"
        return f"Created note with id={note_id} in notebook '{notebook_name or '(root)'}'."


# ---------------------------------------------------------------------------
# notes_search
# ---------------------------------------------------------------------------

_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema("Search query (matches title, content, tags)."),
    limit=IntegerSchema("Maximum number of results to return (default 10)."),
    required=["query"],
)


@tool_parameters(_SEARCH_PARAMETERS)
class NotesSearchTool(Tool):
    """Search notes across the entire vault."""

    _scopes = {"core"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = _notes_config(ctx)
        return cfg is None or bool(getattr(cfg, "enabled", True))

    @property
    def name(self) -> str:
        return "notes_search"

    @property
    def description(self) -> str:
        return (
            "Search all notes in the vault by keyword. Returns matching notes with "
            "id, title, snippet, and notebook name. Use this to find existing notes "
            "before reading their full content with notes_read."
        )

    async def execute(self, **kwargs: Any) -> Any:
        query = str(kwargs.get("query", "")).strip()
        if not query:
            return "Error: query is required."
        limit = kwargs.get("limit")

        if not _vault_ready():
            return "Error: Notes vault is not configured."

        limit_int = 10
        if limit is not None:
            try:
                limit_int = int(limit)
            except (TypeError, ValueError):
                pass

        # Rust-side substring search via Tauri IPC.
        args: dict[str, Any] = {"query": query}
        if limit is not None:
            args["limit"] = limit_int

        try:
            results = tauri_invoke("notes_search_all", args)
        except RuntimeError as e:
            return f"Error searching notes: {e}"

        if not isinstance(results, list) or len(results) == 0:
            return f"No notes found matching '{query}'."

        lines = [f"Found {len(results)} note(s) matching '{query}':"]
        for i, item in enumerate(results, 1):
            if not isinstance(item, dict):
                continue
            note_id = item.get("noteId", "?")
            title = item.get("title", "(untitled)")
            snippet = item.get("snippet", "")
            notebook = item.get("notebookName", "")
            lines.append(f"\n{i}. [{note_id}] {title}" + (f" ({notebook})" if notebook else ""))
            if snippet:
                lines.append(f"   {snippet}")
        return "\n".join(lines)


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

    _scopes = {"core"}
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
        if not _vault_ready():
            return "Error: Notes vault is not configured."

        try:
            result = tauri_invoke("notes_read_note_content", {"noteId": note_id})
        except RuntimeError as e:
            return f"Error reading note: {e}"

        if not isinstance(result, dict):
            return f"Unexpected response: {result}"

        title = result.get("title", "(untitled)")
        content = result.get("contentMarkdown", "")
        tags = result.get("tags", [])
        notebook = result.get("notebookName", "")
        updated = result.get("updatedAt", "")
        context_level = result.get("contextLevel", "full")

        lines = [f"# {title}"]
        meta_parts = [f"id={note_id}"]
        if notebook:
            meta_parts.append(f"notebook={notebook}")
        if tags:
            meta_parts.append(f"tags={', '.join(tags)}")
        if updated:
            meta_parts.append(f"updated={updated}")
        meta_parts.append(f"contextLevel={context_level}")
        lines.append(f"({'; '.join(meta_parts)})")
        lines.append("")
        lines.append(content)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# notes_edit
# ---------------------------------------------------------------------------

_EDIT_PARAMETERS = tool_parameters_schema(
    note_id=StringSchema(
        "The note ID returned by notes_search or notes_create. Required."
    ),
    operation=StringSchema(
        "Edit operation, one of: 'replace_text' | 'set_title' | 'set_tags'. "
        "Only one operation per call."
    ),
    old_string=StringSchema(
        "For replace_text: exact substring to find in the note body. "
        "Must match exactly once (unique); include surrounding context if the "
        "text appears multiple times. Whitespace and line breaks must match exactly."
    ),
    new_string=StringSchema(
        "For replace_text: replacement text. Pass empty string to delete the match."
    ),
    title=StringSchema("For set_title: new note title (non-empty after trim)."),
    tags=ArraySchema(
        StringSchema(""),
        description="For set_tags: new tags list. Pass [] to clear all tags.",
    ),
    required=["note_id", "operation"],
)


@tool_parameters(_EDIT_PARAMETERS)
class NotesEditTool(Tool):
    """Edit an existing note in place. Supports targeted text replacement and
    metadata edits without rewriting the whole note."""

    _scopes = {"core"}
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
        return "notes_edit"

    @property
    def description(self) -> str:
        return (
            "Edit an existing note by ID. Supports three atomic operations:\n"
            "- replace_text: replace one unique substring in the body (old_string "
            "must match exactly once). Use this for surgical edits; prefer it over "
            "rewriting the whole note to preserve formatting.\n"
            "- set_title: change the note title (also renames the .md file).\n"
            "- set_tags: replace the tags list.\n"
            "Returns the new title, preview, and first 200 chars of content for "
            "verification. Read the note first with notes_read if you need to "
            "locate exact text to replace."
        )

    async def execute(self, **kwargs: Any) -> Any:
        note_id = str(kwargs.get("note_id", "")).strip()
        if not note_id:
            return "Error: note_id is required."
        operation = str(kwargs.get("operation", "")).strip()
        if not operation:
            return "Error: operation is required."
        if operation not in {"replace_text", "set_title", "set_tags"}:
            return (
                "Error: operation must be one of: replace_text, set_title, set_tags. "
                f"Got '{operation}'."
            )

        if not _vault_ready():
            return "Error: Notes vault is not configured."

        # Validate operation-specific args before IPC to give clear errors.
        if operation == "replace_text":
            old = kwargs.get("old_string")
            if not isinstance(old, str) or not old:
                return "Error: old_string is required for replace_text."
        elif operation == "set_title":
            title = kwargs.get("title")
            if not isinstance(title, str) or not title.strip():
                return "Error: title is required for set_title."
        # set_tags allows empty list to clear tags.

        args: dict[str, Any] = {"noteId": note_id, "operation": operation}
        if operation == "replace_text":
            args["oldString"] = str(kwargs["old_string"])
            new = kwargs.get("new_string")
            args["newString"] = str(new) if new is not None else ""
        elif operation == "set_title":
            args["title"] = str(kwargs["title"])
        elif operation == "set_tags":
            tags = kwargs.get("tags") or []
            args["tags"] = [str(t) for t in tags]

        try:
            result = tauri_invoke("notes_edit_note", args)
        except RuntimeError as e:
            return f"Error editing note: {e}"

        if not isinstance(result, dict):
            return f"Unexpected response: {result}"

        new_title = result.get("title", "(untitled)")
        preview = result.get("preview", "")
        content_head = result.get("contentHead", "")
        updated = result.get("updatedAt", "")

        lines = [f"Edited note {note_id} ({operation})."]
        lines.append(f"Title: {new_title}")
        if updated:
            lines.append(f"Updated: {updated}")
        if preview:
            lines.append(f"Preview: {preview}")
        if content_head:
            lines.append("Content head:")
            lines.append(content_head)
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

    _scopes = {"core"}
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

        if not _vault_ready():
            return "Error: Notes vault is not configured."

        args: dict[str, Any] = {"filePath": file_path}
        file_name = kwargs.get("file_name")
        if file_name:
            args["fileName"] = str(file_name)

        try:
            rel_path = tauri_invoke("notes_save_image", args)
        except RuntimeError as e:
            return f"Error saving image: {e}"

        return (
            f"Saved image. Use this Markdown reference in notes: `![image]({rel_path})`."
        )
