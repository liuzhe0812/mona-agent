"""Content-addressed storage for media files."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import threading
from pathlib import Path

from loguru import logger

_CHUNK_SIZE = 1024 * 1024
_SAFE_SUFFIX = re.compile(r"\.[a-z0-9][a-z0-9._-]*\Z")
_MEDIA_LOCK = threading.RLock()
_REPARSE_POINT = 0x400


def stage_media_file(source: Path, media_dir: Path) -> Path:
    """Store *source* under a content-addressed name and return its path.

    The source is hashed before checking for an existing blob so repeated
    staging does not copy it again. If a copy is needed, the hash is computed
    from the bytes written to the temporary file, so a source changing while
    it is read can never produce a name for different bytes.
    """

    source = Path(source)
    with _MEDIA_LOCK:
        root = _prepare_media_dir(media_dir)
        suffix = _normalize_suffix(source.suffix)
        initial_digest = _hash_file(source)
        target = _target_path(root, initial_digest, suffix)
        if target.exists() or _is_link_like(target):
            _verify_existing_target(target, initial_digest)
            return target

        temporary: Path | None = None
        try:
            temporary, copied_digest = _copy_to_temp(source, root)
            target = _target_path(root, copied_digest, suffix)
            if target.exists() or _is_link_like(target):
                _verify_existing_target(target, copied_digest)
                return target
            return _publish_temp(temporary, target, copied_digest)
        finally:
            if temporary is not None:
                _unlink_temp(temporary)


def store_media_bytes(raw: bytes, media_dir: Path, suffix: str) -> Path:
    """Store *raw* under a content-addressed name and return its path."""

    if not isinstance(raw, bytes):
        raise TypeError("raw media must be bytes")
    with _MEDIA_LOCK:
        root = _prepare_media_dir(media_dir)
        normalized_suffix = _normalize_suffix(suffix)
        digest = hashlib.sha256(raw).hexdigest()
        target = _target_path(root, digest, normalized_suffix)
        if target.exists() or _is_link_like(target):
            _verify_existing_target(target, digest)
            return target

        temporary: Path | None = None
        try:
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{target.name}.",
                suffix=".tmp",
                dir=root,
            )
            temporary = Path(temporary_name)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            return _publish_temp(temporary, target, digest)
        finally:
            if temporary is not None:
                _unlink_temp(temporary)


def _normalize_suffix(suffix: str) -> str:
    if not isinstance(suffix, str):
        raise TypeError("media suffix must be str")
    value = suffix.strip().lower()
    if not value:
        return ""
    if not value.startswith("."):
        value = f".{value}"
    if not _SAFE_SUFFIX.fullmatch(value):
        return ".bin"
    return value


def _prepare_media_dir(media_dir: Path) -> Path:
    requested = Path(media_dir)
    if requested.exists() or _is_link_like(requested):
        if _is_link_like(requested):
            raise OSError(f"linked media directory: {requested}")
        if not requested.is_dir():
            raise NotADirectoryError(requested)
    else:
        requested.mkdir(parents=True, exist_ok=True)
    if _is_link_like(requested) or not requested.is_dir():
        raise OSError(f"invalid media directory: {requested}")
    return requested.resolve()


def _target_path(root: Path, digest: str, suffix: str) -> Path:
    name = f"sha256-{digest}{suffix}"
    target = root / name
    if target.parent != root or target.resolve().parent != root:
        raise OSError(f"media target escaped its directory: {target}")
    return target


def _is_link_like(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_to_temp(source: Path, root: Path) -> tuple[Path, str]:
    descriptor, temporary_name = tempfile.mkstemp(prefix=".media-", suffix=".tmp", dir=root)
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    try:
        with os.fdopen(descriptor, "wb") as output_stream, source.open("rb") as input_stream:
            for chunk in iter(lambda: input_stream.read(_CHUNK_SIZE), b""):
                digest.update(chunk)
                output_stream.write(chunk)
            output_stream.flush()
            os.fsync(output_stream.fileno())
    except BaseException:
        _unlink_temp(temporary)
        raise
    return temporary, digest.hexdigest()


def _verify_existing_target(target: Path, digest: str) -> None:
    if _is_link_like(target):
        raise OSError(f"linked media target: {target}")
    if not target.is_file():
        raise OSError(f"media target is not a regular file: {target}")
    if _hash_file(target) != digest:
        raise OSError(f"media target hash mismatch: {target}")


def _publish_temp(temporary: Path, target: Path, digest: str) -> Path:
    if _is_link_like(target):
        raise OSError(f"linked media target: {target}")
    try:
        os.link(temporary, target)
    except FileExistsError:
        _verify_existing_target(target, digest)
        return target
    _fsync_directory(target.parent)
    return target


def _unlink_temp(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("failed to clean up media temporary file {}: {}", path, exc)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
