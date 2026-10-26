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


@pytest.mark.parametrize("executor,index", [("codex", 0), ("claude", 1), ("codebuddy", 2)])
def test_explicit_invalid_path_does_not_use_a_known_installation(tmp_path, monkeypatch, executor, index):
    monkeypatch.setattr("mona.development.executors.discovery._standard_candidates", lambda *_: pytest.fail("not allowed"))
    result = discover_executors(DevelopmentConfig(**{f"{executor}_path": str(tmp_path / "missing")}), search_path="")[index]
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


def test_workbuddy_app_components_take_precedence_without_installing_managed_cli(tmp_path, monkeypatch):
    import mona.development.executors.discovery as discovery

    entry = tmp_path / "WorkBuddy" / "codebuddy"
    entry.parent.mkdir()
    entry.write_bytes(b"bundled CLI fixture; never executed")
    entry.chmod(0o700)
    configured = tmp_path / "configured-codebuddy.exe"
    configured.write_bytes(b"explicit CLI fixture; never executed")
    configured.chmod(0o700)
    monkeypatch.setattr(discovery, "discover_workbuddy_cli", lambda: entry)
    monkeypatch.setattr(discovery, "_codex_desktop_candidates", lambda _: [])
    monkeypatch.setattr(discovery, "_standard_candidates", lambda *_: [])
    monkeypatch.setattr(discovery.shutil, "which", lambda *_a, **_k: None)
    def managed(executor):
        assert executor != "codebuddy", "an installed WorkBuddy app must not require a managed copy"
        return None
    monkeypatch.setattr(discovery, "managed_executor_path", managed)

    for include_managed in (True, False):
        probe = discover_executors(DevelopmentConfig(), include_managed=include_managed)[2]
        assert probe.state == "detected" and probe.source == "desktop_application"
        assert probe.executable == str(entry.resolve())
        assert not probe.protocol_verified
    explicit = discover_executors(DevelopmentConfig(codebuddy_path=str(configured)))[2]
    assert explicit.executable == str(configured.resolve()) and explicit.source == "configured"


@pytest.mark.parametrize("executor,index", [(ExecutorId.CODEX, 0), (ExecutorId.CLAUDE, 1)])
def test_stale_path_wrapper_does_not_hide_an_installed_native_engine(tmp_path, monkeypatch, executor, index):
    import mona.development.executors.discovery as discovery

    home = tmp_path / "home"
    native = home / ".local/bin" / (executor.value + (".exe" if os.name == "nt" else ""))
    native.parent.mkdir(parents=True)
    native.write_bytes(b"native fixture; never executed")
    native.chmod(0o700)
    wrapper = tmp_path / f"{executor.value}.cmd"
    wrapper.write_text("must never be executed")
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setattr(discovery, "_codex_desktop_candidates", lambda _: [])
    monkeypatch.setattr(discovery, "discover_workbuddy_cli", lambda: None)
    monkeypatch.setattr(discovery.shutil, "which", lambda name, **_kwargs: str(wrapper) if name == executor.value else None)
    def managed(name):
        assert name != executor.value, "local programs must take precedence over managed copies"
        return None
    monkeypatch.setattr(discovery, "managed_executor_path", managed)

    for include_managed in (True, False):
        probe = discover_executors(DevelopmentConfig(), include_managed=include_managed)[index]
        assert probe.state == "detected" and probe.source == "standard_location"
        assert probe.executable == str(native.resolve())
        assert not probe.protocol_verified and probe.authentication == "unknown"


def test_claude_npm_wrapper_resolves_verified_native_package_without_executing_it(tmp_path):
    root = tmp_path / "npm/node_modules/@anthropic-ai/claude-code"
    native_entry = "bin/claude.exe" if os.name == "nt" else "bin/claude"
    native = root / native_entry
    native.parent.mkdir(parents=True)
    native.write_bytes(b"native fixture; never executed")
    native.chmod(0o700)
    metadata = root / "package.json"
    metadata.write_text(json.dumps({"name": "@anthropic-ai/claude-code", "bin": {"claude": native_entry}}))
    wrapper = tmp_path / "npm/claude.cmd"
    wrapper.write_text("must never be executed")

    resolved, projected = resolve_executable(ExecutorId.CLAUDE, wrapper)
    assert resolved == native.resolve() and projected
    probe = discover_executors(DevelopmentConfig(claude_path=str(wrapper)), search_path="")[1]
    assert probe.state == "detected" and probe.source == "npm_platform_package"
    metadata.write_text(json.dumps({"name": "unrelated", "bin": {"claude": native_entry}}))
    with pytest.raises(ValueError, match="unsupported_launcher"):
        resolve_executable(ExecutorId.CLAUDE, wrapper)
