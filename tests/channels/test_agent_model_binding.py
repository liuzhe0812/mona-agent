from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.partners import AgentDefinition
from mona.channels.websocket import WebSocketChannel
from mona.config.schema import Config
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorProbe

AGENT_ID = "com.example.model-binding"


def _channel(definition: AgentDefinition) -> WebSocketChannel:
    channel = WebSocketChannel({"enabled": True}, MagicMock())
    channel._room_agent_registry = lambda: SimpleNamespace(get=lambda _agent_id: definition)
    channel._send_event = AsyncMock()  # type: ignore[method-assign]
    channel._broadcast_agent_event = AsyncMock()  # type: ignore[method-assign]
    return channel


def _api_model_config(*, visible: bool = True) -> Config:
    config = Config()
    config.providers.openai.api_key = "configured-fixture"
    config.providers.openai.enabled_models = ["api-fixture"] if visible else []
    config.providers.openai.discovered_models = [
        {
            "id": "api-fixture",
            "type": "chat",
            "reasoning_efforts": ["high"],
            "default_reasoning_effort": "high",
        }
    ]
    return config


def _patch_agent_config_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    config_path = tmp_path / "agent-config.json"
    monkeypatch.setattr(
        "mona.agent.user_config.get_agent_user_config_path",
        lambda _agent_id: config_path,
    )
    return config_path


async def _update(channel: WebSocketChannel, binding: dict) -> None:
    await channel._handle_agent_config_update_envelope(
        object(),
        {
            "agent_id": AGENT_ID,
            "request_id": "request-1",
            "config": {"model_binding": binding},
        },
    )


@pytest.mark.asyncio
async def test_agent_update_accepts_visible_mona_api_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = _patch_agent_config_path(monkeypatch, tmp_path)
    monkeypatch.setattr("mona.config.loader.load_config", _api_model_config)
    channel = _channel(AgentDefinition(id=AGENT_ID, display_name="Agent"))

    await _update(
        channel,
        {
            "executor": "mona",
            "model": "api-fixture",
            "provider": "openai",
            "effort": "high",
        },
    )

    result = channel._send_event.await_args
    assert result.args[1] == "agent_config_update_result"
    assert result.kwargs["ok"] is True
    assert result.kwargs["config"]["modelBinding"] == {
        "executor": "mona",
        "model": "api-fixture",
        "provider": "openai",
        "effort": "high",
    }
    assert config_path.exists()


@pytest.mark.asyncio
async def test_agent_update_rejects_hidden_mona_api_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = _patch_agent_config_path(monkeypatch, tmp_path)
    monkeypatch.setattr(
        "mona.config.loader.load_config",
        lambda: _api_model_config(visible=False),
    )
    channel = _channel(AgentDefinition(id=AGENT_ID, display_name="Agent"))

    await _update(
        channel,
        {"executor": "mona", "model": "api-fixture", "provider": "openai"},
    )

    result = channel._send_event.await_args
    assert result.kwargs["ok"] is False
    assert "模型未配置或已隐藏" in result.kwargs["detail"]
    assert not config_path.exists()


@pytest.mark.asyncio
async def test_agent_update_rejects_native_source_when_disabled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = _patch_agent_config_path(monkeypatch, tmp_path)
    config = Config()
    monkeypatch.setattr("mona.config.loader.load_config", lambda: config)
    discover = MagicMock(return_value=[
        ExecutorProbe(executor=ExecutorId.CODEX, state="detected", executable="codex")
    ])
    monkeypatch.setattr("mona.development.executors.discovery.discover_executors", discover)
    channel = _channel(AgentDefinition(id=AGENT_ID, display_name="Agent"))

    await _update(channel, {"executor": "codex", "model": "codex-fixture"})

    result = channel._send_event.await_args
    assert result.kwargs["ok"] is False
    assert "已停用" in result.kwargs["detail"]
    discover.assert_not_called()
    assert not config_path.exists()


@pytest.mark.asyncio
async def test_agent_update_rejects_native_source_without_local_executable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = _patch_agent_config_path(monkeypatch, tmp_path)
    config = Config()
    config.development.enabled_engines = ["codex"]
    monkeypatch.setattr("mona.config.loader.load_config", lambda: config)
    monkeypatch.setattr(
        "mona.development.executors.discovery.discover_executors",
        lambda _development: [
            ExecutorProbe(executor=ExecutorId.CODEX, state="not_detected")
        ],
    )
    channel = _channel(AgentDefinition(id=AGENT_ID, display_name="Agent"))

    await _update(channel, {"executor": "codex", "model": "codex-fixture"})

    result = channel._send_event.await_args
    assert result.kwargs["ok"] is False
    assert "未找到" in result.kwargs["detail"]
    assert not config_path.exists()


@pytest.mark.asyncio
async def test_agent_update_rejects_provider_on_native_binding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = _patch_agent_config_path(monkeypatch, tmp_path)
    channel = _channel(AgentDefinition(id=AGENT_ID, display_name="Agent"))

    await _update(
        channel,
        {"executor": "claude", "model": "claude-fixture", "provider": "openai"},
    )

    result = channel._send_event.await_args
    assert result.kwargs["ok"] is False
    assert "Only Mona" in result.kwargs["detail"]
    assert not config_path.exists()
