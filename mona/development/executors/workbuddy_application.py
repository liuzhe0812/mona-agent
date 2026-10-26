"""Read-only detection of the standalone WorkBuddy desktop application."""
from __future__ import annotations

import json
import mmap
import os
import plistlib
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

from loguru import logger

_WORKBUDDY_NAME = re.compile(r"(?<![A-Za-z0-9])workbuddy(?![A-Za-z0-9])", re.IGNORECASE)


def is_managed_executable(executable: str | None, component_root: Path) -> bool:
    """Return whether the resolved executable is inside Mona's component root."""
    if not executable:
        return False
    try:
        Path(executable).resolve().relative_to(component_root.resolve())
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def _macos_application_roots() -> tuple[Path, ...]:
    return (Path("/Applications"), Path.home() / "Applications")


def _path_stat(path: Path) -> tuple[os.stat_result | None, bool]:
    try:
        return path.stat(), False
    except FileNotFoundError:
        return None, False
    except OSError:
        return None, True


def _expand_registry_path(value: str) -> str:
    return os.path.expandvars(value.strip().strip('"'))


def _display_icon_path(value: str) -> str:
    value = value.strip()
    if value.startswith('"'):
        closing_quote = value.find('"', 1)
        if closing_quote > 0:
            return value[1:closing_quote]
    path, comma, icon_index = value.rpartition(",")
    if comma and icon_index.strip().lstrip("+-").isdigit():
        return path.strip().strip('"')
    return value.strip().strip('"')


def _local_windows_path(value: str) -> Path | None:
    expanded = _expand_registry_path(value)
    if not re.match(r"^[A-Za-z]:[\\/]", expanded):
        return None
    return Path(expanded)


def _windows_application_file(path: Path) -> tuple[Path | None, bool]:
    info, uncertain = _path_stat(path)
    if uncertain:
        return None, True
    if info is None:
        return None, False
    if stat.S_ISREG(info.st_mode):
        return (path.resolve() if path.name.casefold() == "workbuddy.exe" else None), False
    if stat.S_ISDIR(info.st_mode):
        executable = path / "WorkBuddy.exe"
        executable_info, uncertain = _path_stat(executable)
        if uncertain:
            return None, True
        return (executable.resolve() if executable_info and stat.S_ISREG(executable_info.st_mode) else None), False
    return None, False


def _registry_value(registry: Any, key: Any, name: str) -> tuple[str | None, bool]:
    try:
        value, _value_type = registry.QueryValueEx(key, name)
    except FileNotFoundError:
        return None, False
    except OSError:
        return None, True
    return (value, False) if isinstance(value, str) else (None, False)


def _is_registry_key_missing(error: OSError) -> bool:
    return isinstance(error, FileNotFoundError) or getattr(error, "winerror", None) in {2, 3}


def _is_registry_end(error: OSError) -> bool:
    return getattr(error, "winerror", None) == 259 or error.errno == 259


def _locate_windows_workbuddy(registry: Any) -> tuple[Path | None, bool]:
    uncertain = False
    roots = (registry.HKEY_CURRENT_USER, registry.HKEY_LOCAL_MACHINE)
    views = (registry.KEY_WOW64_32KEY, registry.KEY_WOW64_64KEY)
    subkey = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"

    for root in roots:
        for view in views:
            try:
                uninstall_key = registry.OpenKey(root, subkey, 0, registry.KEY_READ | view)
            except OSError as exc:
                if not _is_registry_key_missing(exc):
                    uncertain = True
                continue

            with uninstall_key:
                index = 0
                while True:
                    try:
                        name = registry.EnumKey(uninstall_key, index)
                    except OSError as exc:
                        if not _is_registry_end(exc):
                            uncertain = True
                        break
                    index += 1

                    try:
                        entry = registry.OpenKey(uninstall_key, name, 0, registry.KEY_READ)
                    except OSError as exc:
                        if not _is_registry_key_missing(exc):
                            uncertain = True
                        continue

                    with entry:
                        display_name, name_error = _registry_value(registry, entry, "DisplayName")
                        if name_error:
                            uncertain = True
                            continue
                        if (
                            not display_name
                            or not _WORKBUDDY_NAME.search(display_name)
                            or re.search(r"\bcli\b", display_name, re.IGNORECASE)
                        ):
                            continue

                        install_location, location_error = _registry_value(registry, entry, "InstallLocation")
                        display_icon, icon_error = _registry_value(registry, entry, "DisplayIcon")
                        if location_error or icon_error:
                            uncertain = True
                        paths: list[Path] = []
                        if install_location:
                            install_path = _local_windows_path(install_location)
                            if install_path is not None:
                                paths.append(install_path)
                            else:
                                uncertain = True
                        if display_icon:
                            icon_path = _local_windows_path(_display_icon_path(display_icon))
                            if icon_path is not None:
                                paths.append(icon_path)
                            else:
                                uncertain = True
                        if not paths:
                            uncertain = True

                        for path in paths:
                            executable, path_error = _windows_application_file(path)
                            if executable:
                                return executable, False
                            uncertain = uncertain or path_error

    return None, uncertain


def _windows_shortcut_targets() -> list[Path] | None:
    script = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$folders = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
$shell = New-Object -ComObject WScript.Shell
$targets = @(foreach ($folder in $folders) {
    if (-not $folder) { continue }
    foreach ($name in @('WorkBuddy.lnk', 'WorkBuddy\WorkBuddy.lnk')) {
        $shortcut = Join-Path $folder $name
        if (Test-Path -LiteralPath $shortcut -PathType Leaf) {
            $shell.CreateShortcut($shortcut).TargetPath
        }
    }
})
ConvertTo-Json -InputObject $targets -Compress
"""
    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    try:
        result = subprocess.run(
            [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, encoding="utf-8", timeout=5, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        values = json.loads(result.stdout.lstrip("\ufeff"))
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            return None
        paths = [_local_windows_path(value) for value in values]
        return [path for path in paths if path is not None] if all(paths) else None
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        logger.warning("WorkBuddy shortcut detection could not be confirmed ({})", type(exc).__name__)
        return None


def _locate_windows_desktop_app(registry: Any) -> tuple[Path | None, bool]:
    registered, uncertain = _locate_windows_workbuddy(registry)
    if registered:
        return registered, False
    targets = _windows_shortcut_targets()
    if targets is None:
        return None, True
    for target in targets:
        executable, path_error = _windows_application_file(target)
        if executable:
            return executable, False
        uncertain = uncertain or path_error
    return None, uncertain


def _locate_macos_workbuddy(roots: tuple[Path, ...]) -> tuple[Path | None, bool]:
    uncertain = False
    for root in roots:
        app = root / "WorkBuddy.app"
        app_info, path_error = _path_stat(app)
        if path_error:
            uncertain = True
            continue
        if app_info is None or not stat.S_ISDIR(app_info.st_mode):
            continue

        info_path = app / "Contents" / "Info.plist"
        try:
            with info_path.open("rb") as info_file:
                info = plistlib.load(info_file)
        except FileNotFoundError:
            uncertain = True
            continue
        except (OSError, plistlib.InvalidFileException, ValueError):
            uncertain = True
            continue

        product_name = info.get("CFBundleDisplayName") or info.get("CFBundleName")
        if not isinstance(product_name, str) or not _WORKBUDDY_NAME.search(product_name):
            continue

        executable = info.get("CFBundleExecutable")
        if not isinstance(executable, str) or not executable or Path(executable).name != executable:
            uncertain = True
            continue
        executable_path = app / "Contents" / "MacOS" / executable
        executable_info, file_error = _path_stat(executable_path)
        if file_error:
            uncertain = True
        elif executable_info and stat.S_ISREG(executable_info.st_mode):
            return executable_path.resolve(), False

    return None, uncertain


def locate_workbuddy_desktop_app() -> tuple[Path | None, bool]:
    """Return the actual app executable and whether detection was incomplete."""
    try:
        if sys.platform == "win32":
            import winreg

            return _locate_windows_desktop_app(winreg)
        if sys.platform == "darwin":
            return _locate_macos_workbuddy(_macos_application_roots())
    except Exception as exc:
        logger.warning("WorkBuddy desktop app detection could not be confirmed ({})", type(exc).__name__)
    return None, True


def detect_workbuddy_desktop_app() -> bool | None:
    executable, uncertain = locate_workbuddy_desktop_app()
    return True if executable else None if uncertain else False


def _run_as_node_enabled(binary: Path) -> bool:
    # Electron's public fuse schema; never change the application's fuse bytes.
    sentinel = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
    with binary.open("rb") as file, mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as data:
        offset = data.find(sentinel)
        if offset < 0:
            return False
        header = data[offset + len(sentinel):offset + len(sentinel) + 3]
        return len(header) == 3 and header[0] == 1 and header[1] > 0 and header[2] == ord("1")


def workbuddy_cli_launcher(entry: Path) -> Path | None:
    """Accept only WorkBuddy's fixed bundled CLI, not arbitrary Node/shell scripts."""
    if entry.name != "codebuddy" or entry.parent.name != "bin":
        return None
    package = entry.parent.parent
    if package.name != "cli" or package.parent.name != "app.asar.unpacked":
        return None
    resources = package.parent.parent
    if resources.name == "resources":
        app = resources.parent / "WorkBuddy.exe"
        fuse_binary = app
        app_root = resources.parent
    elif resources.name == "Resources" and resources.parent.name == "Contents":
        app_root = resources.parent
        app = app_root / "MacOS" / "WorkBuddy"
        fuse_binary = app_root / "Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
    else:
        return None
    try:
        root = app_root.resolve(strict=True)
        required = (entry, package / "package.json", package / "dist/codebuddy.js", app, fuse_binary)
        if any(not path.is_file() or not path.resolve().is_relative_to(root) for path in required):
            return None
        with (package / "package.json").open(encoding="utf8") as file:
            metadata = json.loads(file.read(65537))
        if metadata.get("name") != "@genie/agent-cli" or metadata.get("bin", {}).get("codebuddy") != "./bin/codebuddy":
            return None
        return app.resolve() if _run_as_node_enabled(fuse_binary) else None
    except (OSError, ValueError, AttributeError):
        return None


def discover_workbuddy_cli() -> Path | None:
    app, _uncertain = locate_workbuddy_desktop_app()
    if not app:
        return None
    resources = app.parent / "resources" if app.suffix.lower() == ".exe" else app.parent.parent / "Resources"
    entry = resources / "app.asar.unpacked/cli/bin/codebuddy"
    return entry.resolve() if workbuddy_cli_launcher(entry) else None
