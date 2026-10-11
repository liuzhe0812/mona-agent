from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from mona.config.schema import DevelopmentConfig
from mona.development.contracts import ExecutorId
from mona.development.executors.discovery import discover_executors, resolve_executable


def test_standard_install_location_is_found_without_reading_profiles(tmp_path, monkeypatch):
    home = tmp_path / "用户"
    binary = home / ".local/bin" / ("claude.exe" if os.name == "nt" else "claude")
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"not executed")
    binary.chmod(0o700)
    (home / ".claude").mkdir()
    rule = home / ".claude/settings.json"
    rule.write_text("PRIVATE_CONFIG_NOT_TO_LOAD")
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setattr("mona.development.executors.discovery.shutil.which", lambda *_a, **_k: None)
    result = discover_executors(DevelopmentConfig())[1]
    assert result.executable == str(binary.resolve()) and result.source == "standard_location"
    assert result.stage == "discovery" and not result.protocol_verified
    assert "PRIVATE_CONFIG" not in result.model_dump_json()
    assert all(p.state == "not_detected" for p in discover_executors(DevelopmentConfig(), search_path=""))


def test_codex_known_npm_shim_resolves_platform_binary_without_executing_shim(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.development.executors.discovery.sys.platform", "win32")
    monkeypatch.setattr("mona.development.executors.discovery.platform.machine", lambda: "AMD64")
    prefix = tmp_path / "npm"
    root = prefix / "node_modules/@openai/codex"
    root.mkdir(parents=True)
    (root / "package.json").write_text(json.dumps({"name": "@openai/codex"}))
    shim = prefix / "codex.cmd"
    shim.write_text("DO NOT EXECUTE WRAPPER")
    binary = root.parent / "codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex" / ("codex.exe" if os.name == "nt" else "codex")
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"not executed")
    binary.chmod(0o700)
    resolved, projected = resolve_executable(ExecutorId.CODEX, shim)
    assert resolved == binary.resolve() and projected
    result = discover_executors(DevelopmentConfig(codex_path=str(shim)), search_path="")[0]
    assert result.state == "detected" and result.source == "npm_platform_package"
    (root / "package.json").write_text(json.dumps({"name": "unrelated-package"}))
    with pytest.raises(ValueError, match="unsupported_launcher"):
        resolve_executable(ExecutorId.CODEX, shim)


def test_explicit_invalid_path_does_not_use_a_known_installation(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.development.executors.discovery._standard_candidates", lambda *_: pytest.fail("not allowed"))
    result = discover_executors(DevelopmentConfig(codex_path=str(tmp_path / "missing")), search_path="")[0]
    assert result.state == "invalid_path" and result.error_code == "invalid_executable"


def test_arbitrary_wrapper_stays_unsupported(tmp_path):
    script = tmp_path / "my-tool.cmd"
    script.write_text("arbitrary command")
    for executor in (ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY):
        with pytest.raises(ValueError, match="unsupported_launcher"):
            resolve_executable(executor, script)


def test_desktop_codex_refresh_finds_new_binary_without_copying_it(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.development.executors.discovery.sys.platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root = tmp_path / "OpenAI/Codex/bin"
    old = root / "old/codex.exe"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"old native fixture")
    old.chmod(0o700)
    (root / "incomplete").mkdir()
    monkeypatch.setattr("mona.development.executors.discovery.shutil.which", lambda *_a, **_k: str(old))
    first = discover_executors(DevelopmentConfig())[0]
    assert first.executable == str(old.resolve()) and first.source == "desktop_application"
    new = root / "new/codex.exe"
    new.parent.mkdir()
    new.write_bytes(b"new native fixture")
    new.chmod(0o700)
    os.utime(new, ns=(old.stat().st_atime_ns, old.stat().st_mtime_ns + 1_000_000))
    refreshed = discover_executors(DevelopmentConfig())[0]
    assert refreshed.executable == str(new.resolve())
    assert new.read_bytes() == b"new native fixture" and old.exists()
    explicit = discover_executors(DevelopmentConfig(codex_path=str(old)))[0]
    assert explicit.executable == str(old.resolve()) and explicit.source == "configured"
