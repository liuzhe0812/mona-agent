import json
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from aiohttp.test_utils import make_mocked_request

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.api.server import handle_usage_get
from mona.config.schema import AgentDefaults
from mona.providers.base import LLMProvider, LLMResponse
from mona.usage import get_usage_summary, record_model_usage, record_provider_usage


class UsageTestProvider(LLMProvider):
    async def chat(self, *args, **kwargs):
        return LLMResponse(
            content="done",
            usage={"prompt_tokens": 60, "completion_tokens": 20},
        )

    def get_default_model(self) -> str:
        return "byok-model"


def test_usage_summary_groups_all_local_provider_calls(monkeypatch, tmp_path):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    now = datetime(2026, 8, 28, 4, 0, tzinfo=timezone.utc)
    record_model_usage(
        provider="DeepSeek",
        model="deepseek-chat",
        usage={"prompt_tokens": 100, "completion_tokens": 20, "cached_tokens": 40},
        created_at=datetime(2026, 8, 27, 15, 0, tzinfo=timezone.utc),
    )
    record_model_usage(
        provider="Mona 托管模型",
        model="deepseek-v4-flash",
        usage={"prompt_tokens": 50, "completion_tokens": 10},
        created_at=datetime(2026, 8, 28, 2, 0, tzinfo=timezone.utc),
    )

    summary = get_usage_summary(480, now=now)

    assert summary["today_tokens"] == 60
    assert summary["period_tokens"] == 180
    assert summary["request_count"] == 2
    assert summary["model_count"] == 2
    assert summary["provider_count"] == 2
    assert summary["by_model"][0]["provider"] == "DeepSeek"
    assert summary["recent"][0]["model"] == "deepseek-v4-flash"


def test_direct_provider_response_is_persisted(monkeypatch, tmp_path):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    provider = MagicMock(spec=LLMProvider)
    provider.get_default_model.return_value = "Qwen/Qwen3-Coder-480B-A35B-Instruct"
    record_provider_usage(
        provider,
        None,
        LLMResponse(content="done", usage={"prompt_tokens": 80, "completion_tokens": 20}),
    )

    summary = get_usage_summary(480)
    assert summary["request_count"] == 1
    assert summary["by_model"][0]["model"] == "Qwen/Qwen3-Coder-480B-A35B-Instruct"


def test_model_totals_include_cached_input_once_and_keep_providers_separate(monkeypatch, tmp_path):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    for provider, prompt, completion, cached in [
        ("Provider A", 100, 20, 40),
        ("Provider A", 900, 180, 90),
        ("Provider B", 300, 10, 300),
    ]:
        record_model_usage(
            provider=provider,
            model="shared-model",
            usage={"prompt_tokens": prompt, "completion_tokens": completion, "cached_tokens": cached},
        )

    summary = get_usage_summary(480)
    rows = {row["provider"]: row for row in summary["by_model"]}
    assert rows["Provider A"] == {
        "provider": "Provider A", "model": "shared-model", "prompt_tokens": 1_000,
        "completion_tokens": 200, "cached_tokens": 130, "total_tokens": 1_200,
        "request_count": 2,
    }
    assert rows["Provider A"]["cached_tokens"] / rows["Provider A"]["prompt_tokens"] == 0.13
    assert rows["Provider B"]["cached_tokens"] / rows["Provider B"]["prompt_tokens"] == 1
    assert summary["period_tokens"] == 1_510


@pytest.mark.asyncio
async def test_runner_records_usage_for_every_model_response(monkeypatch, tmp_path):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    provider = UsageTestProvider()
    tools = MagicMock()
    tools.get_definitions.return_value = []

    await AgentRunner(provider).run(
        AgentRunSpec(
            initial_messages=[],
            tools=tools,
            model="byok-model",
            max_iterations=1,
            max_tool_result_chars=AgentDefaults().max_tool_result_chars,
        )
    )

    summary = get_usage_summary(480)
    assert summary["request_count"] == 1
    assert summary["by_model"][0]["model"] == "byok-model"


@pytest.mark.asyncio
async def test_gateway_usage_route_reads_local_summary(monkeypatch, tmp_path):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    record_model_usage(
        provider="DeepSeek",
        model="deepseek-chat",
        usage={"prompt_tokens": 20, "completion_tokens": 5},
    )

    response = await handle_usage_get(
        make_mocked_request("GET", "/api/usage?tz_offset_minutes=480")
    )

    assert response.status == 200
    assert json.loads(response.text)["period_tokens"] == 25
