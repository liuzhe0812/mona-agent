"""Automatic discovery is read-only and stays within operator install roots."""
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

import pytest

from mona.hosted_work import codex_discovery


@pytest.fixture
def roots(tmp_path, monkeypatch):
    home = tmp_path / "operator"
    home.mkdir()
    work = home / "mona-hosted-work"
    work.mkdir()
    monkeypatch.setattr(codex_discovery, "_SYSTEM_DIRS", ())
    monkeypatch.setattr(codex_discovery, "_SYSTEM_ROOTS", ())
    return home, work


def native(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform.startswith("linux"):
        path.write_bytes(b"\x7fELF\x02\x01\x01" + b"\0" * 57)
    else:
        magic = b"MZ" if sys.platform == "win32" else b"\xcf\xfa\xed\xfe"
        path.write_bytes(magic + b"\0" * 96)
    path.chmod(0o755)
    return path


def filename() -> str:
    return "codex.exe" if os.name == "nt" else "codex"


def symlink(link: Path, target: Path, *, directory: bool = False) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=directory)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"Symbolic links unavailable: {type(exc).__name__}")


def test_path_discovery_does_not_execute_or_accept_tenant_workspace(roots, monkeypatch):
    home, work = roots
    private = native(work / "state/users/tenant/workspace/bin" / filename())
    wanted = native(home / ".local/bin" / filename())
    marker = home / "do-not-read-or-execute"
    marker.write_text("unchanged", encoding="utf-8")
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: pytest.fail("discovery ran a command"))
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: pytest.fail("discovery launched a process"))
    result = codex_discovery.discover_codex(home=home, work_root=work,
        search_path=os.pathsep.join((str(private.parent), str(wanted.parent))))
    assert result == wanted.resolve()
    assert marker.read_text(encoding="utf-8") == "unchanged"


def test_nvm_latest_fallback_path_priority_and_incomplete_install(roots):
    home, work = roots
    nvm = home / ".nvm/versions/node"
    old = native(nvm / "v20.11.0/bin" / filename())
    latest = native(nvm / "v22.16.0/bin" / filename())
    incomplete = nvm / "v24.1.0/bin" / filename()
    incomplete.parent.mkdir(parents=True)
    incomplete.write_text("unfinished", encoding="utf-8")
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") == latest.resolve()
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path=str(old.parent)) == old.resolve()
    npm_global = native(home / ".npm-global/bin" / filename())
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") == npm_global.resolve()


@pytest.mark.parametrize("install", ["home", "work"])
def test_fixed_local_npm_package_projects_to_its_native_executable(roots, install):
    home, work = roots
    project = home if install == "home" else work
    arch = "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else "x64"
    triple = {("linux", "x64"): "x86_64-unknown-linux-musl", ("linux", "arm64"): "aarch64-unknown-linux-musl",
              ("win32", "x64"): "x86_64-pc-windows-msvc", ("win32", "arm64"): "aarch64-pc-windows-msvc",
              ("darwin", "x64"): "x86_64-apple-darwin", ("darwin", "arm64"): "aarch64-apple-darwin"}.get((sys.platform, arch))
    if not triple:
        pytest.skip("Unsupported platform for the existing Codex resolver")
    modules = project / "node_modules"
    package = modules / "@openai/codex"
    entry = package / "bin/codex.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("throw new Error('must never execute');", encoding="utf-8")
    (package / "package.json").write_text(json.dumps({"name": "@openai/codex"}), encoding="utf-8")
    binary = native(modules / "@openai" / f"codex-{sys.platform}-{arch}" / "vendor" / triple / "codex" / filename())
    symlink(modules / ".bin" / filename(), entry)
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") == binary.resolve()
    (package / "package.json").write_text(json.dumps({"name": "not-openai"}), encoding="utf-8")
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") is None


def test_local_npm_directory_refuses_unverified_native_or_escape(roots):
    home, work = roots
    unverified = native(home / "node_modules/.bin" / filename())
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") is None
    unverified.unlink()
    private = native(work / "state/users/tenant/workspace/bin" / filename())
    symlink(home / ".local/bin" / filename(), private)
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") is None


def test_untrusted_local_link_does_not_hide_later_trusted_install(roots):
    home, work = roots
    wanted = native(home / ".local/bin" / filename())
    local_bin = home / "node_modules/.bin"
    symlink(local_bin / filename(), wanted)
    assert codex_discovery.discover_codex(home=home, work_root=work,
        search_path=os.pathsep.join((str(local_bin), str(wanted.parent)))) == wanted.resolve()


def test_symlinked_local_modules_cannot_escape_package_validation(roots):
    home, work = roots
    native(home / ".local/.bin" / filename())
    symlink(home / "node_modules", home / ".local", directory=True)
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") is None


@pytest.mark.skipif(os.name == "nt", reason="Windows chmod does not supply POSIX executable bits")
def test_non_executable_binary_is_not_detected(roots):
    home, work = roots
    path = native(home / ".local/bin" / filename())
    path.chmod(0o644)
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") is None


def test_truncated_elf_header_is_not_detected_during_install(roots, monkeypatch):
    home, work = roots
    monkeypatch.setattr(codex_discovery.sys, "platform", "linux")
    path = native(home / ".local/bin" / filename())
    data = path.read_bytes()
    path.write_bytes(data[:24])
    assert codex_discovery.discover_codex(home=home, work_root=work, search_path="") is None
