"""Materials vault 路径解析（自包含，不依赖 Tauri IPC）。

优先读取 Rust 侧持久化的 `$MONA_APP_DATA_DIR/notes/vault_path.txt`
（gateway / services 进程启动时均已注入 MONA_APP_DATA_DIR）；
文件缺失或非常规启动（如测试）时回退 Tauri IPC。
"""

from __future__ import annotations

import os
from pathlib import Path


def get_vault_path() -> Path | None:
    """返回笔记 vault 根路径；未配置时返回 None。"""
    app_data = os.environ.get("MONA_APP_DATA_DIR")
    if app_data:
        try:
            text = (Path(app_data) / "notes" / "vault_path.txt").read_text(
                encoding="utf-8"
            ).strip()
        except OSError:
            text = ""
        if text:
            return Path(text)
    return _vault_path_via_ipc()


def _vault_path_via_ipc() -> Path | None:
    """回退路径：通过 Tauri IPC 向 Rust 侧查询 vault 路径。"""
    try:
        from mona.agent.tools.tauri_ipc import tauri_invoke

        result = tauri_invoke("notes_vault_get_path")
    except RuntimeError:
        return None
    if result is None:
        return None
    if isinstance(result, str) and result.strip():
        return Path(result.strip())
    if isinstance(result, dict):
        v = result.get("path") or result.get("result")
        if isinstance(v, str) and v.strip():
            return Path(v.strip())
    return None
