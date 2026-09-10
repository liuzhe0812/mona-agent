"""Knowledge-library catalog and per-library path resolution.

The notes vault owns one materials catalog. Each library is an isolated LLM
Wiki compilation unit under ``.mona/materials/libraries/<library-id>``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any

CATALOG_SCHEMA_VERSION = 1
DEFAULT_LIBRARY_ID = "kb-default"
_LIBRARY_ID_RE = re.compile(r"^kb-[a-z0-9][a-z0-9-]{0,63}$")
_LEGACY_NAMES = ("raw", "text", "wiki", "evidence", "index.db", "index.db-wal", "index.db-shm")
_CATALOG_LOCK = threading.RLock()


def _catalog_locked(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _CATALOG_LOCK:
            return func(*args, **kwargs)

    return wrapped


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def materials_base(vault: Path) -> Path:
    return vault / ".mona" / "materials"


def _catalog_path(vault: Path) -> Path:
    return materials_base(vault) / "catalog.json"


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _ensure_library_dirs(root: Path) -> None:
    for name in ("raw", "text", "evidence", "wiki"):
        (root / name).mkdir(parents=True, exist_ok=True)


def _default_entry() -> dict[str, Any]:
    now = _now()
    return {
        "id": DEFAULT_LIBRARY_ID,
        "name": "默认知识库",
        "description": "",
        "createdAt": now,
        "updatedAt": now,
    }


def _migrate_legacy_layout(base: Path, default_root: Path) -> None:
    """Move the legacy single-library layout into ``kb-default`` once."""
    default_root.mkdir(parents=True, exist_ok=True)
    for name in _LEGACY_NAMES:
        source = base / name
        target = default_root / name
        if not source.exists() or target.exists():
            continue
        shutil.move(str(source), str(target))


@_catalog_locked
def ensure_catalog(vault: Path) -> dict[str, Any]:
    base = materials_base(vault)
    libraries_root = base / "libraries"
    libraries_root.mkdir(parents=True, exist_ok=True)
    path = _catalog_path(vault)

    if path.exists():
        try:
            catalog = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("materials catalog is unreadable") from exc
        if not isinstance(catalog, dict) or catalog.get("schemaVersion") != CATALOG_SCHEMA_VERSION:
            raise ValueError("unsupported materials catalog schema")
        libraries = catalog.get("libraries")
        if not isinstance(libraries, list):
            raise ValueError("materials catalog libraries must be a list")
    else:
        catalog = {
            "schemaVersion": CATALOG_SCHEMA_VERSION,
            "libraries": [_default_entry()],
        }
        _migrate_legacy_layout(base, libraries_root / DEFAULT_LIBRARY_ID)
        _atomic_write_json(path, catalog)

    for entry in catalog["libraries"]:
        if not isinstance(entry, dict):
            raise ValueError("materials catalog entry must be an object")
        library_id = str(entry.get("id", ""))
        validate_library_id(library_id)
        _ensure_library_dirs(libraries_root / library_id)
    return catalog


def validate_library_id(library_id: str) -> str:
    value = library_id.strip().lower()
    if not _LIBRARY_ID_RE.fullmatch(value):
        raise ValueError("invalid knowledge library id")
    return value


def list_libraries(vault: Path) -> list[dict[str, Any]]:
    catalog = ensure_catalog(vault)
    return [dict(entry) for entry in catalog["libraries"]]


def get_library(vault: Path, library_id: str) -> dict[str, Any] | None:
    resolved = validate_library_id(library_id)
    return next(
        (entry for entry in list_libraries(vault) if entry.get("id") == resolved),
        None,
    )


def get_library_root(vault: Path, library_id: str | None = None) -> Path:
    resolved = validate_library_id(library_id or DEFAULT_LIBRARY_ID)
    if get_library(vault, resolved) is None:
        raise KeyError(f"knowledge library not found: {resolved}")
    root = materials_base(vault) / "libraries" / resolved
    _ensure_library_dirs(root)
    return root


@_catalog_locked
def create_library(vault: Path, name: str, description: str = "") -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("knowledge library name is required")
    if len(clean_name) > 80:
        raise ValueError("knowledge library name is too long")
    clean_description = description.strip()
    if len(clean_description) > 500:
        raise ValueError("knowledge library description is too long")

    catalog = ensure_catalog(vault)
    now = _now()
    entry = {
        "id": f"kb-{uuid.uuid4().hex}",
        "name": clean_name,
        "description": clean_description,
        "createdAt": now,
        "updatedAt": now,
    }
    catalog["libraries"].append(entry)
    _ensure_library_dirs(materials_base(vault) / "libraries" / entry["id"])
    _atomic_write_json(_catalog_path(vault), catalog)
    return dict(entry)


@_catalog_locked
def update_library(
    vault: Path,
    library_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    resolved = validate_library_id(library_id)
    catalog = ensure_catalog(vault)
    entry = next(
        (item for item in catalog["libraries"] if item.get("id") == resolved),
        None,
    )
    if entry is None:
        raise KeyError(f"knowledge library not found: {resolved}")
    if name is not None:
        clean_name = name.strip()
        if not clean_name or len(clean_name) > 80:
            raise ValueError("knowledge library name must be 1-80 characters")
        entry["name"] = clean_name
    if description is not None:
        clean_description = description.strip()
        if len(clean_description) > 500:
            raise ValueError("knowledge library description is too long")
        entry["description"] = clean_description
    entry["updatedAt"] = _now()
    _atomic_write_json(_catalog_path(vault), catalog)
    return dict(entry)


@_catalog_locked
def remove_library(vault: Path, library_id: str) -> Path:
    resolved = validate_library_id(library_id)
    if resolved == DEFAULT_LIBRARY_ID:
        raise ValueError("the default knowledge library cannot be deleted")
    catalog = ensure_catalog(vault)
    remaining = [
        item for item in catalog["libraries"] if item.get("id") != resolved
    ]
    if len(remaining) == len(catalog["libraries"]):
        raise KeyError(f"knowledge library not found: {resolved}")
    if not remaining:
        raise ValueError("at least one knowledge library must remain")
    catalog["libraries"] = remaining
    _atomic_write_json(_catalog_path(vault), catalog)
    return materials_base(vault) / "libraries" / resolved
