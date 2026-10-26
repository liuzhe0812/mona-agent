"""Real planning stores, local HTTP and encrypted cloud coordination on two devices."""
from __future__ import annotations

import secrets
import time
from unittest.mock import Mock

import httpx
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestServer
from test_cloud_coordinator import desktops as desktops

from mona.cloud.planning import PlanningClient, PlanningState
from mona.cloud.transfer import CloudTransferError
from mona.schedule.service import ScheduleService
from mona.schedule.sync import (
    PlanningSyncError,
    apply_sync_item,
    fingerprint,
    list_sync_items,
    normalize_item,
)
from mona.schedule.sync_api import register_planning_sync_routes
from mona.schedule.todo_service import TodoService
from mona.schedule.todo_types import TodoItem
from mona.schedule.types import ScheduleItem


@pytest_asyncio.fixture
async def planning_pair(desktops, tmp_path, monkeypatch):
    token = secrets.token_hex(32)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", token)
    cloud, create = desktops
    servers, devices = [], []
    for name in ("planning-a", "planning-b"):
        coordinator, native = create(name)
        directory = coordinator.manager.workspace / "schedule"
        directory.mkdir()
        schedule = ScheduleService(directory / "items.json", cron_service=Mock())
        todos = TodoService(directory / "todos.json")
        app = web.Application()
        app["schedule_service"], app["todo_service"] = schedule, todos
        register_planning_sync_routes(app)
        server = TestServer(app, host="127.0.0.1")
        await server.start_server()
        coordinator.planning_client = PlanningClient(server.port)
        servers.append(server)
        devices.append((coordinator, native, schedule, todos, server))
    try:
        yield cloud, *devices
    finally:
        for _, _, schedule, _, _ in devices:
            schedule.stop()
        for server in servers:
            await server.close()


async def enable(device, recovery=None, enabled=True):
    coordinator, *_ = device
    draft = await coordinator.prepare(recovery)
    await coordinator.enable(draft["draft_id"], [], True, sync_planning=enabled)
    await coordinator.run_once()
    assert coordinator.problem is None, coordinator.problem
    return draft


def todo(item_id="todo-origin", title="准备材料"):
    return TodoItem(id=item_id, title=title, created_at_ms=1, updated_at_ms=1)


def event(item_id="schedule-origin", title="会议"):
    return ScheduleItem(id=item_id, title=title, start_at_ms=int(time.time() * 1000) + 86_400_000,
                        description="讨论方案", tz="Asia/Shanghai")


async def settle(*devices, rounds=2):
    for _ in range(rounds):
        for device in devices:
            await device[0].run_once()
            assert device[0].problem is None, device[0].problem


async def receive_without_upload(device):
    coordinator = device[0]
    config = coordinator.preferences.read()
    assert config.enabled is True and config.upload_enabled is None
    await coordinator.run_once()
    config = coordinator.preferences.read()
    assert config.enabled is True and config.upload_enabled is False
    assert coordinator.problem is None, coordinator.problem


def count_versions(cloud):
    return sum(map(len, cloud.versions.values()))


@pytest.mark.asyncio
async def test_planning_off_does_not_read_or_upload_planning(planning_pair, monkeypatch):
    cloud, a, _ = planning_pair
    await a[3].add_item(todo())
    async def forbidden(*_):
        raise AssertionError("Unapproved planning read")
    monkeypatch.setattr(a[0].planning_client, "list", forbidden)
    await enable(a, enabled=False)
    assert not cloud.versions
    assert a[0].preferences.read().sync_planning is False


@pytest.mark.asyncio
async def test_actual_two_service_ports_sync_edit_complete_and_stay_idle(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    await a[2].add_item(event())
    await enable(a)
    await enable(b, a[1].recovery)
    imported = (await b[3].list_items())[0]
    imported_event = (await b[2].list_items())[0]
    assert imported.title == "准备材料" and imported.id != "todo-origin"
    assert imported_event.start_at_ms == (await a[2].get_item("schedule-origin")).start_at_ms
    assert imported_event.tz == "Asia/Shanghai"
    assert b[1].notifications == [{"work_keys": [], "planning": True}]
    await b[3].update_item(imported.id, {"state": "done"})
    imported_event.description = "第二台设备调整后的议程"
    await b[2].update_item(imported_event)
    await settle(b, a)
    assert (await a[3].get_item("todo-origin")).state == "done"
    assert (await a[2].get_item("schedule-origin")).description == "第二台设备调整后的议程"
    before = count_versions(cloud)
    await settle(a, b)
    assert count_versions(cloud) == before == 4
    assert a[0].phase == b[0].phase == "idle"
    assert b[1].notifications == [{"work_keys": [], "planning": True}]
    assert a[1].notifications[-1] == {"work_keys": [], "planning": True}
    for blob in cloud.objects.values():
        assert "准备材料".encode() not in blob and "第二台设备".encode() not in blob


@pytest.mark.asyncio
async def test_new_device_receives_planning_without_uploading_private_items(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    await a[2].add_item(event())
    await enable(a)
    before_versions, before_objects = count_versions(cloud), set(cloud.objects)
    assert before_versions == 2

    await b[3].add_item(todo("private-todo", "LOCAL_ONLY_TODO"))
    await b[2].add_item(event("private-event", "LOCAL_ONLY_EVENT"))
    await receive_without_upload(b)

    assert b[0].preferences.read().sync_planning is False
    assert {item.title for item in await b[3].list_items()} == {"准备材料", "LOCAL_ONLY_TODO"}
    assert {item.title for item in await b[2].list_items()} == {"会议", "LOCAL_ONLY_EVENT"}
    assert count_versions(cloud) == before_versions
    assert set(cloud.objects) == before_objects
    assert b"LOCAL_ONLY_TODO" not in b"".join(cloud.objects.values())
    assert b"LOCAL_ONLY_EVENT" not in b"".join(cloud.objects.values())


@pytest.mark.asyncio
async def test_ai_tasks_and_machine_source_links_never_migrate(planning_pair):
    cloud, a, b = planning_pair
    item = todo()
    item.source_type = "email"
    item.source_locator = {"messageId": "LOCAL_ONLY_MESSAGE", "authorization": "SYNTHETIC_VALUE"}
    item.source_snapshot = {"title": "邮件主题", "evidence": "本周交付", "cookie": "SYNTHETIC_VALUE"}
    item.schedule_id = "LOCAL_SCHEDULE_LINK"
    await a[3].add_item(item)
    ai = event("ai-job")
    ai.kind, ai.ai_message, ai.enabled = "ai_task", "NEVER_RUN", False
    await a[2].add_item(ai)
    await enable(a)
    await enable(b, a[1].recovery)
    assert await b[2].list_items() == []
    b[2]._cron.add_job.assert_not_called()
    imported = (await b[3].list_items())[0]
    assert imported.source_type == "email" and imported.source_snapshot == {"title": "邮件主题", "evidence": "本周交付"}
    assert imported.source_locator == {} and imported.schedule_id is None
    await b[3].update_item(imported.id, {"notes": "同步后的内容"})
    await settle(b, a)
    original = await a[3].get_item(item.id)
    assert original.source_locator == item.source_locator and original.schedule_id == item.schedule_id
    assert {v["kind"] for versions in cloud.versions.values() for v in versions} == {"todo"}


@pytest.mark.asyncio
async def test_known_item_deletion_propagates_without_deleting_unrelated_or_ai(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    await enable(a)
    await enable(b, a[1].recovery)
    imported = (await b[3].list_items())[0]
    await b[3].remove_item(imported.id)
    await settle(b, a)
    assert await a[3].list_items() == [] and await b[3].list_items() == []
    assert next(iter(cloud.versions.values()))[-1]["deleted"] is True
    assert len(cloud.objects) > 0  # History retention is separate from tombstones.


@pytest.mark.asyncio
async def test_concurrent_edits_keep_both_contents_without_repeated_conflict_copies(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    await enable(a)
    await enable(b, a[1].recovery)
    imported = (await b[3].list_items())[0]
    await a[3].update_item("todo-origin", {"title": "A端修改"})
    await b[3].update_item(imported.id, {"title": "B端修改"})
    await settle(a, b, rounds=3)
    for device in (a, b):
        titles = {item.title for item in await device[3].list_items()}
        assert titles == {"B端修改", "A端修改 · 同步冲突"}
    before = count_versions(cloud)
    await settle(a, b)
    assert count_versions(cloud) == before


@pytest.mark.asyncio
async def test_concurrent_calendar_copy_is_not_a_second_enabled_reminder(planning_pair):
    _, a, b = planning_pair
    await a[2].add_item(event())
    await enable(a)
    await enable(b, a[1].recovery)
    local = await a[2].get_item("schedule-origin")
    imported = (await b[2].list_items())[0]
    local.title, imported.title = "A议程", "B议程"
    await a[2].update_item(local)
    await b[2].update_item(imported)
    await settle(a, b)
    rows = await b[2].list_items()
    assert len(rows) == 2
    conflict = next(item for item in rows if "同步冲突" in item.title)
    assert conflict.enabled is False and conflict.id not in b[2]._timers
    b[2]._cron.add_job.assert_not_called()


@pytest.mark.asyncio
async def test_lost_commit_ack_is_reconciled_without_duplicate_item(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    draft = await a[0].prepare()
    await a[0].enable(draft["draft_id"], [], True, sync_planning=True)
    cloud.lose_commit_response = True
    await a[0].run_once()
    assert a[0].problem is not None
    assert count_versions(cloud) == 1
    await settle(a)
    await enable(b, a[1].recovery)
    assert len(await a[3].list_items()) == len(await b[3].list_items()) == 1
    assert count_versions(cloud) == 1


@pytest.mark.asyncio
async def test_planning_upload_scope_still_receives_cloud_changes_and_blocks_uploads(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    await enable(a)
    await enable(b, a[1].recovery)
    await b[0].select([], sync_planning=False)
    await a[3].update_item("todo-origin", {"notes": "等待同步"})
    await settle(a, b)
    assert (await b[3].list_items())[0].notes == "等待同步"
    before = count_versions(cloud)
    imported = (await b[3].list_items())[0]
    await b[3].update_item(imported.id, {"notes": "LOCAL_ONLY_TODO_EDIT"})
    await b[0].run_once()
    assert b[0].problem is None
    assert (await b[3].get_item(imported.id)).notes == "LOCAL_ONLY_TODO_EDIT"
    assert count_versions(cloud) == before == 2


@pytest.mark.asyncio
async def test_quota_rejection_and_local_corruption_never_send_empty_deletions(planning_pair):
    cloud, a, b = planning_pair
    await a[3].add_item(todo())
    await enable(a)
    before = count_versions(cloud)
    cloud.quota = sum(map(len, cloud.objects.values()))
    await a[3].update_item("todo-origin", {"notes": "仍保留在本机"})
    await a[0].run_once()
    assert a[0].problem["code"] == "cloud_quota_exceeded"
    assert count_versions(cloud) == before and (await a[3].get_item("todo-origin")).notes == "仍保留在本机"
    a[3].store_path.write_text("{broken", encoding="utf-8")
    await a[0].run_once()
    assert a[0].problem is not None and count_versions(cloud) == before


@pytest.mark.asyncio
async def test_real_local_api_requires_token_and_rejects_execution_fields(planning_pair):
    _, a, _ = planning_pair
    base = str(a[4].make_url("/api/schedule/sync/"))
    async with httpx.AsyncClient() as client:
        assert (await client.get(base + "todo")).status_code == 401
    valid = normalize_item("calendar_event", event().to_dict())
    with pytest.raises(CloudTransferError):
        await a[0].planning_client.apply("calendar_event", "schedule-bad", None, {**valid, "kind": "ai_task", "aiMessage": "RUN"})
    assert not a[2].store_path.exists()
    a[2]._cron.add_job.assert_not_called()


@pytest.mark.asyncio
async def test_local_compare_before_write_and_duplicate_reply(planning_pair):
    _, a, _ = planning_pair
    await a[3].add_item(todo())
    client = a[0].planning_client
    before = (await client.list("todo"))["todo-origin"]
    await a[3].update_item("todo-origin", {"notes": "用户刚修改"})
    desired = {**before, "notes": "旧的云修改"}
    with pytest.raises(CloudTransferError):
        await client.apply("todo", "todo-origin", before, desired)
    assert (await a[3].get_item("todo-origin")).notes == "用户刚修改"
    fresh = (await client.list("todo"))["todo-origin"]
    await client.apply("todo", "todo-origin", fresh, desired)
    await client.apply("todo", "todo-origin", fresh, desired)
    assert (await a[3].get_item("todo-origin")).notes == "旧的云修改"


@pytest.mark.asyncio
async def test_second_account_cannot_republish_first_accounts_planning(planning_pair):
    cloud, a, _ = planning_pair
    await a[3].add_item(todo())
    await enable(a)
    first_vault = a[0].preferences.read().vault_id
    cloud.space = None
    a[1].account_id, a[1].binding, a[1].recovery = "2", "f" * 64, None
    draft = await a[0].prepare()
    await a[0].enable(draft["draft_id"], [], True, sync_planning=True)
    # A real server lists only the current account's versions.
    cloud.versions.clear()
    cloud.operations.clear()
    await a[0].run_once()
    assert a[0].problem is None
    assert a[0].preferences.read().vault_id != first_vault
    assert not cloud.versions
    assert (await a[3].get_item("todo-origin")).title == "准备材料"


@pytest.mark.asyncio
async def test_failed_first_upload_then_local_delete_does_not_create_invalid_tombstone(planning_pair):
    cloud, a, _ = planning_pair
    await a[3].add_item(todo())
    draft = await a[0].prepare()
    await a[0].enable(draft["draft_id"], [], True, sync_planning=True)
    cloud.quota = 0
    await a[0].run_once()
    assert a[0].problem["code"] == "cloud_quota_exceeded"
    await a[3].remove_item("todo-origin")
    cloud.quota = 10_000_000_000
    await a[0].run_once()
    assert a[0].problem is None and not cloud.versions
    state = PlanningState(a[0].store)
    assert state.rows(a[0].preferences.read().vault_id)[0]["version"] is None


@pytest.mark.asyncio
async def test_remote_delete_does_not_destroy_concurrent_local_edit(planning_pair):
    _, a, b = planning_pair
    await a[3].add_item(todo())
    await enable(a)
    await enable(b, a[1].recovery)
    imported = (await b[3].list_items())[0]
    await a[3].remove_item("todo-origin")
    await b[3].update_item(imported.id, {"notes": "离线新增的内容"})
    await settle(a, b, rounds=3)
    assert (await a[3].get_item("todo-origin")).notes == "离线新增的内容"
    assert (await b[3].get_item(imported.id)).notes == "离线新增的内容"


@pytest.mark.parametrize("kind,field,value", [
    ("todo", "createdAtMs", None), ("todo", "state", ["open"]),
    ("todo", "confidence", float("nan")), ("todo", "focusRank", True),
    ("calendar_event", "startAtMs", None), ("calendar_event", "tz", "Invalid/Zone"),
    ("calendar_event", "enabled", "true"), ("calendar_event", "endAtMs", -1),
])
def test_malformed_planning_data_rejected(kind, field, value):
    raw = todo().to_dict() if kind == "todo" else event().to_dict()
    data = normalize_item(kind, raw)
    data[field] = value
    with pytest.raises(PlanningSyncError):
        normalize_item(kind, data, incoming=True)


@pytest.mark.parametrize("recurrence,expected", [
    ("daily", "30 9 * * *"), ("weekly", "30 9 * * 1"), ("monthly", "30 9 12 * *"),
])
def test_synced_recurrence_uses_the_event_timezone(recurrence, expected, monkeypatch):
    from datetime import datetime, timezone

    from mona.schedule.service import _cron_expr_for_recurrence
    item = event()
    item.recurrence = recurrence
    item.start_at_ms = int(datetime(2026, 10, 12, 1, 30, tzinfo=timezone.utc).timestamp() * 1000)
    item.tz = "Asia/Shanghai"
    def wrong_host_timezone(*_):
        raise AssertionError("Receiving machine timezone must not replace the event timezone")
    monkeypatch.setattr("mona.schedule.service.time.localtime", wrong_host_timezone)
    assert _cron_expr_for_recurrence(item) == expected


def test_next_recurring_reminder_preserves_wall_time_across_dst(monkeypatch):
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from mona.schedule.service import _compute_next_run_ms
    item = event()
    item.recurrence, item.tz = "daily", "America/New_York"
    item.start_at_ms = int(datetime(2026, 3, 7, 9, 30, tzinfo=ZoneInfo(item.tz)).timestamp() * 1000)
    now = datetime(2026, 3, 8, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr("mona.schedule.service._now_ms", lambda: int(now.timestamp() * 1000))
    expected = datetime(2026, 3, 8, 9, 30, tzinfo=ZoneInfo(item.tz))
    assert _compute_next_run_ms(item) == int(expected.timestamp() * 1000)


def test_storage_corruption_is_not_an_empty_store(tmp_path):
    store = TodoService(tmp_path / "todos.json")
    store.store_path.write_text('{"version":1,"items":[{"id":"same"},{"id":"same"}]}', encoding="utf-8")
    before = store.store_path.read_bytes()
    with pytest.raises(PlanningSyncError):
        list_sync_items(store, "todo")
    with pytest.raises(PlanningSyncError):
        apply_sync_item(store, "todo", "new", fingerprint(None), normalize_item("todo", todo().to_dict()))
    assert store.store_path.read_bytes() == before
