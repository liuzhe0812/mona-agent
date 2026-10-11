from __future__ import annotations

import asyncio
import os
import zipfile
from pathlib import Path

import pytest

import mona.development.sandbox as sandbox_module
from mona.development.sandbox import (
    DevelopmentSandbox,
    DevelopmentSandboxError,
    DevelopmentSandboxUnavailableError,
    _bwrap_profile_args,
    _landlock_profile_args,
    _seatbelt_profile_args,
)
from mona.runtime.manager import RuntimeComponentManifest, RuntimeComponentStore


def test_platform_profiles_keep_writes_inside_workspace(tmp_path: Path) -> None:
    root = tmp_path / "project-one"
    root.mkdir()

    assert _bwrap_profile_args(root, "read-only") == [
        "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"
    ]
    assert _bwrap_profile_args(root, "workspace-write")[-5:] == ["--tmpfs", "/tmp", "--bind", str(root), str(root)]
    assert _landlock_profile_args(root, "read-only") == ["--ro", "/", "--rw", "/dev/null"]
    assert _landlock_profile_args(root, "workspace-write") == [
        "--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", str(root)
    ]
    quoted_root = Path(f'{root} "one"')
    seatbelt = _seatbelt_profile_args(quoted_root, "workspace-write", tmp_path / "temp")
    assert seatbelt[0] == "-p"
    escaped_root = str(quoted_root).replace("\\", "\\\\").replace('"', '\\"')
    assert f'(subpath "{escaped_root}")' in seatbelt[1]
    assert "(deny file-write*)" in seatbelt[1]


def test_spawn_rejects_working_directory_outside_workspace(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    sandbox = DevelopmentSandbox(root, "session")

    async def run() -> None:
        with pytest.raises(DevelopmentSandboxError, match="outside the workspace"):
            await sandbox.spawn("exit 0", outside, os.environ.copy(), stdin=asyncio.subprocess.DEVNULL)

    asyncio.run(run())


@pytest.mark.parametrize(
    ("backend", "mode", "exit_code", "stderr", "expected"),
    [
        (
            "windows-acl",
            "workspace-write",
            1,
            "Access is denied.",
            "[sandbox: file access denied under workspace-write mode]\n"
            "先检查此前可能已经产生的影响；确认后，如仍需继续，请用同一命令并设置 "
            "`sandbox_permissions='danger-full-access'` 和非空 `justification` 请求一次性授权。"
            "命令不会自动重放。",
        ),
        (
            "windows-acl",
            "read-only",
            1,
            "Access is denied.",
            "[sandbox: file access denied under read-only mode]",
        ),
        ("windows-acl", "workspace-write", 0, "Access is denied.", ""),
        ("windows-acl", "workspace-write", None, "Access is denied.", ""),
        ("windows-acl", "workspace-write", -1, "Access is denied.", ""),
        ("windows-acl", "workspace-write", 1, "ordinary command failure", ""),
        (
            "windows-acl",
            "workspace-write",
            127,
            "windows-acl-run: CreateProcessAsUserW failed\nAccess is denied.",
            "[sandbox: SANDBOX_UNAVAILABLE — the sandbox runner itself failed under "
            "workspace-write mode; the command did not run; this is a sandbox problem, "
            "not a command failure]",
        ),
        ("windows-acl", "workspace-write", 126, "windows-acl-run: runner failed", ""),
        (
            "landlock",
            "workspace-write",
            125,
            "landlock-run: ruleset creation failed",
            "[sandbox: SANDBOX_UNAVAILABLE — the sandbox runner itself failed under "
            "workspace-write mode; the command did not run; this is a sandbox problem, "
            "not a command failure]",
        ),
        ("landlock", "workspace-write", 124, "landlock-run: ruleset creation failed", ""),
        (
            "landlock",
            "workspace-write",
            125,
            "landlock-run: partial enforcement (older Landlock ABI)",
            "",
        ),
    ],
)
def test_diagnostics_match_dsh_denial_and_runner_rules(
    backend: str,
    mode: str,
    exit_code: int | None,
    stderr: str,
    expected: str,
) -> None:
    sandbox = object.__new__(DevelopmentSandbox)
    sandbox.mode = mode
    sandbox._backend = sandbox_module._Backend(backend, None, "partial")

    assert sandbox.diagnostics(exit_code, stderr) == expected


def test_embedded_windows_component_matches_fixed_record() -> None:
    archive, manifest, record = sandbox_module._packaged_windows_component()

    assert archive.name == record["archiveFile"]
    assert manifest.id == "development-sandbox"
    assert manifest.version == record["componentVersion"]
    assert manifest.dependencies == [f"node-base@{record['nodeBaseVersion']}"]


def _install_node_base(store: RuntimeComponentStore, tmp_path: Path, version: str) -> None:
    manifest = RuntimeComponentManifest(
        id="node-base",
        version=version,
        kind="node-base",
        entrypoints={"node": "node.exe"},
    )
    archive = tmp_path / f"node-base-{version}.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("runtime-manifest.json", manifest.model_dump_json(by_alias=True))
        bundle.writestr("node.exe", b"temporary test entrypoint")
    store.install_archive(archive)


@pytest.mark.skipif(os.name != "nt", reason="Windows runtime-store initialization")
def test_missing_managed_windows_component_imports_bundled_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    runtime_root = tmp_path / "runtimes"
    store = RuntimeComponentStore(runtime_root)
    _install_node_base(store, tmp_path, "22.23.2")
    monkeypatch.setattr(sandbox_module, "get_managed_runtimes_dir", lambda: runtime_root)
    sandbox = DevelopmentSandbox(root, "session")

    async def run() -> None:
        node, runner = await sandbox._windows_runtime()
        active = store.active("development-sandbox")
        assert active is not None
        assert active[0].version == "0.1.7-rc.1+46a7f68"
        assert node.name == "node.exe"
        assert runner.is_file()
        assert await sandbox._windows_runtime() == (node, runner)

    asyncio.run(run())


@pytest.mark.skipif(os.name != "nt", reason="Windows runtime dependency version check")
def test_sandbox_does_not_silently_use_another_node_base_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    runtime_root = tmp_path / "runtimes"
    store = RuntimeComponentStore(runtime_root)
    _install_node_base(store, tmp_path, "22.23.3")
    monkeypatch.setattr(sandbox_module, "get_managed_runtimes_dir", lambda: runtime_root)
    sandbox = DevelopmentSandbox(root, "session")

    async def run() -> None:
        with pytest.raises(DevelopmentSandboxUnavailableError, match="active version is 22.23.3"):
            await sandbox._windows_runtime()

    asyncio.run(run())
