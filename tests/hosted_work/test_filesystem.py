"""The hosted reader reuses desktop rendering without opening host files."""
import asyncio
import base64
import builtins
import hashlib
import mimetypes
import os
import re
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.tools.filesystem import ReadFileTool
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.filesystem import HostedReadFileTool
from mona.hosted_work.tools import HostedTools


class SandboxFiles:
    def __init__(self, files):
        self.files = files
        self.calls = []

    async def file(self, action, *, path):
        self.calls.append((action, path))
        if path not in self.files:
            raise WorkError("file_not_found", "文件不存在。", 404)
        data = self.files[path]
        result = {"path": path, "name": PurePosixPath(path).name, "size": len(data),
                  "sha256": hashlib.sha256(data).hexdigest()}
        if action == "download":
            result["data"] = base64.b64encode(data).decode("ascii")
        else:
            assert action == "stat"
        return result


def reader(files):
    sandbox = SandboxFiles(files)
    return HostedReadFileTool(sandbox.file, max_file_bytes=1_000_000), sandbox


@pytest.mark.asyncio
async def test_text_and_image_do_not_open_or_resolve_user_paths_on_host(monkeypatch):
    # MIME configuration is process startup state, not a user's workspace file.
    mimetypes.init()
    image = b"\x89PNG\r\n\x1a\nfixture"
    tool, sandbox = reader({"note.txt": "你好\n世界".encode(), "image.png": image})

    def denied(*_args, **_kwargs):
        raise AssertionError("unexpected host file access")

    def virtual_resolve(value, *_args, **_kwargs):
        assert "\x00" in str(value)
        raise ValueError("virtual sentinel")

    def virtual_stat(value, *_args, **_kwargs):
        with pytest.raises(OSError):
            os.fspath(value)
        raise OSError("virtual file has no host path")

    monkeypatch.setattr(builtins, "open", denied)
    monkeypatch.setattr(os, "open", denied)
    monkeypatch.setattr(os, "stat", virtual_stat)
    monkeypatch.setattr(Path, "resolve", virtual_resolve)
    monkeypatch.setattr(Path, "read_bytes", denied)
    monkeypatch.setattr("mona.agent.tools.filesystem._hash_file", denied)

    text = await tool.execute(path="/workspace/note.txt")
    assert "1| 你好\n2| 世界" in text
    blocks = await tool.execute(path="image.png")
    assert blocks == [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(image).decode()},
         "_meta": {"path": "/workspace/image.png"}},
        {"type": "text", "text": "(Image file: /workspace/image.png)"},
    ]
    assert sandbox.calls == [("download", "note.txt"), ("download", "image.png")]


@pytest.mark.asyncio
async def test_schema_and_line_pagination_match_desktop(tmp_path):
    data = "第一行\r\n第二行\r\n第三行\n".encode()
    local = tmp_path / "notes.txt"
    local.write_bytes(data)
    tool, _ = reader({"notes.txt": data})
    desktop = ReadFileTool(workspace=tmp_path)
    assert tool.parameters == desktop.parameters
    actual = await tool.execute(path="notes.txt", offset=2, limit=1)
    expected = await desktop.execute(path=str(local), offset=2, limit=1)
    assert actual == expected + f"\n[SHA256={hashlib.sha256(data).hexdigest()}]"
    assert tool.cast_params({"path": "notes.txt", "offset": 0})["offset"] == 1
    assert "1| 第一行" in await tool.execute(path="notes.txt", offset=0, force=True)


@pytest.mark.asyncio
async def test_character_windows_sha_and_modified_file_detection(tmp_path):
    content = "好" * 8501 + "\r\n终"
    data = content.encode()
    local = tmp_path / "long.txt"
    local.write_bytes(data)
    tool, sandbox = reader({"long.txt": data})
    desktop = ReadFileTool(workspace=tmp_path)
    first = await tool.execute(path="long.txt", char_offset=0, char_limit=4000)
    assert first == await desktop.execute(path=str(local), char_offset=0, char_limit=4000)
    assert "Continue with char_offset=4000" in first
    digest = hashlib.sha256(data).hexdigest()
    second = await tool.execute(path="long.txt", char_offset=4000, char_limit=4000, expected_sha256=digest)
    assert second == await desktop.execute(path=str(local), char_offset=4000, char_limit=4000, expected_sha256=digest)
    auto = await tool.execute(path="long.txt")
    assert auto.startswith("[Character window 0:4000")
    sandbox.files["long.txt"] += b"!"
    changed = await tool.execute(path="long.txt", char_offset=8000, expected_sha256=digest)
    assert "file changed" in changed and "Restart the read" in changed


@pytest.mark.asyncio
async def test_large_line_result_provides_a_real_continuation():
    lines = [f"{index:03d} " + "文" * 1000 for index in range(150)]
    data = "\n".join(lines).encode()
    tool, _ = reader({"large.txt": data})
    first = await tool.execute(path="large.txt")
    assert len(first) < 100_000
    next_offset = int(re.search(r"Use offset=(\d+) to continue", first).group(1))
    assert 1 < next_offset <= len(lines)
    second = await tool.execute(path="large.txt", offset=next_offset)
    assert f"{next_offset}| {lines[next_offset - 1]}" in second
    assert f"{len(lines)}| {lines[-1]}" in second
    assert "End of file" in second


@pytest.mark.asyncio
async def test_dedup_force_and_hash_are_scoped_to_each_reader():
    data = b"one\ntwo\n"
    tool, sandbox = reader({"a.txt": data, "empty.txt": b""})
    first = await tool.execute(path="a.txt")
    again = await tool.execute(path="/workspace/a.txt")
    assert "1| one" in first and "File unchanged" in again
    assert hashlib.sha256(data).hexdigest() in again
    assert "1| one" in await tool.execute(path="a.txt", force=True)
    assert "File unchanged" in await tool.execute(path="a.txt")
    tool.invalidate_read_dedup()
    assert "1| one" in await tool.execute(path="a.txt")
    assert "2| two" in await tool.execute(path="a.txt", offset=2)
    second = HostedReadFileTool(sandbox.file, max_file_bytes=1_000_000)
    assert "1| one" in await second.execute(path="a.txt")
    empty = await tool.execute(path="empty.txt")
    assert "Empty file: /workspace/empty.txt" in empty and hashlib.sha256(b"").hexdigest() in empty


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/etc/passwd", "../secret", "/workspace/../secret", "a\\b", ".mona-trash/file"])
async def test_untrusted_paths_do_not_reach_the_sandbox_or_host(path):
    tool, sandbox = reader({})
    assert "outside the workspace or invalid" in await tool.execute(path=path)
    assert sandbox.calls == []


@pytest.mark.asyncio
async def test_documents_fail_closed_without_host_parser(monkeypatch):
    tool, sandbox = reader({"report.pdf": b"%PDF-fixture", "slides.pptx": b"PK-fixture"})
    monkeypatch.setattr(ReadFileTool, "_read_pdf", lambda *_: pytest.fail("host PDF parser ran"))
    monkeypatch.setattr(ReadFileTool, "_read_office_doc", lambda *_: pytest.fail("host Office parser ran"))
    for path in ("report.pdf", "slides.pptx"):
        result = await tool.execute(path=path)
        assert "runtime_unavailable" in result and "not been configured or verified" in result
    assert sandbox.calls == [("stat", "report.pdf"), ("stat", "slides.pptx")]
    with pytest.raises(WorkError) as error:
        await tool.execute(path="absent.docx")
    assert error.value.code == "file_not_found"


@pytest.mark.asyncio
async def test_download_must_match_declared_path_size_and_digest():
    tool, sandbox = reader({"a.txt": b"hello"})
    original = sandbox.file

    async def wrong_bytes(action, *, path):
        result = await original(action, path=path)
        result["data"] = base64.b64encode(b"other").decode()
        return result

    tool._file_operation = wrong_bytes
    with pytest.raises(WorkError) as error:
        await tool.execute(path="a.txt")
    assert error.value.code == "file_changed"

    async def wrong_path(action, *, path):
        return {**await original(action, path=path), "path": "other.txt"}

    tool._file_operation = wrong_path
    with pytest.raises(WorkError) as error:
        await tool.execute(path="a.txt")
    assert error.value.code == "invalid_file_reply"


@pytest.mark.asyncio
async def test_binary_is_not_falsely_reported_as_text():
    tool, _ = reader({"blob.bin": b"\xff\xfe\x00\x01"})
    result = await tool.execute(path="blob.bin")
    assert "Cannot read binary file /workspace/blob.bin" in result
    assert "\x00mona-hosted-read" not in result


@pytest.mark.asyncio
async def test_hosted_registry_registers_desktop_reader_and_detects_webp():
    webp = b"RIFF\x04\x00\x00\x00WEBPfixture"
    files = SandboxFiles({"a.txt": "零\n一".encode(), "no-extension": webp})

    async def sandbox_file(request):
        return await files.file(request["action"], path=request["path"])

    sandbox = SimpleNamespace(config=HostedWorkConfig(), file=sandbox_file)
    tools = HostedTools(sandbox, AsyncMock())
    registered = tools.registry.get("read_file")
    assert isinstance(registered, HostedReadFileTool)
    assert registered.parameters == ReadFileTool().parameters
    assert tools.registry.is_visible("read_file")
    result = await tools.registry.execute("read_file", {"path": "a.txt", "offset": 0})
    assert "1| 零\n2| 一" in result and hashlib.sha256(files.files["a.txt"]).hexdigest() in result
    blocks = await tools.registry.execute("read_file", {"path": "no-extension"})
    assert blocks[0]["image_url"]["url"] == "data:image/webp;base64," + base64.b64encode(webp).decode()
    assert blocks[0]["_meta"]["path"] == "/workspace/no-extension"
    assert files.calls == [("download", "a.txt"), ("download", "no-extension")]


@pytest.mark.asyncio
async def test_hosted_reader_keeps_sandbox_timeout_failure_boundary():
    async def timeout(_request):
        raise TimeoutError("sandbox unavailable")

    tools = HostedTools(SimpleNamespace(config=HostedWorkConfig(), file=timeout), AsyncMock())
    with pytest.raises(asyncio.CancelledError):
        await tools.registry.execute("read_file", {"path": "a.txt"})
    assert tools.fault and "工作区操作未能安全完成" in tools.fault
