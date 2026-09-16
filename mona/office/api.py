"""Services HTTP and WebSocket endpoints for Mona Office sessions."""

from __future__ import annotations

import hashlib
import os
import secrets
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web
from pydantic import TypeAdapter, ValidationError

from mona.config.paths import get_workspace_path
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.schemas import (
    OFFICE_OWNER_HEADER,
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCheckpointMetadata,
    OfficeCheckpointRequestMessage,
    OfficeCheckpointStartRequest,
    OfficeCommandMessage,
    OfficeCommandResultMessage,
    OfficeEditorReadyMessage,
    OfficeEngineRangeRequest,
    OfficeExportRequest,
    OfficeInspectCommand,
    OfficeInspectCommandMessage,
    OfficeInspectRequest,
    OfficeInspectResultMessage,
    OfficeSaveRequest,
    OfficeSessionClosedMessage,
    OfficeSessionCreateRequest,
    OfficeSessionOpenMessage,
    OfficeSessionStateMessage,
    OfficeSocketMessage,
    OfficeSocketTicketRequest,
    OfficeSocketTicketResponse,
    OfficeUserChangeMessage,
)
from mona.office.sidecar import XlsxEngineService

_SOCKET_TICKET_TTL_SECONDS = 30
_SOCKET_MESSAGE_ADAPTER = TypeAdapter(OfficeSocketMessage)

OFFICE_MANAGER_KEY = web.AppKey("office_manager", OfficeSessionManager)
OFFICE_TICKET_STORE_KEY = web.AppKey("office_ticket_store", object)
OFFICE_SOCKET_HUB_KEY = web.AppKey("office_socket_hub", object)
OFFICE_WORKSPACE_KEY = web.AppKey("office_workspace", Path)
OFFICE_ENGINE_KEY = web.AppKey("office_engine", XlsxEngineService)
OFFICE_CHECKPOINT_UPLOADS_KEY = web.AppKey("office_checkpoint_uploads", object)

_CHECKPOINT_CHUNK_BYTES = 1024 * 1024
_CHECKPOINT_UPLOAD_TTL_SECONDS = 300
_MAX_IMPORT_FILENAME_LENGTH = 255


@dataclass(frozen=True, slots=True)
class _SocketTicket:
    session_id: str
    owner_session_key: str
    editor_epoch: str
    expires_at: float


@dataclass(slots=True)
class _CheckpointUpload:
    upload_id: str
    session_id: str
    owner_session_key: str
    metadata: OfficeCheckpointMetadata
    temporary_path: Path
    expires_at: float
    received: int = 0
    digest: Any = field(default_factory=hashlib.sha256)


class OfficeCheckpointUploadStore:
    def __init__(self) -> None:
        self._uploads: dict[str, _CheckpointUpload] = {}

    def create(
        self,
        *,
        session_id: str,
        owner_session_key: str,
        metadata: OfficeCheckpointMetadata,
        temporary_path: Path,
    ) -> _CheckpointUpload:
        self.remove_expired()
        self.cancel_session(session_id)
        upload_id = secrets.token_urlsafe(24)
        upload = _CheckpointUpload(
            upload_id=upload_id,
            session_id=session_id,
            owner_session_key=owner_session_key,
            metadata=metadata,
            temporary_path=temporary_path,
            expires_at=time.monotonic() + _CHECKPOINT_UPLOAD_TTL_SECONDS,
        )
        self._uploads[upload_id] = upload
        return upload

    def get(self, upload_id: str, owner_session_key: str) -> _CheckpointUpload:
        self.remove_expired()
        upload = self._uploads.get(upload_id)
        if upload is None or upload.owner_session_key != owner_session_key:
            raise OfficeError(OfficeErrorCode.SESSION_NOT_FOUND, "Checkpoint 上传不存在。")
        return upload

    def pop(self, upload_id: str, owner_session_key: str) -> _CheckpointUpload:
        upload = self.get(upload_id, owner_session_key)
        self._uploads.pop(upload_id, None)
        return upload

    def cancel_session(self, session_id: str) -> None:
        for upload_id in [
            key for key, upload in self._uploads.items() if upload.session_id == session_id
        ]:
            upload = self._uploads.pop(upload_id)
            upload.temporary_path.unlink(missing_ok=True)

    def close(self) -> None:
        for upload in self._uploads.values():
            upload.temporary_path.unlink(missing_ok=True)
        self._uploads.clear()

    def remove_expired(self) -> None:
        now = time.monotonic()
        for upload_id in [
            key for key, upload in self._uploads.items() if upload.expires_at <= now
        ]:
            upload = self._uploads.pop(upload_id)
            upload.temporary_path.unlink(missing_ok=True)


class OfficeSocketTicketStore:
    def __init__(self, *, ttl_seconds: int = _SOCKET_TICKET_TTL_SECONDS) -> None:
        self.ttl_seconds = ttl_seconds
        self._tickets: dict[str, _SocketTicket] = {}

    def issue(self, *, session_id: str, owner_session_key: str, editor_epoch: str) -> str:
        self._remove_expired()
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = _SocketTicket(
            session_id=session_id,
            owner_session_key=owner_session_key,
            editor_epoch=editor_epoch,
            expires_at=time.monotonic() + self.ttl_seconds,
        )
        return ticket

    def consume(self, ticket: str) -> _SocketTicket | None:
        record = self._tickets.pop(ticket, None)
        if record is None or record.expires_at <= time.monotonic():
            return None
        return record

    def _remove_expired(self) -> None:
        now = time.monotonic()
        expired = [ticket for ticket, record in self._tickets.items() if record.expires_at <= now]
        for ticket in expired:
            self._tickets.pop(ticket, None)


class OfficeSocketHub:
    def __init__(self) -> None:
        self._connections: dict[str, web.WebSocketResponse] = {}

    async def attach(self, session_id: str, socket: web.WebSocketResponse) -> None:
        previous = self._connections.get(session_id)
        if previous is not None and previous is not socket and not previous.closed:
            await previous.close(code=4000, message=b"editor replaced")
        self._connections[session_id] = socket

    def detach(self, session_id: str, socket: web.WebSocketResponse) -> None:
        if self._connections.get(session_id) is socket:
            self._connections.pop(session_id, None)

    async def send_command(self, command: OfficeApplyCommand) -> None:
        socket = self._connections.get(command.session_id)
        if socket is None or socket.closed:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 编辑器尚未连接。",
                retryable=True,
            )
        message = OfficeCommandMessage(event="office_command", command=command)
        await socket.send_json(message.model_dump(by_alias=True, mode="json", exclude_unset=True))

    async def send_inspect(self, command: OfficeInspectCommand) -> None:
        socket = self._connections.get(command.session_id)
        if socket is None or socket.closed:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 编辑器尚未连接。",
                retryable=True,
            )
        message = OfficeInspectCommandMessage(event="office_inspect_command", command=command)
        await socket.send_json(message.model_dump(by_alias=True, mode="json"))

    async def send_checkpoint_request(
        self,
        session_id: str,
        version: DocumentVersion,
    ) -> None:
        socket = self._connections.get(session_id)
        if socket is None or socket.closed:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 编辑器尚未连接。",
                retryable=True,
            )
        message = OfficeCheckpointRequestMessage(
            event="office_checkpoint_request",
            session_id=session_id,
            version=version,
        )
        await socket.send_json(message.model_dump(by_alias=True, mode="json"))

    async def send_state(self, manager: OfficeSessionManager, session_id: str) -> None:
        socket = self._connections.get(session_id)
        if socket is None or socket.closed:
            return
        message = OfficeSessionStateMessage(
            event="office_session_state",
            session=manager.get_session(session_id).to_state(),
        )
        await socket.send_json(message.model_dump(by_alias=True, mode="json"))

    async def close_session(self, session_id: str) -> None:
        socket = self._connections.pop(session_id, None)
        if socket is None or socket.closed:
            return
        message = OfficeSessionClosedMessage(
            event="office_session_closed",
            session_id=session_id,
        )
        await socket.send_json(message.model_dump(by_alias=True, mode="json"))
        await socket.close()

    async def close(self) -> None:
        sockets = list(self._connections.values())
        self._connections.clear()
        for socket in sockets:
            if not socket.closed:
                await socket.close(code=1001, message=b"service shutdown")


def _manager(request: web.Request) -> OfficeSessionManager:
    return request.app[OFFICE_MANAGER_KEY]


def _tickets(request: web.Request) -> OfficeSocketTicketStore:
    return request.app[OFFICE_TICKET_STORE_KEY]  # type: ignore[return-value]


def _hub(request: web.Request) -> OfficeSocketHub:
    return request.app[OFFICE_SOCKET_HUB_KEY]  # type: ignore[return-value]


def _engine(request: web.Request) -> XlsxEngineService:
    return request.app[OFFICE_ENGINE_KEY]


def _checkpoint_uploads(request: web.Request) -> OfficeCheckpointUploadStore:
    return request.app[OFFICE_CHECKPOINT_UPLOADS_KEY]  # type: ignore[return-value]


def _owner_session_key(request: web.Request) -> str:
    owner = request.headers.get(OFFICE_OWNER_HEADER, "").strip()
    if not owner:
        raise OfficeError(OfficeErrorCode.SESSION_NOT_FOUND, "Office 会话不存在。")
    return owner


def _accept_socket_action(action: Callable[[], object]) -> bool:
    try:
        action()
        return True
    except OfficeError:
        return False


async def _parse_json(request: web.Request, model_type):
    try:
        payload = await request.json()
    except (ValueError, TypeError) as exc:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "请求 JSON 无效。") from exc
    return model_type.model_validate(payload)


def _model_response(model, *, status: int = 200) -> web.Response:
    return web.json_response(model.model_dump(by_alias=True, mode="json"), status=status)


@web.middleware
async def office_error_middleware(request: web.Request, handler) -> web.StreamResponse:
    try:
        return await handler(request)
    except ValidationError as exc:
        return web.json_response(
            {
                "error": {
                    "code": OfficeErrorCode.INVALID_OPERATION,
                    "message": "Office 请求参数无效。",
                    "retryable": False,
                    "details": exc.errors(include_url=False, include_input=False),
                }
            },
            status=422,
        )
    except OfficeError as exc:
        status = {
            OfficeErrorCode.SESSION_NOT_FOUND: 404,
            OfficeErrorCode.EDITOR_UNAVAILABLE: 503,
            OfficeErrorCode.VERSION_CONFLICT: 409,
            OfficeErrorCode.RESYNC_REQUIRED: 409,
            OfficeErrorCode.INVALID_OPERATION: 422,
            OfficeErrorCode.CHECKPOINT_FAILED: 422,
            OfficeErrorCode.SAVE_CONFLICT: 409,
        }[exc.code]
        return web.json_response(
            {
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "retryable": exc.retryable,
                }
            },
            status=status,
        )


async def handle_create_session(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeSessionCreateRequest)
    owner_session_key = _owner_session_key(request)
    if body.owner_session_key != owner_session_key:
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "Office 会话标识不一致。",
        )
    document_type = body.type or _document_type_from_path(body.path)
    session = _manager(request).create_session(
        owner_session_key=owner_session_key,
        document_type=document_type,
        workspace_root=request.app[OFFICE_WORKSPACE_KEY],
        source_path=body.path,
        display_name=body.display_name,
    )
    return _model_response(session.to_state(), status=201)


async def handle_import(request: web.Request) -> web.Response:
    filename = request.query.get("filename", "")
    source_identity = request.query.get("sourceIdentity", "")
    document_type = _document_type_from_filename(filename)
    owner_session_key = _owner_session_key(request)
    if request.content_type != "application/octet-stream":
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "Office 导入请求必须使用 application/octet-stream。",
        )
    if not source_identity:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Office sourceIdentity 不能为空。")
    normalized_identity = source_identity.replace("\\", "/")
    if len(normalized_identity) > 2048:
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "Office sourceIdentity 超过长度限制。",
        )
    manager = _manager(request)
    if request.content_length is not None and request.content_length > manager.max_checkpoint_bytes:
        raise OfficeError(
            OfficeErrorCode.CHECKPOINT_FAILED,
            "Office 导入文件超过大小限制。",
        )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".office-import-",
        suffix=Path(filename).suffix.lower(),
        dir=manager.sessions_root,
    )
    temporary = Path(temporary_name)
    total = 0
    try:
        with os.fdopen(descriptor, "wb") as stream:
            async for chunk in request.content.iter_chunked(_CHECKPOINT_CHUNK_BYTES):
                total += len(chunk)
                if total > manager.max_checkpoint_bytes:
                    raise OfficeError(
                        OfficeErrorCode.CHECKPOINT_FAILED,
                        "Office 导入文件超过大小限制。",
                    )
                stream.write(chunk)
            if total == 0:
                raise OfficeError(
                    OfficeErrorCode.INVALID_OPERATION,
                    "Office 导入文件不能为空。",
                )
            stream.flush()
            os.fsync(stream.fileno())
        was_existing = manager.find_session(
            owner_session_key=owner_session_key,
            document_type=document_type,
            source_identity=normalized_identity,
        )
        session = manager.create_session(
            owner_session_key=owner_session_key,
            document_type=document_type,
            workspace_root=request.app[OFFICE_WORKSPACE_KEY],
            display_name=filename,
            initial_file=temporary,
            source_identity=normalized_identity,
        )
        return _model_response(session.to_state(), status=200 if was_existing else 201)
    finally:
        temporary.unlink(missing_ok=True)


async def handle_get_session(request: web.Request) -> web.Response:
    session = _manager(request).get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    return _model_response(session.to_state())


async def handle_list_sessions(request: web.Request) -> web.Response:
    sessions = _manager(request).list_sessions(
        owner_session_key=_owner_session_key(request),
    )
    return web.json_response(
        {"sessions": [session.to_state().model_dump(by_alias=True, mode="json") for session in sessions]}
    )


async def handle_get_file(request: web.Request) -> web.StreamResponse:
    session = _manager(request).get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    if not session.working_path.is_file():
        raise OfficeError(OfficeErrorCode.CHECKPOINT_FAILED, "Office 工作副本尚未生成。")
    return web.FileResponse(session.working_path)


async def handle_socket_ticket(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeSocketTicketRequest)
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    if body.renew_editor:
        manager.begin_editor_epoch(session.session_id)
    ticket = _tickets(request).issue(
        session_id=session.session_id,
        owner_session_key=session.owner_session_key,
        editor_epoch=session.version.editor_epoch,
    )
    return _model_response(
        OfficeSocketTicketResponse(
            ticket=ticket,
            session_id=session.session_id,
            editor_epoch=session.version.editor_epoch,
            expires_in_seconds=_tickets(request).ttl_seconds,
        )
    )


async def handle_checkpoint(request: web.Request) -> web.Response:
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    try:
        metadata = OfficeCheckpointMetadata(
            session_id=session.session_id,
            version=DocumentVersion(
                editor_epoch=request.headers["X-Office-Editor-Epoch"],
                model_revision=int(request.headers["X-Office-Model-Revision"]),
            ),
            size=int(request.headers["Content-Length"]),
            sha256=request.headers["X-Office-Content-SHA256"],
        )
    except (KeyError, ValueError) as exc:
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "Checkpoint 请求头不完整。",
        ) from exc
    if metadata.size > manager.max_checkpoint_bytes:
        raise OfficeError(
            OfficeErrorCode.CHECKPOINT_FAILED,
            "Office checkpoint 超过大小限制。",
        )

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{session.working_path.name}.",
        suffix=".upload",
        dir=session.session_dir,
    )
    temporary = Path(temporary_name)
    total = 0
    try:
        with os.fdopen(descriptor, "wb") as stream:
            async for chunk in request.content.iter_chunked(1024 * 1024):
                total += len(chunk)
                if total > manager.max_checkpoint_bytes:
                    raise OfficeError(
                        OfficeErrorCode.CHECKPOINT_FAILED,
                        "Office checkpoint 超过大小限制。",
                    )
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        if total != metadata.size:
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint 大小校验失败。",
            )
        receipt = manager.commit_checkpoint_file(metadata, temporary)
        await _hub(request).send_state(manager, session.session_id)
        return _model_response(receipt)
    finally:
        temporary.unlink(missing_ok=True)


async def handle_checkpoint_start(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeCheckpointStartRequest)
    manager = _manager(request)
    owner = _owner_session_key(request)
    session = manager.get_session(request.match_info["session_id"], owner_session_key=owner)
    if body.size > manager.max_checkpoint_bytes:
        raise OfficeError(
            OfficeErrorCode.CHECKPOINT_FAILED,
            "Office checkpoint 超过大小限制。",
        )
    metadata = OfficeCheckpointMetadata(
        session_id=session.session_id,
        version=body.version,
        size=body.size,
        sha256=body.sha256,
    )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{session.working_path.name}.",
        suffix=".chunked-upload",
        dir=session.session_dir,
    )
    os.close(descriptor)
    upload = _checkpoint_uploads(request).create(
        session_id=session.session_id,
        owner_session_key=owner,
        metadata=metadata,
        temporary_path=Path(temporary_name),
    )
    return web.json_response(
        {
            "uploadId": upload.upload_id,
            "chunkBytes": _CHECKPOINT_CHUNK_BYTES,
        },
        status=201,
    )


async def handle_checkpoint_chunk(request: web.Request) -> web.Response:
    owner = _owner_session_key(request)
    upload = _checkpoint_uploads(request).get(request.match_info["upload_id"], owner)
    try:
        offset = int(request.query.get("offset", ""))
    except ValueError as exc:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Checkpoint offset 无效。") from exc
    if offset != upload.received:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Checkpoint 分块顺序无效。")
    if request.content_length is not None and request.content_length > _CHECKPOINT_CHUNK_BYTES:
        raise OfficeError(OfficeErrorCode.CHECKPOINT_FAILED, "Checkpoint 分块超过大小限制。")
    chunk = await request.read()
    if not chunk or len(chunk) > _CHECKPOINT_CHUNK_BYTES:
        raise OfficeError(OfficeErrorCode.CHECKPOINT_FAILED, "Checkpoint 分块大小无效。")
    if upload.received + len(chunk) > upload.metadata.size:
        raise OfficeError(OfficeErrorCode.CHECKPOINT_FAILED, "Checkpoint 数据超过声明大小。")
    with upload.temporary_path.open("ab") as stream:
        stream.write(chunk)
    upload.received += len(chunk)
    upload.digest.update(chunk)
    upload.expires_at = time.monotonic() + _CHECKPOINT_UPLOAD_TTL_SECONDS
    return web.json_response({"received": upload.received})


async def handle_checkpoint_finish(request: web.Request) -> web.Response:
    owner = _owner_session_key(request)
    upload = _checkpoint_uploads(request).pop(request.match_info["upload_id"], owner)
    try:
        if (
            upload.received != upload.metadata.size
            or upload.digest.hexdigest() != upload.metadata.sha256
        ):
            raise OfficeError(
                OfficeErrorCode.CHECKPOINT_FAILED,
                "Office checkpoint 大小或摘要校验失败。",
            )
        with upload.temporary_path.open("rb+") as stream:
            stream.flush()
            os.fsync(stream.fileno())
        receipt = _manager(request).commit_checkpoint_file(
            upload.metadata,
            upload.temporary_path,
        )
        await _hub(request).send_state(_manager(request), upload.session_id)
        return _model_response(receipt)
    finally:
        upload.temporary_path.unlink(missing_ok=True)


async def handle_engine_open(request: web.Request) -> web.Response:
    session = _manager(request).get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    if session.document_type != "sheets" or not session.working_path.is_file():
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "当前会话不是可打开的表格文件。",
        )
    workbook = await _engine(request).open(session.session_id, session.working_path)
    return web.json_response(workbook)


async def handle_engine_range(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeEngineRangeRequest)
    session = _manager(request).get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    result = await _engine(request).read_range(
        session.session_id,
        sheet_id=body.sheet_id,
        start_row=body.range.start_row,
        end_row=body.range.end_row,
        start_column=body.range.start_column,
        end_column=body.range.end_column,
    )
    return web.json_response(result)


async def handle_inspect(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeInspectRequest)
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    if body.session_id != session.session_id:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Office sessionId 不匹配。")
    command = OfficeInspectCommand(
        session_id=session.session_id,
        request_id=f"inspect_{secrets.token_hex(12)}",
        query=body.query,
    )
    result = await manager.execute_inspect(command, _hub(request).send_inspect)
    return _model_response(result, status=200 if result.ok else 409)


async def handle_apply(request: web.Request) -> web.Response:
    command = await _parse_json(request, OfficeApplyCommand)
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    if command.session_id != session.session_id:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Office sessionId 不匹配。")
    result = await manager.execute_command(command, _hub(request).send_command)
    await _hub(request).send_state(manager, session.session_id)
    return _model_response(result, status=200 if result.ok else 409)


async def _ensure_action_checkpoint(
    request: web.Request,
    session,
    requested_version: DocumentVersion | None,
) -> DocumentVersion:
    target = requested_version or session.version
    if target != session.version:
        raise OfficeError(
            OfficeErrorCode.VERSION_CONFLICT,
            "文档已发生变化，请重新读取后再保存。",
            retryable=True,
        )
    if session.checkpoint_version != target:
        await _hub(request).send_checkpoint_request(session.session_id, target)
        return await _manager(request).wait_for_checkpoint(session.session_id, target)
    return target


async def handle_save(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeSaveRequest)
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    target = await _ensure_action_checkpoint(request, session, body.version)
    saved = manager.save(
        session.session_id,
        version=target,
        overwrite_source=body.overwrite_source,
    )
    await _hub(request).send_state(manager, session.session_id)
    return web.json_response(
        {
            "ok": True,
            "fileName": saved.name,
            "version": session.saved_version.model_dump(by_alias=True),
        }
    )


async def handle_export(request: web.Request) -> web.Response:
    body = await _parse_json(request, OfficeExportRequest)
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    target = await _ensure_action_checkpoint(request, session, body.version)
    exported = manager.export(
        session.session_id,
        output_path=body.output,
        workspace_root=request.app[OFFICE_WORKSPACE_KEY],
        version=target,
    )
    await _hub(request).send_state(manager, session.session_id)
    return web.json_response(
        {
            "ok": True,
            "fileName": exported.name,
            "version": session.saved_version.model_dump(by_alias=True),
        }
    )


async def handle_close_session(request: web.Request) -> web.Response:
    manager = _manager(request)
    session = manager.get_session(
        request.match_info["session_id"],
        owner_session_key=_owner_session_key(request),
    )
    await _engine(request).close(session.session_id)
    _checkpoint_uploads(request).cancel_session(session.session_id)
    await _hub(request).close_session(session.session_id)
    manager.close_session(session.session_id)
    return web.json_response({"ok": True, "sessionId": session.session_id})


async def handle_office_socket(request: web.Request) -> web.WebSocketResponse:
    record = _tickets(request).consume(request.query.get("ticket", ""))
    if record is None:
        raise web.HTTPUnauthorized(reason="invalid office socket ticket")
    manager = _manager(request)
    session = manager.get_session(
        record.session_id,
        owner_session_key=record.owner_session_key,
    )
    if session.version.editor_epoch != record.editor_epoch:
        raise web.HTTPUnauthorized(reason="expired office editor epoch")

    socket = web.WebSocketResponse(heartbeat=20, max_msg_size=20 * 1024 * 1024)
    await socket.prepare(request)
    await socket.send_json(
        OfficeSessionOpenMessage(
            event="office_session_open",
            session=session.to_state(),
        ).model_dump(by_alias=True, mode="json")
    )
    attached = False
    try:
        async for message in socket:
            if message.type == WSMsgType.TEXT:
                try:
                    parsed = _SOCKET_MESSAGE_ADAPTER.validate_json(message.data)
                except ValidationError:
                    await socket.close(code=1008, message=b"invalid office message")
                    break
                if not attached:
                    if not isinstance(parsed, OfficeEditorReadyMessage):
                        await socket.close(code=1008, message=b"editor_ready required")
                        break
                    if not _accept_socket_action(
                        lambda: manager.connect_editor(session.session_id, parsed.version)
                    ):
                        await socket.close(code=1008, message=b"invalid editor version")
                        break
                    await _hub(request).attach(session.session_id, socket)
                    attached = True
                    await _hub(request).send_state(manager, session.session_id)
                    for command in manager.pending_commands(session.session_id):
                        await _hub(request).send_command(command)
                elif isinstance(parsed, OfficeUserChangeMessage):
                    if not _accept_socket_action(
                        lambda: manager.record_editor_version(
                            session.session_id,
                            parsed.version,
                            changed_targets=parsed.changed_targets,
                            pending_visual_slide_ids=parsed.pending_visual_slide_ids,
                            pending_review_targets=parsed.pending_review_targets,
                        )
                    ):
                        await socket.close(code=1008, message=b"invalid editor version")
                        break
                    await _hub(request).send_state(manager, session.session_id)
                elif isinstance(parsed, OfficeCommandResultMessage):
                    if not _accept_socket_action(lambda: manager.complete_command(parsed.result)):
                        await socket.close(code=1008, message=b"invalid command result")
                        break
                elif isinstance(parsed, OfficeInspectResultMessage):
                    if not _accept_socket_action(lambda: manager.complete_inspect(parsed.result)):
                        await socket.close(code=1008, message=b"invalid inspect result")
                        break
                elif isinstance(parsed, OfficeSessionClosedMessage):
                    await socket.close()
                else:
                    await socket.close(code=1008, message=b"message direction not allowed")
                    break
            elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                break
    finally:
        if attached:
            _hub(request).detach(session.session_id, socket)
            try:
                manager.disconnect_editor(session.session_id)
            except OfficeError as exc:
                if exc.code != OfficeErrorCode.SESSION_NOT_FOUND:
                    raise
    return socket


def register_office_routes(
    app: web.Application,
    *,
    manager: OfficeSessionManager | None = None,
    engine: XlsxEngineService | None = None,
    workspace: str | Path | None = None,
) -> None:
    office_manager = manager or OfficeSessionManager()
    app[OFFICE_MANAGER_KEY] = office_manager
    app[OFFICE_TICKET_STORE_KEY] = OfficeSocketTicketStore()
    app[OFFICE_SOCKET_HUB_KEY] = OfficeSocketHub()
    app[OFFICE_WORKSPACE_KEY] = (
        Path(workspace).expanduser().resolve() if workspace is not None else get_workspace_path().resolve()
    )
    app[OFFICE_ENGINE_KEY] = engine or XlsxEngineService()
    app[OFFICE_CHECKPOINT_UPLOADS_KEY] = OfficeCheckpointUploadStore()
    app.router.add_post("/api/office/sessions", handle_create_session)
    app.router.add_get("/api/office/sessions", handle_list_sessions)
    app.router.add_post("/api/office/import", handle_import)
    app.router.add_get("/api/office/sessions/{session_id}", handle_get_session)
    app.router.add_get("/api/office/sessions/{session_id}/file", handle_get_file)
    app.router.add_post("/api/office/sessions/{session_id}/socket-ticket", handle_socket_ticket)
    app.router.add_post("/api/office/sessions/{session_id}/checkpoint", handle_checkpoint)
    app.router.add_post(
        "/api/office/sessions/{session_id}/checkpoint-uploads",
        handle_checkpoint_start,
    )
    app.router.add_put(
        "/api/office/checkpoint-uploads/{upload_id}",
        handle_checkpoint_chunk,
    )
    app.router.add_post(
        "/api/office/checkpoint-uploads/{upload_id}/finish",
        handle_checkpoint_finish,
    )
    app.router.add_post("/api/office/sessions/{session_id}/engine/open", handle_engine_open)
    app.router.add_post("/api/office/sessions/{session_id}/engine/range", handle_engine_range)
    app.router.add_post("/api/office/sessions/{session_id}/inspect", handle_inspect)
    app.router.add_post("/api/office/sessions/{session_id}/apply", handle_apply)
    app.router.add_post("/api/office/sessions/{session_id}/save", handle_save)
    app.router.add_post("/api/office/sessions/{session_id}/export", handle_export)
    app.router.add_delete("/api/office/sessions/{session_id}", handle_close_session)
    app.router.add_get("/api/office/ws", handle_office_socket)

    async def cleanup_office(_app: web.Application) -> None:
        await _hub_from_app(app).close()
        await app[OFFICE_ENGINE_KEY].shutdown()
        _checkpoint_uploads_from_app(app).close()
        office_manager.shutdown()

    app.on_cleanup.append(cleanup_office)


def _hub_from_app(app: web.Application) -> OfficeSocketHub:
    return app[OFFICE_SOCKET_HUB_KEY]  # type: ignore[return-value]


def _checkpoint_uploads_from_app(app: web.Application) -> OfficeCheckpointUploadStore:
    return app[OFFICE_CHECKPOINT_UPLOADS_KEY]  # type: ignore[return-value]


def _document_type_from_path(path: str | None):
    if not path:
        raise OfficeError(
            OfficeErrorCode.INVALID_OPERATION,
            "新建 Office 会话必须指定文档类型。",
        )
    return _document_type_from_filename(Path(path).name)


def _document_type_from_filename(filename: str):
    if (
        not filename
        or len(filename) > _MAX_IMPORT_FILENAME_LENGTH
        or filename in {".", ".."}
        or "/" in filename
        or "\\" in filename
        or Path(filename).name != filename
    ):
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "Office 文件名必须是纯文件名。")
    extension = Path(filename).suffix.lower()
    document_type = {".docx": "docs", ".xlsx": "sheets", ".pptx": "slides"}.get(extension)
    if document_type is None:
        raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "不支持的 Office 文件类型。")
    return document_type
