"""Durable request and native-source correlations for Stock Vibe."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import uuid
from collections.abc import Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

_UUID_HEX = re.compile(r"^[0-9a-fA-F]{32}$")
_UUID_DASHED = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_METHOD = re.compile(r"^[A-Z]{3,16}$")
_ERROR_CATEGORY = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SNAPSHOT_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_INSTANCE_ID = re.compile(r"^[0-9a-fA-F]{32}$")
_TERMINAL_STATES = {"completed", "rejected"}


class RequestConflictError(ValueError):
    """A stable request or native object was reused with conflicting data."""


def normalize_request_id(request_id: str) -> str:
    """Validate a UUID request id and return its lowercase, separator-free form."""
    if not isinstance(request_id, str) or not (
        _UUID_HEX.fullmatch(request_id) or _UUID_DASHED.fullmatch(request_id)
    ):
        raise ValueError("request_id must be a UUID in hex or hyphenated form")
    return uuid.UUID(request_id).hex


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("value must be JSON serializable") from exc


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source_record(source: Mapping[str, Any]) -> tuple[str, str, str]:
    if not isinstance(source, Mapping):
        raise ValueError("source must be a mapping")
    data_root_sha256 = source.get("data_root_sha256")
    instance_id = source.get("instance_id")
    snapshot_id = source.get("snapshot_id")
    patches = source.get("patches")
    if not isinstance(data_root_sha256, str) or not _SHA256.fullmatch(data_root_sha256):
        raise ValueError("source.data_root_sha256 must be a SHA-256 hex digest")
    if not isinstance(instance_id, str) or not _INSTANCE_ID.fullmatch(instance_id):
        raise ValueError("source.instance_id must be a 32-character hex id")
    if not isinstance(snapshot_id, str) or not _SNAPSHOT_ID.fullmatch(snapshot_id):
        raise ValueError("source.snapshot_id must be a sha256 snapshot id")
    if not isinstance(patches, list):
        raise ValueError("source.patches must be the native patch receipt list")
    for patch in patches:
        if not isinstance(patch, Mapping):
            raise ValueError("source patch entries must be mappings")
        if not all(isinstance(patch.get(key), str) and patch[key] for key in ("path", "category")):
            raise ValueError("source patch entries require path and category")
        if not isinstance(patch.get("sha256"), str) or not _SHA256.fullmatch(patch["sha256"]):
            raise ValueError("source patch entries require a SHA-256 digest")
    serialized = _canonical_json(dict(source))
    return serialized, _sha256(serialized), instance_id.lower()


class RequestStore:
    """SQLite index for host requests and native object source bindings.

    Request payloads are hashed in memory and never written to SQLite. A new
    claim starts as ``unknown`` so an interrupted host process cannot make the
    operation look safe to replay.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @contextmanager
    def _connection(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS requests (
                request_id TEXT PRIMARY KEY,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','completed','rejected','unknown')),
                error_category TEXT,
                source_json TEXT,
                source_sha256 TEXT,
                instance_id TEXT,
                receipt_json TEXT,
                receipt_sha256 TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS object_references (
                kind TEXT NOT NULL,
                object_id TEXT NOT NULL,
                request_id TEXT NOT NULL REFERENCES requests(request_id),
                source_json TEXT NOT NULL,
                source_sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(kind, object_id, request_id)
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS object_references_request_id "
            "ON object_references(request_id)"
        )
        if os.name != "nt":
            self.path.chmod(0o600)
        if immediate:
            connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
        except BaseException:
            if connection.in_transaction:
                connection.rollback()
            raise
        else:
            if connection.in_transaction:
                connection.commit()
        finally:
            connection.close()

    @staticmethod
    def _payload_hash(method: str, path: str, payload: Any) -> tuple[str, str, str]:
        if not isinstance(method, str) or not _METHOD.fullmatch(method.upper()):
            raise ValueError("method must be an HTTP method token")
        if not isinstance(path, str) or not path.startswith("/") or "?" in path or "#" in path:
            raise ValueError("path must be an absolute route path without a query or fragment")
        method_value = method.upper()
        canonical = _canonical_json({"method": method_value, "path": path, "payload": payload})
        return method_value, path, _sha256(canonical)

    @staticmethod
    def _record(row: sqlite3.Row) -> dict[str, Any]:
        source = json.loads(row["source_json"]) if row["source_json"] is not None else None
        receipt = json.loads(row["receipt_json"]) if row["receipt_json"] is not None else None
        return {
            "request_id": row["request_id"],
            "method": row["method"],
            "path": row["path"],
            "payload_sha256": row["payload_sha256"],
            "status": row["status"],
            "error_category": row["error_category"],
            "source": source,
            "source_sha256": row["source_sha256"],
            "receipt": receipt,
            "receipt_owner": "mona_settings" if row["path"] in {"/host/model", "/host/attention", "/host/data-settings"} else "vibe",
            "receipt_sha256": row["receipt_sha256"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def claim(self, request_id: str, method: str, path: str, payload: Any) -> tuple[dict[str, Any], bool]:
        normalized_id = normalize_request_id(request_id)
        method_value, path_value, payload_sha256 = self._payload_hash(method, path, payload)
        with self._connection(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            if row is not None:
                if row["payload_sha256"] != payload_sha256:
                    raise RequestConflictError("request_id was reused with a different request")
                if row["status"] == "pending":
                    connection.execute(
                        "UPDATE requests SET status = 'unknown', error_category = 'recovered_pending', updated_at = ? "
                        "WHERE request_id = ?",
                        (_now(), normalized_id),
                    )
                    row = connection.execute(
                        "SELECT * FROM requests WHERE request_id = ?",
                        (normalized_id,),
                    ).fetchone()
                return self._record(row), False

            now = _now()
            connection.execute(
                "INSERT INTO requests(request_id, method, path, payload_sha256, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'unknown', ?, ?)",
                (normalized_id, method_value, path_value, payload_sha256, now, now),
            )
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            return self._record(row), True

    def get(self, request_id: str) -> dict[str, Any] | None:
        normalized_id = normalize_request_id(request_id)
        with self._connection(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            if row is None:
                return None
            if row["status"] == "pending":
                connection.execute(
                    "UPDATE requests SET status = 'unknown', error_category = 'recovered_pending', updated_at = ? "
                    "WHERE request_id = ?",
                    (_now(), normalized_id),
                )
                row = connection.execute(
                    "SELECT * FROM requests WHERE request_id = ?",
                    (normalized_id,),
                ).fetchone()
            return self._record(row)

    def list_completed_uploads(self, *, limit: int = 100) -> list[dict[str, Any]]:
        """List confirmed host upload receipts without exposing request bodies."""
        if type(limit) is not int or not 1 <= limit <= 500:
            raise ValueError("upload receipt limit must be between 1 and 500")
        if not self.path.is_file():
            return []
        connection = sqlite3.connect(
            f"{self.path.resolve().as_uri()}?mode=ro", uri=True, timeout=30
        )
        connection.row_factory = sqlite3.Row
        try:
            exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'"
            ).fetchone()
            if exists is None:
                return []
            rows = connection.execute(
                "SELECT * FROM requests WHERE method = 'POST' AND path = '/upload' "
                "AND status = 'completed' AND source_json IS NOT NULL AND source_sha256 IS NOT NULL "
                "AND receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL "
                "ORDER BY created_at DESC, request_id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            records = []
            for row in rows:
                try:
                    record = self._record(row)
                    if not isinstance(record["receipt"], dict):
                        continue
                    _source_json, source_sha256, _instance_id = _source_record(record["source"])
                    receipt_sha256 = _sha256(_canonical_json(record["receipt"]))
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if source_sha256 != record["source_sha256"] or receipt_sha256 != record["receipt_sha256"]:
                    continue
                status_code = record["receipt"].get("status_code")
                if type(status_code) is not int or not 200 <= status_code < 300:
                    continue
                records.append(record)
            return records
        finally:
            connection.close()

    def bind_source(self, request_id: str, source: Mapping[str, Any]) -> dict[str, Any]:
        normalized_id = normalize_request_id(request_id)
        source_json, source_sha256, instance_id = _source_record(source)
        with self._connection(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            if row is None:
                raise KeyError("request has not been claimed")
            if row["source_json"] is not None:
                if row["source_json"] != source_json:
                    raise RequestConflictError("request source binding cannot be changed")
                return self._record(row)
            if row["status"] in _TERMINAL_STATES:
                raise RequestConflictError("cannot bind a source after a terminal receipt")
            connection.execute(
                "UPDATE requests SET source_json = ?, source_sha256 = ?, instance_id = ?, updated_at = ? "
                "WHERE request_id = ?",
                (source_json, source_sha256, instance_id, _now(), normalized_id),
            )
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            return self._record(row)

    def complete(
        self,
        request_id: str,
        *,
        status: str,
        receipt: Mapping[str, Any],
        source: Mapping[str, Any],
    ) -> dict[str, Any]:
        normalized_id = normalize_request_id(request_id)
        if status not in _TERMINAL_STATES:
            raise ValueError("status must be completed or rejected")
        if not isinstance(receipt, Mapping):
            raise ValueError("receipt must be the native request ledger response")
        receipt_json = _canonical_json(dict(receipt))
        receipt_sha256 = _sha256(receipt_json)
        source_json, source_sha256, instance_id = _source_record(source)
        if receipt.get("request_id") is not None and normalize_request_id(str(receipt["request_id"])) != normalized_id:
            raise ValueError("native receipt request_id does not match the host request")
        native_status = receipt.get("status")
        if native_status is not None and native_status != status:
            raise ValueError("status does not match the native ledger receipt")

        with self._connection(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            if row is None:
                raise KeyError("request has not been claimed")
            if row["source_json"] is None:
                raise RequestConflictError("native source must be bound before dispatch")
            if row["source_json"] != source_json or row["source_sha256"] != source_sha256:
                raise RequestConflictError("native source differs from the pre-dispatch binding")
            if row["status"] in _TERMINAL_STATES:
                if (
                    row["status"] == status
                    and row["receipt_json"] == receipt_json
                    and row["receipt_sha256"] == receipt_sha256
                ):
                    return self._record(row)
                raise RequestConflictError("terminal native receipt cannot be changed")
            connection.execute(
                "UPDATE requests SET status = ?, error_category = NULL, receipt_json = ?, receipt_sha256 = ?, "
                "updated_at = ? WHERE request_id = ?",
                (status, receipt_json, receipt_sha256, _now(), normalized_id),
            )
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            return self._record(row)

    def mark_unknown(self, request_id: str, error_category: str) -> dict[str, Any]:
        normalized_id = normalize_request_id(request_id)
        if not isinstance(error_category, str) or not _ERROR_CATEGORY.fullmatch(error_category):
            raise ValueError("error_category must be a short lowercase category token")
        with self._connection(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            if row is None:
                raise KeyError("request has not been claimed")
            if row["status"] in _TERMINAL_STATES:
                raise RequestConflictError("terminal request cannot be changed to unknown")
            connection.execute(
                "UPDATE requests SET status = 'unknown', error_category = ?, updated_at = ? "
                "WHERE request_id = ?",
                (error_category, _now(), normalized_id),
            )
            row = connection.execute(
                "SELECT * FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            return self._record(row)

    def reject_before_dispatch(self, request_id: str) -> dict[str, Any]:
        normalized_id = normalize_request_id(request_id)
        with self._connection(immediate=True) as connection:
            row = connection.execute("SELECT * FROM requests WHERE request_id = ?", (normalized_id,)).fetchone()
            if row is None:
                raise KeyError(request_id)
            if row["source_json"] is not None or row["status"] in _TERMINAL_STATES:
                raise RequestConflictError("a bound or terminal request cannot be rejected before dispatch")
            connection.execute(
                "UPDATE requests SET status='rejected', error_category='not_dispatched', updated_at=? WHERE request_id=?",
                (_now(), normalized_id),
            )
            return self._record(connection.execute("SELECT * FROM requests WHERE request_id=?", (normalized_id,)).fetchone())

    def complete_model_setting(self, request_id: str, *, receipt: dict, status: str = "completed") -> dict:
        if status not in _TERMINAL_STATES:
            raise ValueError("invalid settings receipt status")
        code = receipt.get("status_code")
        if (type(code) is not int or status == "completed" and not 200 <= code < 300
            or status == "rejected" and not 400 <= code < 500):
            raise ValueError("invalid settings receipt code")
        normalized_id = normalize_request_id(request_id)
        serialized = _canonical_json(receipt)
        with self._connection(immediate=True) as connection:
            row = connection.execute("SELECT * FROM requests WHERE request_id=?", (normalized_id,)).fetchone()
            if row is None:
                raise KeyError(request_id)
            if row["path"] not in {"/host/model", "/host/attention", "/host/data-settings"} or row["method"] != "PUT" or row["source_json"] is not None:
                raise RequestConflictError("only Mona settings may have a local receipt")
            if row["status"] in _TERMINAL_STATES:
                if row["status"] != status or row["receipt_json"] != serialized:
                    raise RequestConflictError("settings receipt cannot be changed")
                return self._record(row)
            connection.execute(
                "UPDATE requests SET status=?, receipt_json=?, receipt_sha256=?, error_category=NULL, updated_at=? WHERE request_id=?",
                (status, serialized, _sha256(serialized), _now(), normalized_id),
            )
            return self._record(connection.execute("SELECT * FROM requests WHERE request_id=?", (normalized_id,)).fetchone())

    def record_reference(
        self,
        kind: str,
        object_id: str,
        request_id: str,
        source: Mapping[str, Any],
    ) -> None:
        normalized_id = normalize_request_id(request_id)
        kind_value = self._reference_part(kind, "kind", 64)
        object_value = self._reference_part(object_id, "object_id", 256)
        source_json, source_sha256, _instance_id = _source_record(source)
        with self._connection(immediate=True) as connection:
            row = connection.execute(
                "SELECT source_json, source_sha256 FROM requests WHERE request_id = ?",
                (normalized_id,),
            ).fetchone()
            if row is None:
                raise KeyError("request has not been claimed")
            if row["source_json"] != source_json or row["source_sha256"] != source_sha256:
                raise RequestConflictError("reference source differs from the request source binding")
            existing = connection.execute(
                "SELECT source_json, source_sha256 FROM object_references WHERE kind = ? AND object_id = ? LIMIT 1",
                (kind_value, object_value),
            ).fetchone()
            if existing is not None and (
                existing["source_json"] != source_json or existing["source_sha256"] != source_sha256
            ):
                raise RequestConflictError("native object reference cannot be rebound to another source")
            connection.execute(
                "INSERT OR IGNORE INTO object_references(kind, object_id, request_id, source_json, source_sha256, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (kind_value, object_value, normalized_id, source_json, source_sha256, _now()),
            )

    def reference(self, kind: str, object_id: str) -> dict[str, Any] | None:
        kind_value = self._reference_part(kind, "kind", 64)
        object_value = self._reference_part(object_id, "object_id", 256)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT source_json FROM object_references WHERE kind = ? AND object_id = ? ORDER BY created_at LIMIT 2",
                (kind_value, object_value),
            ).fetchall()
        if not rows:
            return None
        if len(rows) > 1 and rows[0]["source_json"] != rows[1]["source_json"]:
            raise RequestConflictError("native object has inconsistent source references")
        return json.loads(rows[0]["source_json"])

    @staticmethod
    def _reference_part(value: str, name: str, limit: int) -> str:
        if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(char) < 32 for char in value):
            raise ValueError(f"{name} must be a nonempty plain-text identifier")
        return value.strip()
