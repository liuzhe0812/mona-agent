"""Losslessly store hosted conversation images outside bounded JSON history.

Only image blocks are transformed. Stored references are scoped by the
server-derived owner and verified before they are restored; ordinary text and
external image URLs are left alone. The caller owns the SQLite transaction.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import sqlite3
from typing import Any

from mona.hosted_work.contracts import WorkError
from mona.utils.helpers import detect_image_mime

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_REFERENCE = re.compile(r"^mona-history-media:sha256:([a-f0-9]{64})$")
_REFERENCE_PREFIX = "mona-history-media:"
_HEADERS = {
    "data:image/png;base64": "image/png",
    "data:image/x-png;base64": "image/png",
    "data:image/jpeg;base64": "image/jpeg",
    "data:image/jpg;base64": "image/jpeg",
    "data:image/pjpeg;base64": "image/jpeg",
    "data:image/webp;base64": "image/webp",
    "data:image/gif;base64": "image/gif",
}
_MAX_HEADER_BYTES = max(map(len, _HEADERS)) + 1
_MAX_IMAGE_BLOCKS = 4096


def init_history_media(db: sqlite3.Connection) -> None:
    """Create the account-scoped blob table without committing caller work."""
    db.execute("""
        CREATE TABLE IF NOT EXISTS history_media (
            owner TEXT NOT NULL CHECK(length(owner)=64 AND owner NOT GLOB '*[^0-9a-f]*'),
            digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
            data BLOB NOT NULL CHECK(typeof(data)='blob' AND length(data)>0),
            PRIMARY KEY(owner, digest)
        )
    """)


def stored_history_bytes(db: sqlite3.Connection, owner: str) -> int:
    """Account quota covers both conversation images and durable tool results."""
    total = db.execute("SELECT COALESCE(SUM(length(data)),0) FROM history_media WHERE owner=?",
                       (owner,)).fetchone()[0]
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_tool_results'").fetchone():
        total += db.execute("SELECT COALESCE(SUM(length(data)),0) FROM hosted_tool_results WHERE owner=?",
                            (owner,)).fetchone()[0]
    return total


def tool_result_image_references(db: sqlite3.Connection, owner: str, session_id: str | None = None) -> set[str]:
    """Retain image blobs referenced by this owner's durable tool results."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_tool_results'").fetchone():
        return set()
    sql = "SELECT image_digest FROM hosted_tool_results WHERE owner=? AND image_digest IS NOT NULL"
    values = (owner,)
    if session_id is not None:
        sql += " AND session_id=?"
        values = (owner, session_id)
    found = {row[0] for row in db.execute(sql, values)}
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in found):
        raise _invalid()
    return found


def _invalid() -> WorkError:
    return WorkError("invalid_history_media", "会话图片无法核验，已有记录已保留。", 409)


def _limit() -> WorkError:
    return WorkError("history_media_limit", "会话图片超过保存上限，已有记录已保留。", 409)


def _validate_limits(max_image_bytes: int, max_expanded_bytes: int) -> None:
    if (type(max_image_bytes) is not int or max_image_bytes <= 0
            or type(max_expanded_bytes) is not int or max_expanded_bytes <= 0):
        raise ValueError("history media limits must be positive integers")


def _validate_arguments(owner: str, max_image_bytes: int, max_storage_bytes: int, max_expanded_bytes: int) -> None:
    if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
        raise _invalid()
    _validate_limits(max_image_bytes, max_expanded_bytes)
    if type(max_storage_bytes) is not int or max_storage_bytes <= 0:
        raise ValueError("history media storage limit must be a positive integer")


def _max_url_bytes(max_image_bytes: int) -> int:
    return _MAX_HEADER_BYTES + 4 * ((max_image_bytes + 2) // 3)


def _image_size(url: str, max_image_bytes: int) -> int:
    """Validate a data URL and image signature without altering its bytes."""
    if not url.isascii() or len(url) > _max_url_bytes(max_image_bytes):
        raise _limit() if len(url) > _max_url_bytes(max_image_bytes) else _invalid()
    header, separator, encoded = url.partition(",")
    mime = _HEADERS.get(header.lower())
    if not separator or mime is None or not encoded:
        raise _invalid()
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise _invalid() from None
    if len(raw) > max_image_bytes:
        raise _limit()
    if not raw or detect_image_mime(raw) != mime:
        raise _invalid()
    return len(raw)


class _MediaTransform:
    def __init__(self, db: sqlite3.Connection, owner: str, max_image_bytes: int,
                 max_storage_bytes: int, max_expanded_bytes: int, *, restore: bool):
        self.db, self.owner = db, owner
        self.max_image_bytes, self.max_storage_bytes = max_image_bytes, max_storage_bytes
        self.max_expanded_bytes, self.restore = max_expanded_bytes, restore
        self.total = 0
        self.count = 0
        self.cache: dict[str, tuple[str, int]] = {}
        self.stored_bytes: int | None = None

    def _check_budget(self, size: int) -> None:
        if self.count + 1 > _MAX_IMAGE_BLOCKS or self.total + size > self.max_expanded_bytes:
            raise _limit()

    def _budget(self, size: int) -> None:
        self._check_budget(size)
        self.count += 1
        self.total += size

    def _load(self, digest: str, *, check_budget: bool = False) -> tuple[str, int]:
        cached = self.cache.get(digest)
        if cached is not None:
            if check_budget:
                self._check_budget(len(cached[0]))
            return cached
        row = self.db.execute("SELECT length(data) FROM history_media WHERE owner=? AND digest=?",
                              (self.owner, digest)).fetchone()
        if row is None or not isinstance(row[0], int) or row[0] <= 0:
            raise _invalid()
        if row[0] > _max_url_bytes(self.max_image_bytes):
            raise _limit()
        if check_budget:
            self._check_budget(row[0])
        row = self.db.execute("SELECT data FROM history_media WHERE owner=? AND digest=?",
                              (self.owner, digest)).fetchone()
        if row is None or not isinstance(row[0], bytes) or hashlib.sha256(row[0]).hexdigest() != digest:
            raise _invalid()
        try:
            url = row[0].decode("ascii")
        except UnicodeDecodeError:
            raise _invalid() from None
        value = (url, _image_size(url, self.max_image_bytes))
        self.cache[digest] = value
        return value

    def _store(self, url: str) -> str:
        self._budget(len(url))
        size = _image_size(url, self.max_image_bytes)
        raw = url.encode("ascii")
        digest = hashlib.sha256(raw).hexdigest()
        row = self.db.execute("SELECT 1 FROM history_media WHERE owner=? AND digest=?",
                              (self.owner, digest)).fetchone()
        if row is not None:
            stored, _ = self._load(digest)
            if stored != url:
                raise _invalid()
        else:
            if self.stored_bytes is None:
                self.stored_bytes = stored_history_bytes(self.db, self.owner)
            if self.stored_bytes + len(raw) > self.max_storage_bytes:
                raise _limit()
            self.db.execute("INSERT INTO history_media(owner,digest,data) VALUES(?,?,?)",
                            (self.owner, digest, raw))
            self.stored_bytes += len(raw)
            self.cache[digest] = (url, size)
        return _REFERENCE_PREFIX + "sha256:" + digest

    def _url(self, url: Any) -> Any:
        if not isinstance(url, str):
            return url
        if url.startswith(_REFERENCE_PREFIX):
            match = _REFERENCE.fullmatch(url)
            if match is None:
                raise _invalid()
            original, _ = self._load(match.group(1), check_budget=True)
            self._budget(len(original))
            return original if self.restore else url
        if url.lower().startswith(_REFERENCE_PREFIX):
            raise _invalid()
        if url.lower().startswith("data:"):
            if self.restore:
                self._budget(len(url))
                _image_size(url, self.max_image_bytes)
                return url
            return self._store(url)
        return url

    def walk(self, value: Any) -> Any:
        if isinstance(value, dict):
            result = {key: self.walk(item) for key, item in value.items()}
            if value.get("type") == "image_url" and isinstance(value.get("image_url"), dict):
                original = value["image_url"]
                if "url" in original:
                    result["image_url"]["url"] = self._url(original["url"])
            return result
        if isinstance(value, list):
            return [self.walk(item) for item in value]
        if isinstance(value, tuple):
            return tuple(self.walk(item) for item in value)
        return value


class _MediaMeasure(_MediaTransform):
    def __init__(self, max_image_bytes: int, max_expanded_bytes: int):
        self.max_image_bytes, self.max_expanded_bytes = max_image_bytes, max_expanded_bytes
        self.total = 0
        self.count = 0

    def _url(self, url: Any) -> Any:
        if not isinstance(url, str):
            return url
        if url.lower().startswith(_REFERENCE_PREFIX):
            # This read-only check has no owner or database for validation.
            raise _invalid()
        if url.lower().startswith("data:"):
            self._budget(len(url))
            _image_size(url, self.max_image_bytes)
            return ""
        return url


def measure_media(value: Any, *, max_image_bytes: int, max_expanded_bytes: int) -> tuple[int, int]:
    """Return compact JSON bytes excluding inline data and data-URL bytes.

    This is for legacy inline values only: an internal reference cannot be
    measured securely without its owner and database and is rejected.
    """
    _validate_limits(max_image_bytes, max_expanded_bytes)
    try:
        measure = _MediaMeasure(max_image_bytes, max_expanded_bytes)
        projected = measure.walk(value)
        size = len(json.dumps(projected, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        return size, measure.total
    except (RecursionError, TypeError, ValueError):
        raise _invalid() from None


def media_references(value: Any) -> set[str]:
    """Find stored-image digests without reading the database or changing data.

    Only image blocks can contain our persisted references. Ambiguous uses of
    the reserved scheme fail closed so cleanup cannot remove a possibly
    referenced image on the basis of malformed data.
    """
    found: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            if item.get("type") == "image_url" and isinstance(item.get("image_url"), dict):
                url = item["image_url"].get("url")
                if isinstance(url, str) and url.lower().startswith("mona-history-media"):
                    match = _REFERENCE.fullmatch(url)
                    if match is None:
                        raise _invalid()
                    found.add(match.group(1))
            for child in item.values():
                visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                visit(child)

    try:
        visit(value)
    except RecursionError:
        raise _invalid() from None
    return found


def externalize_media(db: sqlite3.Connection, owner: str, value: Any, *,
                      max_image_bytes: int, max_storage_bytes: int, max_expanded_bytes: int) -> Any:
    """Replace inline image URLs and store them inside the caller's transaction.

    The SHA-256 covers the original ASCII data URL, not a normalized image, so
    restoration preserves every character. Limits bound each decoded image,
    expanded data-URL bytes and the account's total stored data-URL bytes. A failed conversion
    rolls back its own inserts without committing or rolling back caller work.
    """
    _validate_arguments(owner, max_image_bytes, max_storage_bytes, max_expanded_bytes)
    if not db.in_transaction:
        raise WorkError("invalid_state", "会话图片保存事务不可用。", 503)
    db.execute("SAVEPOINT hosted_history_media_pack")
    try:
        result = _MediaTransform(db, owner, max_image_bytes, max_storage_bytes, max_expanded_bytes, restore=False).walk(value)
        db.execute("RELEASE SAVEPOINT hosted_history_media_pack")
        return result
    except BaseException as exc:
        db.execute("ROLLBACK TO SAVEPOINT hosted_history_media_pack")
        db.execute("RELEASE SAVEPOINT hosted_history_media_pack")
        if isinstance(exc, sqlite3.Error):
            raise WorkError("history_media_unavailable", "会话图片暂时无法保存，已有记录已保留。", 503) from None
        if isinstance(exc, RecursionError):
            raise _invalid() from None
        raise


def restore_media(db: sqlite3.Connection, owner: str, value: Any, *,
                  max_image_bytes: int, max_storage_bytes: int, max_expanded_bytes: int) -> Any:
    """Restore exact image URLs for this owner; invalid or foreign references fail closed."""
    _validate_arguments(owner, max_image_bytes, max_storage_bytes, max_expanded_bytes)
    try:
        return _MediaTransform(db, owner, max_image_bytes, max_storage_bytes, max_expanded_bytes, restore=True).walk(value)
    except sqlite3.Error:
        raise WorkError("history_media_unavailable", "会话图片暂时无法读取，已有记录已保留。", 503) from None
    except RecursionError:
        raise _invalid() from None
