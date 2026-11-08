"""Desktop read formatting over verified bytes from a hosted sandbox."""
from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath
from typing import Any

from mona.agent.tools.filesystem import ReadFileTool
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.sandbox_files import relative_path
from mona.hosted_work.tool_results import RESULT_PREFIX

FileOperation = Callable[..., Awaitable[dict]]
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_DOCUMENTS = frozenset({".pdf", ".docx", ".xlsx", ".pptx"})


class _NoFileStates:
    """The desktop reader must not resolve or hash a sandbox path on the host."""

    def get(self, _path):
        return None

    def record_read(self, _path, **_kwargs):
        return None


class _BytesPath:
    """A file-like Path exposing verified bytes, with no host filesystem path."""

    def __init__(self, suffix: str, data: bytes):
        # The shared device-path check resolves str(path). The embedded NUL
        # makes that resolution fail without touching any user-controlled path.
        self._name = "/\x00mona-hosted-read" + suffix
        self.suffix, self._data = suffix, data

    def __str__(self):
        return self._name

    def __fspath__(self):
        raise OSError("a hosted file has no host filesystem path")

    def exists(self):
        return True

    def is_file(self):
        return True

    def read_bytes(self):
        return self._data


class _ByteReader(ReadFileTool):
    # Leave room for the shared formatter's continuation and SHA footer under
    # the hosted runner's 100k result budget; never truncate its continuation.
    _MAX_CHARS = min(ReadFileTool._MAX_CHARS, 90_000)

    def __init__(self, source: _BytesPath):
        super().__init__(file_states=_NoFileStates())
        self.source = source

    def _resolve(self, _path):
        return self.source


class HostedReadFileTool(ReadFileTool):
    """Use the desktop schema and renderer while keeping files in the sandbox.

    The operation callback accepts ``(action, **arguments)`` like
    ``HostedTools._file``. A reader belongs to one hosted turn, so its
    deduplication state is never shared across accounts.
    """

    def __init__(self, file_operation: FileOperation, *, max_file_bytes: int, result_store=None):
        super().__init__()
        self._file_operation = file_operation
        self._max_file_bytes = max_file_bytes
        self._result_store = result_store
        self._last_reads: dict[str, tuple[str, int, int | None]] = {}

    @property
    def description(self) -> str:
        return (super().description + " PDF and Office extraction require a configured "
                "and verified isolated runtime; never fall back to a host parser.")

    def cast_params(self, params: dict[str, Any]) -> dict[str, Any]:
        result = super().cast_params(params)
        # Old hosted versions used an initial zero offset. Public schema and
        # all further pagination use the desktop's one-based line numbers.
        if type(result.get("offset")) is int and result["offset"] == 0:
            result["offset"] = 1
        return result

    def invalidate_read_dedup(self) -> None:
        """Use after context compaction so a fresh read returns its contents."""
        self._last_reads.clear()

    def _metadata(self, result: Any, path: str) -> tuple[int, str]:
        if (not isinstance(result, dict) or result.get("path") != path
                or type(result.get("size")) is not int or not 0 <= result["size"] <= self._max_file_bytes
                or not isinstance(result.get("sha256"), str) or not _SHA256.fullmatch(result["sha256"])):
            raise WorkError("invalid_file_reply", "工作区文件结果未通过校验。", 503)
        return result["size"], result["sha256"]

    async def execute(
        self, path: str | None = None, offset: int = 1, limit: int | None = None,
        pages: str | None = None, force: bool = False, char_offset: int | None = None,
        char_limit: int = 4000, expected_sha256: str | None = None, **kwargs: Any,
    ) -> Any:
        if kwargs:
            return "Error: Unsupported tool parameters."
        if type(offset) is int and offset == 0:
            offset = 1
        params = {"path": path, "offset": offset, "char_limit": char_limit, "force": force}
        params.update({key: value for key, value in {"limit": limit, "pages": pages,
                       "char_offset": char_offset, "expected_sha256": expected_sha256}.items() if value is not None})
        errors = self.validate_params(params)
        if errors:
            return "Error: Invalid parameters: " + "; ".join(errors)
        if isinstance(path, str) and path.lower().startswith("mona-tool-result:"):
            if not path.startswith(RESULT_PREFIX) or self._result_store is None:
                return "Error: Tool result reference is unavailable."
            raw, digest, extension = self._result_store.read(path)
            logical, suffix = path, "." + extension
        else:
            try:
                relative = relative_path(path)
            except (TypeError, ValueError):
                return "Error: File path is outside the workspace or invalid."
            logical = "/workspace/" + relative
            suffix = PurePosixPath(relative).suffix.lower()
            if suffix in _DOCUMENTS:
                # Validate ownership/existence in the sandbox, but never import or
                # execute an untrusted document parser in the privileged host.
                result = await self._file_operation("stat", path=relative)
                _, digest = self._metadata(result, relative)
                if expected_sha256 is not None and expected_sha256 != digest:
                    return f"Error: file changed; expected_sha256 does not match current SHA256 {digest}. Restart the read."
                return ("Error: runtime_unavailable: PDF and Office parsing has not been configured "
                        "or verified in the isolated runtime.")

            result = await self._file_operation("download", path=relative)
            size, digest = self._metadata(result, relative)
            encoded = result.get("data")
            if not isinstance(encoded, str) or len(encoded) > 4 * ((self._max_file_bytes + 2) // 3):
                raise WorkError("invalid_file_reply", "工作区文件结果未通过校验。", 503)
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise WorkError("invalid_file_reply", "工作区文件结果未通过校验。", 503) from exc
            if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
                raise WorkError("file_changed", "文件已发生变化，请重新读取后再操作。", 409)
        if expected_sha256 is not None and expected_sha256 != digest:
            return f"Error: file changed; expected_sha256 does not match current SHA256 {digest}. Restart the read."

        source = _BytesPath(suffix, raw)
        reader = _ByteReader(source)
        # The shared reader's own path-based dedup is deliberately bypassed;
        # only the verified bytes and this turn's state determine dedup below.
        output = await reader.execute(path=str(source), offset=offset, limit=limit, pages=pages,
                                      force=True, char_offset=char_offset, char_limit=char_limit,
                                      expected_sha256=expected_sha256)
        if isinstance(output, list):
            for block in output:
                if block.get("type") == "image_url" and isinstance(block.get("_meta"), dict):
                    block["_meta"]["path"] = logical
                elif block.get("type") == "text" and block.get("text") == f"(Image file: {source})":
                    block["text"] = f"(Image file: {logical})"
            return output
        if output.startswith("Error"):
            return output.replace(str(source), logical)
        if output == f"(Empty file: {source})":
            return output.replace(str(source), logical) + f"\n[SHA256={digest}]"

        key = digest, offset, limit
        is_window = output.startswith("[Character window ")
        if not force and not is_window and self._last_reads.get(logical) == key:
            output = f"[File unchanged since last read: {logical}]"
        self._last_reads[logical] = key
        # Desktop character windows already carry the hash. Line reads need it
        # too because hosted writes require the source SHA explicitly.
        return output if is_window else output + f"\n[SHA256={digest}]"
