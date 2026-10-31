import asyncio
import json

import pytest

from mona.agent.tools.context import RequestContext
from mona.agent.tools.development_workbench import DevelopmentWorkbenchTool
from mona.development.executors.rpc import RpcError
from mona.development.hub_contracts import HubCommand
from mona.development.store import DevelopmentError


class FakeHub:
    def __init__(self):
        self.calls = []

    def allows_context(self, source):
        return source.chat_id != "room"

    async def execute(self, command, source):
        self.calls.append((command, source))
        await asyncio.sleep(0)
        return {"ok": True, "chat": source.chat_id, "action": command.action, "title": "开发项目"}


def source(chat_id):
    return RequestContext(channel="websocket", chat_id=chat_id, session_key=f"websocket:{chat_id}")


@pytest.mark.asyncio
async def test_tool_requires_an_allowed_chat_context():
    hub = FakeHub()
    tool = DevelopmentWorkbenchTool(hub)
    assert not tool.available_in_context()
    assert json.loads(await tool.execute(action="list_projects"))["error"]["code"] == "unavailable"

    tool.set_context(source("room"))
    assert not tool.available_in_context()
    assert json.loads(await tool.execute(action="list_projects"))["error"]["code"] == "unavailable"
    assert hub.calls == []


@pytest.mark.asyncio
async def test_concurrent_calls_keep_their_own_source_chat():
    hub = FakeHub()
    tool = DevelopmentWorkbenchTool(hub)

    async def request(chat_id):
        tool.set_context(source(chat_id))
        await asyncio.sleep(0)
        assert tool.available_in_context()
        return json.loads(await tool.execute(action="list_projects"))

    first, second = await asyncio.gather(request("first"), request("second"))
    assert (first["chat"], second["chat"]) == ("first", "second")
    assert first["title"] == "开发项目"
    assert {call[1].session_key for call in hub.calls} == {"websocket:first", "websocket:second"}


@pytest.mark.asyncio
async def test_invalid_mutation_and_forged_source_do_not_reach_service():
    hub = FakeHub()
    tool = DevelopmentWorkbenchTool(hub)
    tool.set_context(source("origin"))

    missing_revision = json.loads(await tool.execute(action="send_task", session_id="dev_1",
                                                     request_id="req_1", content="实现登录"))
    forged_source = json.loads(await tool.execute(action="list_projects", source_chat_id="other"))
    assert missing_revision["error"]["code"] == "invalid_request"
    assert forged_source["error"]["code"] == "invalid_request"
    assert hub.calls == []

    result = json.loads(await tool.execute(action="send_task", session_id="dev_1", request_id="req_1",
                                           content="实现登录", expected_revision=0))
    assert result["ok"] is True
    assert isinstance(hub.calls[0][0], HubCommand)
    assert hub.calls[0][0].content == "实现登录"
    assert hub.calls[0][1].session_key == "websocket:origin"


@pytest.mark.asyncio
async def test_known_failures_are_reported_without_leaking_permission_details():
    class FailedHub(FakeHub):
        async def execute(self, command, source):
            if command.action == "list_tasks":
                raise DevelopmentError("conflict", "会话已变化，请刷新。")
            raise PermissionError("private-path")

    tool = DevelopmentWorkbenchTool(FailedHub())
    tool.set_context(source("origin"))
    conflict = json.loads(await tool.execute(action="list_tasks"))
    denied = await tool.execute(action="list_projects")
    assert conflict["error"] == {"code": "conflict", "message": "会话已变化，请刷新。"}
    assert json.loads(denied)["error"]["code"] == "access_denied"
    assert "private-path" not in denied


def test_tool_metadata_and_schema_expose_only_the_workbench_contract():
    tool = DevelopmentWorkbenchTool(FakeHub())
    assert tool.name == "development_workbench"
    assert tool.system_managed and not tool.read_only and not tool._plugin_discoverable
    assert tool._scopes == {"core"} and tool.agent_allowlist == frozenset({"mona"})
    assert not tool.enabled(None)
    assert set(tool.parameters["properties"]) == set(HubCommand.model_fields)
    assert tool.parameters["required"] == ["action"]


@pytest.mark.asyncio
async def test_unknown_native_result_does_not_expose_raw_provider_details():
    class UncertainHub(FakeHub):
        async def execute(self, command, source):
            raise RpcError("native_timeout", "RAW_PROVIDER_DETAIL", outcome_unknown=True)

    tool = DevelopmentWorkbenchTool(UncertainHub())
    tool.set_context(source("origin"))
    result = await tool.execute(action="list_tasks")
    assert "RAW_PROVIDER_DETAIL" not in result
    assert "无法确认" in json.loads(result)["error"]["message"]
