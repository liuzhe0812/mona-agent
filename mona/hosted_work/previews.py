"""Account- and conversation-bound image previews for a pending question."""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import sqlite3
import stat
from pathlib import Path
from uuid import uuid4

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.tenant_files import TenantFiles
from mona.utils.helpers import detect_image_mime

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_ASK_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_PREFIX = "/workspace/.question-previews"
_PATH = re.compile(r"^/workspace/\.question-previews/([a-f0-9]{32})/([a-f0-9]{64})\.(png|jpg|webp)$")
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_SUFFIXES = {"image/png": (".png",), "image/jpeg": (".jpg", ".jpeg", ".jpe"), "image/webp": (".webp",)}


def _bad_preview() -> WorkError:
    return WorkError("invalid_preview", "样张未通过安全检查，请重新准备。", 400)


def _not_found() -> WorkError:
    return WorkError("not_found", "未找到此会话的样张。", 404)


def _linked(info: os.stat_result) -> bool:
    return (stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)))


def _valid_name(name: object, mime: object) -> bool:
    if not isinstance(name, str) or not isinstance(mime, str):
        return False
    try:
        return (bool(name) and len(name) <= 160 and len(name.encode("utf-8")) <= 240
                and name not in {".", ".."} and not any(c in name for c in "/\\:")
                and not any(ord(c) < 32 or ord(c) == 127 for c in name)
                and mime in _SUFFIXES and name.lower().endswith(_SUFFIXES[mime]))
    except UnicodeError:
        return False


class QuestionPreviews:
    """Stage preview bytes without making them workspace deliverables."""

    def __init__(self, config: HostedWorkConfig, state: DesktopStore, files: TenantFiles):
        configured = Path(config.state_dir)
        if (not configured.is_absolute()
                or Path(files.config.state_dir).resolve() != configured.resolve()
                or Path(state.service.config.state_dir).resolve() != configured.resolve()):
            raise ValueError("preview state must use the configured account root")
        self.config, self.state, self.files = config, state, files

    @staticmethod
    def handles(raw: object) -> bool:
        if not isinstance(raw, str):
            return False
        value = "/workspace/" + raw if not raw.startswith("/") else raw
        return value == _PREFIX or value.startswith(_PREFIX + "/")

    @staticmethod
    def _request_key(sid: str, rid: str, ask_id: str) -> str:
        return f"question_preview_request:{sid}:{rid}:{ask_id}"

    @staticmethod
    def _file_key(sid: str, rid: str, digest: str, ext: str) -> str:
        return f"question_preview_file:{sid}:{rid}:{digest}:{ext}"

    def _run(self, owner: str, sid: str, rid: str, *, active: bool) -> None:
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise WorkError("login_required", "请先登录 Mona 账号。", 401)
        identifier(sid)
        identifier(rid)
        self.state.session(owner, sid)
        run = self.state.service.store.run(owner, rid)
        if run["session_id"] != sid:
            raise _not_found()
        if active and run["status"] != "running":
            raise WorkError("execution_stopped", "本轮已经结束，未继续准备样张。", 409)

    def _directory(self, owner: str, sid: str, rid: str, *, create: bool) -> Path:
        home = self.files._home(owner)
        if _linked(home.lstat()) or home.resolve(strict=True) != home:
            raise _bad_preview()
        current = home
        for name in ("previews", sid, rid):
            path = current / name
            if create:
                try:
                    path.mkdir(mode=0o700)
                except FileExistsError:
                    pass
            try:
                info = path.lstat()
            except FileNotFoundError:
                raise _not_found() from None
            if (_linked(info) or not stat.S_ISDIR(info.st_mode) or path.resolve(strict=True) != path
                    or not path.is_relative_to(home)):
                raise _bad_preview()
            if create:
                path.chmod(0o700)
            current = path
        return current

    def _read_bytes(self, path: Path, digest: str, size: int, mime: str) -> bytes:
        try:
            info = path.lstat()
        except FileNotFoundError:
            raise _not_found() from None
        if (_linked(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or path.resolve(strict=True) != path
                or os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o600):
            raise _bad_preview()
        data = self.files._read_bytes(path, self.config.max_file_bytes)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest or detect_image_mime(data) != mime:
            raise WorkError("file_changed", "样张已变化，请重新准备后再查看。", 409)
        return data

    def _write_once(self, directory: Path, name: str, raw: bytes, digest: str, mime: str) -> None:
        path = directory / name
        if path.exists() or path.is_symlink():
            self._read_bytes(path, digest, len(raw), mime)
            return
        temporary = directory / (".preview-" + uuid4().hex + ".tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        created = False
        try:
            fd = os.open(temporary, flags, 0o600)
            created = True
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.chmod(0o600)
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        except OSError:
            raise WorkError("preview_unavailable", "样张暂时无法保存，请稍后重试。", 503) from None
        finally:
            if created:
                temporary.unlink(missing_ok=True)
        self._read_bytes(path, digest, len(raw), mime)

    def _items(self, images: list[dict]) -> list[tuple[dict, bytes]]:
        if not isinstance(images, list) or not 1 <= len(images) <= 128:
            raise _bad_preview()
        values, total = [], 0
        for item in images:
            if not isinstance(item, dict) or set(item) != {"name", "mime", "size", "sha256", "data"}:
                raise _bad_preview()
            name, mime, size, digest, encoded = (item[k] for k in ("name", "mime", "size", "sha256", "data"))
            if (not _valid_name(name, mime) or type(size) is not int or not 0 < size <= self.config.max_file_bytes
                    or not isinstance(digest, str) or not _SHA256.fullmatch(digest)
                    or not isinstance(encoded, str) or len(encoded) > 4 * ((size + 2) // 3)):
                raise _bad_preview()
            total += size
            if total > self.config.max_history_bytes:
                raise WorkError("file_limit", "样张总大小超过允许范围。", 413)
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError, binascii.Error):
                raise _bad_preview() from None
            if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest or detect_image_mime(raw) != mime:
                raise _bad_preview()
            values.append(({"name": name, "mime": mime, "size": size, "sha256": digest}, raw))
        return values

    def prepare(self, owner: str, sid: str, rid: str, ask_id: str, images: list[dict]) -> list[dict]:
        self._run(owner, sid, rid, active=True)
        if not isinstance(ask_id, str) or not _ASK_ID.fullmatch(ask_id):
            raise WorkError("invalid_request", "提问标识无效。")
        request_key = self._request_key(sid, rid, ask_id)
        previous = self.state.get(owner, request_key)
        try:
            items = self._items(images)
        except WorkError:
            if previous is not None:
                raise WorkError("request_conflict", "同一提问的样张内容已变化。", 409) from None
            raise
        fingerprint = hashlib.sha256(json.dumps([item for item, _ in items], ensure_ascii=False,
            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if previous is not None:
            if not isinstance(previous, dict) or previous.get("fingerprint") != fingerprint:
                raise WorkError("request_conflict", "同一提问的样张内容已变化。", 409)
            records = previous.get("files")
            if not isinstance(records, list) or len(records) != len(items):
                raise _bad_preview()
            for record, (item, _) in zip(records, items):
                if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                    raise _bad_preview()
                logical = f"{_PREFIX}/{rid}/{item['sha256']}.{_EXTENSIONS[item['mime']]}"
                if (record["path"] != logical or record.get("absolute_path") != logical
                        or any(record.get(key) != item[key] for key in ("mime", "size", "sha256"))):
                    raise _bad_preview()
                name, _ = self.read(owner, sid, logical)
                if record.get("name") != name:
                    raise _bad_preview()
            return records

        directory = self._directory(owner, sid, rid, create=True)
        for item, raw in items:
            ext = _EXTENSIONS[item["mime"]]
            self._write_once(directory, item["sha256"] + "." + ext, raw, item["sha256"], item["mime"])

        self._run(owner, sid, rid, active=True)
        database = self.state.db(owner)
        try:
            database.execute("BEGIN IMMEDIATE")
            # No metadata is published until every file has passed validation.
            if self.state.get(owner, request_key) is not None:
                raise WorkError("request_conflict", "同一提问的样张记录已变化，请重新查看。", 409)
            records = []
            for item, _ in items:
                ext = _EXTENSIONS[item["mime"]]
                logical = f"{_PREFIX}/{rid}/{item['sha256']}.{ext}"
                file_key = self._file_key(sid, rid, item["sha256"], ext)
                stored = self.state.get(owner, file_key)
                if stored is None:
                    stored = {"path": logical, **item}
                    self.state.set(owner, file_key, stored)
                elif (not isinstance(stored, dict) or stored.get("path") != logical
                      or not _valid_name(stored.get("name"), stored.get("mime"))
                      or any(stored.get(key) != item[key] for key in ("mime", "size", "sha256"))):
                    raise _bad_preview()
                records.append({"path": logical, "absolute_path": logical, "name": stored["name"],
                                "size": item["size"], "size_human": f"{item['size']} B",
                                "mime": item["mime"], "sha256": item["sha256"]})
            self.state.set(owner, request_key, {"fingerprint": fingerprint, "files": records})
            database.commit()
            return records
        except BaseException as exc:
            if database.in_transaction:
                database.rollback()
            if isinstance(exc, sqlite3.Error):
                raise WorkError("preview_unavailable", "样张记录未能保存，请稍后重试。", 503) from None
            raise

    def read(self, owner: str, sid: str, raw: str) -> tuple[str, bytes]:
        value = "/workspace/" + raw if isinstance(raw, str) and not raw.startswith("/") else raw
        match = _PATH.fullmatch(value) if isinstance(value, str) else None
        if match is None:
            raise _not_found()
        rid, digest, ext = match.groups()
        self._run(owner, sid, rid, active=False)
        stored = self.state.get(owner, self._file_key(sid, rid, digest, ext))
        if (not isinstance(stored, dict) or stored.get("path") != value or stored.get("sha256") != digest
                or not _valid_name(stored.get("name"), stored.get("mime"))
                or _EXTENSIONS.get(stored["mime"]) != ext
                or type(stored.get("size")) is not int or not 0 < stored["size"] <= self.config.max_file_bytes):
            raise _not_found()
        directory = self._directory(owner, sid, rid, create=False)
        return stored["name"], self._read_bytes(directory / (digest + "." + ext), digest, stored["size"], stored["mime"])
