"""Durable, session-owned references for hosted tool results.

The sandbox workspace is ephemeral until the end of a turn.  A result must be
committed here before a model context or checkpoint may contain its reference.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from mona.agent.context_recovery import _inline_image_url
from mona.agent.tools.registry import ToolRegistry
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.frontend import _is_link
from mona.hosted_work.history_media import _image_size, externalize_media, stored_history_bytes
from mona.utils.helpers import (
    _TOOL_RESULT_PREVIEW_CHARS,
    _render_tool_result_reference,
    detect_image_mime,
    stringify_text_blocks,
)

RESULT_PREFIX = "mona-tool-result://sha256/"
_REFERENCE = re.compile(r"^mona-tool-result://sha256/([a-f0-9]{64})\.(txt|json|png|jpg|webp|gif)$")
_OWNER = re.compile(r"^[a-f0-9]{64}$")
_IMAGE_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


def _unavailable() -> WorkError:
    return WorkError("tool_result_unavailable", "工具结果暂时无法保存或读取，已有记录已保留。", 503)


class HostedToolResults:
    """Content-addressed data accessible only within its owner and session."""

    def __init__(self, config, owner: str, session_id: str, run_id: str):
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise _unavailable()
        self.config, self.owner = config, owner
        self.session_id, self.run_id = identifier(session_id), identifier(run_id)

    def _database(self) -> Path:
        root = Path(self.config.state_dir)
        try:
            if not root.is_absolute():
                raise ValueError("invalid state root")
            if any(_is_link(path) for path in (*reversed(root.parents), root)):
                raise ValueError("invalid state root")
            root = root.resolve(strict=True)
            path = root / "sessions.sqlite3"
            if (path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1
                    or path.resolve(strict=True) != root / "sessions.sqlite3"):
                raise ValueError("invalid state database")
            return path
        except (OSError, ValueError):
            raise _unavailable() from None

    @contextmanager
    def _connection(self, *, write: bool):
        db = None
        try:
            uri = self._database().as_uri() + ("?mode=rw" if write else "?mode=ro")
            # Do not keep a cancelled turn waiting behind a busy writer. The
            # runner retains the full raw result if this short attempt fails.
            db = sqlite3.connect(uri, uri=True, timeout=0.25, isolation_level=None)
            db.execute("PRAGMA foreign_keys=ON")
            if write:
                db.execute("PRAGMA synchronous=FULL")
                db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                "SELECT 1 FROM runs WHERE owner=? AND session_id=? AND id=? "
                "AND status IN ('running','cancelling')",
                (self.owner, self.session_id, self.run_id),
            ).fetchone()
            if active is None:
                raise _unavailable()
            yield db
            if write:
                db.execute("COMMIT")
        except (sqlite3.Error, OSError):
            if db is not None and db.in_transaction:
                db.execute("ROLLBACK")
            raise _unavailable() from None
        except BaseException:
            if db is not None and db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            if db is not None:
                db.close()

    @staticmethod
    def _ensure_table(db: sqlite3.Connection) -> None:
        db.execute("""
            CREATE TABLE IF NOT EXISTS hosted_tool_results (
                owner TEXT NOT NULL, session_id TEXT NOT NULL,
                digest TEXT NOT NULL, extension TEXT NOT NULL,
                data BLOB, image_digest TEXT,
                CHECK((typeof(data)='blob' AND length(data)>0 AND image_digest IS NULL)
                   OR (data IS NULL AND length(image_digest)=64)),
                PRIMARY KEY(owner,session_id,digest,extension),
                FOREIGN KEY(owner,session_id) REFERENCES sessions(owner,id) ON DELETE CASCADE,
                FOREIGN KEY(owner,image_digest) REFERENCES history_media(owner,digest) ON DELETE RESTRICT
            )
        """)

    def save_many(self, items: list[tuple[bytes, str]]) -> list[str]:
        prepared = []
        for data, extension in items:
            if (not isinstance(data, bytes) or not data or len(data) > self.config.max_file_bytes
                    or extension not in {"txt", "json"}):
                raise _unavailable()
            prepared.append((data, extension, hashlib.sha256(data).hexdigest()))
        if not prepared:
            return []
        with self._connection(write=True) as db:
            self._ensure_table(db)
            total = stored_history_bytes(db, self.owner)
            for data, extension, digest in prepared:
                row = db.execute(
                    "SELECT data FROM hosted_tool_results WHERE owner=? AND session_id=? AND digest=? AND extension=?",
                    (self.owner, self.session_id, digest, extension),
                ).fetchone()
                if row is None:
                    if total + len(data) > self.config.history_media_storage_bytes:
                        raise _unavailable()
                    db.execute("INSERT INTO hosted_tool_results VALUES(?,?,?,?,?,NULL)",
                               (self.owner, self.session_id, digest, extension, data))
                    total += len(data)
                elif not isinstance(row[0], bytes) or row[0] != data:
                    raise _unavailable()
        return [f"{RESULT_PREFIX}{digest}.{extension}" for _, extension, digest in prepared]

    def save(self, data: bytes, extension: str) -> str:
        return self.save_many([(data, extension)])[0]

    def _image_bytes(self, db: sqlite3.Connection, image_digest: str) -> bytes:
        row = db.execute("SELECT data FROM history_media WHERE owner=? AND digest=?", (self.owner, image_digest)).fetchone()
        if (row is None or not isinstance(row[0], bytes) or hashlib.sha256(row[0]).hexdigest() != image_digest):
            raise _unavailable()
        try:
            url = row[0].decode("ascii")
            _image_size(url, self.config.max_file_bytes)
            return base64.b64decode(url.partition(",")[2], validate=True)
        except (ValueError, UnicodeDecodeError):
            raise _unavailable() from None

    def read(self, reference: str) -> tuple[bytes, str, str]:
        match = _REFERENCE.fullmatch(reference) if isinstance(reference, str) else None
        if match is None:
            raise _unavailable()
        digest, extension = match.groups()
        with self._connection(write=False) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_tool_results'").fetchone():
                raise _unavailable()
            row = db.execute(
                "SELECT data,image_digest FROM hosted_tool_results WHERE owner=? AND session_id=? AND digest=? AND extension=?",
                (self.owner, self.session_id, digest, extension),
            ).fetchone()
            if row is None:
                raise _unavailable()
            if extension in {"txt", "json"}:
                raw = row[0] if row[1] is None else None
            else:
                raw = self._image_bytes(db, row[1]) if row[0] is None and isinstance(row[1], str) else None
        if (not isinstance(raw, bytes) or not 0 < len(raw) <= self.config.max_file_bytes
                or hashlib.sha256(raw).hexdigest() != digest):
            raise _unavailable()
        if extension not in {"txt", "json"} and _IMAGE_EXTENSIONS.get(detect_image_mime(raw)) != extension:
            raise _unavailable()
        return raw, digest, extension

    def images(self, urls: list[str]) -> list[str]:
        prepared = []
        for url in urls:
            _image_size(url, self.config.max_file_bytes)
            raw = base64.b64decode(url.partition(",")[2], validate=True)
            extension = _IMAGE_EXTENSIONS.get(detect_image_mime(raw))
            if extension is None:
                raise _unavailable()
            prepared.append((url, raw, extension, hashlib.sha256(raw).hexdigest()))
        if not prepared:
            return []
        with self._connection(write=True) as db:
            self._ensure_table(db)
            for url, raw, extension, digest in prepared:
                row = db.execute(
                    "SELECT image_digest FROM hosted_tool_results WHERE owner=? AND session_id=? AND digest=? AND extension=?",
                    (self.owner, self.session_id, digest, extension),
                ).fetchone()
                if row is None:
                    other = db.execute(
                        "SELECT image_digest FROM hosted_tool_results WHERE owner=? AND digest=? "
                        "AND extension=? AND image_digest IS NOT NULL LIMIT 1",
                        (self.owner, digest, extension),
                    ).fetchone()
                    if other is not None:
                        image_digest = other[0]
                        if not isinstance(image_digest, str) or self._image_bytes(db, image_digest) != raw:
                            raise _unavailable()
                    else:
                        packed = externalize_media(db, self.owner, {"type": "image_url", "image_url": {"url": url}},
                            max_image_bytes=self.config.max_file_bytes, max_storage_bytes=self.config.history_media_storage_bytes,
                            max_expanded_bytes=self.config.history_media_expand_bytes)
                        image_reference = packed["image_url"]["url"]
                        image_digest = image_reference.removeprefix("mona-history-media:sha256:")
                        if not re.fullmatch(r"[a-f0-9]{64}", image_digest):
                            raise _unavailable()
                    db.execute("INSERT INTO hosted_tool_results VALUES(?,?,?,?,NULL,?)",
                               (self.owner, self.session_id, digest, extension, image_digest))
                elif not isinstance(row[0], str) or self._image_bytes(db, row[0]) != raw:
                    raise _unavailable()
        return [f"{RESULT_PREFIX}{digest}.{extension}" for _, _, extension, digest in prepared]


class HostedResultRegistry(ToolRegistry):
    """Optional shared-runner hooks, without changing desktop tool semantics."""

    def __init__(self, storage: HostedToolResults):
        super().__init__()
        self.storage = storage

    def _mona_normalize_tool_result(self, _call_id: str, content: Any, max_chars: int) -> Any:
        text = content if isinstance(content, str) else stringify_text_blocks(content) if isinstance(content, list) else None
        if isinstance(text, str) and max_chars > 0 and len(text) > max_chars:
            extension = "json" if isinstance(content, list) else "txt"
            value = json.dumps(content, ensure_ascii=False, indent=2) if isinstance(content, list) else text
            reference = self.storage.save(value.encode("utf-8"), extension)
            overhead = _render_tool_result_reference(reference, original_size=len(text), preview="", truncated_preview=True)
            preview = text[:min(_TOOL_RESULT_PREVIEW_CHARS, max(0, max_chars - len(overhead)))]
            return _render_tool_result_reference(reference, original_size=len(text), preview=preview, truncated_preview=True)
        if not isinstance(content, list):
            return content
        references = iter(self.storage.images([url for block in content if (url := _inline_image_url(block))]))
        result = []
        for block in content:
            url = _inline_image_url(block)
            if url:
                reference = next(references)
                metadata = block.get("_meta") if isinstance(block.get("_meta"), dict) else {}
                block = {**block, "_meta": {**metadata, "path": reference}}
            result.append(block)
        return result

    def _mona_offload_tool_images(self, messages: list[dict]) -> dict[int, list[dict[str, Any]]]:
        candidates = [(index, message) for index, message in enumerate(messages)
                      if message.get("role") == "tool" and message.get("tool_call_id")
                      and isinstance(message.get("content"), list)
                      and any(_inline_image_url(block) for block in message["content"])]
        urls = [url for _, message in candidates[:-1] for block in message["content"]
                if (url := _inline_image_url(block))]
        references = iter(self.storage.images(urls))
        replacements = {}
        for index, message in candidates[:-1]:
            blocks = []
            for block in message["content"]:
                url = _inline_image_url(block)
                if url:
                    reference = next(references)
                    blocks.append({"type": "text", "text":
                        f"[Earlier tool image saved outside the active context. Read with read_file if needed: {reference}]"})
                else:
                    blocks.append(block)
            replacements[index] = blocks
        return replacements
