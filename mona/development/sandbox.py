"""Fail-closed process sandbox for Mona's workspace-write development tools."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal, Mapping

from mona.config.paths import get_managed_runtimes_dir
from mona.runtime.manager import (
    ActiveRuntimeComponent,
    RuntimeComponentManifest,
    RuntimeComponentStore,
    parse_runtime_pack_ref,
)

SandboxMode = Literal["workspace-write", "read-only"]
SandboxEnforcement = Literal["full", "partial", "unavailable"]

_NODE_HOST_ENV = {
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_V8_COVERAGE",
    "NODE_REDIRECT_WARNINGS",
    "NODE_COMPILE_CACHE",
}
_WINDOWS_COMPONENT_ID = "development-sandbox"
_WINDOWS_COMPONENT_ARCHIVE = "development-sandbox.zip"

# Classify denials and runner failures by backend signatures. The Landlock
# launcher exits 125; its partial-enforcement line is informational.
_DENIAL_SIGNATURES = {
    "bwrap": ("read-only file system",),
    "landlock": ("permission denied",),
    "seatbelt": ("operation not permitted",),
    "windows-acl": (
        "access is denied",
        "access to the path",
        "permission denied",
        "operation not permitted",
    ),
}
_RUNNER_FAILURE_RULES = {
    "bwrap": (None, ("bwrap: ",), ()),
    "landlock": (
        (125,),
        ("landlock-run: ",),
        ("landlock-run: partial enforcement (older Landlock ABI)",),
    ),
    "seatbelt": (None, ("sandbox-exec: ",), ()),
    "windows-acl": ((127,), ("windows-acl-run: ",), ()),
}


class DevelopmentSandboxUnavailableError(RuntimeError):
    """Raised when the configured sandbox or its managed runtime is unavailable."""


class DevelopmentSandboxError(RuntimeError):
    """Raised when a sandbox request is invalid or cannot be started."""


@dataclass(frozen=True, slots=True)
class _Backend:
    name: Literal["windows-acl", "bwrap", "landlock", "seatbelt"]
    launcher: Path | None
    enforcement: Literal["full", "partial"]


def _bwrap_profile_args(root: Path, mode: SandboxMode) -> list[str]:
    args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"]
    if mode == "workspace-write":
        args.extend(("--tmpfs", "/tmp", "--bind", str(root), str(root)))
    return args


def _landlock_profile_args(root: Path, mode: SandboxMode) -> list[str]:
    args = ["--ro", "/", "--rw", "/dev/null"]
    if mode == "workspace-write":
        args.extend(("--rw", "/tmp", "--rw", str(root)))
    return args


def _seatbelt_profile_args(root: Path, mode: SandboxMode, temp_dir: Path) -> list[str]:
    forms = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        '(allow file-write* (literal "/dev/null"))',
    ]
    if mode == "workspace-write":
        roots = tuple(_canonical_path(path) for path in (root, Path("/tmp"), temp_dir))
        forms.append(
            "(allow file-write* "
            + " ".join(f"(subpath {_sbpl_string(path)})" for path in dict.fromkeys(roots))
            + ")"
        )
    return ["-p", " ".join(forms)]


def _sbpl_string(path: Path) -> str:
    return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _canonical_path(path: Path) -> Path:
    try:
        return path.resolve(strict=True)
    except OSError:
        return path


def _probe_bwrap(launcher: Path) -> bool:
    try:
        result = subprocess.run(
            [str(launcher), *_bwrap_profile_args(Path("/"), "read-only"), "--", "true"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _probe_landlock(launcher: Path) -> Literal["full", "partial"] | None:
    try:
        result = subprocess.run(
            [str(launcher), "--probe"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return "partial" if "partially enforced" in result.stdout else "full"


def _packaged_windows_component() -> tuple[Path, RuntimeComponentManifest, dict[str, object]]:
    package_dir = Path(__file__).resolve().parent / "sandbox_node"
    record_path = package_dir / "UPSTREAM.json"
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox record is unavailable") from exc
    if not isinstance(record, dict) or record.get("componentId") != _WINDOWS_COMPONENT_ID:
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox record has an invalid component id")
    if record.get("archiveFile") != _WINDOWS_COMPONENT_ARCHIVE:
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox archive name is invalid")
    expected_sha256 = record.get("archiveSha256")
    if (
        not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_sha256)
    ):
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox has no valid fixed SHA-256")

    archive = package_dir / _WINDOWS_COMPONENT_ARCHIVE
    try:
        archive_bytes = archive.read_bytes()
    except OSError as exc:
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox archive is missing") from exc
    if hashlib.sha256(archive_bytes).hexdigest() != expected_sha256:
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox archive SHA-256 does not match")

    try:
        with zipfile.ZipFile(archive) as bundle:
            manifest = RuntimeComponentManifest.model_validate_json(bundle.read("runtime-manifest.json"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox manifest is invalid") from exc
    node_version = record.get("nodeBaseVersion")
    required_version = record.get("componentVersion")
    if not isinstance(node_version, str) or not isinstance(required_version, str):
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox version record is invalid")
    if (
        manifest.id != _WINDOWS_COMPONENT_ID
        or manifest.version != required_version
        or manifest.kind != _WINDOWS_COMPONENT_ID
        or manifest.entrypoints.get("runner") != "bin/runner.mjs"
        or manifest.dependencies != [f"node-base@{node_version}"]
    ):
        raise DevelopmentSandboxUnavailableError("packaged Windows sandbox manifest does not match its fixed record")
    return archive, manifest, record


class DevelopmentSandbox:
    """Launch shell commands under the platform sandbox, never without one."""

    def __init__(
        self,
        root: Path,
        session_key: str,
        *,
        mode: SandboxMode = "workspace-write",
        landlock_runner: Path | None = None,
    ) -> None:
        if mode not in ("workspace-write", "read-only"):
            raise ValueError("sandbox mode must be workspace-write or read-only")
        if not isinstance(session_key, str) or not session_key.strip():
            raise ValueError("sandbox session key must not be empty")
        try:
            self.root = Path(root).resolve(strict=True)
        except OSError as exc:
            raise DevelopmentSandboxError("sandbox workspace root does not exist") from exc
        if not self.root.is_dir():
            raise DevelopmentSandboxError("sandbox workspace root is not a directory")

        self.session_key = session_key
        self.mode = mode
        self._landlock_runner = self._resolve_explicit_launcher(landlock_runner)
        self._backend = self._select_backend()
        self.enforcement: SandboxEnforcement = self._backend.enforcement if self._backend else "unavailable"

    @staticmethod
    def _resolve_explicit_launcher(path: Path | None) -> Path | None:
        if path is None:
            return None
        candidate = Path(path)
        if not candidate.is_absolute():
            raise DevelopmentSandboxUnavailableError("Landlock runner must be an explicit absolute path")
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as exc:
            raise DevelopmentSandboxUnavailableError("explicit Landlock runner does not exist") from exc
        if not resolved.is_file() or not os.access(resolved, os.X_OK):
            raise DevelopmentSandboxUnavailableError("explicit Landlock runner is not executable")
        return resolved

    def _select_backend(self) -> _Backend | None:
        if sys.platform == "win32":
            return _Backend("windows-acl", None, "partial")
        if sys.platform == "darwin":
            launcher = Path("/usr/bin/sandbox-exec")
            return _Backend("seatbelt", launcher, "full") if launcher.is_file() else None
        if sys.platform == "linux":
            bwrap_raw = shutil.which("bwrap")
            try:
                bwrap = Path(bwrap_raw).resolve(strict=True) if bwrap_raw else None
            except OSError:
                bwrap = None
            if bwrap is not None and _probe_bwrap(bwrap):
                return _Backend("bwrap", bwrap, "full")
            if self._landlock_runner is not None:
                enforcement = _probe_landlock(self._landlock_runner)
                if enforcement is not None:
                    return _Backend("landlock", self._landlock_runner, enforcement)
        return None

    def _required_entrypoint(
        self,
        store: RuntimeComponentStore,
        component_id: str,
        entrypoint_name: str,
    ) -> tuple[RuntimeComponentManifest, Path]:
        active = store.active(component_id)
        if active is None:
            raise DevelopmentSandboxUnavailableError(
                f"managed runtime component {component_id!r} is not installed or active"
            )
        manifest, version_root = active
        relative = manifest.entrypoints.get(entrypoint_name)
        if not relative:
            raise DevelopmentSandboxUnavailableError(
                f"managed runtime component {component_id!r} has no {entrypoint_name!r} entrypoint"
            )
        try:
            resolved_root = version_root.resolve(strict=True)
            entrypoint = resolved_root.joinpath(*PurePosixPath(relative).parts).resolve(strict=True)
        except OSError as exc:
            raise DevelopmentSandboxUnavailableError(
                f"managed runtime component {component_id!r} has a missing entrypoint"
            ) from exc
        if not entrypoint.is_file() or not entrypoint.is_relative_to(resolved_root):
            raise DevelopmentSandboxUnavailableError(
                f"managed runtime component {component_id!r} has an invalid entrypoint"
            )
        return manifest, entrypoint

    async def _windows_runtime(self) -> tuple[Path, Path]:
        try:
            store = RuntimeComponentStore(get_managed_runtimes_dir())
        except Exception as exc:
            raise DevelopmentSandboxUnavailableError("managed runtime store is unavailable") from exc

        archive, packaged_manifest, record = _packaged_windows_component()
        active_sandbox = store.active(_WINDOWS_COMPONENT_ID)
        if active_sandbox is None or active_sandbox[0].version != packaged_manifest.version:
            try:
                store.install_archive(archive)
            except Exception as exc:
                raise DevelopmentSandboxUnavailableError(
                    "bundled Windows sandbox component could not be installed"
                ) from exc

        sandbox_manifest, runner = self._required_entrypoint(
            store, _WINDOWS_COMPONENT_ID, "runner"
        )
        if sandbox_manifest != packaged_manifest:
            raise DevelopmentSandboxUnavailableError(
                "active Windows sandbox component does not match the bundled version"
            )
        expected_sha256 = str(record["archiveSha256"])
        active_root = store.active(_WINDOWS_COMPONENT_ID)
        if active_root is None:
            raise DevelopmentSandboxUnavailableError("managed Windows sandbox is not active")
        pointer_path = active_root[1].parent.parent / "current.json"
        try:
            receipt = ActiveRuntimeComponent.model_validate_json(
                pointer_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as exc:
            raise DevelopmentSandboxUnavailableError(
                "managed Windows sandbox receipt is invalid"
            ) from exc
        if receipt.sha256 != expected_sha256:
            raise DevelopmentSandboxUnavailableError(
                "active Windows sandbox archive SHA-256 does not match the bundled version"
            )

        node_dependencies = []
        for reference in sandbox_manifest.dependencies:
            dependency_id, version = parse_runtime_pack_ref(reference)
            if dependency_id == "node-base":
                node_dependencies.append((dependency_id, version))
        if len(node_dependencies) != 1:
            raise DevelopmentSandboxUnavailableError(
                "managed sandbox component must declare exactly one node-base dependency"
            )
        _node_id, required_version = node_dependencies[0]
        if store.active("node-base") is None:
            try:
                from mona.runtime.official import get_official_runtime_jobs

                await get_official_runtime_jobs().ensure_packs(
                    _WINDOWS_COMPONENT_ID,
                    [f"node-base@{required_version}"],
                )
            except Exception as exc:
                raise DevelopmentSandboxUnavailableError(
                    f"required managed dependency node-base@{required_version} is unavailable: {exc}"
                ) from exc
        node_manifest, node = self._required_entrypoint(store, "node-base", "node")
        if node_manifest.version != required_version:
            raise DevelopmentSandboxUnavailableError(
                f"managed sandbox requires node-base@{required_version}; "
                f"the active version is {node_manifest.version}"
            )
        return node, runner

    def _resolve_cwd(self, cwd: Path | str) -> Path:
        candidate = Path(cwd)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as exc:
            raise DevelopmentSandboxError("sandbox working directory does not exist") from exc
        if not resolved.is_dir():
            raise DevelopmentSandboxError("sandbox working directory is not a directory")
        if not resolved.is_relative_to(self.root):
            raise DevelopmentSandboxError("sandbox working directory is outside the workspace")
        return resolved

    def diagnostics(self, exit_code: int | None, stderr: str) -> str:
        """Describe only backend-signature denials and runner failures."""
        # Negative Python return codes indicate signal termination, not a sandbox denial.
        if exit_code is None or exit_code <= 0:
            return ""

        backend = self._backend.name if self._backend is not None else ""
        runner_rule = _RUNNER_FAILURE_RULES.get(backend)
        if runner_rule is not None:
            allowed_exit_codes, fatal_signatures, informational_lines = runner_rule
            if allowed_exit_codes is None or exit_code in allowed_exit_codes:
                informational = {line.lower() for line in informational_lines}
                for line in stderr.replace("\r\n", "\n").split("\n"):
                    lowered = line.lower()
                    if lowered not in informational and any(
                        signature.lower() in lowered for signature in fatal_signatures
                    ):
                        return (
                            f"[sandbox: SANDBOX_UNAVAILABLE — the sandbox runner itself failed under "
                            f"{self.mode} mode; the command did not run; this is a sandbox problem, "
                            "not a command failure]"
                        )

        lowered_stderr = stderr.lower()
        if not any(signature in lowered_stderr for signature in _DENIAL_SIGNATURES.get(backend, ())):
            return ""

        marker = f"[sandbox: file access denied under {self.mode} mode]"
        if self.mode == "read-only":
            return marker
        return (
            f"{marker}\n"
            "先检查此前可能已经产生的影响；确认后，如仍需继续，请用同一命令并设置 "
            "`sandbox_permissions='danger-full-access'` 和非空 `justification` 请求一次性授权。"
            "命令不会自动重放。"
        )

    @staticmethod
    def _resolve_shell(shell_program: str | None, env: Mapping[str, str]) -> Path:
        if sys.platform == "win32":
            system_root = env.get("SystemRoot") or os.environ.get("SystemRoot") or r"C:\Windows"
            raw = shell_program or env.get("COMSPEC") or os.environ.get("COMSPEC") or str(
                Path(system_root) / "System32" / "cmd.exe"
            )
        else:
            raw = shell_program or shutil.which("bash") or "/bin/bash"
        path = Path(raw)
        if not path.is_absolute():
            resolved = shutil.which(raw, path=env.get("PATH"))
            if resolved is None:
                raise DevelopmentSandboxUnavailableError("configured shell program could not be resolved")
            path = Path(resolved)
        try:
            path = path.resolve(strict=True)
        except OSError as exc:
            raise DevelopmentSandboxUnavailableError("configured shell program does not exist") from exc
        if not path.is_file():
            raise DevelopmentSandboxUnavailableError("configured shell program is not a file")
        return path

    def _shell_argv(
        self,
        command: str,
        shell_program: str | None,
        login: bool,
        env: Mapping[str, str],
    ) -> list[str]:
        shell = self._resolve_shell(shell_program, env)
        name = shell.name.casefold()
        if sys.platform == "win32":
            if name in {"cmd", "cmd.exe"}:
                args = ["/d", "/s", "/c", command]
            elif name in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}:
                args = ["-NoLogo", "-NoProfile", "-Command", command]
            else:
                args = ["-c", command]
                if login and name in {"bash", "bash.exe", "zsh", "zsh.exe"}:
                    args.insert(0, "-l")
        else:
            args = ["-l"] if login and name in {"bash", "zsh"} else []
            args.extend(("-c", command))
        return [str(shell), *args]

    @staticmethod
    async def _spawn_process(
        argv: list[str],
        *,
        cwd: Path,
        env: dict[str, str],
        stdin: int | None,
    ) -> asyncio.subprocess.Process:
        start = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *argv,
                cwd=str(cwd),
                env=env,
                stdin=stdin,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=sys.platform != "win32",
            )
        )
        try:
            return await asyncio.shield(start)
        except asyncio.CancelledError:
            process = await asyncio.shield(start)
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            raise

    async def spawn(
        self,
        command: str,
        cwd: Path | str,
        env: Mapping[str, str],
        shell_program: str | None = None,
        login: bool = True,
        *,
        stdin: int | None = asyncio.subprocess.DEVNULL,
    ) -> asyncio.subprocess.Process:
        """Start one shell command with workspace-write or read-only confinement."""
        if not isinstance(command, str) or not command:
            raise ValueError("sandbox command must be a non-empty string")
        working_dir = self._resolve_cwd(cwd)
        child_env = dict(env)
        if sys.platform == "win32":
            for key in tuple(child_env):
                if key.upper() in _NODE_HOST_ENV:
                    child_env.pop(key)
            node, runner = await self._windows_runtime()
            try:
                temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
            except OSError as exc:
                raise DevelopmentSandboxUnavailableError("system temporary directory is unavailable") from exc
            argv = [
                str(node),
                str(runner),
                "--workspace",
                str(self.root),
                "--temp",
                str(temp_root),
                "--mode",
                self.mode,
                "--",
                *self._shell_argv(command, shell_program, login, child_env),
            ]
        elif self._backend is None:
            raise DevelopmentSandboxUnavailableError(
                "no usable sandbox runner is available on this platform"
            )
        elif self._backend.name == "bwrap":
            argv = [
                str(self._backend.launcher),
                *_bwrap_profile_args(self.root, self.mode),
                "--",
                *self._shell_argv(command, shell_program, login, child_env),
            ]
        elif self._backend.name == "landlock":
            argv = [
                str(self._backend.launcher),
                *_landlock_profile_args(self.root, self.mode),
                "--",
                *self._shell_argv(command, shell_program, login, child_env),
            ]
        elif self._backend.name == "seatbelt":
            temp_dir = Path(tempfile.gettempdir()).resolve(strict=True)
            argv = [
                str(self._backend.launcher),
                *_seatbelt_profile_args(self.root, self.mode, temp_dir),
                "--",
                *self._shell_argv(command, shell_program, login, child_env),
            ]
        else:
            raise DevelopmentSandboxUnavailableError("selected sandbox backend is invalid")

        try:
            return await self._spawn_process(
                argv,
                cwd=working_dir,
                env=child_env,
                stdin=stdin,
            )
        except OSError as exc:
            raise DevelopmentSandboxUnavailableError(
                f"sandbox launcher could not start: {exc.strerror or type(exc).__name__}"
            ) from exc


__all__ = [
    "DevelopmentSandbox",
    "DevelopmentSandboxError",
    "DevelopmentSandboxUnavailableError",
    "SandboxEnforcement",
    "SandboxMode",
]
