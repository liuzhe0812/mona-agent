"""Legacy WebUI JSON snapshot path helpers (JSON file); transcripts use transcript."""

from __future__ import annotations

import json
from pathlib import Path

from loguru import logger

from mona.config.paths import get_webui_dir
from mona.session.manager import SessionLoadError, SessionManager
from mona.webui.transcript import delete_webui_transcript, migrate_legacy_transcript


def webui_thread_file_path(session_key: str) -> Path:
    stem = SessionManager.safe_key(session_key)
    return get_webui_dir() / f"{stem}.json"


def migrate_legacy_webui_thread(session_key: str) -> None:
    """Move display history before its verified legacy session stem is reused."""
    source = get_webui_dir() / f"{SessionManager.legacy_safe_key(session_key)}.json"
    target = webui_thread_file_path(session_key)
    if source != target and source.is_file():
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise SessionLoadError("Legacy display history ownership could not be verified") from exc
        if not isinstance(payload, dict) or payload.get("sessionKey") != session_key:
            raise SessionLoadError("Legacy display history belongs to a different session")
        if target.exists():
            raise SessionLoadError("Both legacy and current display histories exist; the original files were preserved")
    migrate_legacy_transcript(session_key)
    if source != target and source.is_file():
        source.rename(target)


def delete_webui_thread(session_key: str) -> bool:
    """Remove legacy WebUI JSON snapshot and append-only transcript for *session_key*."""
    removed = False
    path = webui_thread_file_path(session_key)
    if path.is_file():
        try:
            path.unlink()
            removed = True
        except OSError as e:
            logger.warning("Failed to delete webui thread file {}: {}", path, e)
    if delete_webui_transcript(session_key):
        removed = True
    return removed
