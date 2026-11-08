"""File mutation contracts use controlled files; real gVisor acceptance is opt-in."""
import hashlib
import io
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work import sandbox_files
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.executor import ProcessExecutor, child_environment
from mona.hosted_work.sandbox import DockerSandbox


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox_files, "ROOT", tmp_path)
    # The production helper runs in gVisor; never inspect/kill host processes here.
    monkeypatch.setattr(sandbox_files, "quiesce", lambda: None)
    return tmp_path


def write(path="source.txt", content="private document"):
    return sandbox_files.operate({"action": "write", "path": path, "content": content}, 4096)


def rename(source, destination, digest):
    return sandbox_files.operate({"action": "rename", "path": source, "destination": destination,
                                  "expected_sha256": digest}, 4096)


def trash(source, digest):
    return sandbox_files.operate({"action": "trash", "path": source, "expected_sha256": digest}, 4096)


@pytest.mark.parametrize("expected", [None, "0" * 64])
def test_write_conflict_is_a_safe_helper_reply(workspace, monkeypatch, capsys, expected):
    write()
    request = {"action": "write", "path": "source.txt", "content": "replacement"}
    if expected is not None:
        request["expected_sha256"] = expected
    monkeypatch.setattr(sys, "argv", ["sandbox_files", "file", "4096"])
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()), encoding="utf-8"))

    sandbox_files.main()

    assert json.loads(capsys.readouterr().out) == {"error": "file_changed"}
    assert (workspace / "source.txt").read_text(encoding="utf-8") == "private document"


@pytest.mark.parametrize("action", ["stat", "read", "download", "list"])
def test_missing_file_is_a_safe_helper_reply(workspace, monkeypatch, capsys, action):
    request = {"action": action, "path": "missing.txt"}
    monkeypatch.setattr(sys, "argv", ["sandbox_files", "file", "4096"])
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()), encoding="utf-8"))

    sandbox_files.main()

    assert json.loads(capsys.readouterr().out) == {"error": "file_not_found"}


def test_invalid_write_path_is_a_safe_helper_reply(workspace, monkeypatch, capsys):
    request = {"action": "write", "path": "../outside.txt", "content": "replacement"}
    monkeypatch.setattr(sys, "argv", ["sandbox_files", "file", "4096"])
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()), encoding="utf-8"))

    sandbox_files.main()

    assert json.loads(capsys.readouterr().out) == {"error": "invalid_file_operation"}
    assert not (workspace.parent / "outside.txt").exists()


def test_write_race_does_not_overwrite_the_new_file(workspace, monkeypatch):
    def competing_create(_source, destination):
        Path(destination).write_text("other writer", encoding="utf-8")
        raise FileExistsError

    monkeypatch.setattr(sandbox_files.os, "link", competing_create)
    with pytest.raises(sandbox_files.FileOperationError) as error:
        write("new.txt", "replacement")
    assert error.value.code == "file_exists"
    assert (workspace / "new.txt").read_text(encoding="utf-8") == "other writer"
    assert not list(workspace.glob(".mona-write-*"))


def test_unknown_write_failure_is_not_reported_as_a_conflict(workspace, monkeypatch):
    original = write()

    def fail_replace(*_args):
        raise OSError("unconfirmed write")

    monkeypatch.setattr(sandbox_files.os, "replace", fail_replace)
    with pytest.raises(OSError):
        sandbox_files.operate({"action": "write", "path": "source.txt", "content": "replacement",
                               "expected_sha256": original["sha256"]}, 4096)
    assert (workspace / "source.txt").read_text(encoding="utf-8") == "private document"


def test_rename_is_digest_bound_preserves_bytes_and_never_overwrites(workspace):
    original = write()
    (workspace / "folder").mkdir()
    changed = rename("/workspace/source.txt", "/workspace/folder/renamed.txt", original["sha256"])
    assert changed == {**original, "path": "folder/renamed.txt", "name": "renamed.txt"}
    assert not (workspace / "source.txt").exists()
    assert (workspace / changed["path"]).read_text(encoding="utf-8") == "private document"
    write("occupied.txt", "keep this file")
    for target in ("occupied.txt", "folder", "folder/renamed.txt"):
        with pytest.raises(sandbox_files.FileOperationError) as exc:
            rename(changed["path"], target, changed["sha256"])
        assert exc.value.code == "file_exists"
    assert (workspace / "occupied.txt").read_text(encoding="utf-8") == "keep this file"
    assert (workspace / changed["path"]).exists()


def test_mutations_require_current_digest_and_regular_files(workspace):
    original = write()
    for request in (
        {"action": "rename", "path": "source.txt", "destination": "new.txt"},
        {"action": "trash", "path": "source.txt", "expected_sha256": "invalid"},
        {"action": "trash", "path": "source.txt", "expected_sha256": original["sha256"], "owner": "other"},
    ):
        with pytest.raises(sandbox_files.FileOperationError) as exc:
            sandbox_files.operate(request, 4096)
        assert exc.value.code == "invalid_file_operation"
    for mutate in (lambda: rename("source.txt", "new.txt", "0" * 64),
                   lambda: trash("source.txt", "0" * 64)):
        with pytest.raises(sandbox_files.FileOperationError) as exc:
            mutate()
        assert exc.value.code == "file_changed"
    (workspace / "directory").mkdir()
    for mutate in (lambda: rename("directory", "new", original["sha256"]),
                   lambda: trash("directory", original["sha256"])):
        with pytest.raises(sandbox_files.FileOperationError) as exc:
            mutate()
        assert exc.value.code == "invalid_file_operation"
    os.link(workspace / "source.txt", workspace / "hardlink.txt")
    with pytest.raises(sandbox_files.FileOperationError):
        rename("source.txt", "new.txt", original["sha256"])
    assert (workspace / "source.txt").exists() and not (workspace / "new.txt").exists()


@pytest.mark.parametrize("bad", ["../other/file", "/etc/passwd", "/workspace/../file", "C:\\secret", ".mona-trash/file"])
def test_mutations_cannot_escape_or_target_private_storage(workspace, bad):
    original = write()
    for mutate in (lambda: rename("source.txt", bad, original["sha256"]),
                   lambda: rename(bad, "renamed.txt", original["sha256"]),
                   lambda: trash(bad, original["sha256"])):
        with pytest.raises(sandbox_files.FileOperationError) as exc:
            mutate()
        assert exc.value.code == "invalid_file_operation"
    assert (workspace / "source.txt").exists()


def test_destination_created_during_move_is_not_overwritten(workspace, monkeypatch):
    original = write()
    link = sandbox_files.os.link

    def create_competitor(source, target, **kwargs):
        target.write_text("other operation", encoding="utf-8")
        return link(source, target, **kwargs)

    monkeypatch.setattr(sandbox_files.os, "link", create_competitor)
    with pytest.raises(sandbox_files.FileOperationError) as exc:
        rename("source.txt", "new.txt", original["sha256"])
    assert exc.value.code == "file_exists"
    assert (workspace / "new.txt").read_text(encoding="utf-8") == "other operation"
    assert (workspace / "source.txt").exists()


def test_unknown_unlink_retains_the_only_remaining_copy(workspace, monkeypatch):
    original = write()
    unlink = Path.unlink

    def interrupted_unlink(path, *args, **kwargs):
        unlink(path, *args, **kwargs)
        if path == workspace / "source.txt":
            raise OSError("fixture: unlink completed before transport interruption")

    monkeypatch.setattr(Path, "unlink", interrupted_unlink)
    with pytest.raises(sandbox_files.FileOperationError) as exc:
        rename("source.txt", "new.txt", original["sha256"])
    assert exc.value.code == "file_operation_unknown"
    assert (workspace / "new.txt").read_text(encoding="utf-8") == "private document"
    assert not (workspace / "source.txt").exists()


def test_symlink_source_parent_and_destination_are_rejected(workspace, tmp_path):
    original = write()
    outside = tmp_path.parent / ("outside-" + uuid4().hex)
    outside.mkdir()
    try:
        (outside / "file.txt").write_text("outside", encoding="utf-8")
        try:
            (workspace / "link").symlink_to(outside, target_is_directory=True)
            (workspace / "alias.txt").symlink_to(workspace / "source.txt")
            (workspace / "dangling.txt").symlink_to(outside / "missing.txt")
        except OSError:
            pytest.skip("Windows requires symlink privilege; Linux symlink acceptance remains required")
        for mutate in (
            lambda: rename("alias.txt", "new.txt", original["sha256"]),
            lambda: rename("source.txt", "link/new.txt", original["sha256"]),
            lambda: rename("source.txt", "dangling.txt", original["sha256"]),
            lambda: trash("link/file.txt", original["sha256"]),
        ):
            with pytest.raises(sandbox_files.FileOperationError) as exc:
                mutate()
            assert exc.value.code == "invalid_file_operation"
        assert (outside / "file.txt").read_text(encoding="utf-8") == "outside"
    finally:
        (outside / "file.txt").unlink(missing_ok=True)
        outside.rmdir()


def test_trash_retains_bytes_audit_and_is_private_to_normal_file_api(workspace):
    original = write()
    result = trash("/workspace/source.txt", original["sha256"])
    assert result == {**original, "trashed": True}
    assert not (workspace / "source.txt").exists()
    slots = list((workspace / sandbox_files.TRASH).iterdir())
    assert len(slots) == 1 and len(slots[0].name) == 32
    assert hashlib.sha256((slots[0] / "file").read_bytes()).hexdigest() == original["sha256"]
    audit = json.loads((slots[0] / "metadata.json").read_text(encoding="utf-8"))
    assert audit["path"] == "source.txt" and audit["sha256"] == original["sha256"]
    assert audit["deleted_at"] > 0
    assert sandbox_files.operate({"action": "list", "path": "/workspace"}, 4096)["entries"] == []
    hidden = "/workspace/" + sandbox_files.TRASH + "/" + slots[0].name + "/file"
    for action in ("list", "read", "stat", "download", "write", "upload"):
        with pytest.raises(ValueError):
            sandbox_files.operate({"action": action, "path": hidden, "content": "no", "data": "bm8="}, 4096)
    if sys.platform == "linux":
        assert (slots[0].stat().st_mode & 0o777) == 0o700
        assert ((slots[0] / "metadata.json").stat().st_mode & 0o777) == 0o600


@pytest.mark.asyncio
async def test_transport_maps_only_bounded_mutation_errors(tmp_path, monkeypatch):
    sandbox = DockerSandbox(HostedWorkConfig(), owner_key("1"), "a" * 32, tmp_path / "workspace.zip")
    outputs = [b'{"error":"file_changed"}', b'{"error":"file_not_found"}', b'{"error":"host private text"}']

    async def helper(*args, **kwargs):
        return outputs.pop(0)

    monkeypatch.setattr(sandbox, "_helper", helper)
    for code, status in (("file_changed", 409), ("file_not_found", 404), ("invalid_file_reply", 503)):
        with pytest.raises(WorkError) as exc:
            await sandbox.file({"action": "trash"})
        assert (exc.value.code, exc.value.status) == (code, status)
        assert "host private" not in str(exc.value)


@pytest.mark.asyncio
async def test_executor_file_uses_existing_child_lifecycle_without_model_credentials(tmp_path, monkeypatch):
    config = HostedWorkConfig(state_dir=str(tmp_path))
    executor = ProcessExecutor(config)
    observed = []

    async def capture(payload, callback):
        observed.append((payload, callback))
        return {"status": "unknown", "workspace_saved": False}

    async def no_event(*args):
        raise AssertionError("file operation must not emit model events")

    monkeypatch.setattr(executor, "execute", capture)
    request = {"action": "rename", "path": "old.txt", "destination": "new.txt", "expected_sha256": "a" * 64}
    assert await executor.file(owner_key("1"), "b" * 32, request, no_event) == {
        "status": "unknown", "workspace_saved": False}
    payload, callback = observed[0]
    assert callback is no_event
    assert payload == {"action": "upload", "owner": owner_key("1"), "run_id": "b" * 32,
                       "file_request": request}
    assert payload["file_request"] is not request
    monkeypatch.setenv("MONA_MUTATION_CREDENTIAL_CANARY", "synthetic")
    assert "MONA_MUTATION_CREDENTIAL_CANARY" not in child_environment(config, payload)
    with pytest.raises(WorkError):
        await executor.file(owner_key("1"), "b" * 32, {"action": "exec"}, no_event)


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "linux", reason="Windows fail-closed contract")
async def test_non_linux_file_mutations_never_fall_back_to_host():
    executor = ProcessExecutor(HostedWorkConfig())
    async def no_event(*_):
        raise AssertionError("unexpected execution")
    with pytest.raises(WorkError) as exc:
        await executor.file(owner_key("1"), "b" * 32, {"action": "trash"}, no_event)
    assert exc.value.code == "linux_required"


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux" or os.environ.get("MONA_HOSTED_SANDBOX_SMOKE") != "1",
                    reason="requires explicitly enabled Ubuntu/gVisor file-mutation acceptance")
async def test_real_gvisor_mutations_survive_snapshot_and_keep_other_owner_private(tmp_path):
    image = os.environ.get("MONA_HOSTED_SANDBOX_IMAGE", "")
    assert image, "Use a preinstalled, verified immutable image digest."
    config = HostedWorkConfig(state_dir=str(tmp_path), sandbox_image=image, workspace_bytes=8 * 1024 * 1024)
    owner = owner_key("900000001")
    snapshot = tmp_path / "private.zip"
    first = DockerSandbox(config, owner, uuid4().hex, snapshot)
    other = DockerSandbox(config, owner_key("900000002"), uuid4().hex, tmp_path / "other.zip")
    restored = DockerSandbox(config, owner, uuid4().hex, snapshot)
    try:
        await first.preflight()
        await first.start()
        original = await first.file({"action": "write", "path": "source.txt", "content": "private"})
        moved = await first.file({"action": "rename", "path": "source.txt", "destination": "new.txt",
                                  "expected_sha256": original["sha256"]})
        assert moved["path"] == "new.txt"
        with pytest.raises(WorkError) as exc:
            await first.file({"action": "trash", "path": "new.txt", "expected_sha256": "0" * 64})
        assert exc.value.status == 409
        await first.file({"action": "trash", "path": "new.txt", "expected_sha256": moved["sha256"]})
        await first.save()
        await first.close()
        await restored.start()
        assert (await restored.file({"action": "list", "path": "/workspace"}))["entries"] == []
        with pytest.raises(WorkError):
            await restored.file({"action": "trash", "path": ".mona-trash", "expected_sha256": moved["sha256"]})
        # Readback occurs inside gVisor; the host never opens/extracts the archive.
        verified = await restored.execute("python3 -I -c \"from pathlib import Path; "
                                          "p=list(Path('/workspace/.mona-trash').glob('*/file')); "
                                          "assert len(p)==1 and p[0].read_bytes()==b'private'\"")
        assert verified["exit_code"] == 0
        await other.start()
        assert (await other.file({"action": "list", "path": "/workspace"}))["entries"] == []
    finally:
        await first.close()
        await restored.close()
        await other.close()
