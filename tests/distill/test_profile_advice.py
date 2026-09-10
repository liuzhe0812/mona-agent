from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

from mona.distill.base import DistillContext
from mona.distill.tasks.advice import AdviceTask, _parse_search_results
from mona.distill.tasks.profile import ProfileTask
from mona.providers.base import LLMResponse


class _Provider:
    def __init__(self, payload: dict | list[dict]):
        self.payloads = payload if isinstance(payload, list) else [payload]
        self.calls: list[dict] = []

    async def chat(self, **kwargs):
        self.calls.append(kwargs)
        payload = self.payloads[min(len(self.calls) - 1, len(self.payloads) - 1)]
        return LLMResponse(content=json.dumps(payload, ensure_ascii=False))


def _config():
    return SimpleNamespace(
        profile_max_output_tokens=4096,
        advice_max_output_tokens=8192,
        llm_timeout_seconds=3,
        max_input_tokens=12000,
        max_advice_history=100,
    )


def _evidence():
    return {
        "session-message:one": {
            "ref": "session-message:one",
            "kind": "user_message",
            "source_scope_id": "scope:test",
            "title": "画像设计",
            "occurred_at": "2026-09-08T08:00:00+00:00",
            "excerpt": "我想把画像改成 AI 眼中的用户，并给出可以直接开始的建议。",
            "truncated": False,
            "session_key": "websocket:test-one",
            "message_index": 1,
            "content_hash": "a" * 64,
        },
        "session-message:two": {
            "ref": "session-message:two",
            "kind": "user_message",
            "source_scope_id": "scope:test",
            "title": "验收设计",
            "occurred_at": "2026-09-07T08:00:00+00:00",
            "excerpt": "调整后的结果更好，所以我准备用这个方案。",
            "truncated": False,
            "session_key": "websocket:test-two",
            "message_index": 2,
            "content_hash": "b" * 64,
        },
    }


def _holistic_evidence():
    return [
        {"ref": value["ref"], "session_key": value["session_key"], "title": value["title"], "occurred_at": value["occurred_at"], "content": value["excerpt"]}
        for value in _evidence().values()
    ]


def test_search_result_parser_keeps_only_safe_real_urls(monkeypatch) -> None:
    monkeypatch.setattr(
        "mona.security.network.validate_url_target",
        lambda url: (url.startswith("https://docs.example.org/"), ""),
    )
    raw = (
        "Results for: 因果推断\n\n"
        "1. 因果推断入门\n"
        "   https://docs.example.org/causal\n"
        "   介绍合理对照与混杂因素。\n"
        "2. 内部地址\n"
        "   http://127.0.0.1/private\n"
        "   不应保留。"
    )

    resources = _parse_search_results(raw)

    assert len(resources) == 1
    assert resources[0]["url"] == "https://docs.example.org/causal"


def test_profile_understanding_accepts_only_known_source_refs(tmp_path) -> None:
    provider = _Provider(
        {
            "understanding": [
                {
                    "field": "current_focus",
                    "text": "正在把用户画像改造成可行动的使用仪表盘",
                    "source_refs": ["session-message:one"],
                },
                {
                    "field": "background",
                    "text": "没有依据",
                    "source_refs": ["made-up"],
                },
            ]
        }
    )
    ctx = DistillContext(
        workspace=tmp_path,
        memory_dir=tmp_path,
        provider=provider,
        model_name="test",
        since=datetime(2026, 8, 9, tzinfo=timezone.utc),
        until=datetime(2026, 9, 8, tzinfo=timezone.utc),
        profile_config=_config(),
    )
    result = asyncio.run(
        ProfileTask().distill(
            ctx,
            {
                "evidence_index": _evidence(),
                "effective_context": [],
                "context_revision": 0,
                "coverage": [],
                "notes": {},
            },
        )
    )
    assert result.success
    assert result.data["understanding"] == [
        {
            "field": "current_focus",
            "text": "正在把用户画像改造成可行动的使用仪表盘",
            "source_refs": ["session-message:one"],
            "observed_at": "2026-09-08T08:00:00+00:00",
        }
    ]


def test_advice_generates_one_insight_with_learning_advice_and_resources(
    tmp_path,
    monkeypatch,
) -> None:
    provider = _Provider(
        {
            "knowledge": {
                "title": "AI 能否真正了解你，取决于它看到了什么",
                "content": "聊天记录已经保存，并不意味着模型每次都能用到。",
            },
            "learning_advice": "先分清当前对话、长期保存的信息和检索补回的内容。",
            "resources": [
                {
                    "title": "短期与长期记忆",
                    "url": "https://docs.example.org/memory",
                }
            ],
            "empty_reason": "",
        }
    )

    async def searched(_knowledge_title, _suggested):
        return [
            {
                "title": "短期与长期记忆",
                "url": "https://docs.example.org/memory",
            }
        ]

    monkeypatch.setattr("mona.distill.tasks.advice._search_resources", searched)
    ctx = DistillContext(
        workspace=tmp_path,
        memory_dir=tmp_path,
        provider=provider,
        model_name="test",
        since=datetime(2026, 8, 9, tzinfo=timezone.utc),
        until=datetime(2026, 9, 8, tzinfo=timezone.utc),
        profile_config=_config(),
    )
    rich = {
        "facts": {"explicit_context": {}, "context_revision": 0},
        "profile": {"understanding": []},
        "advice": {"items": []},
        "feedback": {"advice": {}},
    }
    result = asyncio.run(
        AdviceTask().distill(
            ctx,
            {
                "rich": rich,
                "evidence_index": _evidence(),
                "holistic_evidence": _holistic_evidence(),
                "coverage": [],
                "source_scope_id": "scope:test",
            },
        )
    )
    assert result.success
    item = result.data["items"][0]
    assert item["source_refs"] == ["session-message:one", "session-message:two"]
    assert item["kind"] == "one_insight"
    assert item["knowledge"]["title"] == "AI 能否真正了解你，取决于它看到了什么"
    assert "长期保存" in item["learning_advice"]
    assert item["resources"][0]["url"] == "https://docs.example.org/memory"
    assert result.data["current_ids"] == [item["id"]]
    assert len(provider.calls) == 1
    assert provider.calls[0]["messages"][0]["role"] == "user"
    assert len(provider.calls[0]["messages"]) == 1


def test_advice_can_return_no_insight_when_context_is_insufficient(tmp_path) -> None:
    provider = _Provider(
        {
            "knowledge": None,
            "learning_advice": "",
            "resources": [],
            "empty_reason": "目前还没有足够的信息。",
        }
    )
    ctx = DistillContext(
        workspace=tmp_path,
        memory_dir=tmp_path,
        provider=provider,
        model_name="test",
        profile_config=_config(),
    )
    result = asyncio.run(
        AdviceTask().distill(
            ctx,
            {
                "rich": {
                    "facts": {"explicit_context": {}, "context_revision": 0},
                    "profile": {"understanding": []},
                    "advice": {"items": []},
                    "feedback": {"advice": {}},
                },
                    "evidence_index": _evidence(),
                    "holistic_evidence": _holistic_evidence(),
                "coverage": [],
                "source_scope_id": "scope:test",
            },
        )
    )
    assert result.status == "empty"
    assert result.data["current_ids"] == []
    assert result.data["empty_reason"] == "目前还没有足够的信息。"
