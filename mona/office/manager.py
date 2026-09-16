"""Services-owned Office session and persistence manager."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable, Iterable, Sequence
from pathlib import Path

from mona.config.paths import get_data_dir
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.schemas import (
    ChangedSinceQuery,
    ChangedSinceResult,
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCheckpointMetadata,
    OfficeCheckpointReceipt,
    OfficeCommandFailure,
    OfficeCommandResult,
    OfficeDocumentType,
    OfficeErrorPayload,
    OfficeInspectCommand,
    OfficeInspectFailure,
    OfficeInspectResponse,
    OfficeInspectSuccess,
    RevisionChange,
)
from mona.office.session import OfficeSession

_DOCUMENT_EXTENSIONS: dict[OfficeDocumentType, str] = {
    "docs": ".docx",
    "sheets": ".xlsx",
    "slides": ".pptx",
}
_MAX_SOURCE_IDENTITY_LENGTH = 2048


def _blank_template_path(document_type: OfficeDocumentType) -> Path:
    relative = Path("office-editor") / "templates" / f"blank{_DOCUMENT_EXTENSIONS[document_type]}"
    resources_root = os.environ.get("MONA_RESOURCES_DIR", "").strip()
    candidate = (
        Path(resources_root).expanduser().resolve() / relative
        if resources_root
        else Path(__file__).parents[2] / "src-tauri" / "resources" / relative
    )
    if not candidate.is_file():
        raise OfficeError(
            OfficeErrorCode.EDITOR_UNAVAILABLE,
            f"缺少 {document_type} 空白文档模板。",
        )
    return candidate


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_source_identity(value: str) -> str:
    normalized = value.replace("\\", "/")
    if not normalized or len(normalized) > _MAX_SOURCE_IDENTITY_LENGTH:
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "Office sourceIdentity 无效或超过长度限制。",
        )
    return normalized


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


class OfficeSessionManager:
    def __init__(
        self,
        *,
        sessions_root: Path | None = None,
        max_checkpoint_bytes: int = 100 * 1024 * 1024,
        operation_cache_size: int = 128,
    ) -> None:
        self.sessions_root = (
            sessions_root.resolve()
            if sessions_root is not None
            else (get_data_dir() / "office" / "sessions").resolve()
        )
        self.sessions_root.mkdir(parents=True, exist_ok=True)
        self.max_checkpoint_bytes = max_checkpoint_bytes
        self.operation_cache_size = operation_cache_size
        self._sessions: dict[str, OfficeSession] = {}
        self._recovery_errors: dict[str, str] = {}
        self._command_locks: dict[str, asyncio.Lock] = {}
        self._pending_commands: dict[
            tuple[str, str],
            tuple[OfficeApplyCommand, asyncio.Future[OfficeCommandResult]],
        ] = {}
        self._pending_inspections: dict[
            tuple[str, str],
            tuple[OfficeInspectCommand, asyncio.Future[OfficeInspectResponse]],
        ] = {}
        self._checkpoint_waiters: dict[
            tuple[str, str, int],
            list[asyncio.Future[None]],
        ] = {}
        self._recover_sessions()

    def create_session(
        self,
        *,
        owner_session_key: str,
        document_type: OfficeDocumentType,
        workspace_root: Path,
        source_path: str | Path | None = None,
        allowed_roots: Sequence[Path] = (),
        display_name: str | None = None,
        initial_file: Path | None = None,
        source_identity: str | None = None,
    ) -> OfficeSession:
        workspace = workspace_root.expanduser().resolve()
        extension = _DOCUMENT_EXTENSIONS[document_type]
        normalized_display_name: str | None = None
        if display_name is not None:
            normalized_display_name = display_name.strip()
            if (
                not normalized_display_name
                or any(separator in normalized_display_name for separator in ("/", "\\"))
            ):
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    "Office 文档名称无效。",
                )
            suffix = Path(normalized_display_name).suffix.lower()
            if suffix in _DOCUMENT_EXTENSIONS.values() and suffix != extension:
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    f"文档名称扩展名与 {document_type} 编辑器不匹配。",
                )
            if suffix != extension:
                normalized_display_name += extension
        if initial_file is not None and source_path is not None:
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                "Office 初始文件不能同时指定源文件。",
            )
        if initial_file is not None:
            staging = self._resolve_initial_file(initial_file)
            if staging.suffix.lower() != extension:
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    f"文件类型与 {document_type} 编辑器不匹配。",
                )
            identity = _normalize_source_identity(source_identity or "")
            existing = self.find_session(
                owner_session_key=owner_session_key,
                document_type=document_type,
                source_identity=identity,
            )
            if existing is not None:
                return existing
        elif source_path is not None:
            candidate = Path(source_path).expanduser()
            if candidate.is_absolute():
                identity = _normalize_source_identity(str(candidate))
                existing = self.find_session(
                    owner_session_key=owner_session_key,
                    document_type=document_type,
                    source_identity=identity,
                    imported_only=True,
                )
                if existing is not None:
                    return existing
        source = self._resolve_source(source_path, workspace, allowed_roots)
        if source is not None and source.suffix.lower() != extension:
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                f"文件类型与 {document_type} 编辑器不匹配。",
            )
        if source is not None:
            identity = _normalize_source_identity(str(source))
        elif initial_file is None:
            identity = None
        existing = self.find_session(
            owner_session_key=owner_session_key,
            document_type=document_type,
            source_identity=identity,
        )
        if existing is not None:
            return existing

        session_id = f"office_{uuid.uuid4().hex}"
        session_dir = (self.sessions_root / session_id).resolve()
        if self.sessions_root not in session_dir.parents:
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "无效的 Office 会话目录。")
        session_dir.mkdir(parents=True, exist_ok=False)
        working_path = session_dir / f"working{extension}"
        version = DocumentVersion(editor_epoch=f"epoch_{uuid.uuid4().hex}", model_revision=0)
        source_hash: str | None = None
        try:
            if source is not None:
                self._copy_initial_file(source, working_path)
                source_hash = _sha256_file(source)
                if _sha256_file(working_path) != source_hash:
                    raise OfficeError(
                        OfficeErrorCode.SAVE_CONFLICT,
                        "源文件在创建 Office 工作副本时发生了变化。",
                    )
            elif initial_file is not None:
                self._copy_initial_file(staging, working_path)
            else:
                self._copy_initial_file(_blank_template_path(document_type), working_path)
            session = OfficeSession(
                session_id=session_id,
                owner_session_key=owner_session_key,
                document_type=document_type,
                display_name=normalized_display_name
                or (
                    source.name
                    if source is not None
                    else staging.name
                    if initial_file is not None
                    else f"未命名{extension}"
                ),
                session_dir=session_dir,
                working_path=working_path,
                source_path=source,
                source_identity=identity,
                source_hash=source_hash,
                version=version,
                checkpoint_version=version,
                saved_version=version if source is not None or initial_file is not None else None,
                dirty=source is None and initial_file is None,
                save_state="clean" if source is not None or initial_file is not None else "dirty",
            )
            self._sessions[session_id] = session
            self._command_locks[session_id] = asyncio.Lock()
            self._persist_session(session)
            return session
        except Exception:
            self._sessions.pop(session_id, None)
            self._command_locks.pop(session_id, None)
            shutil.rmtree(session_dir, ignore_errors=True)
            raise

    def find_session(
        self,
        *,
        owner_session_key: str,
        document_type: OfficeDocumentType,
        source_identity: str | None,
        imported_only: bool = False,
    ) -> OfficeSession | None:
        if source_identity is None:
            return None
        for session in self._sessions.values():
            if (
                session.owner_session_key == owner_session_key
                and session.document_type == document_type
                and session.source_identity == source_identity
                and (not imported_only or session.source_path is None)
            ):
                return session
        return None

    def list_sessions(self, *, owner_session_key: str) -> list[OfficeSession]:
        return [
            session
            for session in self._sessions.values()
            if session.owner_session_key == owner_session_key and not session.closed
        ]

    def get_session(
        self,
        session_id: str,
        *,
        owner_session_key: str | None = None,
    ) -> OfficeSession:
        session = self._sessions.get(session_id)
        if session is None:
            recovery_error = self._recovery_errors.get(session_id)
            if recovery_error is not None:
                raise OfficeError(OfficeErrorCode.CHECKPOINT_FAILED, recovery_error)
            raise OfficeError(OfficeErrorCode.SESSION_NOT_FOUND, "Office 会话不存在。")
        if owner_session_key is not None and session.owner_session_key != owner_session_key:
            raise OfficeError(OfficeErrorCode.SESSION_NOT_FOUND, "Office 会话不存在。")
        return session

    def connect_editor(
        self,
        session_id: str,
        version: DocumentVersion,
    ) -> OfficeSession:
        session = self.get_session(session_id)
        self._require_current_epoch(session, version)
        if version.model_revision < session.version.model_revision:
            raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, "编辑器版本已过期。")
        session.version = version
        session.editor_connected = True
        self._persist_session(session)
        return session

    def disconnect_editor(self, session_id: str) -> None:
        session = self.get_session(session_id)
        session.editor_connected = False
        self._persist_session(session)

    def begin_editor_epoch(self, session_id: str) -> DocumentVersion:
        session = self.get_session(session_id)
        checkpoint_was_saved = (
            session.checkpoint_version is not None
            and session.checkpoint_version == session.saved_version
        )
        self._fail_pending_for_session(session_id)
        version = DocumentVersion(
            editor_epoch=f"epoch_{uuid.uuid4().hex}",
            model_revision=0,
        )
        session.version = version
        session.checkpoint_version = version if session.working_path.is_file() else None
        session.saved_version = version if checkpoint_was_saved else None
        session.dirty = not checkpoint_was_saved
        session.save_state = "dirty" if session.dirty else "clean"
        session.editor_connected = False
        session.recent_changed_targets.clear()
        session.revision_changes.clear()
        session.change_floor_revision = 0
        self._persist_session(session)
        return version

    def record_editor_version(
        self,
        session_id: str,
        version: DocumentVersion,
        *,
        changed_targets: Sequence[str] = (),
        pending_visual_slide_ids: Sequence[str] | None = None,
        pending_review_targets: Sequence[str] | None = None,
    ) -> bool:
        session = self.get_session(session_id)
        self._require_current_epoch(session, version)
        if version.model_revision <= session.version.model_revision:
            return False
        session.version = version
        session.dirty = session.saved_version != version
        session.save_state = "dirty" if session.dirty else "clean"
        session.recent_changed_targets = list(changed_targets)[-50:]
        if pending_visual_slide_ids is not None:
            session.pending_visual_slide_ids = list(pending_visual_slide_ids)
        if pending_review_targets is not None:
            session.pending_review_targets = list(pending_review_targets)
        self._append_revision_changes(session, "user", version, changed_targets)
        self._persist_session(session)
        return True

    async def execute_command(
        self,
        command: OfficeApplyCommand,
        send: Callable[[OfficeApplyCommand], Awaitable[None]],
        *,
        timeout: float = 30.0,
    ) -> OfficeCommandResult:
        session = self.get_session(command.session_id)
        async with self._command_locks[session.session_id]:
            serialized = command.model_dump_json(by_alias=True)
            remembered = session.operation_commands.get(command.operation_id)
            if remembered is not None and remembered != serialized:
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    "同一 operationId 不能用于不同命令。",
                )
            cached = session.operation_results.get(command.operation_id)
            if cached is not None:
                return cached

            key = (session.session_id, command.operation_id)
            pending = self._pending_commands.get(key)
            if pending is None:
                session.remember_command(command, limit=self.operation_cache_size)
                if command.expected_version != session.version:
                    result = self._version_conflict(session, command.operation_id)
                    session.remember_result(result, limit=self.operation_cache_size)
                    return result
                if not session.editor_connected:
                    raise OfficeError(
                        OfficeErrorCode.EDITOR_UNAVAILABLE,
                        "Office 编辑器尚未连接。",
                        retryable=True,
                    )
                future: asyncio.Future[OfficeCommandResult] = (
                    asyncio.get_running_loop().create_future()
                )
                pending = (command, future)
                self._pending_commands[key] = pending
                try:
                    await send(command)
                except Exception:
                    self._pending_commands.pop(key, None)
                    raise

            _, future = pending
            try:
                result = await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
            except TimeoutError as exc:
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "等待 Office 编辑器响应超时。",
                    retryable=True,
                ) from exc

            self._pending_commands.pop(key, None)
            cached_result = session.operation_results.get(command.operation_id)
            if cached_result is None:
                self._accept_command_result(session, result)
                session.remember_result(result, limit=self.operation_cache_size)
                self._persist_session(session)
                return result
            return cached_result

    def complete_command(self, result: OfficeCommandResult) -> bool:
        session = self.get_session(result.session_id)
        key = (session.session_id, result.operation_id)
        pending = self._pending_commands.get(key)
        if pending is None:
            cached = session.operation_results.get(result.operation_id)
            return cached == result
        _, future = pending
        version = result.version if result.ok else result.current_version
        self._require_current_epoch(session, version)
        self._accept_command_result(session, result)
        session.remember_result(result, limit=self.operation_cache_size)
        self._persist_session(session)
        self._pending_commands.pop(key, None)
        if not future.done():
            future.set_result(result)
        return True

    def pending_commands(self, session_id: str) -> list[OfficeApplyCommand]:
        self.get_session(session_id)
        return [
            command
            for (pending_session_id, _), (command, _) in self._pending_commands.items()
            if pending_session_id == session_id
        ]

    async def execute_inspect(
        self,
        command: OfficeInspectCommand,
        send: Callable[[OfficeInspectCommand], Awaitable[None]],
        *,
        timeout: float = 30.0,
    ) -> OfficeInspectResponse:
        session = self.get_session(command.session_id)
        async with self._command_locks[session.session_id]:
            if isinstance(command.query, ChangedSinceQuery):
                return self._inspect_changed_since(session, command)
            if not session.editor_connected:
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "Office 编辑器尚未连接。",
                    retryable=True,
                )
            key = (session.session_id, command.request_id)
            if key in self._pending_inspections:
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    "Office inspect requestId 正在使用。",
                )
            future: asyncio.Future[OfficeInspectResponse] = (
                asyncio.get_running_loop().create_future()
            )
            self._pending_inspections[key] = (command, future)
            try:
                await send(command)
                return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
            except TimeoutError as exc:
                raise OfficeError(
                    OfficeErrorCode.EDITOR_UNAVAILABLE,
                    "等待 Office 编辑器读取结果超时。",
                    retryable=True,
                ) from exc
            finally:
                self._pending_inspections.pop(key, None)

    def complete_inspect(self, result: OfficeInspectResponse) -> bool:
        session = self.get_session(result.session_id)
        key = (session.session_id, result.request_id)
        pending = self._pending_inspections.get(key)
        if pending is None:
            return False
        _, future = pending
        version = result.version if result.ok else result.current_version
        self._require_current_epoch(session, version)
        if version.model_revision > session.version.model_revision:
            session.version = version
            session.dirty = session.saved_version != version
            session.save_state = "dirty" if session.dirty else "clean"
            self._persist_session(session)
        if result.ok and version == session.version:
            pending_pages = getattr(result.result, "pending_visual_slide_ids", None)
            pending_targets = getattr(result.result, "pending_review_targets", None)
            if result.result.mode == "review":
                pending_pages = result.result.pending_slide_ids
                pending_targets = result.result.pending_targets
            if pending_pages is not None:
                session.pending_visual_slide_ids = list(pending_pages)
            if pending_targets is not None:
                session.pending_review_targets = list(pending_targets)
            if pending_pages is not None or pending_targets is not None:
                self._persist_session(session)
        if not future.done():
            future.set_result(result)
        return True

    def write_checkpoint(
        self,
        metadata: OfficeCheckpointMetadata,
        chunks: Iterable[bytes],
    ) -> OfficeCheckpointReceipt:
        session = self.get_session(metadata.session_id)
        temporary = session.session_dir / f".{session.working_path.name}.{uuid.uuid4().hex}.tmp"
        total = 0
        try:
            with temporary.open("xb") as stream:
                for chunk in chunks:
                    if not isinstance(chunk, bytes):
                        raise TypeError("checkpoint chunks must be bytes")
                    total += len(chunk)
                    if total > self.max_checkpoint_bytes:
                        raise OfficeError(
                            OfficeErrorCode.CHECKPOINT_FAILED,
                            "Office checkpoint 超过大小限制。",
                        )
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            return self.commit_checkpoint_file(metadata, temporary)
        except OfficeError:
            temporary.unlink(missing_ok=True)
            raise
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint 写入失败。",
            ) from exc

    def commit_checkpoint_file(
        self,
        metadata: OfficeCheckpointMetadata,
        temporary: Path,
    ) -> OfficeCheckpointReceipt:
        session = self.get_session(metadata.session_id)
        self._require_current_epoch(session, metadata.version)
        if metadata.version.model_revision > session.version.model_revision:
            raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, "Checkpoint 版本超前。")
        if (
            session.checkpoint_version is not None
            and session.checkpoint_version.editor_epoch == metadata.version.editor_epoch
            and metadata.version.model_revision < session.checkpoint_version.model_revision
        ):
            raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, "Checkpoint 版本已过期。")
        if metadata.size > self.max_checkpoint_bytes:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint 超过大小限制。",
            )
        staging = temporary.resolve()
        if staging.parent != session.session_dir or staging == session.working_path:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint staging 路径无效。",
            )
        try:
            if staging.stat().st_size != metadata.size or _sha256_file(staging) != metadata.sha256:
                raise OfficeError(
                    OfficeErrorCode.CHECKPOINT_FAILED,
                    "Office checkpoint 大小或摘要校验失败。",
                )
            if session.checkpoint_version == metadata.version and session.working_path.is_file():
                if (
                    session.working_path.stat().st_size != metadata.size
                    or _sha256_file(session.working_path) != metadata.sha256
                ):
                    raise OfficeError(
                        OfficeErrorCode.VERSION_CONFLICT,
                        "同一 Office 版本不能对应不同 checkpoint。",
                    )
                staging.unlink()
                return OfficeCheckpointReceipt(
                    **metadata.model_dump(),
                    working_file_name=session.working_path.name,
                )
            with staging.open("rb+") as stream:
                os.fsync(stream.fileno())
            os.replace(staging, session.working_path)
            _fsync_directory(session.session_dir)
        except OfficeError:
            raise
        except OSError as exc:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint 写入失败。",
            ) from exc

        session.checkpoint_version = metadata.version
        if (
            session.last_error is not None
            and session.last_error.code == OfficeErrorCode.CHECKPOINT_FAILED
        ):
            session.last_error = None
        self._persist_session(session)
        self._complete_checkpoint_waiters(metadata.session_id, metadata.version)
        return OfficeCheckpointReceipt(
            **metadata.model_dump(),
            working_file_name=session.working_path.name,
        )

    async def wait_for_checkpoint(
        self,
        session_id: str,
        version: DocumentVersion,
        *,
        timeout: float = 30.0,
    ) -> DocumentVersion:
        session = self.get_session(session_id)
        self._require_current_epoch(session, version)
        if (
            session.checkpoint_version is not None
            and session.checkpoint_version.editor_epoch == version.editor_epoch
            and session.checkpoint_version.model_revision >= version.model_revision
        ):
            return session.checkpoint_version
        key = (session_id, version.editor_epoch, version.model_revision)
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._checkpoint_waiters.setdefault(key, []).append(future)
        try:
            await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except TimeoutError as exc:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "等待 Office checkpoint 超时。",
                retryable=True,
            ) from exc
        finally:
            waiters = self._checkpoint_waiters.get(key)
            if waiters is not None:
                if future in waiters:
                    waiters.remove(future)
                if not waiters:
                    self._checkpoint_waiters.pop(key, None)
        session = self.get_session(session_id)
        if session.checkpoint_version is None:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint 未生成。",
            )
        return session.checkpoint_version

    def mark_saved(self, session_id: str, version: DocumentVersion) -> None:
        session = self.get_session(session_id)
        if session.checkpoint_version != version:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "只能保存已经持久化的 Office 版本。",
            )
        session.saved_version = version
        session.dirty = session.version != version
        session.save_state = "dirty" if session.dirty else "clean"
        self._persist_session(session)

    def save(
        self,
        session_id: str,
        *,
        version: DocumentVersion | None = None,
        overwrite_source: bool = False,
    ) -> Path:
        session = self.get_session(session_id)
        target_version = version or session.checkpoint_version
        if target_version is None or not session.working_path.is_file():
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office 文档尚未生成可保存的 checkpoint。",
            )
        if session.checkpoint_version != target_version:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "只能保存指定版本的 Office checkpoint。",
            )
        if overwrite_source:
            if session.source_path is None or session.source_hash is None:
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    "当前 Office 会话没有可覆盖的源文件。",
                )
            if (
                not session.source_path.is_file()
                or _sha256_file(session.source_path) != session.source_hash
            ):
                raise OfficeError(
                    OfficeErrorCode.SAVE_CONFLICT,
                    "源文件已被其他程序修改，不能覆盖。",
                )
            try:
                self._atomic_copy(session.working_path, session.source_path)
            except OSError as exc:
                raise OfficeError(
                    OfficeErrorCode.CHECKPOINT_FAILED,
                    "Office 源文件保存失败。",
                ) from exc
            session.source_hash = _sha256_file(session.source_path)
            session.last_error = None
        self.mark_saved(session_id, target_version)
        return session.source_path if overwrite_source else session.working_path

    def export(
        self,
        session_id: str,
        *,
        output_path: str | Path,
        workspace_root: Path,
        version: DocumentVersion | None = None,
    ) -> Path:
        session = self.get_session(session_id)
        if session.checkpoint_version is None or not session.working_path.is_file():
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office 文档尚未生成可导出的 checkpoint。",
            )
        target_version = version or session.checkpoint_version
        if session.checkpoint_version != target_version:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "只能导出指定版本的 Office checkpoint。",
            )
        workspace = workspace_root.expanduser().resolve()
        candidate = Path(output_path).expanduser()
        if not candidate.is_absolute():
            candidate = workspace / candidate
        output = candidate.resolve(strict=False)
        if output != workspace and workspace not in output.parents:
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                "导出路径不在当前工作区。",
            )
        if output.suffix.lower() != _DOCUMENT_EXTENSIONS[session.document_type]:
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                "导出文件扩展名与编辑器类型不匹配。",
            )
        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._atomic_copy(session.working_path, output)
        except OSError as exc:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office 文件导出失败。",
            ) from exc
        self.mark_saved(session_id, target_version)
        return output

    def close_session(self, session_id: str) -> None:
        session = self.get_session(session_id)
        self._fail_pending_for_session(session_id)
        self._sessions.pop(session_id, None)
        self._command_locks.pop(session_id, None)
        session.editor_connected = False
        session.closed = True
        self._persist_session(session)

    def shutdown(self) -> None:
        for session_id, session in self._sessions.items():
            self._fail_pending_for_session(session_id)
            session.editor_connected = False
            self._persist_session(session)

    @staticmethod
    def _resolve_source(
        source_path: str | Path | None,
        workspace: Path,
        allowed_roots: Sequence[Path],
    ) -> Path | None:
        if source_path is None:
            return None
        candidate = Path(source_path).expanduser()
        if not candidate.is_absolute():
            candidate = workspace / candidate
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as exc:
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Office 文件不存在。") from exc
        roots = [workspace, *(root.expanduser().resolve() for root in allowed_roots)]
        if not any(resolved == root or root in resolved.parents for root in roots):
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                "Office 文件不在允许的目录中。",
            )
        if not resolved.is_file():
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Office 路径不是文件。")
        return resolved

    def _resolve_initial_file(self, initial_file: Path) -> Path:
        try:
            staging = initial_file.expanduser().resolve(strict=True)
        except OSError as exc:
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                "Office 导入临时文件不存在。",
            ) from exc
        if staging.parent != self.sessions_root or not staging.is_file():
            raise OfficeError(
                OfficeErrorCode.INVALID_OPERATION,
                "Office 导入临时文件路径无效。",
            )
        return staging

    @staticmethod
    def _copy_initial_file(source: Path, destination: Path) -> None:
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            with source.open("rb") as input_stream, temporary.open("xb") as output_stream:
                shutil.copyfileobj(input_stream, output_stream, 1024 * 1024)
                output_stream.flush()
                os.fsync(output_stream.fileno())
            os.replace(temporary, destination)
            _fsync_directory(destination.parent)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    @staticmethod
    def _atomic_copy(source: Path, destination: Path) -> None:
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            with source.open("rb") as input_stream, temporary.open("xb") as output_stream:
                shutil.copyfileobj(input_stream, output_stream, 1024 * 1024)
                output_stream.flush()
                os.fsync(output_stream.fileno())
            os.replace(temporary, destination)
            _fsync_directory(destination.parent)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    @staticmethod
    def _require_current_epoch(session: OfficeSession, version: DocumentVersion) -> None:
        if version.editor_epoch != session.version.editor_epoch:
            raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, "Office 编辑器实例已失效。")

    @staticmethod
    def _version_conflict(
        session: OfficeSession,
        operation_id: str,
    ) -> OfficeCommandFailure:
        return OfficeCommandFailure(
            ok=False,
            session_id=session.session_id,
            operation_id=operation_id,
            current_version=session.version,
            changed_targets=session.recent_changed_targets,
            error=OfficeErrorPayload(
                code=OfficeErrorCode.VERSION_CONFLICT,
                message="文档已发生变化，请重新读取相关区域。",
                retryable=True,
            ),
        )

    def _accept_command_result(
        self,
        session: OfficeSession,
        result: OfficeCommandResult,
    ) -> None:
        if result.ok:
            if result.unchanged:
                if result.version != session.version or result.changed_targets:
                    raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, "无变化结果必须对应当前版本且没有修改目标。")
                return
            if result.version.model_revision <= session.version.model_revision:
                raise OfficeError(
                    OfficeErrorCode.VERSION_CONFLICT,
                    "编辑器返回了非递增版本。",
                )
            session.version = result.version
            if result.pending_visual_slide_ids is not None:
                session.pending_visual_slide_ids = list(result.pending_visual_slide_ids)
            if result.pending_review_targets is not None:
                session.pending_review_targets = list(result.pending_review_targets)
            session.dirty = session.saved_version != result.version
            session.save_state = "dirty" if session.dirty else "clean"
            session.recent_changed_targets = result.changed_targets[-50:]
            self._append_revision_changes(session, "agent", result.version, result.changed_targets)
            return
        if result.current_version.model_revision > session.version.model_revision:
            session.version = result.current_version
            session.dirty = session.saved_version != result.current_version
            session.save_state = "dirty" if session.dirty else "clean"
            self._append_revision_changes(
                session,
                "user",
                result.current_version,
                result.changed_targets,
            )
        session.recent_changed_targets = result.changed_targets[-50:]

    @staticmethod
    def _append_revision_changes(
        session: OfficeSession,
        actor: str,
        version: DocumentVersion,
        targets: Sequence[str],
    ) -> None:
        for target in targets:
            kind = (
                "cell"
                if "!" in target
                else "block"
                if target.startswith("block_")
                else "slide"
                if target.startswith(("slide_", "s_"))
                else "document"
            )
            session.revision_changes.append(
                RevisionChange(
                    revision=version.model_revision,
                    actor=actor,
                    target=target,
                    kind=kind,
                )
            )
        if len(session.revision_changes) > 128:
            removed = session.revision_changes[:-128]
            session.revision_changes = session.revision_changes[-128:]
            session.change_floor_revision = max(
                session.change_floor_revision,
                removed[-1].revision,
            )

    @staticmethod
    def _inspect_changed_since(
        session: OfficeSession,
        command: OfficeInspectCommand,
    ) -> OfficeInspectResponse:
        query = command.query
        assert isinstance(query, ChangedSinceQuery)
        if (
            query.version.editor_epoch != session.version.editor_epoch
            or query.version.model_revision < session.change_floor_revision
        ):
            return OfficeInspectFailure(
                ok=False,
                request_id=command.request_id,
                session_id=session.session_id,
                current_version=session.version,
                error=OfficeErrorPayload(
                    code=OfficeErrorCode.RESYNC_REQUIRED,
                    message="请求的版本已不在增量变更窗口内，请重新读取文档。",
                    retryable=True,
                ),
            )
        if query.version.model_revision > session.version.model_revision:
            return OfficeInspectFailure(
                ok=False,
                request_id=command.request_id,
                session_id=session.session_id,
                current_version=session.version,
                error=OfficeErrorPayload(
                    code=OfficeErrorCode.INVALID_OPERATION,
                    message="请求的版本晚于当前文档版本。",
                ),
            )
        return OfficeInspectSuccess(
            ok=True,
            request_id=command.request_id,
            session_id=session.session_id,
            version=session.version,
            result=ChangedSinceResult(
                mode="changed_since",
                changes=[
                    change
                    for change in session.revision_changes
                    if change.revision > query.version.model_revision
                ],
            ),
        )

    def _fail_pending_for_session(self, session_id: str) -> None:
        keys = [key for key in self._pending_commands if key[0] == session_id]
        for key in keys:
            _, future = self._pending_commands.pop(key)
            if not future.done():
                future.set_exception(
                    OfficeError(
                        OfficeErrorCode.EDITOR_UNAVAILABLE,
                        "Office 编辑器连接已失效。",
                        retryable=True,
                    )
                )
        checkpoint_keys = [key for key in self._checkpoint_waiters if key[0] == session_id]
        for key in checkpoint_keys:
            waiters = self._checkpoint_waiters.pop(key)
            for future in waiters:
                if not future.done():
                    future.set_exception(
                        OfficeError(
                            OfficeErrorCode.CHECKPOINT_FAILED,
                            "Office checkpoint 等待已取消。",
                            retryable=True,
                        )
                    )
        inspect_keys = [key for key in self._pending_inspections if key[0] == session_id]
        for key in inspect_keys:
            _, future = self._pending_inspections.pop(key)
            if not future.done():
                future.set_exception(
                    OfficeError(
                        OfficeErrorCode.EDITOR_UNAVAILABLE,
                        "Office 编辑器连接已失效。",
                        retryable=True,
                    )
                )

    def _complete_checkpoint_waiters(
        self,
        session_id: str,
        version: DocumentVersion,
    ) -> None:
        keys = [
            key
            for key in self._checkpoint_waiters
            if key[0] == session_id
            and key[1] == version.editor_epoch
            and key[2] <= version.model_revision
        ]
        for key in keys:
            for future in self._checkpoint_waiters.pop(key, []):
                if not future.done():
                    future.set_result(None)

    @staticmethod
    def _session_payload(session: OfficeSession) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "sessionId": session.session_id,
            "ownerSessionKey": session.owner_session_key,
            "type": session.document_type,
            "displayName": session.display_name,
            "sourcePath": str(session.source_path) if session.source_path is not None else None,
            "sourceIdentity": session.source_identity,
            "sourceHash": session.source_hash,
            "workingFileName": session.working_path.name,
            "version": session.version.model_dump(by_alias=True),
            "checkpointVersion": (
                session.checkpoint_version.model_dump(by_alias=True)
                if session.checkpoint_version is not None
                else None
            ),
            "savedVersion": (
                session.saved_version.model_dump(by_alias=True)
                if session.saved_version is not None
                else None
            ),
            "dirty": session.dirty,
            "editorConnected": session.editor_connected,
            "closed": session.closed,
            "saveState": session.save_state,
            "lastError": (
                session.last_error.model_dump(by_alias=True)
                if session.last_error is not None
                else None
            ),
            "changeFloorRevision": session.change_floor_revision,
            "pendingVisualSlideIds": session.pending_visual_slide_ids,
            "pendingReviewTargets": session.pending_review_targets,
            "revisionChanges": [
                change.model_dump(by_alias=True) for change in session.revision_changes
            ],
        }

    def _persist_session(self, session: OfficeSession) -> None:
        _atomic_write_json(session.session_dir / "session.json", self._session_payload(session))

    def _recover_sessions(self) -> None:
        for session_dir in self.sessions_root.glob("office_*"):
            if not session_dir.is_dir():
                continue
            session_id = session_dir.name
            try:
                resolved_dir = session_dir.resolve()
                if self.sessions_root not in resolved_dir.parents:
                    raise ValueError("session directory escaped the Office root")
                payload = json.loads((resolved_dir / "session.json").read_text(encoding="utf-8"))
                if payload.get("schemaVersion") != 1 or payload.get("sessionId") != session_id:
                    raise ValueError("unsupported Office session metadata")
                if payload.get("closed") is True:
                    continue
                document_type = payload["type"]
                if document_type not in _DOCUMENT_EXTENSIONS:
                    raise ValueError("invalid Office document type")
                owner_session_key = payload["ownerSessionKey"]
                display_name = payload["displayName"]
                working_file_name = payload["workingFileName"]
                if not all(
                    isinstance(value, str) and value
                    for value in (owner_session_key, display_name, working_file_name)
                ):
                    raise ValueError("invalid Office session identity")
                if Path(working_file_name).name != working_file_name:
                    raise ValueError("invalid Office working file name")
                working_path = (resolved_dir / working_file_name).resolve()
                if resolved_dir not in working_path.parents:
                    raise ValueError("Office working file escaped its session")
                version = DocumentVersion.model_validate(payload["version"])
                checkpoint_version = (
                    DocumentVersion.model_validate(payload["checkpointVersion"])
                    if payload.get("checkpointVersion") is not None
                    else None
                )
                saved_version = (
                    DocumentVersion.model_validate(payload["savedVersion"])
                    if payload.get("savedVersion") is not None
                    else None
                )
                if checkpoint_version is not None and not working_path.is_file():
                    raise ValueError("Office checkpoint file is missing")
                source_path = payload.get("sourcePath")
                source_hash = payload.get("sourceHash")
                if source_path is not None and not isinstance(source_path, str):
                    raise ValueError("invalid Office source path")
                if source_hash is not None and not isinstance(source_hash, str):
                    raise ValueError("invalid Office source hash")
                persisted_identity = payload.get("sourceIdentity")
                if persisted_identity is not None and not isinstance(persisted_identity, str):
                    raise ValueError("invalid Office source identity")
                save_state = payload.get("saveState", "dirty")
                if save_state not in {"clean", "dirty", "saving", "error"}:
                    raise ValueError("invalid Office save state")
                last_error = (
                    OfficeErrorPayload.model_validate(payload["lastError"])
                    if payload.get("lastError") is not None
                    else None
                )
                revision_changes = [
                    RevisionChange.model_validate(change)
                    for change in payload.get("revisionChanges", [])
                ]
                dirty = bool(payload.get("dirty", True))
                if (
                    checkpoint_version is not None
                    and version.editor_epoch == checkpoint_version.editor_epoch
                    and version.model_revision > checkpoint_version.model_revision
                ):
                    version = checkpoint_version
                    dirty = saved_version != checkpoint_version
                    save_state = "dirty" if dirty else "clean"
                    revision_changes = [
                        change
                        for change in revision_changes
                        if change.revision <= checkpoint_version.model_revision
                    ]
                    last_error = OfficeErrorPayload(
                        code=OfficeErrorCode.CHECKPOINT_FAILED,
                        message="应用异常退出，已恢复到最近一次保存点；其后的未保存修改未能恢复。",
                        retryable=False,
                    )
                resolved_source = (
                    Path(source_path).expanduser().resolve()
                    if source_path is not None
                    else None
                )
                source_identity = (
                    _normalize_source_identity(persisted_identity)
                    if persisted_identity is not None
                    else (
                        _normalize_source_identity(str(resolved_source))
                        if resolved_source is not None
                        else None
                    )
                )
                if (
                    last_error is None
                    and resolved_source is not None
                    and source_hash is not None
                    and (
                        not resolved_source.is_file()
                        or _sha256_file(resolved_source) != source_hash
                    )
                ):
                    last_error = OfficeErrorPayload(
                        code=OfficeErrorCode.SAVE_CONFLICT,
                        message="源文件已被其他程序修改或移动，覆盖保存前请先确认。",
                        retryable=False,
                    )
                session = OfficeSession(
                    session_id=session_id,
                    owner_session_key=owner_session_key,
                    document_type=document_type,
                    display_name=display_name,
                    session_dir=resolved_dir,
                    working_path=working_path,
                    source_path=resolved_source,
                    source_identity=source_identity,
                    source_hash=source_hash,
                    version=version,
                    checkpoint_version=checkpoint_version,
                    saved_version=saved_version,
                    dirty=dirty,
                    editor_connected=False,
                    closed=False,
                    save_state=save_state,
                    last_error=last_error,
                    revision_changes=revision_changes[-128:],
                    pending_visual_slide_ids=[str(value) for value in payload.get("pendingVisualSlideIds", [])],
                    pending_review_targets=[str(value) for value in payload.get("pendingReviewTargets", [])],
                    change_floor_revision=max(
                        0,
                        int(payload.get("changeFloorRevision", 0)),
                    ),
                )
                self._sessions[session_id] = session
                self._command_locks[session_id] = asyncio.Lock()
                self._persist_session(session)
            except (OSError, OfficeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                self._recovery_errors[session_id] = (
                    f"Office 会话恢复失败（{session_id}）：{exc}"
                )
