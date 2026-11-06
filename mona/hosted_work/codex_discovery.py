"""Find an installed Codex binary without running it or reading user credentials."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from mona.development.contracts import ExecutorId
from mona.development.executors.discovery import resolve_executable

_SYSTEM_DIRS = (Path("/usr/local/bin"), Path("/usr/bin"), Path("/bin"), Path("/snap/bin"))
_SYSTEM_ROOTS = (Path("/usr"), Path("/opt"), Path("/snap"))
_NODE_VERSION = re.compile(r"^v(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][A-Za-z0-9.-]{1,32})?$")


def _within(path: Path, roots: tuple[Path, ...]) -> bool:
    return any(path.is_relative_to(root) for root in roots)


def _native(path: Path) -> bool:
    try:
        if not path.is_file() or (os.name != "nt" and not os.access(path, os.X_OK)):
            return False
        with path.open("rb") as stream:
            header = stream.read(64)
            magic = header[:4]
            if sys.platform.startswith("linux"):
                return len(header) == 64 and magic == b"\x7fELF" and header[4] in (1, 2) and header[5] in (1, 2)
            if sys.platform == "win32":
                return magic.startswith(b"MZ")
            if sys.platform == "darwin":
                return magic in {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
    except (OSError, ValueError):
        pass
    return False


def _trusted_system_dir(directory: Path) -> bool:
    """Only root-controlled system bins may be taken from the service PATH."""
    try:
        return os.name == "nt" or (directory.stat().st_uid == 0 and directory.stat().st_mode & 0o022 == 0)
    except OSError:
        return False


def discover_codex(*, home: Path | None = None, work_root: Path | None = None,
                   search_path: str | None = None) -> Path | None:
    """Return a verified native path, not proof of launch, authentication or readiness."""
    try:
        home = (home or Path.home()).resolve(strict=True)
        work_root = work_root.resolve(strict=True) if work_root else None
    except (OSError, RuntimeError):
        return None
    name = "codex.exe" if os.name == "nt" else "codex"
    nvm = home / ".nvm" / "versions" / "node"
    user_roots = (home / ".local", home / ".npm-global", nvm, home / "node_modules")
    local_roots = [home / "node_modules"]
    if work_root:
        user_roots += (work_root / "node_modules",)
        local_roots.append(work_root / "node_modules")
    fixed_user_bins = [home / ".local" / "bin", home / ".npm-global" / "bin", home / "node_modules" / ".bin"]
    if work_root:
        fixed_user_bins.append(work_root / "node_modules" / ".bin")

    # Check PATH entries only when they are trusted system bins or one of the
    # fixed operator install locations. Relative entries and workspaces are ignored.
    directories: list[Path] = []
    for part in (os.environ.get("PATH", "") if search_path is None else search_path).split(os.pathsep):
        directory = Path(part)
        if not part or not directory.is_absolute():
            continue
        try:
            resolved = directory.resolve(strict=True)
            system = resolved.name == "bin" and _within(resolved, _SYSTEM_ROOTS) and _trusted_system_dir(resolved)
            user = resolved in fixed_user_bins or (resolved.parent.parent == nvm and resolved.name == "bin"
                                                    and bool(_NODE_VERSION.fullmatch(resolved.parent.name)))
            if system or user:
                directories.append(directory)
        except (OSError, RuntimeError, ValueError):
            continue
    for directory in _SYSTEM_DIRS:
        try:
            resolved = directory.resolve(strict=True)
            if _within(resolved, _SYSTEM_ROOTS) and _trusted_system_dir(resolved):
                directories.append(directory)
        except (OSError, RuntimeError):
            continue
    directories.extend(fixed_user_bins)
    try:
        versions = []
        if nvm.resolve(strict=True) != nvm:
            raise OSError("untrusted_nvm_root")
        with os.scandir(nvm) as entries:
            for index, entry in enumerate(entries):
                if index >= 128:
                    break
                match = _NODE_VERSION.fullmatch(entry.name)
                if match and entry.is_dir(follow_symlinks=False):
                    versions.append((tuple(map(int, match.groups())), entry.name))
        directories.extend(nvm / version / "bin" for _, version in sorted(versions, reverse=True))
    except (OSError, RuntimeError):
        pass

    allowed_roots = (*_SYSTEM_ROOTS, *user_roots)
    seen: set[tuple[Path, Path | None]] = set()
    for directory in directories:
        try:
            entry = directory / name
            resolved = entry.resolve(strict=True)
            if not _within(resolved, allowed_roots):
                continue
            local_root = next((root for root in local_roots if directory == root / ".bin"
                               or directory.resolve(strict=True) == root / ".bin"), None)
            if local_root and not resolved.is_relative_to(local_root):
                continue
            key = (resolved, local_root)
            if key in seen:
                continue
            seen.add(key)
            # Never discover a program from the tenant state or a workspace.
            if work_root and resolved.is_relative_to(work_root) and not resolved.is_relative_to(work_root / "node_modules"):
                continue
            if not local_root and _native(resolved):
                return resolved
            if resolved.parts[-5:] != ("node_modules", "@openai", "codex", "bin", "codex.js"):
                continue
            native, projected = resolve_executable(ExecutorId.CODEX, resolved)
            native = native.resolve(strict=True)
            if projected and _within(native, allowed_roots) and _native(native):
                if local_root and not native.is_relative_to(local_root):
                    continue
                if not work_root or not native.is_relative_to(work_root) or native.is_relative_to(work_root / "node_modules"):
                    return native
        except (OSError, RuntimeError, ValueError):
            continue
    return None
