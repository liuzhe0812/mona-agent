"""Standalone stdlib helper executed INSIDE the online sandbox, never on host input.

The host sends this source through an isolated Python invocation. No host paths,
credentials, or Docker socket are mounted. Workspace snapshots remain opaque ZIP
bytes on the host and are only extracted inside a fresh sandbox.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import signal
import stat
import sys
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from uuid import uuid4

ROOT = Path("/workspace")
TRASH = ".mona-trash"


class FileOperationError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def relative_path(value: str, *, private: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024 or "\\" in value or "\x00" in value:
        raise ValueError("invalid workspace path")
    if value.startswith("/workspace/"):
        value = value[len("/workspace/"):]
    parts = PurePosixPath(value).parts
    if not parts or PurePosixPath(value).is_absolute() or any(part in {"..", "."} for part in parts):
        raise ValueError("path is outside workspace")
    if not private and parts[0] == TRASH:
        raise ValueError("private workspace path is not accessible")
    return str(PurePosixPath(*parts))


def resolve(value: str, *, private: bool = False) -> Path:
    rel = relative_path(value, private=private)
    path = ROOT / rel
    current = ROOT
    for part in PurePosixPath(rel).parts:
        current /= part
        if current.is_symlink():
            raise ValueError("symbolic links are not accepted for file operations")
    if not path.resolve().is_relative_to(ROOT.resolve(strict=True)):
        raise ValueError("path is outside workspace")
    return path


def info(path: Path, limit: int) -> dict:
    s = path.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > limit:
        raise ValueError("not a supported regular file or file exceeds limit")
    data = path.read_bytes()
    if len(data) > limit or len(data) != s.st_size:
        raise ValueError("file changed while reading")
    return {"path": path.relative_to(ROOT).as_posix(), "name": path.name,
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def quiesce() -> None:
    # PID 1 is the sandbox keeper. Kill leftover user commands, not host processes.
    mine = os.getpid()
    for _ in range(5):
        active = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit() or int(entry.name) in {1, mine}:
                continue
            try:
                state = (entry / "stat").read_text().split(")", 1)[1].split()[0]
                if state != "Z":
                    active.append(int(entry.name))
            except (OSError, IndexError):
                continue
        if not active:
            return
        for pid in active:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.05)
    raise ValueError("workspace processes could not be stopped before saving")


def export_snapshot(limit: int) -> bytes:
    quiesce()
    total = 0
    entries = []
    for directory, dirs, files in os.walk(ROOT, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                raise ValueError("workspace contains unsupported links or special files")
            if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
                raise ValueError("workspace contains unsupported hard links")
            total += metadata.st_size if stat.S_ISREG(metadata.st_mode) else 0
            entries.append(path)
            if total > limit or len(entries) > 2048:
                raise ValueError("workspace snapshot limit exceeded")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED, strict_timestamps=False) as archive:
        for path in entries:
            archive.write(path, str(path.relative_to(ROOT)))
    return stream.getvalue()


def restore_snapshot(data: bytes, limit: int) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2048 or sum(item.file_size for item in entries) > limit:
            raise ValueError("workspace snapshot limit exceeded")
        names = set()
        for item in entries:
            normalized = relative_path(item.filename.rstrip("/"), private=True)
            mode = item.external_attr >> 16
            if normalized in names or item.compress_type != zipfile.ZIP_STORED:
                raise ValueError("unsupported workspace archive")
            if mode and stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise ValueError("unsupported archive entry")
            names.add(normalized)
            path = resolve(normalized, private=True)
            if item.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, path.open("xb") as target:
                    written = 0
                    while chunk := source.read(65536):
                        written += len(chunk)
                        if written > item.file_size:
                            raise ValueError("invalid archive entry size")
                        target.write(chunk)


def _move_file(path: Path, target: Path, expected: str, limit: int) -> dict:
    def signature(value):
        return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns

    before = path.lstat()
    current = info(path, limit)
    if current["sha256"] != expected:
        raise FileOperationError("file_changed")
    if signature(before) != signature(path.lstat()):
        raise FileOperationError("file_changed")
    # link is exclusive on Linux as well as Windows; rename/replace can overwrite.
    os.link(path, target, follow_symlinks=False)
    try:
        original, linked = path.lstat(), target.lstat()
        if (not stat.S_ISREG(original.st_mode) or not stat.S_ISREG(linked.st_mode)
                or original.st_nlink != 2 or linked.st_nlink != 2
                or signature(original) != signature(before) or signature(linked) != signature(before)
                or hashlib.sha256(target.read_bytes()).hexdigest() != expected):
            raise FileOperationError("file_changed")
        path.unlink()
    except BaseException:
        try:
            original, linked = path.lstat(), target.lstat()
            if (original.st_dev, original.st_ino) == (linked.st_dev, linked.st_ino) == (before.st_dev, before.st_ino):
                target.unlink()
        except FileNotFoundError:
            # A completed unlink must never discard the only remaining copy.
            raise FileOperationError("file_operation_unknown") from None
        raise
    return {**current, "path": target.relative_to(ROOT).as_posix(), "name": target.name}


def _mutate(request: dict, file_limit: int) -> dict:
    action = request["action"]
    fields = {"action", "path", "expected_sha256"} | ({"destination"} if action == "rename" else set())
    if set(request) != fields:
        raise FileOperationError("invalid_file_operation")
    expected = request["expected_sha256"]
    if not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise FileOperationError("invalid_file_operation")
    try:
        quiesce()
        path = resolve(request["path"])
        target = resolve(request["destination"]) if action == "rename" else None
        if target is not None:
            return _move_file(path, target, expected, file_limit)
        metadata = info(path, file_limit)
        if metadata["sha256"] != expected:
            raise FileOperationError("file_changed")
        trash = resolve(TRASH, private=True)
        trash.mkdir(mode=0o700, exist_ok=True)
        slot = trash / uuid4().hex
        slot.mkdir(mode=0o700)
        try:
            audit = {**metadata, "deleted_at": time.time()}
            fd = os.open(slot / "metadata.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(audit, stream, ensure_ascii=False, separators=(",", ":"))
            _move_file(path, slot / "file", expected, file_limit)
        except BaseException:
            if not (slot / "file").exists():
                (slot / "metadata.json").unlink(missing_ok=True)
                slot.rmdir()
            raise
        return {**metadata, "trashed": True}
    except FileOperationError:
        raise
    except FileNotFoundError:
        raise FileOperationError("file_not_found") from None
    except FileExistsError:
        raise FileOperationError("file_exists") from None
    except (ValueError, IsADirectoryError, NotADirectoryError):
        raise FileOperationError("invalid_file_operation") from None
    except OSError:
        raise FileOperationError("file_operation_failed") from None


def operate(request: dict, file_limit: int):
    action = request["action"]
    if action in {"rename", "trash"}:
        return _mutate(request, file_limit)
    if action == "list":
        directory = ROOT if request.get("path") in (None, "", ".", "/workspace") else resolve(request["path"])
        entries = []
        for path in sorted(directory.iterdir()):
            if path == ROOT / TRASH:
                continue
            entry = {"path": path.relative_to(ROOT).as_posix(), "name": path.name,
                     "kind": "link" if path.is_symlink() else "directory" if path.is_dir() else "file"}
            entries.append(entry)
            if len(entries) > 500:
                return {"entries": entries[:500], "truncated": True}
        return {"entries": entries, "truncated": False}
    path = resolve(request["path"])
    if action in {"read", "download", "stat"}:
        metadata = info(path, file_limit)
        if action == "download":
            metadata["data"] = base64.b64encode(path.read_bytes()).decode("ascii")
        elif action == "read":
            text = path.read_text(encoding="utf-8")
            offset = request.get("offset", 0)
            if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
                raise ValueError("invalid read offset")
            metadata.update(content=text[offset:offset + 16000], next_offset=min(len(text), offset + 16000),
                            truncated=offset + 16000 < len(text))
        return metadata
    if action not in {"write", "upload"}:
        raise ValueError("unsupported file action")
    data = (base64.b64decode(request["data"], validate=True) if action == "upload"
            else request["content"].encode("utf-8"))
    if len(data) > file_limit:
        raise ValueError("file exceeds limit")
    expected = request.get("expected_sha256")
    if path.exists():
        current = info(path, file_limit)
        if action == "upload" and current["sha256"] == hashlib.sha256(data).hexdigest():
            return current
        if not expected or current["sha256"] != expected:
            raise ValueError("file changed; read the current file before overwriting")
    elif expected:
        raise ValueError("expected file no longer exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".mona-write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        if path.exists():
            if not expected or info(path, file_limit)["sha256"] != expected:
                raise ValueError("file changed during save")
            os.replace(temp, path)
        else:
            os.link(temp, path)
            os.unlink(temp)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return info(path, file_limit)


def main():
    mode, raw_limit = sys.argv[1:3]
    limit = int(raw_limit)
    if mode == "export":
        sys.stdout.buffer.write(export_snapshot(limit))
    elif mode == "restore":
        data = sys.stdin.buffer.read(limit + 512 * 1024 + 1)
        if len(data) > limit + 512 * 1024:
            raise ValueError("archive exceeds limit")
        restore_snapshot(data, limit)
    else:
        data = sys.stdin.buffer.read(2 * limit + 65537)
        if len(data) > 2 * limit + 65536:
            raise ValueError("request exceeds limit")
        try:
            result = operate(json.loads(data), limit)
        except FileOperationError as exc:
            result = {"error": exc.code}
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
