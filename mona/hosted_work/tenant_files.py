"""Private workspace documents for the hosted desktop-compatible UI."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from filelock import FileLock, Timeout

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, identifier

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_CANVAS_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_CANVAS_LIMIT = 2 * 1024 * 1024


def _bad_path() -> WorkError:
    return WorkError("invalid_path", "文件不在当前工作区内。", 400)


def _ensure_directory(parent: Path, name: str) -> Path:
    path = parent / name
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise WorkError("invalid_state", "工作区目录不可用。", 503)
    resolved = path.resolve(strict=True)
    if resolved.parent != parent:
        raise WorkError("invalid_state", "工作区目录不可用。", 503)
    path.chmod(0o700)
    return resolved


class TenantFiles:
    """Map browser document operations to one authenticated account's root."""

    def __init__(self, config: HostedWorkConfig, authorize_session: Callable[[str, str], Any]):
        self.config = config
        self.authorize_session = authorize_session

    def _home(self, owner: str) -> Path:
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise WorkError("invalid_identity", "登录身份无效，请重新登录。", 401)
        state = Path(self.config.state_dir)
        if not state.is_absolute() or state.is_symlink() or not state.is_dir():
            raise WorkError("invalid_state", "工作区目录不可用。", 503)
        state = state.resolve(strict=True)
        users = _ensure_directory(state, "users")
        return _ensure_directory(users, owner)

    def root(self, owner: str) -> Path:
        try:
            return _ensure_directory(self._home(owner), "documents")
        except OSError:
            raise WorkError("invalid_state", "工作区目录不可用。", 503) from None

    @staticmethod
    def _path(root: Path, raw: object) -> Path:
        if (not isinstance(raw, str) or not raw.startswith("/workspace/")
                or len(raw) > 1024 or "\\" in raw or any(ord(c) < 32 or ord(c) == 127 for c in raw)):
            raise _bad_path()
        parts = raw[len("/workspace/"):].split("/")
        if (not parts or parts[0].rstrip(" .").lower() == ".office"
                or any(part in {"", ".", ".."} for part in parts)):
            raise _bad_path()
        path = root
        for index, part in enumerate(parts):
            path = path / part
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode):
                raise _bad_path()
            if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
                raise _bad_path()
            if index == len(parts) - 1 and stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                raise _bad_path()
        if not path.resolve().is_relative_to(root):
            raise _bad_path()
        return path

    @staticmethod
    def _logical(root: Path, path: Path) -> str:
        return "/workspace/" + PurePosixPath(*path.relative_to(root).parts).as_posix()

    def _session(self, owner: str, value: object) -> str | None:
        if value is None or value == "":
            return None
        session_id = identifier(value)
        if self.authorize_session(owner, session_id) is False:
            raise WorkError("not_found", "未找到该会话。", 404)
        return session_id

    def _validate_canvas(self, owner: str, value: object, *, authorize_origin: bool = True) -> dict[str, Any]:
        if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
            raise WorkError("invalid_canvas", "画布内容格式无效。")
        if not isinstance(value.get("id"), str) or not _CANVAS_ID.fullmatch(value["id"]):
            raise WorkError("invalid_canvas", "画布标识无效。")
        if not isinstance(value.get("kind"), str) or value["kind"] not in {"flowchart", "mindmap"}:
            raise WorkError("invalid_canvas", "画布类型无效。")
        for name in ("title", "createdAt", "updatedAt", "contentMarkdown"):
            if not isinstance(value.get(name), str):
                raise WorkError("invalid_canvas", "画布内容格式无效。")
        if not value["title"].strip() or not value["contentMarkdown"].strip():
            raise WorkError("invalid_canvas", "画布标题和内容不能为空。")
        origin = value.get("originChatId")
        if authorize_origin:
            self._session(owner, origin)
        elif origin is not None and origin != "":
            identifier(origin)
        try:
            data = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8") + b"\n"
        except (TypeError, ValueError, UnicodeError):
            raise WorkError("invalid_canvas", "画布内容格式无效。") from None
        if len(data) > _CANVAS_LIMIT:
            raise WorkError("file_limit", "画布超过允许的大小。", 413)
        return dict(value)

    @staticmethod
    def _read_bytes(path: Path, limit: int) -> bytes:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except FileNotFoundError:
            raise WorkError("not_found", "未找到该文件。", 404) from None
        except OSError:
            raise _bad_path() from None
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise _bad_path()
            if before.st_size > limit:
                raise WorkError("file_limit", "文件超过允许的大小。", 413)
            data = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
        if (len(data) != before.st_size or len(data) > limit or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns or before.st_ino != after.st_ino):
            raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409)
        return data

    @staticmethod
    def _file_digest(path: Path, limit: int) -> tuple[str, os.stat_result]:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except FileNotFoundError:
            raise WorkError("not_found", "未找到该文件。", 404) from None
        except OSError:
            raise _bad_path() from None
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise _bad_path()
            if before.st_size > limit:
                raise WorkError("file_limit", "文件超过允许的大小。", 413)
            digest = hashlib.sha256()
            size = 0
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise WorkError("file_limit", "文件超过允许的大小。", 413)
                digest.update(chunk)
            after = os.fstat(stream.fileno())
        if (size != before.st_size or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns or before.st_ino != after.st_ino):
            raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409)
        return digest.hexdigest(), before

    def _read_canvas(self, owner: str, root: Path, path: Path, *, chat_id: str | None = None,
                     list_all: bool = False) -> dict[str, Any] | None:
        if path.suffix.lower() != ".mona-canvas":
            raise _bad_path()
        data = self._read_bytes(path, _CANVAS_LIMIT)
        try:
            canvas = json.loads(data)
        except (UnicodeError, json.JSONDecodeError):
            raise WorkError("invalid_canvas", "画布文件格式无效。", 409) from None
        if chat_id is not None and (not isinstance(canvas, dict) or canvas.get("originChatId") != chat_id):
            return None
        canvas = self._validate_canvas(owner, canvas, authorize_origin=not list_all)
        return {"canvas": canvas, "path": self._logical(root, path), "sha256": hashlib.sha256(data).hexdigest()}

    @staticmethod
    def _expected(value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not _SHA256.fullmatch(value):
            raise WorkError("invalid_request", "文件版本无效，请重新读取后再操作。")
        return value

    @staticmethod
    def _save_atomic(path: Path, data: bytes, *, create: bool) -> None:
        fd, name = tempfile.mkstemp(prefix=".mona-canvas-", dir=path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            if create:
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409) from None
                temporary.unlink()
            else:
                os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _save(self, owner: str, root: Path, canvas: dict[str, Any], path: Path, expected: object,
              *, must_exist: bool = False) -> dict[str, Any]:
        value = dict(canvas)
        previous_sha = self._expected(expected)
        try:
            path.lstat()
        except FileNotFoundError:
            if must_exist:
                raise WorkError("not_found", "未找到该文件。", 404) from None
            if previous_sha is not None:
                raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409) from None
            previous = None
        else:
            previous = self._read_canvas(owner, root, path)
            if previous_sha is None or previous_sha != previous["sha256"]:
                raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409)
            if previous["canvas"]["id"] != value["id"]:
                raise WorkError("invalid_canvas", "不能使用其他画布覆盖此文件。", 409)
        now = datetime.now(timezone.utc).isoformat()
        if not value["createdAt"].strip():
            value["createdAt"] = previous["canvas"]["createdAt"] if previous else now
        value["updatedAt"] = now
        try:
            data = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8") + b"\n"
        except (TypeError, ValueError, UnicodeError):
            raise WorkError("invalid_canvas", "画布内容格式无效。") from None
        if len(data) > _CANVAS_LIMIT:
            raise WorkError("file_limit", "画布超过允许的大小。", 413)
        self._save_atomic(path, data, create=previous is None)
        return {"canvas": value, "path": self._logical(root, path), "sha256": hashlib.sha256(data).hexdigest()}

    def _trash(self, owner: str, home: Path, root: Path, raw_path: object, expected: object) -> None:
        path = self._path(root, raw_path)
        digest, before = self._file_digest(path, self.config.workspace_bytes)
        previous_sha = self._expected(expected)
        if previous_sha is not None and previous_sha != digest:
            raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409)
        trash = _ensure_directory(home, "trash")
        slot = _ensure_directory(trash, uuid4().hex)
        metadata = {"owner": owner, "path": self._logical(root, path), "sha256": digest,
                    "deletedAt": datetime.now(timezone.utc).isoformat()}
        self._save_atomic(slot / "metadata.json", (json.dumps(metadata, ensure_ascii=False) + "\n").encode(),
                          create=True)
        current = path.lstat()
        if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_dev != before.st_dev
                or current.st_ino != before.st_ino or current.st_size != before.st_size
                or current.st_mtime_ns != before.st_mtime_ns):
            raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409)
        os.replace(path, slot / "file")

    def invoke(self, owner: str, command: str, args: dict[str, Any]) -> Any:
        commands = {
            "workspace_canvas_save": {"workspaceRoot", "canvas", "expectedSha256"},
            "workspace_canvas_list": {"workspaceRoot", "chatId"},
            "workspace_canvas_read": {"workspaceRoot", "path"},
            "workspace_canvas_open_file": {"path"},
            "workspace_canvas_write_file": {"path", "canvas", "expectedSha256"},
            "move_to_trash": {"path", "expectedSha256"},
        }
        if (not isinstance(command, str) or command not in commands
                or not isinstance(args, dict) or set(args) - commands[command]):
            raise WorkError("invalid_operation", "此操作不可用。")
        try:
            home = self._home(owner)
            root = _ensure_directory(home, "documents")
            lock_path = home / ".documents.lock"
            if lock_path.is_symlink():
                raise WorkError("invalid_state", "工作区目录不可用。", 503)
            if lock_path.exists():
                lock_stat = lock_path.lstat()
                if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
                    raise WorkError("invalid_state", "工作区目录不可用。", 503)
            with FileLock(str(lock_path), timeout=10, mode=0o600):
                if command in {"workspace_canvas_save", "workspace_canvas_list", "workspace_canvas_read"}:
                    if not isinstance(args.get("workspaceRoot"), str) or args["workspaceRoot"] not in {"/workspace", "/workspace/"}:
                        raise _bad_path()
                if command == "move_to_trash":
                    return self._trash(owner, home, root, args.get("path"), args.get("expectedSha256"))
                if command == "workspace_canvas_list":
                    chat_id = self._session(owner, args.get("chatId"))
                    folder = _ensure_directory(root, "canvases")
                    items = []
                    for path in folder.iterdir():
                        if path.suffix.lower() != ".mona-canvas":
                            continue
                        checked = self._path(root, self._logical(root, path))
                        # An unfiltered list exposes files, not permission to access their former session.
                        item = self._read_canvas(owner, root, checked, chat_id=chat_id, list_all=chat_id is None)
                        if item is not None:
                            items.append(item)
                    return sorted(items, key=lambda item: (item["canvas"]["createdAt"], item["canvas"]["id"]))
                if command == "workspace_canvas_save":
                    canvas = self._validate_canvas(owner, args.get("canvas"))
                    _ensure_directory(root, "canvases")
                    path = self._path(root, "/workspace/canvases/" + canvas["id"] + ".mona-canvas")
                    return self._save(owner, root, canvas, path, args.get("expectedSha256"))
                path = self._path(root, args.get("path"))
                if command in {"workspace_canvas_read", "workspace_canvas_open_file"}:
                    return self._read_canvas(owner, root, path)
                canvas = self._validate_canvas(owner, args.get("canvas"))
                return self._save(owner, root, canvas, path, args.get("expectedSha256"), must_exist=True)
        except Timeout:
            raise WorkError("workspace_busy", "工作区正忙，请稍后重试。", 409) from None
        except OSError:
            raise WorkError("workspace_unavailable", "工作区暂时不可用，请稍后重试。", 503) from None
