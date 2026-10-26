"""Install and verify one stock-vibe ZIP inside an isolated .codex_tmp runtime root.

The global Python base is read-only copied into the fixture. The script never
downloads packages, mutates global runtime pointers, or starts the Vibe server.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mona.config.loader import get_config_path  # noqa: E402
from mona.runtime.manager import RuntimeComponentManifest, RuntimeComponentStore  # noqa: E402
from mona.runtime.python_env import (  # noqa: E402
    CommandResult,
    PythonEnvironmentBuilder,
    _run_command,
)

_BASE_REF = "python-base@3.13.15"
_STOCK_ID = "stock-vibe"
_SAFE_CHILD_ENV = {
    "APPDATA",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
}


class VerificationError(RuntimeError):
    """Raised when the offline installation or verification cannot complete."""


def _sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _tree_inventory(root: Path) -> tuple[int, int, str]:
    files: list[tuple[str, int, str]] = []
    for current, directories, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        for directory in directories:
            if (current_path / directory).is_symlink():
                raise VerificationError(f"runtime component contains a symlink: {current_path / directory}")
        for filename in filenames:
            path = current_path / filename
            if path.is_symlink():
                raise VerificationError(f"runtime component contains a symlink: {path}")
            size, digest = _sha256_file(path)
            files.append((path.relative_to(root).as_posix(), size, digest))
    files.sort()
    tree_hash = hashlib.sha256()
    for relative, size, digest in files:
        tree_hash.update(relative.encode("utf-8"))
        tree_hash.update(b"\0")
        tree_hash.update(str(size).encode("ascii"))
        tree_hash.update(b"\0")
        tree_hash.update(digest.encode("ascii"))
        tree_hash.update(b"\n")
    return len(files), sum(item[1] for item in files), tree_hash.hexdigest()


def _file_state(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"exists": False, "sha256": None, "bytes": 0}
    size, digest = _sha256_file(path)
    return {"exists": True, "sha256": digest, "bytes": size}


def _global_runtime_roots() -> list[tuple[str, Path]]:
    legacy = Path(get_config_path()).expanduser().resolve().parent / "runtimes"
    if os.name == "nt":
        local_app_data = Path(
            os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
        )
        target = (local_app_data / "Mona" / "runtimes").resolve()
    else:
        target = legacy.resolve()
    roots: list[tuple[str, Path]] = [("target", target)]
    if legacy != target:
        roots.append(("legacy", legacy))
    return roots


def _find_global_base(
    roots: list[tuple[str, Path]] | None = None,
) -> tuple[str, Path, RuntimeComponentManifest, Path, bytes]:
    seen: set[Path] = set()
    for label, root in roots or _global_runtime_roots():
        root = root.resolve()
        if root in seen:
            continue
        seen.add(root)
        store = RuntimeComponentStore(root)
        active = store.active("python-base")
        if active is None:
            continue
        manifest, version_root = active
        if manifest.version != "3.13.15":
            continue
        if not manifest.entrypoints.get("python"):
            raise VerificationError("installed python-base@3.13.15 has no python entrypoint")
        pointer = root / "components" / "python-base" / "current.json"
        return label, root, manifest, version_root, pointer.read_bytes()
    raise VerificationError("no active python-base@3.13.15 component found in read-only runtime roots")


def _copy_base(
    runtime_root: Path,
    global_manifest: RuntimeComponentManifest,
    global_version_root: Path,
    global_pointer: bytes,
) -> dict[str, Any]:
    component_root = runtime_root / "components" / "python-base"
    version_root = component_root / "versions" / global_manifest.version
    if component_root.exists():
        raise VerificationError("fresh verification root already contains python-base")
    component_root.mkdir(parents=True)
    shutil.copytree(global_version_root, version_root)
    pointer = component_root / "current.json"
    pointer.write_bytes(global_pointer)

    copied = RuntimeComponentStore(runtime_root).active("python-base")
    if copied is None or copied[0] != global_manifest:
        raise VerificationError("copied Python base identity did not validate in the test store")
    source_files, source_bytes, source_hash = _tree_inventory(global_version_root)
    copied_files, copied_bytes, copied_hash = _tree_inventory(version_root)
    if (source_files, source_bytes, source_hash) != (copied_files, copied_bytes, copied_hash):
        raise VerificationError("copied Python base bytes do not match the installed component")
    return {
        "ref": f"{global_manifest.id}@{global_manifest.version}",
        "receipt_sha256": _file_state(version_root / "receipt.json")["sha256"],
        "current_pointer_sha256": hashlib.sha256(pointer.read_bytes()).hexdigest(),
        "file_count": copied_files,
        "bytes": copied_bytes,
        "tree_sha256": copied_hash,
    }


def _safe_command_runner(log_dir: Path, command_log: list[dict[str, Any]]):
    async def run(command: list[str], cwd: Path, environment: dict[str, str]) -> CommandResult:
        safe_environment = {
            key: value for key, value in environment.items() if key.upper() in _SAFE_CHILD_ENV
        }
        safe_environment.update(
            {
                key: environment[key]
                for key in (
                    "PIP_CACHE_DIR",
                    "PIP_CONFIG_FILE",
                    "PIP_DISABLE_PIP_VERSION_CHECK",
                    "PIP_NO_INDEX",
                    "PIP_NO_INPUT",
                    "PYTHONNOUSERSITE",
                    "PYTHONDONTWRITEBYTECODE",
                    "PYTHONUTF8",
                    "PYTHONUNBUFFERED",
                    "PYTHONIOENCODING",
                    "VIBE_TRADING_HOME",
                )
                if key in environment
            }
        )
        result = await _run_command(command, cwd, safe_environment)
        index = len(command_log) + 1
        (log_dir / f"python-env-{index}.stdout.log").write_text(result.stdout, encoding="utf-8")
        (log_dir / f"python-env-{index}.stderr.log").write_text(result.stderr, encoding="utf-8")
        command_log.append({"step": index, "returncode": result.returncode})
        return result

    return run


@contextmanager
def _offline_install_environment(test_root: Path, cache: Path, private_home: Path):
    config = test_root / "pip.ini"
    config.write_text("[global]\nno-index = true\n", encoding="utf-8")
    values = {
        "PIP_CACHE_DIR": str(cache),
        "PIP_CONFIG_FILE": str(config),
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_INDEX": "1",
        "PIP_NO_INPUT": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONUTF8": "1",
        "TEMP": str(test_root / "temp"),
        "TMP": str(test_root / "temp"),
        "TMPDIR": str(test_root / "temp"),
        "VIBE_TRADING_HOME": str(private_home),
    }
    old = {key: os.environ.get(key) for key in values}
    for key, value in values.items():
        os.environ[key] = value
    Path(values["TEMP"]).mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    private_home.mkdir(parents=True, exist_ok=True)
    try:
        yield config
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _run_logged(
    command: list[str], cwd: Path, environment: dict[str, str], stdout_path: Path, stderr_path: Path
) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    stdout_path.write_text(completed.stdout, encoding="utf-8")
    stderr_path.write_text(completed.stderr, encoding="utf-8")
    return {
        "returncode": completed.returncode,
        "stdout_log": stdout_path.name,
        "stderr_log": stderr_path.name,
    }


def _child_environment(agent_root: Path, test_root: Path, private_home: Path) -> dict[str, str]:
    environment = {
        key: os.environ[key]
        for key in _SAFE_CHILD_ENV
        if key in os.environ
    }
    environment.update(
        {
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
            "PYTHONPATH": str(agent_root),
            "PIP_CACHE_DIR": str(test_root / "pip-cache"),
            "PIP_CONFIG_FILE": str(test_root / "pip.ini"),
            "PIP_NO_INDEX": "1",
            "PIP_NO_INPUT": "1",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "TEMP": str(test_root / "temp"),
            "TMP": str(test_root / "temp"),
            "TMPDIR": str(test_root / "temp"),
            "VIBE_TRADING_HOME": str(private_home),
            "VIBE_TRADING_HOSTED": "1",
            "HOSTED": "1",
        }
    )
    return environment


def _size_tree(root: Path) -> dict[str, int]:
    files, size, _digest = _tree_inventory(root) if root.exists() else (0, 0, "")
    return {"file_count": files, "bytes": size}


def verify_install(
    *,
    package: Path,
    test_root: Path,
    base_runtime_root: Path | None = None,
) -> dict[str, Any]:
    """Install the package and build its offline environment under ``.codex_tmp`` only."""
    package_input = Path(package)
    if package_input.is_symlink() or not package_input.is_file():
        raise VerificationError("package must be a regular file")
    package = package_input.resolve(strict=True)
    test_root = Path(test_root).resolve()
    codex_tmp = (REPO_ROOT / ".codex_tmp").resolve()
    if test_root == codex_tmp or not test_root.is_relative_to(codex_tmp):
        raise VerificationError("test runtime root must be a new child of this worktree's .codex_tmp")
    if test_root.exists():
        raise VerificationError("refusing to overwrite an existing verification root")
    package_size, package_sha = _sha256_file(package)
    package_sidecar = Path(f"{package}.receipt.json")
    if not package_sidecar.is_file():
        raise VerificationError("preflight package receipt is missing")
    sidecar = json.loads(package_sidecar.read_text(encoding="utf-8"))
    if sidecar.get("package", {}).get("sha256") != package_sha:
        raise VerificationError("package SHA-256 does not match its build receipt")
    with zipfile.ZipFile(package) as archive:
        manifest = RuntimeComponentManifest.model_validate_json(archive.read("runtime-manifest.json"))
        source_receipt_bytes = archive.read("source-receipt.json")
        source_receipt = json.loads(source_receipt_bytes)
    if sidecar.get("source_receipt_sha256") != hashlib.sha256(source_receipt_bytes).hexdigest():
        raise VerificationError("embedded source receipt does not match the sidecar")
    if sidecar.get("package", {}).get("bytes") != package_size:
        raise VerificationError("package byte count does not match its build receipt")
    if manifest.id != _STOCK_ID or manifest.dependencies != [_BASE_REF]:
        raise VerificationError("package manifest does not declare the required stock-vibe/base identity")
    if manifest.python_environment != "stock-vibe":
        raise VerificationError("package does not use the isolated stock-vibe Python environment")
    if source_receipt.get("source", {}).get("patches") is None:
        raise VerificationError("package source receipt is missing patch provenance")

    roots = _global_runtime_roots()
    if base_runtime_root is not None:
        roots = [("explicit", Path(base_runtime_root).resolve(strict=True))]
    base_label, global_root, base_manifest, base_version_root, base_pointer = _find_global_base(roots)
    if base_manifest.version != "3.13.15":
        raise VerificationError("only python-base@3.13.15 is accepted")

    global_refs = {
        "python_base_current": global_root / "components" / "python-base" / "current.json",
        "official_environment_current": global_root / "python" / "official-envs" / "current.json",
        "stock_vibe_current": global_root / "components" / "stock-vibe" / "current.json",
    }
    global_pointers_before = {name: _file_state(path) for name, path in global_refs.items()}
    global_base_files_before, global_base_bytes_before, global_base_tree_before = _tree_inventory(
        base_version_root
    )

    test_root.mkdir(parents=True)
    logs = test_root / "logs"
    logs.mkdir()
    report_path = test_root / "verification.json"
    report: dict[str, Any] = {
        "status": "preparing",
        "package": {
            "filename": package.name,
            "bytes": package_size,
            "sha256": package_sha,
            "source_snapshot_id": source_receipt["source"]["snapshot_id"],
            "patches": source_receipt["source"]["patches"],
            "upstream_requirements_lock_sha256": source_receipt["source"][
                "upstream_requirements_lock_sha256"
            ],
            "wheel_requirements_lock_sha256": source_receipt["build"]["requirements_lock_sha256"],
        },
        "python_base": {"origin": base_label, "ref": _BASE_REF},
        "global_pointers_before": global_pointers_before,
        "home_unchanged": True,
        "network_enabled": False,
    }

    store = RuntimeComponentStore(test_root)
    stock_installed = False
    env_pointer = test_root / "python" / "stock-vibe-envs" / "current.json"
    pip_cache = test_root / "pip-cache"
    private_home = test_root / "native-home"
    try:
        copied_base = _copy_base(test_root, base_manifest, base_version_root, base_pointer)
        report["python_base"].update(copied_base)
        report["python_base"]["source_bytes"] = global_base_bytes_before
        report["python_base"]["source_file_count"] = global_base_files_before
        report["python_base"]["source_tree_sha256"] = global_base_tree_before
        report["status"] = "base-copied"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        installed_manifest = store.install_archive(package)
        stock_installed = True
        report["component"] = {
            "id": installed_manifest.id,
            "version": installed_manifest.version,
            "kind": installed_manifest.kind,
            "manifest_sha256": _file_state(
                test_root / "components" / _STOCK_ID / "versions" / installed_manifest.version / "runtime-manifest.json"
            )["sha256"],
            "expanded": _size_tree(
                test_root / "components" / _STOCK_ID / "versions" / installed_manifest.version
            ),
        }
        report["status"] = "component-installed"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        command_log: list[dict[str, Any]] = []
        builder = PythonEnvironmentBuilder(
            test_root,
            store,
            environment="stock-vibe",
            runner=_safe_command_runner(logs, command_log),
        )
        home_before = os.environ.get("HOME")
        userprofile_before = os.environ.get("USERPROFILE")
        with _offline_install_environment(test_root, pip_cache, private_home):
            environment = asyncio.run(builder.ensure([_BASE_REF, f"{_STOCK_ID}@{manifest.version}"]))
        report["python_environment"] = {
            "generation": environment.generation,
            "packs": environment.packs,
            "python_relative": environment.python_relative,
            "builder_commands": command_log,
        }
        if os.environ.get("HOME") != home_before or os.environ.get("USERPROFILE") != userprofile_before:
            raise VerificationError("HOME or USERPROFILE changed during verification")

        python_executable = builder.environments_root / environment.generation / environment.python_relative
        if not python_executable.is_file():
            raise VerificationError("stock-vibe Python executable was not created")
        pip_environment = _child_environment(
            test_root / "components" / _STOCK_ID / "versions" / manifest.version / "agent",
            test_root,
            private_home,
        )
        work_dir = test_root / "work"
        work_dir.mkdir()
        with _offline_install_environment(test_root, pip_cache, private_home):
            check = _run_logged(
                [str(python_executable), "-m", "pip", "check"],
                test_root,
                pip_environment,
                logs / "pip-check.stdout.log",
                logs / "pip-check.stderr.log",
            )
            version_result = _run_logged(
                [str(python_executable), "--version"],
                test_root,
                pip_environment,
                logs / "python-version.stdout.log",
                logs / "python-version.stderr.log",
            )
            pip_result = _run_logged(
                [str(python_executable), "-m", "pip", "--version"],
                test_root,
                pip_environment,
                logs / "pip-version.stdout.log",
                logs / "pip-version.stderr.log",
            )
            import_probe = (
                "import importlib, json; "
                "modules=['fastapi','pydantic_settings','numpy','pandas','api_server',"
                "'src.agent.loop','src.swarm.runtime','backtest.runner','src.shadow_account.extractor']; "
                "[importlib.import_module(name) for name in modules]; "
                "print(json.dumps({'imports': modules}))"
            )
            imports = _run_logged(
                [str(python_executable), "-c", import_probe],
                work_dir,
                pip_environment,
                logs / "core-imports.stdout.log",
                logs / "core-imports.stderr.log",
            )
        report["pip_check"] = check
        report["python_version"] = version_result
        report["pip_version"] = pip_result
        report["core_imports"] = imports
        report["sizes"] = {
            "program_bytes": source_receipt["inventory"]["program_bytes"],
            "wheel_bytes": source_receipt["inventory"]["wheel_bytes"],
            "package_uncompressed_bytes": sidecar["package"]["uncompressed_bytes"],
            "installed_component": report["component"]["expanded"],
            "python_environment": _size_tree(builder.environments_root / environment.generation),
            "pip_cache": _size_tree(pip_cache),
            "temporary_files": _size_tree(test_root / "temp"),
        }
        if any(result["returncode"] != 0 for result in (check, version_result, pip_result, imports)):
            raise VerificationError("pip check or a required core import command failed")
        if env_pointer.exists():
            report["stock_vibe_environment_pointer"] = _file_state(env_pointer)
        else:
            raise VerificationError("Python environment builder did not activate its stock-vibe generation")

        global_pointers_after = {name: _file_state(path) for name, path in global_refs.items()}
        global_base_files_after, global_base_bytes_after, global_base_tree_after = _tree_inventory(
            base_version_root
        )
        report["global_pointers_after"] = global_pointers_after
        report["global_base_unchanged"] = (
            (global_base_files_before, global_base_bytes_before, global_base_tree_before)
            == (global_base_files_after, global_base_bytes_after, global_base_tree_after)
        )
        report["global_pointers_unchanged"] = global_pointers_before == global_pointers_after
        if not report["global_base_unchanged"] or not report["global_pointers_unchanged"]:
            raise VerificationError("global runtime state changed during test-root verification")
        report["status"] = "verified"
        report["report"] = str(report_path.relative_to(REPO_ROOT))
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report
    except Exception as exc:
        if stock_installed:
            try:
                store.deactivate(_STOCK_ID)
            except Exception as deactivate_error:
                report["deactivation_error"] = f"{type(deactivate_error).__name__}: {deactivate_error}"
        env_pointer.unlink(missing_ok=True)
        report["status"] = "failed"
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["failure_state"] = {
            "stock_vibe_component_active": store.active(_STOCK_ID) is not None,
            "stock_vibe_environment_pointer_exists": env_pointer.exists(),
        }
        try:
            global_pointers_after = {name: _file_state(path) for name, path in global_refs.items()}
            global_base_files_after, global_base_bytes_after, global_base_tree_after = _tree_inventory(
                base_version_root
            )
            report["global_pointers_after"] = global_pointers_after
            report["global_base_unchanged"] = (
                (global_base_files_before, global_base_bytes_before, global_base_tree_before)
                == (global_base_files_after, global_base_bytes_after, global_base_tree_after)
            )
            report["global_pointers_unchanged"] = global_pointers_before == global_pointers_after
        except Exception as state_error:
            report["global_state_check_error"] = f"{type(state_error).__name__}: {state_error}"
        report["logs_dir"] = str(logs.relative_to(REPO_ROOT))
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        raise VerificationError(f"offline runtime verification failed; report retained at {report_path}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--test-root", type=Path, required=True)
    parser.add_argument("--base-runtime-root", type=Path)
    args = parser.parse_args(argv)
    report = verify_install(
        package=args.package,
        test_root=args.test_root,
        base_runtime_root=args.base_runtime_root,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
