"""Read-only native executable discovery, never an implicit install or login.

A path existing is not a verified protocol, authentication or isolation check.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from mona.config.schema import DevelopmentConfig
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorProbe


def discover_executors(config: DevelopmentConfig, *, search_path: str | None = None) -> list[ExecutorProbe]:
    result: list[ExecutorProbe] = []
    for executor, configured in (
        (ExecutorId.CODEX, config.codex_path),
        (ExecutorId.CLAUDE, config.claude_path),
        (ExecutorId.CODEBUDDY, config.codebuddy_path),
    ):
        located: str | None
        if configured is not None:
            candidate = Path(configured).expanduser()
            if not candidate.is_absolute() or not candidate.is_file() or (os.name != "nt" and not os.access(candidate, os.X_OK)):
                result.append(ExecutorProbe(executor=executor, state="invalid_path", executable=configured,
                    reason="显式路径无效，未静默改用 PATH 中另一个程序。"))
                continue
            located = str(candidate.resolve())
        else:
            # An explicitly empty search_path must stay empty, not use host PATH.
            located = shutil.which(executor.value, path=search_path) if search_path != "" else None
        if not located:
            result.append(ExecutorProbe(executor=executor, state="not_detected",
                reason="在当前执行环境的 PATH 和配置中未检测到；尚未进行原生协议、认证和项目资源隔离验证。"))
            continue
        result.append(ExecutorProbe(executor=executor, state="detected", executable=str(Path(located).resolve()),
            reason="已找到程序，未启动、未读取用户配置；版本、认证及隔离能力仍需原生协议验证。"))
    return result
