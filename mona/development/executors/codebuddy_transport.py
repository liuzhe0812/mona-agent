"""Adapt the pinned SDK's executable-only launcher to WorkBuddy's bundled CLI."""
from __future__ import annotations

import importlib
import os
from contextlib import contextmanager
from pathlib import Path

from mona.development.executors.rpc import RpcError
from mona.development.executors.workbuddy_application import workbuddy_cli_launcher


def desktop_transport(executable: str, *, options):
    entry = Path(executable)
    launcher = workbuddy_cli_launcher(entry)
    if not launcher:
        return None
    from codebuddy_agent_sdk.transport import SubprocessTransport

    if not all(callable(getattr(SubprocessTransport, name, None)) for name in ("_get_cli_path", "_build_args")):
        raise RpcError("sdk_contract_incompatible", "配套 SDK 不支持此应用的启动方式。")

    class DesktopTransport(SubprocessTransport):
        def _get_cli_path(self) -> str:
            return str(launcher)

        def _build_args(self) -> list[str]:
            return [str(entry), *super()._build_args()]

        async def connect(self) -> None:
            if os.environ.get("ELECTRON_RUN_AS_NODE") != "1":
                raise RpcError("sdk_contract_incompatible", "应用组件的隔离启动环境不完整。")
            await super().connect()

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
