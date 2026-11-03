"""Hosted canvas documents remain private, durable, and version checked."""

import hashlib
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.tenant_files import TenantFiles

OWNER_A, OWNER_B = "a" * 64, "b" * 64
CHAT_A, CHAT_B = "1" * 32, "2" * 32
CANVAS_ID = "canvas-12345678-1234-1234-1234-123456789abc"


@pytest.fixture
def files(tmp_path):
    def authorize(owner, chat_id):
        if (owner, chat_id) not in {(OWNER_A, CHAT_A), (OWNER_B, CHAT_B)}:
            raise WorkError("not_found", "未找到该会话。", 404)

    return TenantFiles(HostedWorkConfig(state_dir=str(tmp_path)), authorize)


def canvas(chat_id=CHAT_A, content="# 初始画布"):
    return {"version": 1, "id": CANVAS_ID, "kind": "mindmap", "title": "示例",
            "originChatId": chat_id, "createdAt": "2026-11-03T00:00:00Z",
            "updatedAt": "2026-11-03T00:00:00Z", "contentMarkdown": content}


def save(files, owner=OWNER_A, value=None, **extra):
    return files.invoke(owner, "workspace_canvas_save", {
        "workspaceRoot": "/workspace", "canvas": value if value is not None else canvas(), **extra,
    })


def read(files, owner, path):
    return files.invoke(owner, "workspace_canvas_read", {"workspaceRoot": "/workspace", "path": path})


def test_canvas_persists_for_one_account_and_never_resolves_other_accounts(files, tmp_path):
    first = save(files)
    assert first["path"] == f"/workspace/canvases/{CANVAS_ID}.mona-canvas"
    assert str(tmp_path) not in json.dumps(first)
    assert len(first["sha256"]) == 64
    assert files.invoke(OWNER_A, "workspace_canvas_list", {"workspaceRoot": "/workspace", "chatId": CHAT_A}) == [first]
    with pytest.raises(WorkError) as missing:
        read(files, OWNER_B, first["path"])
    assert missing.value.status == 404

    second = save(files, OWNER_B, canvas(CHAT_B, "# 另一个账号"))
    assert second["path"] == first["path"]
    assert read(files, OWNER_A, first["path"])["canvas"]["contentMarkdown"] == "# 初始画布"
    assert read(files, OWNER_B, second["path"])["canvas"]["contentMarkdown"] == "# 另一个账号"
    restarted = TenantFiles(files.config, files.authorize_session)
    assert read(restarted, OWNER_A, first["path"]) == first
    if os.name != "nt":
        assert files.root(OWNER_A).stat().st_mode & 0o777 == 0o700
        assert (files.root(OWNER_A) / "canvases").stat().st_mode & 0o777 == 0o700
        assert (files.root(OWNER_A) / "canvases" / f"{CANVAS_ID}.mona-canvas").stat().st_mode & 0o777 == 0o600


def test_foreign_or_unknown_session_is_rejected(files):
    with pytest.raises(WorkError) as denied:
        save(files, OWNER_A, canvas(CHAT_B))
    assert denied.value.status == 404
    with pytest.raises(WorkError) as denied:
        files.invoke(OWNER_A, "workspace_canvas_list", {"workspaceRoot": "/workspace", "chatId": CHAT_B})
    assert denied.value.status == 404
    assert files.invoke(OWNER_A, "workspace_canvas_list", {"workspaceRoot": "/workspace"}) == []


def test_owner_directory_alias_cannot_enter_another_accounts_root(files):
    other = files.root(OWNER_B)
    alias = other.parent.parent / OWNER_A
    if os.name == "nt":
        created = subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(other.parent)], capture_output=True)
        if created.returncode:
            pytest.skip("Directory junction creation unavailable")
    else:
        alias.symlink_to(other.parent, target_is_directory=True)
    try:
        with pytest.raises(WorkError) as denied:
            files.root(OWNER_A)
        assert denied.value.code == "invalid_state"
        assert other.is_dir()
    finally:
        if os.name == "nt":
            alias.rmdir()
        else:
            alias.unlink()


def test_deleted_session_does_not_break_another_sessions_list(tmp_path):
    sessions = {(OWNER_A, CHAT_A), (OWNER_A, CHAT_B)}

    def authorize(owner, chat_id):
        if (owner, chat_id) not in sessions:
            raise WorkError("not_found", "未找到该会话。", 404)

    files = TenantFiles(HostedWorkConfig(state_dir=str(tmp_path)), authorize)
    orphan = save(files)
    current = save(files, value={**canvas(CHAT_B), "id": "canvas-current"})
    sessions.remove((OWNER_A, CHAT_A))

    def list_for(owner, **extra):
        return files.invoke(owner, "workspace_canvas_list", {"workspaceRoot": "/workspace", **extra})

    assert list_for(OWNER_A, chatId=CHAT_B) == [current]
    assert (files.root(OWNER_A) / "canvases" / f"{CANVAS_ID}.mona-canvas").is_file()
    assert list_for(OWNER_A) == [orphan, current]
    for owner, chat_id in ((OWNER_A, CHAT_A), (OWNER_B, CHAT_B), (OWNER_A, "3" * 32)):
        with pytest.raises(WorkError) as denied:
            list_for(owner, chatId=chat_id)
        assert denied.value.status == 404
    with pytest.raises(WorkError) as denied:
        read(files, OWNER_A, orphan["path"])
    assert denied.value.status == 404
    with pytest.raises(WorkError) as denied:
        read(files, OWNER_B, current["path"])
    assert denied.value.status == 404


def test_version_checks_prevent_lost_updates(files):
    first = save(files)
    updated = save(files, value=canvas(content="# 更新后"), expectedSha256=first["sha256"])
    assert updated["sha256"] != first["sha256"]
    for expected in ({}, {"expectedSha256": first["sha256"]}):
        with pytest.raises(WorkError) as conflict:
            save(files, value=canvas(content="# 不应覆盖"), **expected)
        assert conflict.value.status == 409
    assert read(files, OWNER_A, first["path"]) == updated

    with pytest.raises(WorkError) as conflict:
        files.invoke(OWNER_A, "workspace_canvas_write_file", {
            "path": updated["path"], "canvas": {**canvas(), "id": "canvas-other"},
            "expectedSha256": updated["sha256"],
        })
    assert conflict.value.status == 409
    final = files.invoke(OWNER_A, "workspace_canvas_write_file", {
        "path": updated["path"], "canvas": canvas(content="# 独立编辑"),
        "expectedSha256": updated["sha256"],
    })
    assert files.invoke(OWNER_A, "workspace_canvas_open_file", {"path": final["path"]}) == final


def test_concurrent_edits_cannot_both_replace_the_same_version(files):
    initial = save(files)
    ready = Barrier(2)

    def write(content):
        ready.wait(timeout=5)
        try:
            save(files, value=canvas(content=content), expectedSha256=initial["sha256"])
            return "saved"
        except WorkError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write, ["# 编辑一", "# 编辑二"]))
    assert sorted(results) == ["file_changed", "saved"]
    assert read(files, OWNER_A, initial["path"])["canvas"]["contentMarkdown"] in {"# 编辑一", "# 编辑二"}


@pytest.mark.parametrize("path", ["/etc/passwd", "../x.mona-canvas", "/workspace/../x.mona-canvas",
                                  "/workspace//x.mona-canvas", "/workspace/a/./x.mona-canvas",
                                  "/workspace/a\\x.mona-canvas", "/workspace/a\x00.mona-canvas"])
def test_workspace_paths_cannot_escape(files, path):
    with pytest.raises(WorkError) as denied:
        files.invoke(OWNER_A, "workspace_canvas_open_file", {"path": path})
    assert denied.value.code == "invalid_path"


def test_office_cache_prefix_is_not_a_documents_path(files):
    root = files.root(OWNER_A)
    (root / ".office").mkdir()
    (root / ".office" / "file.mona-canvas").write_text(json.dumps(canvas()), encoding="utf-8")
    for path in ("/workspace/.office", "/workspace/.office/file.mona-canvas",
                 "/workspace/.OFFICE/file.mona-canvas", "/workspace/.office./file.mona-canvas"):
        for command, args in (
            ("workspace_canvas_read", {"workspaceRoot": "/workspace", "path": path}),
            ("workspace_canvas_open_file", {"path": path}),
            ("workspace_canvas_write_file", {"path": path, "canvas": canvas()}),
            ("move_to_trash", {"path": path}),
        ):
            with pytest.raises(WorkError) as denied:
                files.invoke(OWNER_A, command, args)
            assert denied.value.code == "invalid_path"
    assert (root / ".office" / "file.mona-canvas").is_file()


def test_symlinked_files_and_directories_are_rejected(files, tmp_path):
    root = files.root(OWNER_A)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "example.mona-canvas").write_text(json.dumps(canvas()), encoding="utf-8")
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
        (root / "linked.mona-canvas").symlink_to(outside / "example.mona-canvas")
    except OSError:
        pytest.skip("symlink creation is not available in this environment")
    for path in ("/workspace/link/example.mona-canvas", "/workspace/linked.mona-canvas"):
        with pytest.raises(WorkError) as denied:
            files.invoke(OWNER_A, "workspace_canvas_open_file", {"path": path})
        assert denied.value.code == "invalid_path"


def test_hardlinked_files_are_rejected(files, tmp_path):
    root = files.root(OWNER_A)
    other = tmp_path / "outside.mona-canvas"
    other.write_text(json.dumps(canvas()), encoding="utf-8")
    try:
        os.link(other, root / "linked.mona-canvas")
    except OSError:
        pytest.skip("hardlink creation is not available in this environment")
    with pytest.raises(WorkError) as denied:
        files.invoke(OWNER_A, "workspace_canvas_open_file", {"path": "/workspace/linked.mona-canvas"})
    assert denied.value.code == "invalid_path"


def test_trash_move_retains_bytes_and_owner_audit(files):
    item = save(files)
    with pytest.raises(WorkError) as conflict:
        files.invoke(OWNER_A, "move_to_trash", {"path": item["path"], "expectedSha256": "0" * 64})
    assert conflict.value.status == 409
    assert read(files, OWNER_A, item["path"]) == item
    assert files.invoke(OWNER_A, "move_to_trash", {"path": item["path"], "expectedSha256": item["sha256"]}) is None
    with pytest.raises(WorkError) as missing:
        read(files, OWNER_A, item["path"])
    assert missing.value.status == 404
    trash = files.root(OWNER_A).parent / "trash"
    slots = list(trash.iterdir())
    assert len(slots) == 1
    metadata = json.loads((slots[0] / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["owner"] == OWNER_A
    assert metadata["path"] == item["path"]
    assert metadata["sha256"] == item["sha256"]
    assert hashlib.sha256((slots[0] / "file").read_bytes()).hexdigest() == item["sha256"]
    assert not (files.root(OWNER_B).parent / "trash").exists()


def test_invalid_owner_workspace_command_and_canvas_are_rejected(files):
    for operation in (
        lambda: files.root("a" * 63),
        lambda: files.invoke(OWNER_A, "delete_everything", {}),
        lambda: files.invoke(OWNER_A, [], {}),
        lambda: files.invoke(OWNER_A, "workspace_canvas_list", {"workspaceRoot": "/"}),
        lambda: files.invoke(OWNER_A, "workspace_canvas_list", {"workspaceRoot": [], "chatId": CHAT_A}),
        lambda: files.invoke(OWNER_A, "workspace_canvas_list", {"workspaceRoot": "/workspace", "user_id": OWNER_B}),
        lambda: save(files, value={**canvas(), "id": "../../other"}),
        lambda: save(files, value={**canvas(), "version": True}),
        lambda: save(files, value={**canvas(), "kind": []}),
        lambda: save(files, value=canvas(content="x" * (2 * 1024 * 1024))),
    ):
        with pytest.raises(WorkError):
            operation()
