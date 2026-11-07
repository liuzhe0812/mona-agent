"""Question previews are isolated temporary references, not deliverables."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import sqlite3
import stat
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.previews import QuestionPreviews
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles

ALICE, BOB = owner_key("101"), owner_key("102")
SID, OTHER_SID, RID = "a" * 32, "b" * 32, "c" * 32
OPERATION = "d" * 32


def image(kind: str) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (3, 2), (40, 120, 80)).save(buffer, format=kind)
    return buffer.getvalue()


def item(name: str, mime: str, data: bytes) -> dict:
    return {"name": name, "mime": mime, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "data": base64.b64encode(data).decode()}


@pytest.fixture
def prepared(tmp_path):
    root = tmp_path / "state"
    if os.name == "nt":
        root = Path("\\\\?\\" + str(root))
    root.mkdir()
    config = HostedWorkConfig(state_dir=str(root), models={"qwen": {"label": "Qwen", "model": "fixture"}})
    store = WorkStore(root / "sessions.sqlite3", config)
    store.create_session(ALICE, NewSession(request_id=SID))
    store.create_session(ALICE, NewSession(request_id=OTHER_SID))
    store.create_session(BOB, NewSession(request_id=SID))
    store.create_run(ALICE, SID, NewTurn(request_id=RID, model_id="qwen", text="fixture"))
    files = TenantFiles(config, store.session)
    state = DesktopStore(SimpleNamespace(config=config, store=store), files)
    previews = QuestionPreviews(config, state, files)
    try:
        yield previews, state, files, store
    finally:
        state.close()
        store.close()


def assert_raises_code(call, code, status=None):
    with pytest.raises(WorkError) as error:
        call()
    assert error.value.code == code
    if status is not None:
        assert error.value.status == status


def test_prepare_images_reuse_private_owner_storage_and_remain_readable_after_finish(prepared):
    previews, state, files, store = prepared
    raws = [image("PNG"), image("JPEG"), image("WEBP")]
    items = [item("one.png", "image/png", raws[0]), item("two.jpg", "image/jpeg", raws[1]),
             item("three.webp", "image/webp", raws[2])]
    records = previews.prepare(ALICE, SID, RID, "ask-1", items)
    assert len(records) == 3
    for row, raw, ext in zip(records, raws, ("png", "jpg", "webp")):
        digest = hashlib.sha256(raw).hexdigest()
        assert row["path"] == row["absolute_path"] == f"/workspace/.question-previews/{RID}/{digest}.{ext}"
        assert row["size"] == len(raw) and row["sha256"] == digest
        assert previews.handles(row["path"]) and previews.handles(row["path"].removeprefix("/workspace/"))
        assert previews.read(ALICE, SID, row["path"]) == (row["name"], raw)
        on_disk = files._home(ALICE) / "previews" / SID / RID / f"{digest}.{ext}"
        assert on_disk.read_bytes() == raw
        if os.name != "nt":
            assert stat.S_IMODE(on_disk.stat().st_mode) == 0o600
            assert all(stat.S_IMODE(directory.stat().st_mode) == 0o700 for directory in
                       (on_disk.parent, on_disk.parent.parent, on_disk.parent.parent.parent))
    assert not (files.root(ALICE) / ".question-previews").exists()
    assert state.get(ALICE, "artifact_index:" + SID, []) == [] and store.files(ALICE, SID) == []
    metadata = [row["data"] for row in state.db(ALICE).execute("SELECT data FROM metadata")]
    assert all(value["data"] not in "".join(metadata) for value in items)
    store.finish(ALICE, RID, "completed", {})
    assert previews.read(ALICE, SID, records[0]["path"]) == ("one.png", raws[0])
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", items), "execution_stopped", 409)


def test_generated_previews_use_file_limit_and_are_owned_by_session_and_run(prepared):
    previews, _, files, store = prepared
    previews.config = previews.config.model_copy(update={"max_history_bytes": 65536, "max_file_bytes": 262144})
    pixels = random.Random(7).randbytes(200 * 200 * 3)
    buffer = BytesIO()
    Image.frombytes("RGB", (200, 200), pixels).save(buffer, format="PNG")
    raw = buffer.getvalue()
    assert 65536 < len(raw) < previews.config.max_file_bytes
    data = item("generated.png", "image/png", raw)
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [data]), "file_limit", 413)
    records = previews.prepare_generated(ALICE, SID, RID, OPERATION, [data])
    row = records[0]
    assert row["path"] == f"/workspace/.generated-previews/{RID}/{OPERATION}/{data['sha256']}.png"
    assert previews.generated(row["path"]) and previews.handles(row["path"])
    assert previews.read(ALICE, SID, row["path"]) == (f"image-{OPERATION}.png", raw)
    assert previews.prepare_generated(ALICE, SID, RID, OPERATION, [data]) == records
    assert_raises_code(lambda: previews.prepare_generated(ALICE, SID, RID, OPERATION, [{**data, "name": "other.png"}]),
                       "request_conflict", 409)
    assert_raises_code(lambda: previews.read(BOB, SID, row["path"]), "not_found", 404)
    assert_raises_code(lambda: previews.read(ALICE, OTHER_SID, row["path"]), "not_found", 404)
    assert_raises_code(lambda: previews.read(ALICE, SID, f"/workspace/.generated-previews/{RID}/../../other.png"),
                       "not_found", 404)
    assert (files._home(ALICE) / "previews" / SID / RID / "generated" / OPERATION / (data["sha256"] + ".png")).is_file()
    store.finish(ALICE, RID, "completed", {})
    assert previews.read(ALICE, SID, row["path"]) == (f"image-{OPERATION}.png", raw)


def test_identical_images_from_distinct_operations_remain_distinct_and_retry_is_idempotent(prepared):
    previews, state, _, _ = prepared
    raw = image("PNG")
    data = item("same.png", "image/png", raw)
    first = previews.prepare_generated(ALICE, SID, RID, OPERATION, [data])[0]
    second_op = "e" * 32
    second = previews.prepare_generated(ALICE, SID, RID, second_op, [data])[0]
    assert first["sha256"] == second["sha256"]
    assert first["path"] != second["path"] and first["name"] != second["name"]
    assert previews.read(ALICE, SID, first["path"]) == (first["name"], raw)
    assert previews.read(ALICE, SID, second["path"]) == (second["name"], raw)
    assert previews.prepare_generated(ALICE, SID, RID, OPERATION, [data]) == [first]
    assert previews.prepare_generated(ALICE, SID, RID, second_op, [data]) == [second]
    assert state.get(ALICE, previews._file_key(SID, RID, data["sha256"], "png", generated=True,
                                              operation=OPERATION))["path"] == first["path"]
    assert state.get(ALICE, previews._file_key(SID, RID, data["sha256"], "png", generated=True,
                                              operation=second_op))["path"] == second["path"]


def test_legacy_generated_preview_remains_readable_and_idempotent(prepared):
    previews, state, _, _ = prepared
    raw = image("PNG")
    data = item("legacy.png", "image/png", raw)
    logical = f"/workspace/.generated-previews/{RID}/{data['sha256']}.png"
    directory = previews._directory(ALICE, SID, RID, create=True, generated=True)
    previews._write_once(directory, data["sha256"] + ".png", raw, data["sha256"], data["mime"])
    stored = {key: value for key, value in data.items() if key != "data"}
    state.set(ALICE, previews._file_key(SID, RID, data["sha256"], "png", generated=True), {"path": logical, **stored})
    fingerprint = hashlib.sha256(json.dumps([stored], ensure_ascii=False, sort_keys=True,
                                            separators=(",", ":")).encode()).hexdigest()
    record = {"path": logical, "absolute_path": logical, **stored, "size_human": f"{len(raw)} B"}
    state.set(ALICE, previews._request_key(SID, RID, OPERATION, generated=True),
              {"fingerprint": fingerprint, "files": [record]})
    assert previews.read(ALICE, SID, logical) == ("legacy.png", raw)
    assert previews.prepare_generated(ALICE, SID, RID, OPERATION, [data]) == [record]


@pytest.mark.parametrize("change", ["path", "size", "digest", "mime"])
def test_generated_preview_rejects_untrusted_metadata_before_staging(prepared, change):
    previews, _, files, _ = prepared
    data = item("generated.png", "image/png", image("PNG"))
    if change == "path":
        data["name"] = "../generated.png"
    elif change == "size":
        data["size"] += 1
    elif change == "digest":
        data["sha256"] = "0" * 64
    else:
        data["mime"] = "image/jpeg"
    assert_raises_code(lambda: previews.prepare_generated(ALICE, SID, RID, OPERATION, [data]), "invalid_preview", 400)
    assert not (files._home(ALICE) / "previews").exists()


def test_same_ask_id_is_idempotent_and_different_content_does_not_overwrite(prepared):
    previews, _, files, _ = prepared
    raw = image("PNG")
    images = [item("one.png", "image/png", raw)]
    first = previews.prepare(ALICE, SID, RID, "ask-1", images)
    path = files._home(ALICE) / "previews" / SID / RID / (images[0]["sha256"] + ".png")
    original = path.stat()
    assert previews.prepare(ALICE, SID, RID, "ask-1", images) == first
    assert path.stat().st_ino == original.st_ino and path.read_bytes() == raw
    changed = [{**images[0], "name": "other.png"}]
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", changed), "request_conflict", 409)
    malformed = [{**images[0], "data": "$$$"}]
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", malformed), "request_conflict", 409)
    assert path.read_bytes() == raw


def test_owner_session_run_and_deleted_session_are_enforced(prepared):
    previews, state, _, store = prepared
    data = item("one.png", "image/png", image("PNG"))
    row = previews.prepare(ALICE, SID, RID, "ask-1", [data])[0]
    assert_raises_code(lambda: previews.read(BOB, SID, row["path"]), "not_found", 404)
    assert_raises_code(lambda: previews.read(ALICE, OTHER_SID, row["path"]), "not_found", 404)
    assert_raises_code(lambda: previews.prepare(BOB, SID, RID, "ask-1", [data]), "not_found", 404)
    assert_raises_code(lambda: previews.prepare(ALICE, OTHER_SID, RID, "ask-1", [data]), "not_found", 404)
    store.finish(ALICE, RID, "completed", {})
    state.delete(ALICE, SID)
    assert_raises_code(lambda: previews.read(ALICE, SID, row["path"]), "not_found", 404)


def test_changed_file_fails_read_and_retry_without_overwrite(prepared):
    previews, _, files, _ = prepared
    raw = image("PNG")
    data = item("one.png", "image/png", raw)
    row = previews.prepare(ALICE, SID, RID, "ask-1", [data])[0]
    path = files._home(ALICE) / "previews" / SID / RID / (data["sha256"] + ".png")
    changed = bytearray(raw)
    changed[-1] ^= 1
    path.write_bytes(changed)
    assert_raises_code(lambda: previews.read(ALICE, SID, row["path"]), "file_changed", 409)
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [data]), "file_changed", 409)
    assert path.read_bytes() == changed


@pytest.mark.parametrize("kind", ["bad-base64", "bad-sha", "bad-size", "wrong-mime", "unsafe-name", "extra-field", "false-magic"])
def test_invalid_inputs_cannot_create_or_register_previews(prepared, kind):
    previews, state, files, _ = prepared
    value = item("one.png", "image/png", image("PNG"))
    if kind == "bad-base64":
        value["data"] = "$$$"
    elif kind == "bad-sha":
        value["sha256"] = "f" * 64
    elif kind == "bad-size":
        value["size"] = True
    elif kind == "wrong-mime":
        value["mime"] = "image/jpeg"
    elif kind == "unsafe-name":
        value["name"] = "../one.png"
    elif kind == "extra-field":
        value["path"] = "/etc/passwd"
    else:
        value = item("one.png", "image/png", b"not a png")
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [value]), "invalid_preview", 400)
    assert not (files._home(ALICE) / "previews").exists()
    assert state.get(ALICE, previews._request_key(SID, RID, "ask-1")) is None


def test_total_byte_limit_and_malformed_paths_are_rejected(prepared):
    previews, _, files, _ = prepared
    previews.config = previews.config.model_copy(update={"max_history_bytes": 64})
    data = item("one.png", "image/png", image("PNG"))
    assert data["size"] > 32
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [data, data]), "file_limit", 413)
    assert not (files._home(ALICE) / "previews").exists()
    for raw in ("/workspace/.question-previews", f"/workspace/.question-previews/{RID}/../../secret.png",
                f"/workspace/.question-previews/{RID}/{'f' * 64}.svg"):
        assert previews.handles(raw)
        assert_raises_code(lambda: previews.read(ALICE, SID, raw), "not_found", 404)
    assert not previews.handles("/workspace/regular.png")


def test_untrusted_stored_metadata_never_selects_an_outside_path(prepared, tmp_path):
    previews, state, files, _ = prepared
    data = item("one.png", "image/png", image("PNG"))
    row = previews.prepare(ALICE, SID, RID, "ask-1", [data])[0]
    key = previews._file_key(SID, RID, data["sha256"], "png")
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"private fixture")
    stored = state.get(ALICE, key)
    state.set(ALICE, key, {**stored, "path": str(outside)})
    assert_raises_code(lambda: previews.read(ALICE, SID, row["path"]), "not_found", 404)
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [data]), "not_found", 404)
    assert outside.read_bytes() == b"private fixture"
    assert (files._home(ALICE) / "previews" / SID / RID / (data["sha256"] + ".png")).is_file()


def test_directory_symlink_cannot_redirect_preview_creation(prepared, tmp_path):
    previews, _, files, _ = prepared
    base = files._home(ALICE) / "previews"
    base.mkdir()
    outside = tmp_path / "other"
    outside.mkdir()
    try:
        (base / SID).symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("creating a directory symlink requires host permission")
    data = item("one.png", "image/png", image("PNG"))
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [data]), "invalid_preview", 400)
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("kind", ["hardlink", "symlink"])
def test_final_file_symlink_and_hardlink_are_rejected(prepared, tmp_path, kind):
    previews, _, files, _ = prepared
    raw = image("PNG")
    data = item("one.png", "image/png", raw)
    row = previews.prepare(ALICE, SID, RID, "ask-1", [data])[0]
    target = files._home(ALICE) / "previews" / SID / RID / (data["sha256"] + ".png")
    outside = tmp_path / "outside.png"
    outside.write_bytes(raw)
    target.unlink()
    if kind == "hardlink":
        try:
            os.link(outside, target)
        except OSError:
            pytest.skip("creating a hard link is unavailable")
    else:
        try:
            target.symlink_to(outside)
        except (OSError, NotImplementedError):
            pytest.skip("creating a symbolic link requires host permission")
    assert_raises_code(lambda: previews.read(ALICE, SID, row["path"]), "invalid_preview", 400)
    assert outside.read_bytes() == raw


def test_failed_metadata_commit_is_not_registered_and_safe_retry_reuses_file(prepared, monkeypatch):
    previews, state, _, _ = prepared
    data = item("one.png", "image/png", image("PNG"))
    original = state.set

    def fail_on_request(owner, key, value):
        if key.startswith("question_preview_request:"):
            raise sqlite3.OperationalError("synthetic database failure")
        return original(owner, key, value)

    monkeypatch.setattr(state, "set", fail_on_request)
    assert_raises_code(lambda: previews.prepare(ALICE, SID, RID, "ask-1", [data]), "preview_unavailable", 503)
    assert not state.db(ALICE).in_transaction
    assert state.get(ALICE, previews._file_key(SID, RID, data["sha256"], "png")) is None
    path = f"/workspace/.question-previews/{RID}/{data['sha256']}.png"
    assert_raises_code(lambda: previews.read(ALICE, SID, path), "not_found", 404)
    monkeypatch.setattr(state, "set", original)
    row = previews.prepare(ALICE, SID, RID, "ask-1", [data])[0]
    assert previews.read(ALICE, SID, row["path"]) == ("one.png", base64.b64decode(data["data"]))
