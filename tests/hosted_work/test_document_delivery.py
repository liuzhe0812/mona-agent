"""Existing Office exports and sandbox files keep distinct delivery boundaries."""
from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.tools.path_utils import (
    get_current_workspace,
    reset_current_workspace,
    set_current_workspace,
)
from mona.hosted_work.editor_tools import build_editor_tools
from mona.hosted_work.tools import HostedTools
from tests.hosted_work.test_editor_tools import OTHER
from tests.hosted_work.test_editor_tools import editors as editors


def make_tools(editors, sandbox_bytes=b"sandbox fixture", *, editor_tools=None):
    config, _, canvas, office, events, _, _ = editors
    metadata = {"path": "shared.pptx", "name": "shared.pptx", "size": len(sandbox_bytes),
                "sha256": hashlib.sha256(sandbox_bytes).hexdigest()}
    sandbox = SimpleNamespace(file=AsyncMock(return_value=metadata))
    selected = editor_tools if editor_tools is not None else (canvas, office)
    tools = HostedTools(sandbox, office._delivery_bus.emit, selected,
                        session_id=selected[1].scope.session_id, config=config)
    return tools, sandbox, metadata, events


def delivery_events(events):
    return [value for kind, value in events if kind == "desktop" and value.get("event") == "deliver_files"]


@pytest.mark.asyncio
async def test_export_then_delivery_reuses_desktop_tool_without_duplicate_card_or_sandbox(editors):
    _, _, _, office, _, _, _ = editors
    tools, sandbox, _, events = make_tools(editors)
    exported = office.scope.root / "shared.pptx"
    content = b"office-export-fixture"
    exported.write_bytes(content)
    await office._publish_export(exported)

    assert len(delivery_events(events)) == 1
    first = delivery_events(events)[0]["files"][0]
    assert first["absolute_path"] == "/workspace/shared.pptx"
    assert first["size"] == len(content) and first["sha256"] == hashlib.sha256(content).hexdigest()
    result = await tools.registry.execute("deliver_file", {"path": "/workspace/shared.pptx"})
    assert result.startswith("Delivered 1 file(s)")
    assert len(delivery_events(events)) == 1
    sandbox.file.assert_not_awaited()


@pytest.mark.asyncio
async def test_unregistered_document_with_same_name_does_not_shadow_sandbox_file(editors):
    _, _, _, office, _, _, _ = editors
    tools, sandbox, metadata, events = make_tools(editors)
    (office.scope.root / "shared.pptx").write_bytes(b"unregistered office file")

    result = json.loads(await tools.registry.execute("deliver_file", {"path": "/workspace/shared.pptx"}))
    expected = {**metadata, "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
    assert result == {"offered": True, **expected}
    sandbox.file.assert_awaited_once_with({"action": "stat", "path": "/workspace/shared.pptx"})
    assert not delivery_events(events) and ("artifact", expected) not in events
    assert tools.pending_delivery_files == [expected]
    await tools.flush_deliveries()
    assert ("artifact", expected) in events and not tools.pending_delivery_files


@pytest.mark.asyncio
@pytest.mark.parametrize("other_conversation", [True, False], ids=["other-conversation", "another-run"])
async def test_export_registered_by_another_run_does_not_authorize_document_delivery(editors, other_conversation):
    config, payload, _, office, _, _, _ = editors
    exported = office.scope.root / "shared.pptx"
    exported.write_bytes(b"another conversation")
    await office._publish_export(exported)
    other_payload = {**payload, "run_id": "d" * 32}
    if other_conversation:
        other_payload["session_id"] = "c" * 32
    other_editors = build_editor_tools(config, other_payload, office._delivery_bus.emit)
    tools, sandbox, metadata, _ = make_tools(editors, editor_tools=other_editors)

    result = json.loads(await tools.registry.execute("deliver_file", {"path": "/workspace/shared.pptx"}))
    expected = {**metadata, "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
    assert result == {"offered": True, **expected}
    sandbox.file.assert_awaited_once_with({"action": "stat", "path": "/workspace/shared.pptx"})
    assert tools.pending_delivery_files == [expected]


@pytest.mark.asyncio
async def test_changed_export_reports_error_without_sandbox_fallback(editors):
    _, _, _, office, _, _, _ = editors
    tools, sandbox, _, events = make_tools(editors)
    exported = office.scope.root / "shared.pptx"
    exported.write_bytes(b"ORIGINAL")
    await office._publish_export(exported)
    exported.write_bytes(b"CHANGED!")  # Same size; checking only size would accept different content.

    result = json.loads(await tools.registry.execute("deliver_file", {"path": "/workspace/shared.pptx"}))
    assert result["ok"] is False and "变化" in result["error"]["message"]
    assert len(delivery_events(events)) == 1
    sandbox.file.assert_not_awaited()


@pytest.mark.asyncio
async def test_other_owner_or_private_editor_path_is_rejected_before_sandbox(editors):
    _, _, _, office, _, _, _ = editors
    tools, sandbox, _, events = make_tools(editors)
    foreign = office.scope.root.parents[1] / OTHER / "documents" / "secret.pptx"
    foreign.parent.mkdir(parents=True)
    foreign.write_bytes(b"other owner fixture")

    for path in (str(foreign), "/workspace/../other/secret.pptx", "/workspace/.office/session/working.pptx"):
        result = json.loads(await tools.registry.execute("deliver_file", {"path": path}))
        assert result["ok"] is False and result["error"]["code"] == "INVALID_OPERATION"
    sandbox.file.assert_not_awaited()
    assert not events


@pytest.mark.asyncio
async def test_ambient_workspace_is_restored_on_delivery_success_and_failure(editors, tmp_path, monkeypatch):
    _, _, _, office, _, _, _ = editors
    tools, sandbox, _, events = make_tools(editors)
    exported = office.scope.root / "shared.pptx"
    exported.write_bytes(b"current owner fixture")
    await office._publish_export(exported)
    foreign = tmp_path / "ambient-elsewhere"
    foreign.mkdir()
    token = set_current_workspace(foreign)
    try:
        result = await tools.registry.execute("deliver_file", {"path": "/workspace/shared.pptx"})
        assert result.startswith("Delivered 1 file(s)")
        assert get_current_workspace() == foreign
        assert len(delivery_events(events)) == 1 and not (foreign / "shared.pptx").exists()

        async def fail(**_kwargs):
            assert get_current_workspace() == office.scope.root
            raise RuntimeError("synthetic failure")

        monkeypatch.setattr(office._delivery, "execute", fail)
        with pytest.raises(RuntimeError, match="synthetic failure"):
            await office.deliver_existing_file("/workspace/shared.pptx")
        assert get_current_workspace() == foreign
    finally:
        reset_current_workspace(token)
    sandbox.file.assert_not_awaited()


@pytest.mark.asyncio
async def test_changed_export_during_delivery_does_not_publish_new_content(editors, monkeypatch):
    _, _, _, office, _, _, _ = editors
    tools, sandbox, _, events = make_tools(editors)
    exported = office.scope.root / "shared.pptx"
    exported.write_bytes(b"ORIGINAL")
    await office._publish_export(exported)
    execute = office._delivery.execute

    async def modify_then_deliver(**kwargs):
        exported.write_bytes(b"CHANGED!")
        return await execute(**kwargs)

    monkeypatch.setattr(office._delivery, "execute", modify_then_deliver)
    result = await tools.registry.execute("deliver_file", {"path": "/workspace/shared.pptx"})
    failed = result.startswith("Error")
    if not failed:
        try:
            failed = json.loads(result).get("ok") is False
        except (ValueError, AttributeError):
            pass
    assert failed
    assert len(delivery_events(events)) == 1
    assert office._delivery_bus.expected_delivery is None
    sandbox.file.assert_not_awaited()
    # An explicit later export is a new version, not a duplicate delivery attempt.
    await office._publish_export(exported)
    assert len(delivery_events(events)) == 2
    assert delivery_events(events)[-1]["files"][0]["sha256"] == hashlib.sha256(b"CHANGED!").hexdigest()
