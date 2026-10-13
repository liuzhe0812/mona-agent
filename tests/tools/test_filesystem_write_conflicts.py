import hashlib
from pathlib import Path

import pytest

from mona.agent.tools.file_state import FileStates
from mona.agent.tools.filesystem import EditFileTool, ReadFileTool, WriteFileTool


def _file_tools(workspace, states):
    return (
        ReadFileTool(workspace=workspace, file_states=states),
        WriteFileTool(workspace=workspace, file_states=states),
        EditFileTool(workspace=workspace, file_states=states),
    )


@pytest.mark.asyncio
async def test_write_file_rejects_a_stale_second_agent_and_keeps_first_write(tmp_path):
    target = tmp_path / "shared.txt"
    target.write_text("base\n", encoding="utf-8")
    read_a, write_a, _ = _file_tools(tmp_path, FileStates())
    read_b, write_b, _ = _file_tools(tmp_path, FileStates())

    await read_a.execute(path="shared.txt")
    await read_b.execute(path="shared.txt")
    first = await write_a.execute(path="shared.txt", content="agent A\n")
    second = await write_b.execute(path="shared.txt", content="agent B\n")

    assert first.startswith("Successfully wrote")
    assert "changed since it was read" in second
    assert target.read_text(encoding="utf-8") == "agent A\n"


@pytest.mark.asyncio
async def test_write_file_requires_a_source_version_but_keeps_create_and_explicit_sha(tmp_path):
    target = tmp_path / "existing.txt"
    target.write_text("original\n", encoding="utf-8")
    _, writer, _ = _file_tools(tmp_path, FileStates())

    rejected = await writer.execute(path="existing.txt", content="blind overwrite\n")
    assert "has not been read" in rejected
    assert target.read_text(encoding="utf-8") == "original\n"

    created = await writer.execute(path="new/note.txt", content="new file\n")
    assert created.startswith("Successfully wrote")
    assert (tmp_path / "new" / "note.txt").read_text(encoding="utf-8") == "new file\n"

    source_sha = hashlib.sha256(target.read_bytes()).hexdigest()
    explicit = await writer.execute(
        path="existing.txt", content="explicit version\n", expected_sha256=source_sha
    )
    assert explicit.startswith("Successfully wrote")
    assert target.read_text(encoding="utf-8") == "explicit version\n"


@pytest.mark.asyncio
async def test_write_file_does_not_create_when_expected_source_is_missing(tmp_path):
    _, writer, _ = _file_tools(tmp_path, FileStates())

    result = await writer.execute(
        path="missing.txt", content="must not create", expected_sha256="0" * 64
    )

    assert "source file no longer exists" in result
    assert not (tmp_path / "missing.txt").exists()


@pytest.mark.asyncio
async def test_write_file_rechecks_source_immediately_before_overwrite(tmp_path, monkeypatch):
    target = tmp_path / "existing.txt"
    target.write_text("original\n", encoding="utf-8")
    states = FileStates()
    reader, writer, _ = _file_tools(tmp_path, states)
    await reader.execute(path="existing.txt")

    read_bytes = Path.read_bytes
    write_bytes = Path.write_bytes
    reads = 0

    def change_before_recheck(path):
        nonlocal reads
        if path.resolve() == target.resolve():
            reads += 1
            if reads == 2:
                write_bytes(path, b"external update\n")
        return read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", change_before_recheck)
    result = await writer.execute(path="existing.txt", content="replacement\n")

    assert "changed during write preparation" in result
    assert target.read_text(encoding="utf-8") == "external update\n"


@pytest.mark.asyncio
async def test_edit_file_rejects_a_stale_second_agent_and_keeps_first_edit(tmp_path):
    target = tmp_path / "shared.txt"
    target.write_text("base\n", encoding="utf-8")
    read_a, _, edit_a = _file_tools(tmp_path, FileStates())
    read_b, _, edit_b = _file_tools(tmp_path, FileStates())

    await read_a.execute(path="shared.txt")
    await read_b.execute(path="shared.txt")
    first = await edit_a.execute(path="shared.txt", old_text="base", new_text="agent A")
    second = await edit_b.execute(path="shared.txt", old_text="base", new_text="agent B")

    assert first.startswith("Successfully edited")
    assert "changed since it was read" in second
    assert target.read_text(encoding="utf-8") == "agent A\n"


@pytest.mark.asyncio
async def test_edit_file_requires_read_and_rechecks_before_writing(tmp_path, monkeypatch):
    target = tmp_path / "shared.txt"
    target.write_text("base\n", encoding="utf-8")
    states = FileStates()
    reader, _, editor = _file_tools(tmp_path, states)

    unread = await editor.execute(path="shared.txt", old_text="base", new_text="edited")
    assert "has not been read" in unread
    assert target.read_text(encoding="utf-8") == "base\n"

    await reader.execute(path="shared.txt")
    edited = await editor.execute(path="shared.txt", old_text="base", new_text="edited")
    assert edited.startswith("Successfully edited")
    assert target.read_text(encoding="utf-8") == "edited\n"

    await reader.execute(path="shared.txt", force=True)
    from mona.agent.tools import filesystem

    find_matches = filesystem._find_matches

    def change_after_read(content, old_text):
        target.write_text("external update\n", encoding="utf-8")
        return find_matches(content, old_text)

    monkeypatch.setattr(filesystem, "_find_matches", change_after_read)
    raced = await editor.execute(path="shared.txt", old_text="edited", new_text="lost update")

    assert "changed during edit preparation" in raced
    assert target.read_text(encoding="utf-8") == "external update\n"


@pytest.mark.asyncio
async def test_edit_file_creates_missing_file_and_preserves_bom_and_crlf_after_read(tmp_path):
    states = FileStates()
    reader, _, editor = _file_tools(tmp_path, states)

    created = await editor.execute(path="new.txt", old_text="", new_text="created\n")
    assert created.startswith("Successfully created")
    assert (tmp_path / "new.txt").read_text(encoding="utf-8") == "created\n"

    target = tmp_path / "encoded.py"
    original = b"\xef\xbb\xbffirst = 1\r\nsecond = 2\r\n"
    target.write_bytes(original)
    await reader.execute(path="encoded.py", force=True)
    result = await editor.execute(path="encoded.py", old_text="first = 1", new_text="first = 3")

    assert result.startswith("Successfully edited")
    assert target.read_bytes() == original.replace(b"first = 1", b"first = 3")
