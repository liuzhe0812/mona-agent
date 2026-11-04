"""Run the existing XLSX protocol only inside an owner-scoped gVisor container."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import stat
import sys
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from uuid import uuid4

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import identifier, private_directory
from mona.hosted_work.sandbox import DockerSandbox
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.sidecar import XlsxEngineService, XlsxSidecarProcess, load_bundled_xlsx_sidecar

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_RUNTIME = "/workspace/.mona-xlsx-runtime/xlsx-sidecar"
_INSTALL_RUNTIME = """import hashlib, os, pathlib, sys
root = pathlib.Path('/workspace/.mona-xlsx-runtime')
root.mkdir(mode=0o700, exist_ok=True)
if root.is_symlink() or root.resolve() != root:
    raise ValueError('invalid runtime directory')
size = int(sys.argv[1])
data = sys.stdin.buffer.read(size + 1)
if len(data) != size or hashlib.sha256(data).hexdigest() != sys.argv[2]:
    raise ValueError('runtime integrity failed')
path = root / 'xlsx-sidecar'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
with os.fdopen(fd, 'wb') as stream:
    stream.write(data)
    stream.flush()
    os.fsync(stream.fileno())
"""
_REMOVE_BOOK = """import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
if path.parent != pathlib.Path('/workspace/.mona-xlsx-books') or not re.fullmatch(r'[a-f0-9]{32}\\.xlsx', path.name):
    raise ValueError('invalid workbook path')
path.unlink(missing_ok=True)
"""


def _unavailable(message: str = "隔离表格编辑组件暂不可用，请稍后重新打开原文档。") -> OfficeError:
    return OfficeError(OfficeErrorCode.EDITOR_UNAVAILABLE, message, retryable=True)


def _linked(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _directory(root: Path, path: Path) -> Path:
    if (not path.is_absolute() or not path.is_relative_to(root) or _linked(root) or not root.is_dir()
            or root.resolve(strict=True) != root or ".." in path.relative_to(root).parts):
        raise _unavailable("表格工作空间未通过安全检查。")
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        if _linked(current) or not current.is_dir():
            raise _unavailable("表格工作空间未通过安全检查。")
    return current.resolve(strict=True)


def _read_regular(root: Path, path: Path, limit: int) -> bytes:
    if not path.is_absolute() or not path.is_relative_to(root):
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "只能读取当前账号的文档工作副本。")
    _directory(root, path.parent)
    if _linked(path):
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "文档工作副本不能是链接。")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "文档工作副本无效或超过大小限制。")
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    if len(data) > limit or len(data) != before.st_size or (before.st_size, before.st_mtime_ns) != (
        after.st_size, after.st_mtime_ns,
    ):
        raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, "文档工作副本已变化，请读取最新版本。")
    return data


class _XlsxSandbox(DockerSandbox):
    async def _invoke(self, arguments: list[str], **kwargs):
        if arguments and arguments[0] == "create":
            arguments = [value.replace("/workspace:rw,", "/workspace:rw,exec,", 1)
                         if value.startswith("/workspace:rw,") else value for value in arguments]
            arguments = ["create", "--label", "mona.work-kind=xlsx", *arguments[1:]]
        return await super()._invoke(arguments, **kwargs)


class SandboxedXlsxSidecarProcess(XlsxSidecarProcess):
    def __init__(self, config: HostedWorkConfig, owner: str, workspace: Path, sessions: Path,
                 resources_root: Path | None, acquire: Callable, release: Callable):
        super().__init__([], request_timeout=min(config.tool_timeout_seconds, 30))
        self.config, self.owner = config, owner
        self.workspace, self.sessions = workspace, sessions
        self.resources_root = resources_root
        self._acquire, self._release = acquire, release
        self._reserved = False
        self._cleanup_failed = False
        self._lifecycle = asyncio.Lock()
        self._book_paths: dict[str, str] = {}
        self._run_id = uuid4().hex
        runtime = private_directory(sessions.parent / "xlsx")
        self._sandbox = _XlsxSandbox(config, owner, self._run_id, runtime / (self._run_id + ".unused.zip"))

    def _runtime_bytes(self) -> bytes:
        if sys.platform != "linux":
            raise _unavailable("线上表格需要 Ubuntu 隔离运行环境，未改用宿主执行。")
        resources = self.resources_root
        if resources is None:
            value = os.environ.get("MONA_RESOURCES_DIR", "").strip()
            if not value:
                raise _unavailable("内置 Linux 表格编辑组件尚未配置。")
            resources = Path(value).expanduser()
        if _linked(resources):
            raise _unavailable("内置表格编辑组件路径无效。")
        root = resources.resolve(strict=True)
        package = load_bundled_xlsx_sidecar(root)
        data = _read_regular(root, package.path, self.config.workspace_bytes)
        if (not data.startswith(b"\x7fELF") or len(data) != package.size
                or hashlib.sha256(data).hexdigest() != package.sha256):
            raise _unavailable("内置 Linux 表格编辑组件校验失败。")
        if len(data) + self.config.max_file_bytes > self.config.workspace_bytes:
            raise _unavailable("表格编辑组件与工作副本超过隔离空间限制。")
        return data

    async def start(self) -> None:
        async with self._lifecycle:
            if self._cleanup_failed:
                raise _unavailable("表格隔离进程结果待核对，未创建替代进程。")
            if self._process is not None and self._process.returncode is None:
                return
            if self._sandbox.created:
                await self._stop_locked()
            try:
                data = self._runtime_bytes()
                if self._sandbox.snapshot.exists() or self._sandbox.snapshot.is_symlink():
                    raise _unavailable("表格隔离工作区不是空工作区。")
                self._acquire(self)
                self._reserved = True
                await self._sandbox.preflight()
                await self._sandbox.start()
                await self._sandbox._invoke(
                    ["exec", "-i", self._sandbox.name, "python3", "-I", "-c", _INSTALL_RUNTIME,
                     str(len(data)), hashlib.sha256(data).hexdigest()], data=data,
                )
                self.command = [self._sandbox.docker, "--host=unix:///var/run/docker.sock", "exec", "-i",
                                "--user=1000:1000", "--workdir=/workspace", self._sandbox.name, _RUNTIME]
                self._process = await asyncio.create_subprocess_exec(
                    *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, limit=16 * 1024 * 1024,
                    env={key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ},
                )
            except BaseException as error:
                await self._stop_locked()
                if isinstance(error, (OfficeError, asyncio.CancelledError)):
                    raise
                raise _unavailable() from error

    async def open(self, path: Path, *, locale: str = "zh"):
        source = Path(path)
        root = next((root for root in (self.workspace, self.sessions) if source.is_relative_to(root)), None)
        if root is None or source.suffix.lower() != ".xlsx":
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "只能打开当前账号的 XLSX 工作副本。")
        try:
            data = _read_regular(root, source, self.config.max_file_bytes)
            await self.start()
            virtual = "/workspace/.mona-xlsx-books/" + uuid4().hex + ".xlsx"
            uploaded = await self._sandbox.file({"action": "upload", "path": virtual,
                                                 "data": base64.b64encode(data).decode("ascii")})
            if uploaded.get("sha256") != hashlib.sha256(data).hexdigest():
                raise _unavailable("表格工作副本传输校验失败。")
            result = await super().open(PurePosixPath(virtual), locale=locale)
            if isinstance(result, dict) and isinstance(result.get("sessionId"), str):
                self._book_paths[result["sessionId"]] = virtual
            return result
        except BaseException as error:
            await self.stop()
            if isinstance(error, (OfficeError, asyncio.CancelledError)):
                raise
            raise _unavailable() from error

    async def close_workbook(self, session_id: str) -> None:
        await super().close_workbook(session_id)
        path = self._book_paths.pop(session_id, None)
        if path:
            await self._sandbox._invoke(["exec", self._sandbox.name, "python3", "-I", "-c", _REMOVE_BOOK, path])

    async def _stop_locked(self) -> None:
        try:
            await super().stop()
        except ProcessLookupError:
            pass
        finally:
            try:
                await self._sandbox.close()
            except BaseException as error:
                self._cleanup_failed = True
                raise _unavailable("表格隔离进程未确认结束，已阻止替代进程。") from error
            self._book_paths.clear()
            if self._reserved:
                self._release(self)
                self._reserved = False

    async def stop(self) -> None:
        async with self._lifecycle:
            await self._stop_locked()


class _SandboxedXlsxEngine(XlsxEngineService):
    def __init__(self, process: SandboxedXlsxSidecarProcess):
        super().__init__(process)
        self._operations = asyncio.Lock()

    async def open(self, office_session_id: str, working_path: Path):
        async with self._operations:
            return await super().open(office_session_id, working_path)

    async def read_range(self, office_session_id: str, **kwargs):
        async with self._operations:
            return await super().read_range(office_session_id, **kwargs)

    async def close(self, office_session_id: str) -> None:
        async with self._operations:
            try:
                await super().close(office_session_id)
            finally:
                if not self._workbooks:
                    await self._get_process().stop()

    async def shutdown(self) -> None:
        async with self._operations:
            await super().shutdown()


class SandboxedXlsxEngineFactory:
    def __init__(self, config: HostedWorkConfig, workspace_for_owner: Callable[[str], Path],
                 resources_root: Path | None = None):
        state = Path(config.state_dir).expanduser()
        if not state.is_absolute() or _linked(state):
            raise ValueError("XLSX state root must be an absolute private directory")
        self.root = private_directory(state)
        self.config = config.model_copy(deep=True)
        self.workspace_for_owner = workspace_for_owner
        self.resources_root = resources_root
        self._active: set[SandboxedXlsxSidecarProcess] = set()

    def _acquire(self, process):
        if process not in self._active and len(self._active) >= self.config.max_concurrent_runs:
            raise _unavailable("在线表格编辑已满，请关闭其他表格后重试。")
        self._active.add(process)

    def _release(self, process):
        self._active.discard(process)

    def __call__(self, owner: str, chat_id: str, sessions_root: Path) -> XlsxEngineService:
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise _unavailable("表格账号身份无效。")
        identifier(chat_id)
        supplied = self.workspace_for_owner(owner)
        workspace = _directory(self.root, self.root / "users" / owner / "documents")
        if _linked(supplied) or supplied.resolve(strict=True) != workspace:
            raise _unavailable("表格工作空间与当前账号不一致。")
        expected = self.root / "users" / owner / "office" / chat_id / "sessions"
        if sessions_root != expected:
            raise _unavailable("表格会话与当前账号不一致。")
        sessions = _directory(self.root, expected)
        process = SandboxedXlsxSidecarProcess(self.config, owner, workspace, sessions, self.resources_root,
                                             self._acquire, self._release)
        return _SandboxedXlsxEngine(process)
