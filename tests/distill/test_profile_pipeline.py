from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from mona.config.schema import ProfileConfig
from mona.distill.base import DistillContext
from mona.distill.store import read_rich_profile
from mona.providers.base import LLMResponse


class _Provider:
    async def chat(self, *, messages, **_kwargs):
        prompt = "\n".join(str(message.get("content") or "") for message in messages)
        if "非常有必要知道" in prompt:
            return LLMResponse(
                content=json.dumps(
                    {
                        "knowledge": {
                            "title": "先确认 AI 实际看到了哪些信息",
                            "content": "保存聊天记录不等于模型每次都能使用全部记录。",
                        },
                        "learning_advice": "先查看一次真实分析的输入范围。",
                        "resources": [],
                        "empty_reason": "",
                    },
                    ensure_ascii=False,
                )
            )
        return LLMResponse(
            content=json.dumps(
                {
                    "understanding": [
                        {
                            "field": "current_focus",
                            "text": "正在改造用户画像仪表盘",
                            "source_refs": [self.source_ref],
                        }
                    ]
                },
                ensure_ascii=False,
            )
        )

    source_ref = ""


def test_pipeline_keeps_dashboard_when_work_pattern_has_no_calls(tmp_path, monkeypatch) -> None:
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    message = {
        "role": "user",
        "content": "请把画像改成 AI 眼中的用户，并给我可以直接起步的建议。",
        "timestamp": (now - timedelta(days=1)).isoformat(),
    }
    metadata = {
        "_type": "metadata",
        "key": "websocket:profile-test",
        "created_at": (now - timedelta(days=2)).isoformat(),
        "updated_at": (now - timedelta(days=1)).isoformat(),
        "metadata": {"title": "画像改造"},
    }
    (sessions / "profile-test.jsonl").write_text(
        "\n".join(json.dumps(item, ensure_ascii=False) for item in [metadata, message]) + "\n",
        encoding="utf-8",
    )

    from mona.distill import service
    from mona.distill.collectors.session_collector import collect_session_topics

    stats = collect_session_topics(
        tmp_path,
        periods={"current": (now - timedelta(days=30), now)},
    )
    provider = _Provider()
    provider.source_ref = stats.message_events[0]["ref"]
    ctx = DistillContext(
        workspace=tmp_path,
        memory_dir=tmp_path / "profile",
        provider=provider,
        model_name="test",
        since=now - timedelta(days=30),
        until=now,
        as_of=now,
        profile_config=ProfileConfig(timezone="UTC"),
    )
    monkeypatch.setattr(service, "build_context", lambda: ctx)
    monkeypatch.setattr(service, "_get_notes_vault", lambda: None)

    async def no_resources(_knowledge_title, _suggested):
        return []

    monkeypatch.setattr("mona.distill.tasks.advice._search_resources", no_resources)

    results = asyncio.run(service.run_all_distill())
    by_task = {result.task_name: result for result in results}
    assert by_task["dashboard"].success
    assert by_task["work-pattern"].success is False
    assert by_task["profile"].success
    assert by_task["advice"].success

    stored = read_rich_profile(ctx.memory_dir)
    assert stored["dashboard"]["metrics"]["user_messages"]["current"]["value"] == 1
    assert stored["dashboard"]["profile_charts"]["profile_dimensions"]
    assert stored["dashboard"]["profile_charts"]["collaboration_types"]
    assert stored["profile"]["understanding"][0]["text"] == "正在改造用户画像仪表盘"
    assert len(stored["advice"]["current_ids"]) == 1
    assert stored["advice"]["items"][0]["kind"] == "one_insight"


def test_current_evidence_rejects_previous_window_items() -> None:
    from mona.distill.service import _is_current_evidence

    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    context = DistillContext(
        workspace=Path("."),
        memory_dir=Path("."),
        since=now - timedelta(days=30),
        until=now,
    )
    assert _is_current_evidence(
        {"kind": "user_message", "occurred_at": (now - timedelta(days=1)).isoformat()},
        context,
    )
    assert not _is_current_evidence(
        {"kind": "note", "occurred_at": (now - timedelta(days=31)).isoformat()},
        context,
    )


def test_holistic_sample_rotates_across_independent_sessions() -> None:
    from mona.distill.service import _select_holistic_events

    events = [
        {"ref": "a-new", "session_key": "a", "occurred_at": "2026-09-08", "content": "A2"},
        {"ref": "a-old", "session_key": "a", "occurred_at": "2026-09-01", "content": "A1"},
        {"ref": "b-new", "session_key": "b", "occurred_at": "2026-09-07", "content": "B1"},
        {"ref": "c-new", "session_key": "c", "occurred_at": "2026-09-06", "content": "C1"},
    ]

    selected = _select_holistic_events(events, max_sessions=2, max_messages=3)

    assert [item["ref"] for item in selected] == ["a-new", "b-new", "a-old"]
