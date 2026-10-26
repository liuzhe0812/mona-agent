"""Real coordinator/encryption/versions; native settings and storage are isolated boundaries."""
from __future__ import annotations

import copy

import pytest
from test_cloud_coordinator import desktops as desktops

from mona.cloud.preferences import PreferencesClient, validate_preferences
from mona.cloud.transfer import CloudTransferError
from mona.schedule.sync import fingerprint

DEFAULT = {"send_message_shortcut": "enter", "default_view": "chat", "quick_ask_mode": "compact",
           "sidebar_modules": [{"key": "chat", "visible": True, "order": 0}, {"key": "note", "visible": True, "order": 1}]}


def test_python_fingerprint_matches_native_settings_wire_contract():
    value = {**copy.deepcopy(DEFAULT), "sidebar_modules": [DEFAULT["sidebar_modules"][0]]}
    validate_preferences(value)
    assert fingerprint(value) == "5cc44cf64fd96afa6891e64ab67416f00535ec141d3382288298372ba59dca95"


class NativeSettings:
    def __init__(self, boundary):
        self.boundary = boundary
        self.data = copy.deepcopy(DEFAULT)
        self.calls = []
        self.before_apply = None

    def invoke(self, command, args, **kwargs):
        assert command == "cloud_preferences"
        assert args["binding"] == self.boundary.binding
        self.calls.append(args["action"])
        if args["action"] == "read":
            return {"data": copy.deepcopy(self.data), "fingerprint": fingerprint(self.data)}
        if self.before_apply:
            self.before_apply()
        if args["expected"] != fingerprint(self.data):
            raise CloudTransferError("preferences_changed", "local settings changed")
        self.data = copy.deepcopy(args["data"])
        return {"applied": True, "data": copy.deepcopy(self.data), "fingerprint": fingerprint(self.data)}


@pytest.fixture
def pair(desktops):
    service, create = desktops
    instances = []
    for name in ("a", "b"):
        coordinator, boundary = create(name)
        native = NativeSettings(boundary)
        coordinator.preferences_client = PreferencesClient(native.invoke, boundary.binding)
        instances.append((coordinator, boundary, native))
    return service, *instances


async def start(item, recovery=None, selected=True):
    coordinator, _, _ = item
    draft = await coordinator.prepare(recovery)
    await coordinator.enable(draft["draft_id"], [], True, sync_preferences=selected)
    await coordinator.run_once()
    assert coordinator.problem is None, coordinator.problem


@pytest.mark.asyncio
async def test_preferences_require_separate_opt_in_and_do_not_read_local_settings_by_default(pair):
    service, a, _ = pair
    await start(a, selected=False)
    assert a[2].calls == [] and not service.versions
    assert (await a[0].status())["sync_preferences"] is False


@pytest.mark.asyncio
async def test_second_device_receives_preferences_then_both_continue_without_version_churn(pair):
    service, a, b = pair
    a[2].data.update(send_message_shortcut="ctrl_enter", default_view="note")
    await start(a)
    await start(b, a[1].recovery)
    assert b[2].data == a[2].data
    b[2].data["quick_ask_mode"] = "full"
    await b[0].run_once()
    await a[0].run_once()
    assert a[0].problem is None and b[0].problem is None
    assert a[2].data == b[2].data and a[2].data["quick_ask_mode"] == "full"
    count = sum(map(len, service.versions.values()))
    await b[0].run_once()
    await a[0].run_once()
    assert sum(map(len, service.versions.values())) == count


@pytest.mark.asyncio
async def test_new_device_receives_preferences_without_uploading_local_changes(pair):
    service, a, b = pair
    a[2].data["default_view"] = "note"
    await start(a)
    before_versions, before_objects = sum(map(len, service.versions.values())), set(service.objects)
    assert before_versions == 1

    b[2].data["quick_ask_mode"] = "full"
    initial = b[0].preferences.read()
    assert initial.enabled is True and initial.upload_enabled is None
    await b[0].pause()
    paused = b[0].preferences.read()
    assert paused.enabled is False and paused.upload_enabled is False
    await b[0].run_once()
    assert b[2].data["quick_ask_mode"] == "full"
    assert sum(map(len, service.versions.values())) == before_versions

    await b[0].resume()
    receiving = b[0].preferences.read()
    assert receiving.enabled is True and receiving.upload_enabled is False
    await b[0].run_once()
    assert b[0].problem is None
    assert b[2].data["default_view"] == "note"
    assert b[2].data["quick_ask_mode"] == "compact"
    assert b[0].preferences.read().sync_preferences is False
    assert sum(map(len, service.versions.values())) == before_versions
    assert set(service.objects) == before_objects

    b[2].data["quick_ask_mode"] = "full"
    a[2].data["default_view"] = "schedule"
    await a[0].run_once()
    assert sum(map(len, service.versions.values())) == 2
    after_source_objects = set(service.objects)
    await b[0].run_once()
    assert b[0].problem is None
    assert b[2].data["default_view"] == "schedule"
    assert b[2].data["quick_ask_mode"] == "full"
    assert b[0].preferences.read().upload_enabled is False
    assert sum(map(len, service.versions.values())) == 2
    assert set(service.objects) == after_source_objects


@pytest.mark.asyncio
async def test_independent_field_edits_merge_without_losing_local_pending_changes(pair):
    _, a, b = pair
    await start(a)
    await start(b, a[1].recovery)
    a[2].data["default_view"] = "note"
    b[2].data["send_message_shortcut"] = "ctrl_enter"
    await a[0].run_once()
    await b[0].run_once()
    await a[0].run_once()
    assert a[0].problem is None and b[0].problem is None
    assert a[2].data == b[2].data
    assert a[2].data["default_view"] == "note" and a[2].data["send_message_shortcut"] == "ctrl_enter"


@pytest.mark.asyncio
async def test_same_field_conflict_keeps_unpublished_local_edit_then_converges(pair):
    _, a, b = pair
    await start(a)
    await start(b, a[1].recovery)
    a[2].data["default_view"] = "note"
    b[2].data["default_view"] = "schedule"
    await a[0].run_once()
    await b[0].run_once()
    assert b[2].data["default_view"] == "schedule"
    await a[0].run_once()
    assert a[2].data["default_view"] == "schedule"


@pytest.mark.asyncio
async def test_pause_stays_paused_and_resume_does_not_reauthorize_preferences(pair):
    service, a, b = pair
    a[2].data["default_view"] = "note"
    await start(a)
    await start(b, a[1].recovery, selected=False)
    assert b[2].data["default_view"] == "note"
    await b[0].pause()
    a[2].data["default_view"] = "schedule"
    await a[0].run_once()
    assert a[0].problem is None and sum(map(len, service.versions.values())) == 2
    await b[0].run_once()
    assert b[0].preferences.read().enabled is False
    assert b[2].data["default_view"] == "note"
    await b[0].resume()
    config = b[0].preferences.read()
    assert config.enabled is True and config.upload_enabled is True and config.sync_preferences is False
    await b[0].run_once()
    assert b[2].data["default_view"] == "schedule"
    assert sum(map(len, service.versions.values())) == 2


@pytest.mark.asyncio
async def test_native_cas_failure_keeps_user_edit_and_does_not_advance_cursor(pair):
    _, a, b = pair
    await start(a)
    await start(b, a[1].recovery)
    before = b[0].store.cursor(b[0].preferences.read().vault_id)
    a[2].data["default_view"] = "note"
    await a[0].run_once()
    b[2].before_apply = lambda: b[2].data.update(quick_ask_mode="full")
    await b[0].run_once()
    assert b[0].problem["code"] == "preferences_changed"
    assert b[0].store.cursor(b[0].preferences.read().vault_id) == before
    assert b[2].data["quick_ask_mode"] == "full" and b[2].data["default_view"] == "chat"
    b[2].before_apply = None
    await b[0].run_once()
    assert b[0].problem is None
    assert b[2].data["default_view"] == "note" and b[2].data["quick_ask_mode"] == "full"


@pytest.mark.asyncio
async def test_lost_commit_response_reuses_the_same_cloud_version(pair):
    service, a, _ = pair
    original = service.control
    failed = False
    def interrupted(method, path, payload=None):
        nonlocal failed
        value = original(method, path, payload)
        if path == "/resources/commit" and payload["kind"] == "preferences" and not failed:
            failed = True
            raise CloudTransferError("connection_lost", "outcome unknown")
        return value
    service.control = interrupted
    draft = await a[0].prepare()
    await a[0].enable(draft["draft_id"], [], True, sync_preferences=True)
    await a[0].run_once()
    assert a[0].problem["code"] == "connection_lost"
    await a[0].run_once()
    assert a[0].problem is None
    assert sum(map(len, service.versions.values())) == 1


@pytest.mark.asyncio
async def test_account_switch_never_sends_previous_accounts_preferences(pair):
    service, a, _ = pair
    await start(a)
    count = sum(map(len, service.versions.values()))
    a[1].account_id = "2"
    a[2].data["quick_ask_mode"] = "full"
    await a[0].run_once()
    assert a[0].problem is None
    assert (await a[0].status())["upload_enabled"] is False
    assert sum(map(len, service.versions.values())) == count


@pytest.mark.asyncio
async def test_free_downgrade_keeps_local_preference_changes_without_cloud_writes(pair):
    service, a, _ = pair
    await start(a)
    count = sum(map(len, service.versions.values()))
    a[1].plan = "free"
    a[2].data["quick_ask_mode"] = "full"
    await a[0].run_once()
    assert a[0].problem is None and a[2].data["quick_ask_mode"] == "full"
    assert sum(map(len, service.versions.values())) == count


@pytest.mark.parametrize("field,value", [("api_key", "never-upload"), ("config_path", "private-path"),
    ("computer_use_enabled", True), ("sidebar_modules", [{"key": "exec", "order": 0, "visible": True}]),
    ("default_view", []), ("quick_ask_mode", "exec"), ("send_message_shortcut", "shift_enter")])
def test_portable_settings_reject_unknown_authority_paths_and_bad_shapes(field, value):
    data = {**copy.deepcopy(DEFAULT), field: value}
    with pytest.raises(CloudTransferError):
        validate_preferences(data)
