"""Portable Work-sync behavior using only temporary histories and files."""
import copy
import hashlib
import json
import os
from pathlib import Path

import pytest

from mona.agent.partners import ConversationMetadata
from mona.cloud.work_files import WorkFileError, materialize_work_file, portable_path
from mona.cloud.work_snapshot import (
    WorkSnapshotError,
    export_work_snapshot,
    is_work_session,
    prepare_work_restore,
    validate_work_snapshot,
)
from mona.session.manager import Session, SessionManager

VAULT, RESOURCE = "a" * 32, "b" * 32
KEY = "websocket:work-sync-test"


@pytest.fixture
def work(tmp_path):
    workspace = tmp_path / "workspace"
    media = tmp_path / "media" / "websocket"
    media.mkdir(parents=True)
    manager = SessionManager(workspace)
    transcript = tmp_path / "webui" / "work.jsonl"
    transcript.parent.mkdir()
    session = Session(key=KEY, metadata={"title": "同步方案", "webui": True,
        "conversation": ConversationMetadata.direct("mona").to_session_metadata(),
        "_last_summary": "已完成资料整理", "task_plan": {"task_id": "old-task", "source": "ai",
            "steps": [{"step": "检查资料", "status": "completed"}]}})
    session.add_message("user", "原始目标不能丢失")
    session.add_message("assistant", "已经完成第一部分")
    manager.save(session)
    transcript.write_text(json.dumps({"event": "user", "content": "更早的完整原文", "chat_id": "work-sync-test"}) + "\n", encoding="utf-8")
    return manager, session, transcript, media


def export(work):
    manager, session, transcript, media = work
    return export_work_snapshot(manager, session.key, vault_id=VAULT, resource_id=RESOURCE,
                                transcript_path=transcript, media_root=media)


def append_event(transcript, value):
    with transcript.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")


def artifact_event(relative, **changes):
    ref = {"owner_kind": "agent", "owner_id": "mona", "session_id": KEY,
           "relative_path": relative, "created_by_agent_id": "mona", **changes}
    return {"event": "deliver_files", "files": [{"artifact_ref": ref}]}


def test_export_preserves_raw_history_summary_plan_and_display_without_runtime_state(work):
    manager, session, _, _ = work
    session.metadata.update(pending_command={"command": "never replay"},
        terminal_session_id="remote-ssh", active_model={"api_key": "private-synthetic-value"})
    session.last_consolidated = 1
    manager.save(session)
    result = export(work)
    assert result.snapshot["messages"][0]["content"] == "原始目标不能丢失"
    assert result.snapshot["display"][0]["content"] == "更早的完整原文"
    assert result.snapshot["metadata"]["_last_summary"] == "已完成资料整理"
    assert result.snapshot["metadata"]["task_plan"]["steps"][0]["status"] == "completed"
    assert result.snapshot["last_consolidated"] == 1
    assert result.snapshot["runtime_migrated"] is False
    assert "private-synthetic-value" not in result.bytes().decode()
    assert "pending_command" not in result.snapshot["metadata"]
    assert export(work).sha256 == result.sha256


@pytest.mark.parametrize("key,metadata", [
    ("development:dev_123", {}), ("cli:main", {}), ("websocket:../outside", {}),
    ("websocket:normal", {"mode": "code"}), ("websocket:normal", {"mode": ["code"]}),
    ("websocket:normal", {"hidden": True}),
    ("websocket:normal", {"native_session_id": "cli-thread"}),
    ("websocket:normal", {"conversation": {"type": "unknown"}}),
    ("websocket:normal", {"conversation": ConversationMetadata.room(["mona"], hidden=True).to_session_metadata()}),
])
def test_non_work_sessions_never_qualify(key, metadata):
    assert is_work_session(key, metadata) is False


def test_code_key_is_rejected_before_file_read(work):
    manager, _, transcript, media = work
    with pytest.raises(WorkSnapshotError) as caught:
        export_work_snapshot(manager, "development:no-file", vault_id=VAULT, resource_id=RESOURCE,
            transcript_path=transcript, media_root=media)
    assert caught.value.code == "not_work_session"


def test_only_explicit_user_and_delivery_files_are_collected(work):
    manager, session, transcript, media = work
    attachment = media / "source.txt"
    attachment.write_text("source body", encoding="utf-8")
    output = manager.workspace / "agent-workspaces" / "mona" / "output"
    output.mkdir(parents=True)
    (output / "result.md").write_text("result body", encoding="utf-8")
    (output / "unrelated.md").write_text("do not upload", encoding="utf-8")
    session.add_message("user", f"本文提到 {output / 'unrelated.md'} 不构成上传授权", media=[str(attachment)])
    manager.save(session)
    append_event(transcript, artifact_event("result.md"))
    result = export(work)
    assert {item["name"] for item in result.snapshot["files"]} == {"source.txt", "result.md"}
    assert b"".join(result.sources[0].chunks(3)) == b"source body"
    assert len(result.snapshot["files"]) == 2


def test_successful_file_edit_included_failed_edit_excluded(work):
    manager, _, transcript, _ = work
    output = manager.workspace / "agent-workspaces" / "mona" / "output"
    output.mkdir(parents=True)
    (output / "working.py").write_text("print('ok')", encoding="utf-8")
    good = artifact_event("working.py")["files"][0]
    append_event(transcript, {"event": "file_edit", "edits": [{**good, "status": "done"},
        {"status": "error", "path": "missing.py"}]})
    result = export(work)
    assert [item["name"] for item in result.snapshot["files"]] == ["working.py"]


def test_other_agent_and_other_session_references_do_not_upload(work):
    _, _, transcript, _ = work
    append_event(transcript, artifact_event("private.md", owner_id="another-agent"))
    append_event(transcript, artifact_event("private.md", session_id="websocket:other"))
    result = export(work)
    assert result.snapshot["files"] == []
    assert {item["reason"] for item in result.snapshot["unavailable_files"]} == {"foreign_owner"}


def test_work_history_bound_to_external_project_does_not_upload_project_files(work, tmp_path):
    manager, session, transcript, _ = work
    project = tmp_path / "code-project"
    project.mkdir()
    private = project / "result.md"
    private.write_text("project source", encoding="utf-8")
    session.metadata["workspace"] = str(project)
    session.add_message("user", "历史保留，项目不上传", media=[str(private)])
    manager.save(session)
    append_event(transcript, artifact_event("result.md"))
    result = export(work)
    assert result.snapshot["messages"][-1]["content"] == "历史保留，项目不上传"
    assert result.snapshot["files"] == []
    assert "workspace" not in result.snapshot["metadata"]
    assert result.snapshot["unavailable_files"]


@pytest.mark.parametrize("name", [".env", ".env.production", "id_rsa", "key.pem", "credentials.json"])
def test_credential_files_are_not_uploaded_even_when_referenced(work, name):
    manager, session, _, media = work
    secret = media / name
    secret.write_text("SYNTHETIC_CREDENTIAL", encoding="utf-8")
    session.add_message("user", "检查附件", media=[str(secret)])
    manager.save(session)
    result = export(work)
    assert not result.sources
    assert result.snapshot["unavailable_files"][0]["reason"] == "excluded_file"


def test_file_changes_after_snapshot_are_detected(work):
    manager, session, _, media = work
    file = media / "data.csv"
    file.write_text("a,b", encoding="utf-8")
    session.add_message("user", "read", media=[str(file)])
    manager.save(session)
    source = export(work).sources[0]
    file.write_text("a,b,c", encoding="utf-8")
    with pytest.raises(WorkFileError) as caught:
        list(source.chunks())
    assert caught.value.code == "file_changed"


def test_missing_file_is_reported_instead_of_an_empty_success(work):
    manager, session, _, media = work
    session.add_message("user", "read", media=[str(media / "absent.txt")])
    manager.save(session)
    result = export(work)
    assert not result.sources
    assert result.snapshot["unavailable_files"] == [
        {"name": "absent.txt", "reason": "missing", "source_path": str(media / "absent.txt")}
    ]


def test_corrupt_or_partially_written_display_does_not_silently_drop_history(work):
    _, _, transcript, _ = work
    with transcript.open("ab") as handle:
        handle.write(b'{"event":"message","content":')
    with pytest.raises(WorkSnapshotError):
        export(work)


def test_duplicate_json_keys_are_rejected(work):
    _, _, transcript, _ = work
    transcript.write_text('{"event":"user","event":"message"}\n', encoding="utf-8")
    with pytest.raises(WorkSnapshotError):
        export(work)


def test_snapshot_is_stable_copy_and_mutation_is_detected(work):
    result = export(work)
    result.snapshot["messages"][0]["content"] = "mutated"
    with pytest.raises(WorkSnapshotError):
        result.bytes()


@pytest.mark.parametrize("field,value", [("mode", "code"), ("vault_id", "c" * 32),
                                        ("runtime_migrated", True), ("resource_id", "c" * 32)])
def test_restore_rejects_scope_and_identity_changes(work, field, value):
    snapshot = copy.deepcopy(export(work).snapshot)
    snapshot[field] = value
    with pytest.raises(WorkSnapshotError):
        prepare_work_restore(snapshot, vault_id=VAULT, resource_id=RESOURCE,
                             workspace=Path("unused"), media_root=Path("unused"))


def test_restore_does_not_reactivate_pending_input_workflow_or_host_authority(work, tmp_path):
    manager, session, _, media = work
    session.metadata.update(pending_inputs=[{"content": "delete"}], terminal_session_id="ssh", permissions="all")
    session.add_message("user", "not submitted", _ui_only=True)
    session.add_message("user", "old command", _command=True)
    session.add_message("assistant", "", tool_calls=[{"id": "call_pending", "type": "function", "function": {"name": "exec", "arguments": "{}"}}])
    manager.save(session)
    snapshot = export(work).snapshot
    restored = prepare_work_restore(snapshot, vault_id=VAULT, resource_id=RESOURCE,
                                    workspace=tmp_path / "new", media_root=media)
    assert restored.session.key != KEY
    assert "pending_inputs" not in restored.session.metadata
    assert "terminal_session_id" not in restored.session.metadata
    assert "permissions" not in restored.session.metadata
    assert "task_id" not in restored.session.metadata["task_plan"]
    assert all(m.get("content") not in ["not submitted", "old command"] for m in restored.session.messages)
    assert restored.session.messages[-1]["cloud_result_unknown"] is True
    assert "本机未执行" in restored.session.messages[-1]["content"]
    assert snapshot["messages"][-3]["content"] == "not submitted"
    assert not (tmp_path / "new").exists()  # Preparing history has no filesystem writes.


def test_restored_attachment_paths_use_this_device_roots_and_verify_bytes(work, tmp_path):
    manager, session, _, media = work
    file = media / "报告.txt"
    file.write_text("中文内容", encoding="utf-8")
    session.add_message("user", "read", media=[str(file)])
    manager.save(session)
    snapshot = export(work)
    destination = tmp_path / "new-workspace"
    destination.mkdir()
    new_media = tmp_path / "new-media"
    new_media.mkdir()
    restored = prepare_work_restore(snapshot.snapshot, vault_id=VAULT, resource_id=RESOURCE,
                                    workspace=destination, media_root=new_media)
    descriptor = snapshot.snapshot["files"][0]
    path = materialize_work_file(descriptor, snapshot.sources[0].chunks(), workspace=destination,
                                 media_root=new_media, vault_id=VAULT)
    assert path.is_relative_to(new_media) and path.read_text(encoding="utf-8") == "中文内容"
    assert restored.session.messages[-1]["media"] == [str(path)]
    assert materialize_work_file(descriptor, snapshot.sources[0].chunks(), workspace=destination,
                                 media_root=new_media, vault_id=VAULT) == path


def test_bad_download_never_publishes_partial_file(work, tmp_path):
    manager, session, _, media = work
    file = media / "x.txt"
    file.write_bytes(b"correct")
    session.add_message("user", "read", media=[str(file)])
    manager.save(session)
    descriptor = export(work).snapshot["files"][0]
    root = tmp_path / "restored"
    root.mkdir()
    with pytest.raises(WorkFileError):
        materialize_work_file(descriptor, [b"wrong!!"], workspace=root, media_root=root, vault_id=VAULT)
    assert not list(root.rglob("x.txt")) and not list(root.rglob(".sync-*"))


def test_local_changed_version_is_never_overwritten(work, tmp_path):
    manager, session, _, media = work
    file = media / "x.txt"
    file.write_bytes(b"original")
    session.add_message("user", "read", media=[str(file)])
    manager.save(session)
    exported = export(work)
    descriptor = exported.snapshot["files"][0]
    root = tmp_path / "restored"
    root.mkdir()
    path = materialize_work_file(descriptor, exported.sources[0].chunks(), workspace=root, media_root=root, vault_id=VAULT)
    path.write_bytes(b"my local edits")
    with pytest.raises(WorkFileError):
        materialize_work_file(descriptor, exported.sources[0].chunks(), workspace=root, media_root=root, vault_id=VAULT)
    assert path.read_bytes() == b"my local edits"


@pytest.mark.parametrize("path", ["../outside", "/absolute", "C:/x", "\\\\server\\x", "x:ads", "CON.txt", "a/../b", "a//b", "trailing. "])
def test_cross_platform_path_tricks_rejected(path):
    with pytest.raises(WorkFileError):
        portable_path(path)


def test_hardlinks_are_not_used_to_import_external_files(work, tmp_path):
    manager, session, _, media = work
    external = tmp_path / "private.txt"
    external.write_text("do not sync", encoding="utf-8")
    linked = media / "linked.txt"
    os.link(external, linked)
    session.add_message("user", "read", media=[str(linked)])
    manager.save(session)
    result = export(work)
    assert not result.sources
    assert result.snapshot["unavailable_files"][0]["reason"] == "linked_path"


def test_symlink_escape_is_not_followed(work, tmp_path):
    manager, session, _, media = work
    external = tmp_path / "private.txt"
    external.write_text("do not sync", encoding="utf-8")
    linked = media / "linked.txt"
    try:
        linked.symlink_to(external)
    except OSError:
        pytest.skip("Current Windows account cannot create symlinks")
    session.add_message("user", "read", media=[str(linked)])
    manager.save(session)
    result = export(work)
    assert not result.sources
    assert result.snapshot["unavailable_files"][0]["reason"] == "linked_path"


def test_empty_files_are_valid_files_not_missing(work):
    manager, session, _, media = work
    file = media / "empty.txt"
    file.write_bytes(b"")
    session.add_message("user", "read", media=[str(file)])
    manager.save(session)
    result = export(work)
    assert result.snapshot["files"][0]["sha256"] == hashlib.sha256(b"").hexdigest()
    assert result.snapshot["files"][0]["size"] == 0


def test_delivery_restores_to_correct_owner_path_and_roundtrips_file_identity(work, tmp_path):
    manager, _, transcript, _ = work
    output = manager.workspace / "agent-workspaces" / "mona" / "output"
    output.mkdir(parents=True)
    (output / "report.md").write_text("final report", encoding="utf-8")
    append_event(transcript, artifact_event("report.md"))
    original = export(work)
    new_root = tmp_path / "device-b"
    new_root.mkdir()
    new_media = tmp_path / "device-b-media"
    new_media.mkdir()
    restored = prepare_work_restore(original.snapshot, vault_id=VAULT, resource_id=RESOURCE,
        workspace=new_root, media_root=new_media)
    descriptor = original.snapshot["files"][0]
    materialized = materialize_work_file(descriptor, original.sources[0].chunks(),
        workspace=new_root, media_root=new_media, vault_id=VAULT)
    item = restored.display[-1]["files"][0]
    assert item["artifact_ref"]["session_id"] == restored.session.key
    new_output = new_root / "agent-workspaces" / "mona" / "output"
    assert new_output / item["artifact_ref"]["relative_path"] == materialized
    assert Path(item["absolute_path"]) == materialized
    new_manager = SessionManager(new_root)
    new_manager.save(restored.session)
    new_transcript = tmp_path / "b-display.jsonl"
    new_transcript.write_text("".join(json.dumps(r) + "\n" for r in restored.display), encoding="utf-8")
    again = export_work_snapshot(new_manager, restored.session.key, vault_id=VAULT, resource_id=RESOURCE,
        transcript_path=new_transcript, media_root=new_media)
    assert again.snapshot["files"][0]["id"] == descriptor["id"]
    assert again.snapshot["files"][0]["sha256"] == descriptor["sha256"]
    assert again.snapshot["files"][0]["relative_path"] == "report.md"
    device_c = prepare_work_restore(again.snapshot, vault_id=VAULT, resource_id=RESOURCE,
        workspace=tmp_path / "device-c", media_root=tmp_path / "device-c-media")
    assert not device_c.display[-1]["files"][0].get("missing")
    assert device_c.display[-1]["files"][0]["artifact_ref"]["session_id"] == device_c.session.key


def test_unmapped_media_never_becomes_a_path_to_read_on_new_device(work, tmp_path):
    manager, session, transcript, media = work
    source_path = str(media / "never-uploaded.txt")
    session.add_message("user", "input", media=[source_path])
    manager.save(session)
    append_event(transcript, {"event": "user", "media_paths": [source_path]})
    restored = prepare_work_restore(export(work).snapshot, vault_id=VAULT, resource_id=RESOURCE,
        workspace=tmp_path / "another", media_root=tmp_path / "another-media")
    assert restored.session.messages[-1]["media"] == []
    assert restored.session.messages[-1]["cloud_unavailable_media"] == ["never-uploaded.txt"]
    assert restored.display[-1]["media_paths"] == []
    assert restored.display[-1]["cloud_unavailable_media"] == ["never-uploaded.txt"]


def test_missing_tool_result_is_closed_before_next_user_turn_not_after_it(work, tmp_path):
    manager, session, _, _ = work
    session.add_message("assistant", "", tool_calls=[{"id": "pending", "type": "function",
        "function": {"name": "exec", "arguments": "{}"}}])
    session.add_message("user", "new request")
    manager.save(session)
    restored = prepare_work_restore(export(work).snapshot, vault_id=VAULT, resource_id=RESOURCE,
        workspace=tmp_path / "another", media_root=tmp_path / "another-media")
    assert restored.session.messages[-1]["content"] == "new request"
    assert restored.session.messages[-2]["tool_call_id"] == "pending"
    assert restored.session.messages[-2]["cloud_result_unknown"] is True


def test_structured_credentials_are_excluded_but_user_text_is_preserved(work):
    manager, session, transcript, _ = work
    session.add_message("user", "literal user text", api_key="SYNTHETIC_PRIVATE_VALUE")
    manager.save(session)
    append_event(transcript, {"event": "message", "authorization": "SYNTHETIC_PRIVATE_VALUE",
        "content": "literal result text"})
    data = export(work).bytes().decode("utf-8")
    assert "SYNTHETIC_PRIVATE_VALUE" not in data
    assert "literal user text" in data and "literal result text" in data


def test_new_message_without_downloaded_files_preserves_cloud_references(work, tmp_path):
    manager, session, _, media = work
    attachment = media / "old-data.csv"
    attachment.write_bytes(b"data")
    session.add_message("user", "attached", media=[str(attachment)])
    manager.save(session)
    snapshot = export(work).snapshot
    new_workspace = tmp_path / "b-workspace"
    new_workspace.mkdir()
    new_media = tmp_path / "b-media"
    new_media.mkdir()
    restored = prepare_work_restore(snapshot, vault_id=VAULT, resource_id=RESOURCE,
        workspace=new_workspace, media_root=new_media)
    restored.session.add_message("user", "继续讨论，不读取附件")
    new_manager = SessionManager(new_workspace)
    new_manager.save(restored.session)
    display_path = tmp_path / "b-history.jsonl"
    display_path.write_text("".join(json.dumps(record) + "\n" for record in restored.display), encoding="utf-8")
    again = export_work_snapshot(new_manager, restored.session.key, vault_id=VAULT, resource_id=RESOURCE,
        transcript_path=display_path, media_root=new_media)
    assert not again.sources
    assert again.snapshot["files"][0]["id"] == snapshot["files"][0]["id"]
    assert again.snapshot["files"][0]["sha256"] == snapshot["files"][0]["sha256"]
    assert again.snapshot["files"][0]["availability"] == "cloud"
    assert not list(new_media.rglob("old-data.csv"))


def test_malformed_nested_scope_and_file_identity_fail_cleanly(work):
    snapshot = export(work).snapshot
    snapshot["files"] = [{"id": ["bad"]}]
    with pytest.raises(WorkSnapshotError):
        validate_work_snapshot(snapshot)
