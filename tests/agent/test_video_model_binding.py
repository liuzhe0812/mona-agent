from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.user_config import load_agent_user_config, save_agent_user_config
from mona.agent.video_model_binding import validate_video_model_binding
from mona.bus.events import InboundMessage
from mona.config.schema import AgentModelBinding, Config, ModelPresetConfig
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorModel, ExecutorProbe
from mona.providers.factory import build_provider_snapshot


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.agent.user_config.get_agent_user_config_path", lambda agent_id: tmp_path / agent_id / "config.json")
    monkeypatch.setattr("mona.webui.settings_api._managed_model_catalog", lambda: {"available": False, "models": []})
    value = Config()
    value.agents.defaults.workspace = str(tmp_path / "workspace")
    value.agents.defaults.provider = "openai"
    value.agents.defaults.model = "main-model"
    value.providers.openai.api_key = "synthetic-fixture"
    value.providers.openai.enabled_models = ["main-model", "video-model"]
    value.providers.openai.discovered_models = [
        {"id": "main-model", "type": "chat", "reasoning_efforts": ["low"]},
        {"id": "video-model", "type": "chat", "reasoning_efforts": ["high"]},
    ]
    value.development.enabled_engines = ["codex", "claude"]
    return value


def _loop(config):
    return AgentLoop.from_config(config, runtime_config_loader=lambda: config,
                                 provider_snapshot_loader=lambda **kwargs: build_provider_snapshot(config, **kwargs))


def test_video_models_and_main_loop_are_independent(config):
    main = _loop(config)
    original_provider = main.provider
    one = main._ensure_document_loop("video", AgentModelBinding(executor="codex", model="one", effort="high"))
    two = main._ensure_document_loop("video", AgentModelBinding(executor="claude", model="two"))
    default = main._ensure_document_loop("video")

    assert one.model == "one" and one.provider.executor.value == "codex"
    assert two.model == "two" and two.provider.executor.value == "claude"
    assert one is main._ensure_document_loop("video", AgentModelBinding(executor="codex", model="one", effort="high"))
    assert default.model == "main-model" and "video" in main._doc_loops
    assert main.provider is original_provider and main.model == "main-model"
    assert config.agents.defaults.executor == "mona"


@pytest.mark.parametrize("preset_owner", ["mona", "default"])
def test_video_inherits_named_preset_but_explicit_binding_stays_independent(config, preset_owner):
    config.model_presets["specific"] = ModelPresetConfig(model="specific-model", provider="openai", reasoning_effort="low")
    if preset_owner == "mona":
        save_agent_user_config("mona", {"model_preset": "specific"}, expected_revision=0)
    else:
        config.agents.defaults.model_preset = "specific"
    main = _loop(config)

    inherited = main._ensure_document_loop("video")
    explicit = main._ensure_document_loop("video", AgentModelBinding(
        executor="mona", provider="openai", model="video-model", effort="high",
    ))
    inherited._refresh_provider_snapshot()
    explicit._refresh_mona_user_config()

    assert inherited.model == "specific-model" and inherited.model_preset == "specific"
    assert inherited.model_presets == main.model_presets
    assert inherited._preset_snapshot_loader is main._preset_snapshot_loader
    assert explicit.model == "video-model" and explicit.model_preset is None
    assert explicit._mona_generation_overrides[2] == "high"
    assert main.model == "specific-model" and main.model_preset == "specific"


def test_video_binding_and_effort_survive_mona_overrides(config):
    save_agent_user_config("mona", {"model_binding": {
        "executor": "codex", "model": "private-mona", "effort": "low",
    }, "reasoning_effort": "low"}, expected_revision=0)
    main = _loop(config)
    video = main._ensure_document_loop("video", AgentModelBinding(
        executor="mona", provider="openai", model="video-model", effort="high",
    ))
    assert video.model == "video-model"
    assert video._mona_generation_overrides[2] == "high"
    current = load_agent_user_config("mona")
    save_agent_user_config("mona", {"model_binding": None, "reasoning_effort": "low"}, expected_revision=current.revision)
    video._refresh_mona_user_config()
    video._refresh_provider_snapshot()

    assert video.model == "video-model" and video.provider.generation.reasoning_effort == "high"
    assert video._mona_generation_overrides[2] == "high"
    assert main.model == "private-mona"


@pytest.mark.asyncio
@pytest.mark.parametrize("snapshot,expected", [("omitted", "persisted"), (None, None), ("queued", "queued")])
async def test_dispatch_uses_message_model_snapshot_before_mutable_session(config, monkeypatch, snapshot, expected):
    main = _loop(config)
    session = main.sessions.get_or_create("websocket:video")
    session.metadata.update(agent_kind="video", model_binding={"executor": "codex", "model": "persisted"})
    main._sync_computer_use_runtime = AsyncMock()
    delegate = SimpleNamespace(_process_message=AsyncMock(return_value="delegated"))
    ensure = MagicMock(return_value=delegate)
    monkeypatch.setattr(main, "_ensure_document_loop", ensure)
    metadata = {"agent_kind": "video"}
    if snapshot != "omitted":
        metadata["model_binding"] = {"executor": "claude", "model": snapshot} if snapshot is not None else None
    await main._process_message(InboundMessage(channel="websocket", sender_id="u", chat_id="video", content="make", metadata=metadata))
    if expected is None:
        ensure.assert_called_once_with("video")
    else:
        assert ensure.call_args.args[1].model == expected
    delegate._process_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_different_model_followup_waits_for_next_turn_preserving_queue_order(config):
    from mona.agent.runner import AgentRunResult

    main = _loop(config)
    binding = {"executor": "codex", "model": "current", "provider": None, "effort": None}
    video = main._ensure_document_loop("video", AgentModelBinding.model_validate(binding))
    queue = asyncio.Queue()
    for model, content in [("current", "same model"), ("next", "other model"), ("current", "later")]:
        queue.put_nowait(InboundMessage(channel="websocket", sender_id="u", chat_id="video", content=content,
                                      metadata={"agent_kind": "video", "model_binding": {**binding, "model": model}}))
    async def run(spec):
        injected = await spec.injection_callback()
        assert [message["content"] for message in injected] == ["same model"]
        assert await spec.injection_callback() == []
        return AgentRunResult(final_content="done", messages=[])
    video.runner.run = run
    await video._run_agent_loop([], metadata={"agent_kind": "video", "model_binding": binding}, pending_queue=queue)
    assert [queue.get_nowait().content, queue.get_nowait().content] == ["other model", "later"]


@pytest.mark.asyncio
async def test_api_selection_checks_visible_catalog_and_effort(config):
    raw = {"executor": "mona", "provider": "openai", "model": "video-model", "effort": "high"}
    assert await validate_video_model_binding(raw, config) == raw
    with pytest.raises(ValueError, match="强度"):
        await validate_video_model_binding({**raw, "effort": "low"}, config)
    config.providers.openai.enabled_models = ["main-model"]
    with pytest.raises(ValueError, match="已隐藏"):
        await validate_video_model_binding(raw, config)


@pytest.mark.asyncio
@pytest.mark.parametrize("auth,model,effort,accepted", [
    ("ready", "native-model", "high", True),
    ("unknown", "native-model", None, True),
    ("required", "native-model", None, False),
    ("ready", "missing", None, False),
    ("ready", "native-model", "low", False),
])
async def test_native_selection_uses_existing_probe_without_a_task(config, tmp_path, monkeypatch, auth, model, effort, accepted):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr("mona.development.executors.discovery.discover_executors", lambda _: [
        ExecutorProbe(executor=ExecutorId.CODEX, state="detected", executable="fixture.exe"),
    ])
    profile = MagicMock()
    monkeypatch.setattr("mona.development.executors.codex_policy.prepare_codex_profile", profile)
    host = MagicMock()
    host.probe = AsyncMock(return_value=ExecutorProbe(
        executor=ExecutorId.CODEX, state="detected", protocol_verified=True, authentication=auth,
        model_details=[ExecutorModel(id="native-model", label="Native", reasoning_efforts=["high"])],
    ))
    host.shutdown = AsyncMock()
    monkeypatch.setattr("mona.development.executors.codex.CodexExecutor", lambda _: host)
    raw = {"executor": "codex", "model": model, "effort": effort}
    if accepted:
        assert (await validate_video_model_binding(raw, config))["model"] == model
    else:
        with pytest.raises(ValueError):
            await validate_video_model_binding(raw, config)
    host.shutdown.assert_awaited_once()
    host.create_session.assert_not_called()
    host.send.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_native_selection_does_not_probe(config, monkeypatch):
    config.development.enabled_engines = []
    discover = MagicMock()
    monkeypatch.setattr("mona.development.executors.discovery.discover_executors", discover)
    with pytest.raises(ValueError, match="已停用"):
        await validate_video_model_binding({"executor": "codex", "model": "x"}, config)
    discover.assert_not_called()
