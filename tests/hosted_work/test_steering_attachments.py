"""Staged steering files are account-scoped and version-checked."""
import base64
import hashlib
from types import SimpleNamespace

import pytest

from mona.hosted_work.contracts import NewSession, WorkError
from mona.hosted_work.steering_attachments import (
    SteeringAttachments,
    build_image_content,
    sandbox_target,
)
from tests.hosted_work.test_inputs import OTHER, OWNER, SID
from tests.hosted_work.test_inputs import scene as scene


def desktop(scene):
    files = scene.state.files
    def logical(owner, raw):
        root = files.root(owner)
        path = files._path(root, raw if raw.startswith("/") else "/workspace/" + raw)
        return path, files._logical(root, path)
    return SimpleNamespace(files=files, state=scene.state, service=scene.state.service, _logical=logical)


@pytest.mark.asyncio
async def test_stage_prepare_and_enrich_are_stable_without_storing_bytes_in_metadata(scene):
    media = b"\x89PNG\r\n\x1a\nreal-image-fixture"
    adapter = SteeringAttachments(desktop(scene))
    item = {"name": "参考.png", "data_url": "data:image/png;base64," + base64.b64encode(media).decode()}
    staged = adapter.stage_media(OWNER, SID, "input-1", [item])
    assert staged == adapter.stage_media(OWNER, SID, "input-1", [item])
    assert staged != adapter.stage_media(OWNER, SID, "input-2", [item])
    descriptors = adapter.prepare(OWNER, SID, "input-1", staged)
    assert descriptors == [{"path": staged[0], "name": "参考.png", "size": len(media),
                            "sha256": hashlib.sha256(media).hexdigest()}]
    stored = scene.state.get(OWNER, "upload:" + staged[0])
    assert "data" not in stored and "data_url" not in stored
    batch = {"request_id": "r", "inputs": [{"input_id": "input-1", "content": "看图", "attachments": descriptors}]}
    enriched = adapter.enrich(OWNER, SID, batch)
    output = enriched["inputs"][0]["attachments"][0]
    assert output["target_path"] == sandbox_target(SID, "input-1", descriptors[0])
    assert base64.b64decode(output["data"], validate=True) == media
    assert "data" not in batch["inputs"][0]["attachments"][0]
    blocks = build_image_content("看图", [{"path": output["target_path"], "data": media}])
    assert blocks[0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert blocks[0]["_meta"]["path"] == "/workspace/" + output["target_path"]
    assert blocks[1] == {"type": "text", "text": "看图"}


@pytest.mark.asyncio
async def test_changed_or_other_owner_staged_file_is_never_enriched(scene):
    media = b"\xff\xd8\xffjpeg-fixture"
    adapter = SteeringAttachments(desktop(scene))
    staged = adapter.stage_media(OWNER, SID, "one", [{"data_url": "data:image/jpeg;base64," + base64.b64encode(media).decode()}])
    descriptors = adapter.prepare(OWNER, SID, "one", staged)
    scene.store.create_session(OTHER, NewSession(request_id=SID))
    with pytest.raises(WorkError) as foreign:
        adapter.prepare(OTHER, SID, "one", staged)
    assert foreign.value.status == 404
    path, _ = adapter.desktop._logical(OWNER, staged[0])
    path.write_bytes(b"changed")
    batch = {"request_id": "r", "inputs": [{"input_id": "one", "content": "check", "attachments": descriptors}]}
    with pytest.raises(WorkError) as changed:
        adapter.enrich(OWNER, SID, batch)
    assert changed.value.code == "file_changed"


@pytest.mark.asyncio
@pytest.mark.parametrize("media", [
    [{"data_url": "https://example.com/image.png"}],
    [{"data_url": "data:image/png;base64,YmFk"}],
    [{"data_url": "data:video/mp4;base64,YmFk"}],
    [{"local_path": "/etc/passwd"}],
])
async def test_only_inline_verified_images_are_staged(scene, media):
    adapter = SteeringAttachments(desktop(scene))
    with pytest.raises(WorkError):
        adapter.stage_media(OWNER, SID, "one", media)


@pytest.mark.asyncio
async def test_enriched_batch_size_is_limited_before_transport(scene):
    media = b"\x89PNG\r\n\x1a\n" + b"x" * 400
    adapter = SteeringAttachments(desktop(scene))
    staged = adapter.stage_media(OWNER, SID, "one", [{"data_url": "data:image/png;base64," + base64.b64encode(media).decode()}])
    descriptors = adapter.prepare(OWNER, SID, "one", staged)
    adapter.desktop.service.config.max_history_bytes = 300
    with pytest.raises(WorkError) as error:
        adapter.enrich(OWNER, SID, {"request_id": "r", "inputs": [{"input_id": "one", "content": "", "attachments": descriptors}]})
    assert error.value.code == "file_limit"
