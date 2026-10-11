"""Native coding programs are ordinary shared runtime components, not user state."""
from __future__ import annotations

import json
import platform
import sys
from pathlib import Path

from mona.config.paths import get_managed_runtimes_dir
from mona.runtime.manager import RuntimeComponentStore, RuntimeManagerError

# Resource name -> immutable component identity and catalog kind.
EXECUTOR_RUNTIMES = {
    "codex": ("codex-cli", "codex-runtime"),
    "claude": ("claude-code-cli", "claude-code-runtime"),
    "codebuddy": ("codebuddy-cli", "codebuddy-runtime"),
}


def managed_executor_path(executor: str, store: RuntimeComponentStore | None = None) -> Path | None:
    """Read the activated version only; never download, execute or inspect CLI homes."""
    component_id, kind = EXECUTOR_RUNTIMES[executor]
    store = store if store is not None else RuntimeComponentStore(get_managed_runtimes_dir())
    active = store.active(component_id)
    pointer = store.root / "components" / component_id / "current.json"
    if active is None:
        if pointer.exists():
            raise RuntimeManagerError("受管执行环境不完整，请在模型引擎管理中修复；未改用其他安装。")
        return None
    manifest, directory = active
    try:
        directory = directory.resolve(strict=True)
        if manifest.kind != kind or executor not in manifest.entrypoints or "metadata" not in manifest.entrypoints:
            raise ValueError("wrong runtime identity")
        paths = {name: (directory / relative).resolve(strict=True) for name, relative in manifest.entrypoints.items()}
        if any(not path.is_relative_to(directory) or not path.is_file() for path in paths.values()):
            raise ValueError("runtime entrypoint escaped")
        with paths["metadata"].open(encoding="utf-8") as stream:
            metadata = json.loads(stream.read(16_385))
        arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(platform.machine().lower(), platform.machine().lower())
        if (metadata.get("schemaVersion"), metadata.get("executor"), metadata.get("platform"), metadata.get("architecture")) != (1, executor, sys.platform, arch):
            raise ValueError("runtime platform mismatch")
        return paths[executor]
    except (KeyError, OSError, ValueError, AttributeError, RuntimeError) as exc:
        raise RuntimeManagerError("受管执行环境的身份、平台或文件不匹配，请在模型引擎管理中修复。") from exc
