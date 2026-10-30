"""No network, Docker, or real provider calls. Test durable boundaries and sandbox policy construction."""
import io
import json
import zipfile

import pytest
from pydantic import ValidationError

from mona.config.schema import Config, HostedWorkConfig
from mona.hosted_work import sandbox_files
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.public_web import public_address, validate_public_url
from mona.hosted_work.sandbox import SandboxError, create_arguments, verify_inspection
from mona.hosted_work.store import WorkStore

OWNER = owner_key("1")
OTHER = owner_key("2")
SID = "a" * 32
RID = "b" * 32


@pytest.fixture
def store(tmp_path):
    value = WorkStore(tmp_path / "online.sqlite3", HostedWorkConfig())
    yield value
    value.close()


def session(store, owner=OWNER):
    return store.create_session(owner, NewSession(request_id=SID))


def turn(**kwargs):
    return NewTurn(request_id=RID, model_id="official", text="整理上传的资料", **kwargs)


def test_desktop_defaults_do_not_enable_online_service():
    assert "hosted_work" not in Config.model_fields
    assert HostedWorkConfig().enabled is False
    with pytest.raises(ValidationError):
        NewTurn(request_id=RID, model_id="official", text="hello", api_base="http://internal")
    with pytest.raises(ValidationError):
        NewTurn(request_id=RID, model_id="official", text="hello", user_id="other")


def test_owner_and_model_identifiers_are_not_user_paths():
    assert OWNER != OTHER and len(OWNER) == 64
    for invalid in ("../test", None, "0", "-1", "１２"):
        with pytest.raises(WorkError):
            owner_key(invalid)
    with pytest.raises(ValidationError):
        HostedWorkConfig(models={"../key": {"label": "bad", "model": "x"}})


def test_sessions_are_owned_and_creation_is_idempotent(store):
    created = session(store)
    assert session(store) == created
    assert store.list_sessions(OTHER) == []
    with pytest.raises(WorkError) as exc:
        store.session(OTHER, SID)
    assert exc.value.status == 404
    with pytest.raises(WorkError):
        store.create_session(OWNER, NewSession(request_id=SID, title="changed"))


def test_lost_submit_response_reuses_exact_run_without_resending(store):
    session(store)
    first, created = store.create_run(OWNER, SID, turn())
    second, repeated = store.create_run(OWNER, SID, turn())
    assert created is True and repeated is False and first == second
    history = json.loads(store.session(OWNER, SID)["history"])
    assert len(history) == 1
    with pytest.raises(WorkError):
        store.create_run(OWNER, SID, turn().model_copy(update={"text": "different"}))


def test_concurrent_user_run_and_global_capacity_are_enforced(store):
    session(store)
    store.create_run(OWNER, SID, turn())
    with pytest.raises(WorkError):
        store.create_run(OWNER, SID, turn().model_copy(update={"request_id": "c" * 32}))
    session(store, OTHER)
    store.create_run(OTHER, SID, turn())
    third = owner_key("3")
    session(store, third)
    with pytest.raises(WorkError) as exc:
        store.create_run(third, SID, turn())
    assert exc.value.code == "capacity"


def test_restart_marks_unknown_and_does_not_requeue(store):
    session(store)
    store.create_run(OWNER, SID, turn())
    assert store.recover() == 1
    assert store.run(OWNER, RID)["status"] == "unknown"
    assert store.create_run(OWNER, SID, turn())[1] is False
    with pytest.raises(WorkError):
        store.require_idle(OWNER)


def test_events_are_bounded_owned_and_paginated(store):
    session(store)
    store.create_run(OWNER, SID, turn())
    for index in range(130):
        store.event(OWNER, RID, "delta", {"text": str(index)})
    first = store.events(OWNER, RID, 0)
    assert first["has_more"] and len(first["events"]) == 128
    assert len(store.events(OWNER, RID, 128)["events"]) == 2
    with pytest.raises(WorkError):
        store.events(OTHER, RID, 0)
    with pytest.raises(WorkError):
        store.event(OWNER, RID, "delta", {"text": "x" * store.config.max_history_bytes})


def test_files_cannot_cross_user_or_conversation(store):
    session(store)
    session(store, OTHER)
    fid = "d" * 32
    info = {"path": "uploads/report.txt", "name": "report.txt", "size": 3, "sha256": "e" * 64}
    assert "path" not in store.add_file(OWNER, SID, fid, info)
    with pytest.raises(WorkError):
        store.create_run(OTHER, SID, turn(attachment_ids=[fid]))
    with pytest.raises(WorkError):
        store.add_file(OWNER, SID, fid, {**info, "sha256": "f" * 64})


def test_stop_preserves_checkpoint_and_is_not_success(store):
    session(store)
    store.create_run(OWNER, SID, turn())
    store.save_checkpoint(OWNER, RID, {"phase": "tools_started", "started_tool_call_ids": ["call1"]})
    store.cancelling(OWNER, RID)
    store.finish(OWNER, RID, "cancelled", {"workspace_saved": True})
    assert store.run(OWNER, RID)["status"] == "cancelled"
    assert "call1" in store.session(OWNER, SID)["history"]


def test_sandbox_arguments_are_fail_closed_and_contain_no_host_mounts():
    config = HostedWorkConfig(sandbox_image="mona-work@sha256:" + "c" * 64)
    args = create_arguments(config, OWNER, RID)
    for expected in ("--network=none", "--runtime=runsc", "--read-only", "--user=1000:1000", "--cap-drop=ALL"):
        assert expected in args
    assert not any(value in args for value in ("--privileged", "--volume", "--mount", "--network=host"))
    with pytest.raises(SandboxError):
        create_arguments(HostedWorkConfig(sandbox_image="python:latest"), OWNER, RID)
    with pytest.raises(SandboxError):
        verify_inspection({"HostConfig": {"NetworkMode": "host"}, "Config": {}}, OWNER, config)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "172.31.3.176", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "224.0.0.1"])
def test_private_and_special_network_addresses_are_denied(address):
    assert not public_address(address)
    host = "[" + address + "]" if ":" in address else address
    with pytest.raises(WorkError):
        validate_public_url("http://" + host)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "https://user:pass@example.com", "http://example.com:22", "http://localhost", "http://x.local", "https://good.com\\@127.0.0.1"])
def test_non_public_http_requests_are_rejected(url):
    with pytest.raises(WorkError):
        validate_public_url(url)


def test_public_urls_are_not_mistaken_for_private_addresses():
    assert public_address("8.8.8.8")
    assert validate_public_url("https://example.com/document")


def test_file_helper_preserves_versions_and_rejects_escape(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox_files, "ROOT", tmp_path)
    first = sandbox_files.operate({"action": "write", "path": "report.txt", "content": "v1"}, 4096)
    with pytest.raises(ValueError):
        sandbox_files.operate({"action": "write", "path": "report.txt", "content": "v2"}, 4096)
    second = sandbox_files.operate({"action": "write", "path": "report.txt", "content": "v2",
                                   "expected_sha256": first["sha256"]}, 4096)
    assert first["sha256"] != second["sha256"]
    for path in ("../secret", "/etc/passwd", "C:\\secret"):
        with pytest.raises(ValueError):
            sandbox_files.resolve(path)


def test_snapshot_restore_refuses_traversal_without_writing_host_data(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox_files, "ROOT", tmp_path)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("../escape.txt", "bad")
    with pytest.raises(ValueError):
        sandbox_files.restore_snapshot(stream.getvalue(), 4096)
    assert not (tmp_path.parent / "escape.txt").exists()


def test_workspace_roundtrip_is_bounded_and_keeps_empty_folders(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox_files, "ROOT", tmp_path)
    # Never execute sandbox process cleanup against the test host's /proc.
    monkeypatch.setattr(sandbox_files, "quiesce", lambda: None)
    (tmp_path / "empty").mkdir()
    (tmp_path / "note.txt").write_text("content", encoding="utf-8")
    data = sandbox_files.export_snapshot(4096)
    restored = tmp_path / "restore"
    restored.mkdir()
    monkeypatch.setattr(sandbox_files, "ROOT", restored)
    sandbox_files.restore_snapshot(data, 4096)
    assert (restored / "empty").is_dir()
    assert (restored / "note.txt").read_text(encoding="utf-8") == "content"
