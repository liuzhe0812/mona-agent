"""Frame the pinned SDK transport and adapt WorkBuddy's bundled CLI launcher."""
from __future__ import annotations

import importlib
import json
import os
from collections.abc import AsyncIterator
from contextlib import contextmanager
from pathlib import Path

from mona.development.executors.rpc import RpcError, _reject_constant
from mona.development.executors.workbuddy_application import workbuddy_cli_launcher
from mona.development.input_content import MAX_NATIVE_FRAME_BYTES


def _checked_frame(text: str) -> str:
    if not text.strip():
        return text
    try:
        value = json.loads(text, parse_constant=_reject_constant)
        if not isinstance(value, dict):
            raise ValueError("invalid envelope")
    except (ValueError, TypeError, RecursionError):
        raise RpcError("native_protocol_error", "原生程序返回了不完整或无效的协议消息。", outcome_unknown=True) from None
    return text


async def _stdout_json_lines(stream) -> AsyncIterator[str]:
    # The SDK guesses frame boundaries from arbitrary pipe chunks and can drop
    # large image results. Feed it complete lines without changing their bytes.
    parts = []
    size = 0
    async for chunk in stream:
        fragments = chunk.split("\n")
        for index, fragment in enumerate(fragments):
            parts.append(fragment)
            size += len(fragment.encode("utf-8"))
            if size > MAX_NATIVE_FRAME_BYTES:
                raise RpcError("rpc_frame_too_large", "原生回复超过通信大小限制。", outcome_unknown=True)
            if index < len(fragments) - 1:
                yield _checked_frame("".join(parts) + "\n")
                parts.clear()
                size = 0
    if parts:
        yield _checked_frame("".join(parts))


def desktop_transport(executable: str, *, options):
    entry = Path(executable)
    launcher = workbuddy_cli_launcher(entry)
    from codebuddy_agent_sdk.transport import SubprocessTransport

    if not all(callable(getattr(SubprocessTransport, name, None)) for name in ("_get_cli_path", "_build_args")):
        raise RpcError("sdk_contract_incompatible", "配套 SDK 不支持此应用的启动方式。")

    class DesktopTransport(SubprocessTransport):
        def _get_cli_path(self) -> str:
            return str(launcher) if launcher else super()._get_cli_path()

        def _build_args(self) -> list[str]:
            arguments = super()._build_args()
            return [str(entry), *arguments] if launcher else arguments

        async def connect(self) -> None:
            if launcher and os.environ.get("ELECTRON_RUN_AS_NODE") != "1":
                raise RpcError("sdk_contract_incompatible", "应用组件的隔离启动环境不完整。")
            await super().connect()
            if self._stdout_stream is not None:
                self._stdout_stream = _stdout_json_lines(self._stdout_stream)

    return DesktopTransport(options=options)


@contextmanager
def desktop_auth_transport(executable: str):
    if not workbuddy_cli_launcher(Path(executable)):
        yield
        return
    # authenticate has no transport option. This factory substitution is confined
    # to the isolated, single-purpose SDK worker; the SDK still owns all auth I/O.
    auth = importlib.import_module("codebuddy_agent_sdk.auth")
    original = auth.SubprocessTransport
    auth.SubprocessTransport = lambda *, options: desktop_transport(executable, options=options)
    try:
        yield
    finally:
        auth.SubprocessTransport = original
