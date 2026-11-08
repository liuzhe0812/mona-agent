"""Child images reuse the parent run's authorization and billing boundaries."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from mona.agent.hook import AgentHook
from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError
from mona.hosted_work.editor_tools import build_editor_tools
from mona.hosted_work.image_control import ImageControl
from mona.hosted_work.image_pricing import image_price_units
from mona.hosted_work.image_runtime import _CALL_ID, ImageRuntime
from mona.hosted_work.store import WorkStore
from mona.hosted_work.subagent_spec import build_subagent_factory
from mona.hosted_work.subagents import build_subagent_runtime
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.context_window import ResolvedContextWindow
from mona.session.manager import Session

OWNER, SID, RUN = "a" * 64, "1" * 32, "2" * 32


class Sandbox:
    def __init__(self, config):
        self.config, self.files = config, {}

    async def file(self, request):
        path = request["path"]
        if request["action"] == "upload":
            self.files[path] = base64.b64decode(request["data"], validate=True)
        data = self.files[path]
        return {"path": path, "name": path.rsplit("/", 1)[-1], "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode()}


class Wallet:
    def __init__(self):
        self.actions = []

    async def reserve_image(self, operation, _token, settings):
        self.actions.append(("reserve", operation))
        return {"status": "reserved", "reserved_units": image_price_units(settings.price.model_dump())}

    async def dispatch(self, operation):
        self.actions.append(("dispatch", operation))
        return {"status": "running"}

    async def settle_image(self, operation, _settings, _usage):
        self.actions.append(("settle", operation))
        return {"status": "settled", "actual_units": 4}


class ChildProvider(LLMProvider):
    def __init__(self):
        super().__init__()
        self.requests = []

    async def chat(self, messages, **_kwargs):
        self.requests.append(messages)
        replies = [message for message in messages if message.get("role") == "tool"]
        if not replies:
            return LLMResponse(None, [ToolCallRequest("load", "load_capability", {"capabilities": ["image"]})])
        if len(replies) == 1:
            return LLMResponse(None, [ToolCallRequest("same-call-id", "generate_image", {"prompt": "red square"})])
        return LLMResponse("image completed")

    def get_default_model(self):
        return "fixture-model"


def setup(root, provider):
    image = HostedWorkImageSettings(enabled=True, model="fixture-image",
                                    price=HostedWorkImagePrice(amount_per_image="0.000004"))
    config = HostedWorkConfig(state_dir=str(root), public_origin="https://example.test",
        auth_origin="https://auth.example.test", image_generation=image,
        models={"free": {"label": "fixture", "model": "fixture-model"}})
    store = WorkStore(root / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RUN, model_id="free", text="draw"))
    wallet = Wallet()
    control = ImageControl(config, store, billing_factory=lambda _: wallet)
    capability = control.bind(OWNER, SID, RUN, image, "synthetic-token")
    payload = {"owner": OWNER, "session_id": SID, "run_id": RUN, "model_id": "free", "desktop_ui": True,
               "account_token": "synthetic-token", "hosted_image": {"settings": image.model_dump(),
                                                                          "capability": capability}}
    session = Session("websocket:" + SID)
    ctx = SimpleNamespace(owner=OWNER, config=config, selection=config.models["free"], session_id=SID,
        session=session, sessions=SimpleNamespace(get_or_create=lambda _key: session), provider=provider,
        window=ResolvedContextWindow(262_144, "catalog"), builder=SimpleNamespace(timezone="UTC"))
    sandbox, emit = Sandbox(config), AsyncMock()
    editors = build_editor_tools(config, payload, emit)
    factory, children = build_subagent_factory(ctx, payload, sandbox, provider, emit, None, editors)
    runtime = build_subagent_runtime(ctx, payload, provider, factory)
    return payload, store, wallet, control, capability, sandbox, factory, children, runtime


def png_bytes():
    output = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(output, format="PNG")
    return output.getvalue()


def test_child_operation_ids_are_scoped_and_parent_id_is_unchanged(tmp_path):
    payload = {"owner": OWNER, "session_id": SID, "run_id": RUN,
               "hosted_image": {"settings": HostedWorkImageSettings().model_dump(), "capability": "c" * 43}}
    config = HostedWorkConfig(state_dir=str(tmp_path), public_origin="https://example.test")
    parent = ImageRuntime(config, payload, None, None)
    one = ImageRuntime(config, payload, None, None, operation_scope="1" * 32)
    other = ImageRuntime(config, payload, None, None, operation_scope="2" * 32)
    token = _CALL_ID.set("same-call-id")
    try:
        old = json.dumps(["hosted-image-v1", OWNER, RUN, "same-call-id", 0], separators=(",", ":"))
        assert parent._operation(0) == hashlib.sha256(old.encode()).hexdigest()[:32]
        assert len({parent._operation(0), one._operation(0), other._operation(0)}) == 3
        assert one._operation(0) == one._operation(0) != one._operation(1)
    finally:
        _CALL_ID.reset(token)
    with pytest.raises(ValueError):
        ImageRuntime(config, payload, None, None, operation_scope="invalid")


@pytest.mark.asyncio
async def test_parallel_children_reuse_parent_image_billing_and_deliver_once(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="mwi-child-") as temporary:
        provider = ChildProvider()
        payload, store, wallet, control, capability, sandbox, factory, children, runtime = setup(Path(temporary).resolve(), provider)
        raw, image_runtimes = png_bytes(), []
        both_started = asyncio.Event()
        started = set()

        async def rpc(self, command, args):
            if self not in image_runtimes:
                image_runtimes.append(self)
            common = (self.owner, self.session, self.run, args["capability"])
            if command == "image_begin":
                return await control.begin(*common, args["operation"], args["fingerprint"])
            if command == "image_dispatch":
                return await control.dispatch(*common, args["operation"])
            if command == "image_generate":
                started.add(args["operation"])
                if len(started) == 2:
                    both_started.set()
                await asyncio.wait_for(both_started.wait(), 3)
                await control.finish(*common, args["operation"],
                                     {"sha256": hashlib.sha256(raw).hexdigest(), "image_count": 1})
                return {"status": "settled", "image": {"mime": "image/png", "size": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}}
            raise AssertionError(command)

        monkeypatch.setattr(ImageRuntime, "_post", rpc)
        runtime.manager.max_concurrent_subagents = 2
        try:
            assert "started" in await runtime.spawn_tool.execute("first image")
            assert "started" in await runtime.spawn_tool.execute("second image")
            await asyncio.wait_for(runtime.wait(), 5)
            assert len(image_runtimes) == len(children) == 2
            assert all(tool.registry.has("generate_image") for tool in children)
            assert all(next(item for item in tool.skills.catalog() if item["name"] == "image-generation")["available"]
                       for tool in children)
            assert all(len(tool.pending_delivery_files) == 1 for tool in children)
            assert len(sandbox.files) == 2 and all(data == raw for data in sandbox.files.values())
            assert len({operation for action, operation in wallet.actions if action == "settle"}) == 2
            assert [action for action, _ in wallet.actions].count("reserve") == 2
            assert [action for action, _ in wallet.actions].count("dispatch") == 2
            assert [action for action, _ in wallet.actions].count("settle") == 2
            assert factory._image_runtimes == {}
            assert capability not in str(provider.requests) and payload["account_token"] not in str(provider.requests)

            token = _CALL_ID.set("same-call-id")
            try:
                again = json.loads(await image_runtimes[0].tool().execute(prompt="red square"))
            finally:
                _CALL_ID.reset(token)
            assert again["ok"] is False and len(wallet.actions) == 6
            for owner, sid, run, cap in (("b" * 64, SID, RUN, capability), (OWNER, "3" * 32, RUN, capability),
                                         (OWNER, SID, "4" * 32, capability), (OWNER, SID, RUN, "z" * 43)):
                with pytest.raises(WorkError):
                    await control.begin(owner, sid, run, cap, "d" * 32, "e" * 64)
        finally:
            await runtime.close()
            store.close()


@pytest.mark.asyncio
async def test_child_image_is_not_enabled_without_parent_capability(tmp_path):
    provider = ChildProvider()
    payload, store, _wallet, _control, _capability, sandbox, _factory, _children, runtime = setup(tmp_path, provider)
    try:
        for changes in ({"hosted_image": None}, {"desktop_ui": False}):
            updated = {**payload, **changes}
            ctx = SimpleNamespace(owner=OWNER, config=sandbox.config, selection=sandbox.config.models["free"],
                session_id=SID, session=Session("websocket:" + SID), provider=provider,
                window=ResolvedContextWindow(262_144, "catalog"), builder=SimpleNamespace(timezone="UTC"))
            emit = AsyncMock()
            editors = build_editor_tools(sandbox.config, updated, emit)
            factory, children = build_subagent_factory(ctx, updated, sandbox, provider, emit, None, editors)
            spec = await factory("child", "draw", {"channel": "websocket", "chat_id": SID,
                "session_key": ctx.session.key}, AgentHook(), AsyncMock())
            assert not spec.tools.has("generate_image") and factory._image_runtimes == {}
            assert not next(item for item in children[0].skills.catalog() if item["name"] == "image-generation")["available"]
    finally:
        await runtime.close()
        store.close()


@pytest.mark.asyncio
async def test_stop_cancels_child_image_without_another_dispatch(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="mwi-child-") as temporary:
        provider = ChildProvider()
        _payload, store, _wallet, _control, _capability, _sandbox, factory, _children, runtime = setup(Path(temporary).resolve(), provider)
        entered, calls = asyncio.Event(), []

        async def rpc(_self, command, args):
            calls.append((command, args["operation"]))
            if command == "image_begin":
                return {"status": "reserved"}
            if command == "image_dispatch":
                return {"status": "running"}
            if command == "image_generate":
                entered.set()
                await asyncio.Event().wait()
            if command == "image_uncertain":
                return {"status": "uncertain"}
            raise AssertionError(command)

        monkeypatch.setattr(ImageRuntime, "_post", rpc)
        try:
            await runtime.spawn_tool.execute("draw")
            await asyncio.wait_for(entered.wait(), 5)
            await runtime.close()
            assert [name for name, _ in calls] == ["image_begin", "image_dispatch", "image_generate", "image_uncertain"]
            assert len({operation for _, operation in calls}) == 1
            assert runtime.manager.get_running_count() == 0 and factory._image_runtimes == {}
        finally:
            await runtime.close()
            store.close()
