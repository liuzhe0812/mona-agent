"""Locate and verify the XLSX sidecar bundled with Mona."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import subprocess
import sys
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mona.office.errors import OfficeError, OfficeErrorCode


@dataclass(frozen=True, slots=True)
class BundledXlsxSidecar:
    path: Path
    version: str
    size: int
    sha256: str


class XlsxSidecarProcess:
    def __init__(
        self,
        executable: Path | Sequence[str],
        *,
        request_timeout: float = 30.0,
    ) -> None:
        self.command = (
            [str(executable)]
            if isinstance(executable, Path)
            else [str(part) for part in executable]
        )
        self.request_timeout = request_timeout
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()

    @property
    def process_id(self) -> int | None:
        return self._process.pid if self._process is not None else None

    async def start(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self._process = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=creationflags,
            limit=16 * 1024 * 1024,
        )

    async def request(
        self,
        command: str,
        **payload: Any,
    ) -> Any:
        async with self._lock:
            await self.start()
            process = self._process
            if process is None or process.stdin is None or process.stdout is None:
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "表格编辑组件未启动。",
                    retryable=True,
                )
            request_id = uuid.uuid4().hex
            message = {
                "version": 1,
                "requestId": request_id,
                "command": command,
                **payload,
            }
            try:
                process.stdin.write(
                    (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode(
                        "utf-8"
                    )
                )
                await process.stdin.drain()
                line = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=self.request_timeout,
                )
            except (BrokenPipeError, ConnectionError, TimeoutError) as exc:
                await self.stop()
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "表格编辑组件响应超时或已退出。",
                    retryable=True,
                ) from exc
            if not line:
                await self.stop()
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "表格编辑组件已退出。",
                    retryable=True,
                )
            try:
                response = json.loads(line)
            except json.JSONDecodeError as exc:
                await self.stop()
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "表格编辑组件返回了无效响应。",
                ) from exc
            if (
                response.get("version") != 1
                or response.get("requestId") != request_id
                or not isinstance(response.get("ok"), bool)
            ):
                await self.stop()
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "表格编辑组件协议不匹配。",
                )
            if not response["ok"]:
                error = response.get("error") if isinstance(response.get("error"), dict) else {}
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    str(error.get("message") or "表格编辑组件执行失败。"),
                )
            return response.get("result")

    async def open(self, path: Path, *, locale: str = "zh") -> Any:
        return await self.request("open", path=str(path), locale=locale)

    async def read_range(
        self,
        *,
        session_id: str,
        sheet_id: str,
        start_row: int,
        end_row: int,
        start_column: int,
        end_column: int,
    ) -> Any:
        return await self.request(
            "read_range",
            sessionId=session_id,
            sheetId=sheet_id,
            range={
                "startRow": start_row,
                "endRow": end_row,
                "startColumn": start_column,
                "endColumn": end_column,
            },
        )

    async def close_workbook(self, session_id: str) -> None:
        await self.request("close", sessionId=session_id)

    async def stop(self) -> None:
        process = self._process
        self._process = None
        if process is None or process.returncode is not None:
            return
        if process.stdin is not None:
            process.stdin.close()
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except TimeoutError:
            process.kill()
            await process.wait()


class XlsxEngineService:
    def __init__(self, process: XlsxSidecarProcess | None = None) -> None:
        self._process = process
        self._workbooks: dict[str, str] = {}

    async def open(self, office_session_id: str, working_path: Path) -> dict[str, Any]:
        previous = self._workbooks.pop(office_session_id, None)
        if previous is not None:
            await self._get_process().close_workbook(previous)
        result = await self._get_process().open(working_path)
        if not isinstance(result, dict) or not isinstance(result.get("sessionId"), str):
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "表格编辑组件返回了无效工作簿。",
            )
        self._workbooks[office_session_id] = result["sessionId"]
        return result

    async def read_range(
        self,
        office_session_id: str,
        *,
        sheet_id: str,
        start_row: int,
        end_row: int,
        start_column: int,
        end_column: int,
    ) -> Any:
        engine_session_id = self._workbooks.get(office_session_id)
        if engine_session_id is None:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "表格工作簿尚未打开。",
                retryable=True,
            )
        return await self._get_process().read_range(
            session_id=engine_session_id,
            sheet_id=sheet_id,
            start_row=start_row,
            end_row=end_row,
            start_column=start_column,
            end_column=end_column,
        )

    async def close(self, office_session_id: str) -> None:
        engine_session_id = self._workbooks.pop(office_session_id, None)
        if engine_session_id is not None:
            await self._get_process().close_workbook(engine_session_id)

    async def shutdown(self) -> None:
        self._workbooks.clear()
        if self._process is not None:
            await self._process.stop()

    def _get_process(self) -> XlsxSidecarProcess:
        if self._process is None:
            self._process = XlsxSidecarProcess(resolve_xlsx_sidecar_executable())
        return self._process


def resolve_xlsx_sidecar_executable() -> Path:
    configured = os.environ.get("MONA_OFFICE_XLSX_SIDECAR", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.is_file():
            return candidate

    resources = os.environ.get("MONA_RESOURCES_DIR", "").strip()
    if resources:
        return load_bundled_xlsx_sidecar(Path(resources)).path

    executable = "xlsx-sidecar.exe" if os.name == "nt" else "xlsx-sidecar"
    development = (
        Path(__file__).parents[2]
        / "webui"
        / "office-editor"
        / "vendor"
        / "genoffice"
        / "apps"
        / "sheets"
        / "native"
        / "xlsx-engine"
        / "target"
        / "release"
        / executable
    ).resolve()
    if development.is_file():
        return development
    raise OfficeError(
        OfficeErrorCode.EDITOR_UNAVAILABLE,
        "内置表格编辑组件尚未准备好。",
        retryable=True,
    )


def load_bundled_xlsx_sidecar(resources_root: Path) -> BundledXlsxSidecar:
    root = resources_root.expanduser().resolve()
    manifest_path = root / "office-editor" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != 1:
            raise ValueError("unsupported manifest schema")
        expected_platform, expected_arch = _runtime_platform_and_arch()
        if (
            manifest.get("platform") != expected_platform
            or manifest.get("arch") != expected_arch
        ):
            raise ValueError("sidecar platform does not match this application")
        entry = manifest["xlsxSidecar"]
        relative_path = Path(entry["path"])
        version = str(entry["version"])
        size = int(entry["size"])
        expected_sha256 = str(entry["sha256"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise OfficeError(
            OfficeErrorCode.EDITOR_UNAVAILABLE,
            "内置表格编辑组件清单无效。",
        ) from exc

    candidate = (manifest_path.parent / relative_path).resolve()
    if candidate != manifest_path.parent and manifest_path.parent not in candidate.parents:
        raise OfficeError(
            OfficeErrorCode.EDITOR_UNAVAILABLE,
            "内置表格编辑组件路径无效。",
        )
    try:
        actual_size = candidate.stat().st_size
    except OSError as exc:
        raise OfficeError(
            OfficeErrorCode.EDITOR_UNAVAILABLE,
            "内置表格编辑组件缺失。",
        ) from exc
    if actual_size != size or _sha256(candidate) != expected_sha256:
        raise OfficeError(
            OfficeErrorCode.EDITOR_UNAVAILABLE,
            "内置表格编辑组件校验失败。",
        )
    return BundledXlsxSidecar(
        path=candidate,
        version=version,
        size=size,
        sha256=expected_sha256,
    )


def _runtime_platform_and_arch() -> tuple[str, str]:
    runtime_platform = "windows" if sys.platform == "win32" else "macos" if sys.platform == "darwin" else sys.platform
    machine = platform.machine().lower()
    runtime_arch = "x64" if machine in {"amd64", "x86_64"} else "arm64" if machine in {"arm64", "aarch64"} else machine
    return runtime_platform, runtime_arch


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
