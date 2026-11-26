"""Provider-declared reasoning capabilities and token counts."""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from mona.config.schema import Config
from mona.providers.anthropic_provider import AnthropicProvider
from mona.providers.factory import make_provider
from mona.providers.openai_compat_provider import OpenAICompatProvider
from mona.providers.reasoning import normalize_reasoning_metadata
from mona.providers.registry import find_by_name


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        (
            {
                "reasoning_efforts": ["high", "low", "none"],
                "default_reasoning_effort": "low",
            },
            {"reasoning_efforts": ["high", "low"], "default_reasoning_effort": "low"},
        ),
        (
            {
                "reasoning": {
                    "supportedEfforts": ["minimal", "xhigh"],
                    "defaultEffort": "xhigh",
                }
            },
            {"reasoning_efforts": ["minimal", "xhigh"], "default_reasoning_effort": "xhigh"},
        ),
        (
            {
                "supported_efforts": ["max", "medium"],
                "default_effort": "max",
            },
            {"reasoning_efforts": ["max", "medium"], "default_reasoning_effort": "max"},
        ),
        (
            {
                "effort": {
                    "supported_levels": ["adaptive", "minimum"],
                    "default_level": "minimum",
                }
            },
            {"reasoning_efforts": ["adaptive", "minimum"], "default_reasoning_effort": "minimum"},
        ),
        (
            {
                "capabilities": {
                    "effort": {
                        "supported": True,
                        "levels": {
                            "high": {"supported": True},
                            "max": {"supported": True},
                            "low": {"supported": True},
                            "medium": {"supported": True},
                        },
                        "default_level": "low",
                    },
                    "thinking": {"supported": False},
                }
            },
            {
                "reasoning_efforts": ["low", "medium", "high", "max"],
                "default_reasoning_effort": "low",
            },
        ),
        (
            {"reasoning_efforts": [], "default_reasoning_effort": "high"},
            {"reasoning_efforts": []},
        ),
        (
            {"capabilities": {"thinking": {"supported": False}}},
            {},
        ),
        (
            {"capabilities": {"effort": {"supported": True, "levels": {"low": {"other": True}}}}},
            {},
        ),
        (
            {
                "capabilities": {
                    "thinking": {
                        "types": {"adaptive": {"supported": False}}
                    }
                }
            },
            {"supports_adaptive_thinking": False},
        ),
    ],
)
def test_normalizes_declared_effort_aliases_without_inventing_levels(
    model: dict[str, object], expected: dict[str, object]
) -> None:
    assert normalize_reasoning_metadata(model) == expected


def test_keeps_only_bounded_effort_tokens_and_provider_order() -> None:
    assert normalize_reasoning_metadata(
        {"supported_efforts": ["XHIGH", "low", "a" * 33, 5]}
    ) == {"reasoning_efforts": ["xhigh", "low"]}


@pytest.mark.parametrize(
    "model",
    [
        {"reasoning_efforts": "high"},
        {"reasoning_efforts": ["low", "x" * 33]},
        {"reasoning_efforts": ["low"] * 17},
        {"reasoning_efforts": ["low"], "default_reasoning_effort": "high"},
        {"supportsAdaptiveThinking": "false"},
        {"reasoning": {"supportedEfforts": "low"}},
        {"capabilities": {"effort": {"supported": True, "levels": {}}}},
        {
            "capabilities": {
                "thinking": {"types": {"adaptive": {"supported": "yes"}}}
            }
        },
    ],
)
def test_strict_save_validation_rejects_invalid_declared_metadata(
    model: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        normalize_reasoning_metadata(model, strict=True)


@pytest.mark.parametrize(("details", "expected"), [
    ({"reasoning_tokens": 6}, 6),
    ({"thinking_tokens": 0}, 0),
    ({}, None),
])
def test_chat_stream_retains_reported_reasoning_until_request_end(details, expected):
    result = OpenAICompatProvider._parse_chunks([
        {
            "choices": [{"delta": {"reasoning_content": "working"}}],
            "usage": {"completion_tokens": 8, "output_tokens_details": details},
        },
        {"choices": [], "usage": {"completion_tokens": 20}},
    ])
    assert result.usage["completion_tokens"] == 20
    assert result.usage.get("reasoning_tokens") == expected


def test_anthropic_normalizes_the_reported_thinking_token_count():
    response = SimpleNamespace(content=[], stop_reason="end_turn", usage=SimpleNamespace(
        input_tokens=20, output_tokens=80, output_tokens_details=SimpleNamespace(thinking_tokens=30),
    ))
    usage = AnthropicProvider._parse_response(response).usage
    assert usage == {"prompt_tokens": 20, "completion_tokens": 80, "total_tokens": 100, "reasoning_tokens": 30}


@pytest.mark.asyncio
async def test_bailian_snapshot_efforts_reach_the_serialized_chat_request(tmp_path, monkeypatch):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "fixture")
    model = "deepseek-v4.1-flash-1017"
    bodies = []
    targets = []

    def upstream(request: httpx.Request) -> httpx.Response:
        targets.append(str(request.url))
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={
            "id": "fixture", "object": "chat.completion", "created": 1, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Done"}, "finish_reason": "stop"}],
        })

    for effort in ("low", "high", "max", None):
        config = Config.model_validate({
            "agents": {"defaults": {"model": model, "provider": "aliyun-bailian-token-plan-cn", "reasoningEffort": effort}},
            "providers": {"cindy": {"aliyun-bailian-token-plan-cn": {"apiKey": "fixture"}}},
        })
        provider = make_provider(config, http_client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        try:
            response = await provider.chat_with_retry(messages=[{"role": "user", "content": "Test"}])
            assert response.content == "Done"
        finally:
            await provider.aclose()

    assert set(targets) == {"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"}
    # The factory reapplies the selected route's recommended high on reset.
    assert [body.get("reasoning_effort") for body in bodies] == ["low", "high", "max", "high"]
    assert all(body["enable_thinking"] is True for body in bodies)
    assert all(body["model"] == model and "chat_template_kwargs" not in body for body in bodies)


def _chat_body(provider, effort):
    return provider._build_kwargs([{"role": "user", "content": "Test"}], None, None, 256, 0.2, effort, None)


def test_custom_connections_use_only_their_own_serializer_and_declared_efforts():
    model = "deepseek-v4.1-flash-1017"
    spec = find_by_name("custom-example")
    for base, expected in (
        ("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", {"enable_thinking": True}),
        ("https://opaque.example/v1", {}),
    ):
        provider = OpenAICompatProvider(default_model=model, api_base=base, spec=spec,
                                        model_metadata=[{"id": model, "reasoning_efforts": ["low", "high", "max"]}])
        body = _chat_body(provider, "max")
        assert body["reasoning_effort"] == "max"
        assert body.get("extra_body", {}) == expected


@pytest.mark.parametrize(("declared", "requested"), [([], "low"), (["low", "high"], "off"), (["off", "on"], "max")])
def test_custom_connection_rejects_a_choice_absent_from_its_declaration(declared, requested):
    provider = OpenAICompatProvider(default_model="private-id", api_base="https://opaque.example/v1",
        spec=find_by_name("custom-example"), model_metadata=[{"id": "private-id", "reasoning_efforts": declared}])
    with pytest.raises(ValueError, match="不支持"):
        _chat_body(provider, requested)


def test_bailian_binary_model_receives_a_switch_and_honors_newer_declared_strengths():
    spec = find_by_name("aliyun-bailian-token-plan-cn")
    model = "qwen3.7-plus"
    binary = OpenAICompatProvider(default_model=model, spec=spec)
    assert "extra_body" not in _chat_body(binary, None)
    for choice in ("off", "on"):
        body = _chat_body(binary, choice)
        assert body["extra_body"] == {"enable_thinking": choice == "on"}
        assert "reasoning_effort" not in body

    named = OpenAICompatProvider(default_model=model, spec=spec,
                                model_metadata=[{"id": model, "reasoning_efforts": ["low", "high"]}])
    body = _chat_body(named, "low")
    assert body["reasoning_effort"] == "low"
    assert body["extra_body"] == {"enable_thinking": True}
    with pytest.raises(ValueError, match="不能关闭"):
        _chat_body(OpenAICompatProvider(default_model="deepseek-v4.1-flash-1017", spec=spec), "off")


def test_anthropic_catalog_effort_uses_the_messages_protocol():
    provider = AnthropicProvider(api_key="fixture", api_base="https://api.anthropic.com", default_model="claude-sonnet-4-6")
    body = _chat_body(provider, "max")
    assert body["output_config"] == {"effort": "max"}
    assert body["thinking"] == {"type": "adaptive"}
    assert "reasoning_effort" not in body


def test_openrouter_has_one_transport_and_keeps_its_existing_model_extensions():
    from mona.providers.registry import PROVIDERS

    routes = [spec for spec in PROVIDERS if spec.name == "openrouter"]
    assert len(routes) == 1
    provider = OpenAICompatProvider(default_model="xiaomi/mimo-v2.5-pro", spec=routes[0])
    body = _chat_body(provider, "medium")
    assert body["extra_body"] == {"reasoning": {"effort": "medium"}, "thinking": {"type": "enabled"}}


@pytest.mark.parametrize(("base", "model", "effort", "expected"), [
    ("https://api.deepseek.com", "deepseek-v4-pro", "max", {"thinking": {"type": "enabled"}, "reasoning_effort": "max"}),
    ("https://api.z.ai/api/coding/paas/v4", "glm-4.7", "on", {"thinking": {"type": "enabled", "clear_thinking": False}}),
    ("https://api.together.ai/v1", "Qwen/Qwen3.5-9B", "off", {"reasoning": {"enabled": False}}),
    ("https://inference.baseten.co/v1", "zai-org/GLM-5.2", "max", {"chat_template_args": {"enable_thinking": True}, "reasoning_effort": "max"}),
    ("https://api.ant-ling.com/v1", "Ring-2.6-1T", "xhigh", {"reasoning": {"effort": "xhigh"}}),
    ("https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/glm-5p2", "low", {"reasoning_effort": "high"}),
])
def test_exact_compatible_endpoint_controls_use_its_wire_protocol(base, model, effort, expected):
    provider = OpenAICompatProvider(default_model=model, api_base=base, spec=find_by_name("custom-example"))
    body = _chat_body(provider, effort)
    actual = dict(body.get("extra_body", {}))
    if "reasoning_effort" in body:
        actual["reasoning_effort"] = body["reasoning_effort"]
    assert actual == expected


def test_responses_api_maps_the_selected_level_in_its_own_protocol():
    provider = OpenAICompatProvider(default_model="gpt-5.3-codex", api_base="https://api.individual.githubcopilot.com",
                                    spec=find_by_name("github_copilot"))
    body = provider._build_responses_body([{"role": "user", "content": "Test"}], None, None, 256, 0.2, "minimal", None)
    assert body["reasoning"] == {"effort": "low"}
