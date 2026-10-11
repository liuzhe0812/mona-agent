"""Scoped native-executor settings; persist references, never resolved secrets."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from mona.config.loader import _atomic_write_json, _config_write_lock, get_config_path
from mona.config.schema import DevelopmentConfig
from mona.development.contracts import ExecutorId
from mona.development.executors.discovery import resolve_executable
from mona.development.store import ConflictError, DevelopmentError

_FIELDS = {"codexPath": "codex_path", "claudePath": "claude_path", "codebuddyPath": "codebuddy_path",
           "claudeApiKeyEnv": "claude_api_key_env", "codebuddyApiKeyEnv": "codebuddy_api_key_env"}


def _snapshot(data: dict) -> dict:
    config = DevelopmentConfig.model_validate(data.get("development", {}))
    values = {key: getattr(config, field) for key, field in _FIELDS.items()}
    fingerprint = hashlib.sha256(json.dumps({**values, "enabledEngines": config.enabled_engines}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"values": values, "enabledEngines": config.enabled_engines, "revision": fingerprint, "credentialPresent": {
        "claude": bool(os.environ.get(config.claude_api_key_env)),
        "codebuddy": bool(os.environ.get(config.codebuddy_api_key_env))}}


def _read(path: Path) -> dict:
    if not path.exists():
        return {}
    result = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(result, dict):
        raise DevelopmentError("invalid_config", "应用配置格式无效，未覆盖原文件。")
    return result


def read_settings(path: Path | None = None) -> dict:
    path = path or get_config_path()
    with _config_write_lock(path):
        return _snapshot(_read(path))


def update_settings(revision: str, values: dict, path: Path | None = None, *, enabled_engines: list[str] | None = None) -> dict:
    if not isinstance(values, dict) or (not values and enabled_engines is None) or set(values) - set(_FIELDS):
        raise DevelopmentError("invalid_executor_settings", "只能修改执行程序路径与认证环境变量名称。")
    if enabled_engines is not None and (not isinstance(enabled_engines, list) or
            any(value not in {"codex", "claude", "codebuddy"} for value in enabled_engines)):
        raise DevelopmentError("invalid_executor_settings", "请选择支持的模型引擎。")
    for name, value in values.items():
        if name.endswith("Path"):
            if value is None or value == "":
                continue
            if not isinstance(value, str) or len(value) > 4096:
                raise DevelopmentError("invalid_executable", "执行程序路径格式无效。")
            candidate = Path(value).expanduser()
            try:
                resolve_executable(ExecutorId(name.removesuffix("Path")), candidate)
            except (OSError, ValueError) as exc:
                raise DevelopmentError("invalid_executable", "请选择已安装的原生程序或可核对的 Codex 官方包入口；不执行任意包装脚本。") from exc
        elif not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", value):
            raise DevelopmentError("invalid_credential_reference", "这里填写环境变量名称，不填写 API Key。")
    path = path or get_config_path()
    with _config_write_lock(path):
        data = _read(path)
        if _snapshot(data)["revision"] != revision:
            raise ConflictError("执行者设置已更新，请刷新后再保存；未覆盖其他修改。")
        raw = dict(data.get("development", {}))
        for key, value in values.items():
            # Avoid conflicting snake/camel spellings in legacy configuration.
            raw.pop(_FIELDS[key], None)
            raw[key] = None if value == "" and key.endswith("Path") else value
        if enabled_engines is not None:
            raw.pop("enabled_engines", None)
            raw["enabledEngines"] = list(dict.fromkeys(enabled_engines))
        DevelopmentConfig.model_validate(raw)
        data["development"] = raw
        _atomic_write_json(path, data)
        return _snapshot(data)
