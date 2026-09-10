from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from mona.distill.dashboard import build_dashboard, compute_source_scope_id
from mona.distill.models import EvidenceRef


def _write_session(workspace: Path, name: str, messages: list[dict]) -> None:
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    metadata = {
        "_type": "metadata",
        "key": f"websocket:{name}",
        "created_at": "2026-07-01T00:00:00+00:00",
        "updated_at": "2026-09-07T12:00:00+00:00",
        "metadata": {"title": name},
    }
    (sessions / f"{name}.jsonl").write_text(
        "\n".join(json.dumps(item, ensure_ascii=False) for item in [metadata, *messages]) + "\n",
        encoding="utf-8",
    )


def test_dashboard_uses_full_counts_and_adjacent_equal_windows(tmp_path: Path) -> None:
    _write_session(
        tmp_path,
        "current-a",
        [
            {"role": "user", "content": "当前一", "timestamp": "2026-09-07T10:00:00+08:00"},
            {"role": "user", "content": "当前二", "timestamp": "2026-09-01T10:00:00+08:00"},
        ],
    )
    _write_session(
        tmp_path,
        "current-b",
        [{"role": "user", "content": "当前三", "timestamp": "2026-09-06T10:00:00+08:00"}],
    )
    _write_session(
        tmp_path,
        "previous",
        [{"role": "user", "content": "前期", "timestamp": "2026-07-20T10:00:00+08:00"}],
    )
    _write_session(
        tmp_path,
        "outside",
        [{"role": "user", "content": "更早", "timestamp": "2026-06-01T10:00:00+08:00"}],
    )

    dashboard = build_dashboard(
        tmp_path,
        None,
        as_of=datetime(2026, 9, 8, tzinfo=timezone.utc),
        timezone_name="Asia/Shanghai",
    )

    metrics = dashboard["metrics"]
    assert metrics["active_conversations"]["current"]["value"] == 2
    assert metrics["active_conversations"]["previous"]["value"] == 1
    assert metrics["active_conversations"]["delta"] == 1
    assert metrics["user_messages"]["current"]["value"] == 3
    assert metrics["active_dates"]["current"]["value"] == 3
    assert dashboard["comparison_available"] is True
    assert dashboard["comparison_reason"] is None
    assert dashboard["daily_activity"] == [
        {"date": "2026-09-01", "user_messages": 1},
        {"date": "2026-09-06", "user_messages": 1},
        {"date": "2026-09-07", "user_messages": 1},
    ]
    assert dashboard["metrics"]["generated_artifacts"]["current"]["availability"] == "unavailable"
    assert set(dashboard["source_stats"]["visible_session_keys"]) == {
        "websocket:current-a",
        "websocket:current-b",
        "websocket:previous",
        "websocket:outside",
    }
    for evidence in dashboard["selected_evidence"]:
        EvidenceRef.model_validate(evidence)


def test_dashboard_keeps_all_visible_session_keys_when_prompt_sample_is_small(tmp_path: Path) -> None:
    for index in range(4):
        _write_session(
            tmp_path,
            f"session-{index}",
            [
                {
                    "role": "user",
                    "content": f"消息 {index}",
                    "timestamp": f"2026-09-0{index + 1}T10:00:00+00:00",
                }
            ],
        )
    dashboard = build_dashboard(
        tmp_path,
        None,
        as_of=datetime(2026, 9, 8, tzinfo=timezone.utc),
        timezone_name="UTC",
        max_evidence_sessions=1,
        max_evidence_messages=1,
    )

    assert len(dashboard["source_stats"]["visible_session_keys"]) == 4
    assert dashboard["coverage"][0]["selected_count"] == 1


def test_dashboard_marks_missing_history_and_source_scope(tmp_path: Path) -> None:
    notes = tmp_path / "notes"
    notes.mkdir()
    dashboard = build_dashboard(
        tmp_path,
        notes,
        as_of=datetime(2026, 9, 8, tzinfo=timezone.utc),
    )

    assert dashboard["metrics"]["active_conversations"]["current"]["availability"] == "unavailable"
    assert dashboard["metrics"]["active_conversations"]["previous"]["availability"] == "unavailable"
    assert dashboard["comparison_available"] is False
    assert dashboard["comparison_reason"] == "sessions_unavailable"
    assert dashboard["source_scope_id"] == compute_source_scope_id(tmp_path, notes)
    assert {item["source"] for item in dashboard["coverage"]} == {
        "sessions",
        "notes",
        "artifacts",
        "agent_execution",
    }


def test_dashboard_respects_half_open_window_boundary(tmp_path: Path) -> None:
    _write_session(
        tmp_path,
        "boundary",
        [
            {"role": "user", "content": "不计入", "timestamp": "2026-09-08T00:00:00+00:00"},
            {"role": "user", "content": "计入", "timestamp": "2026-09-07T23:59:59.999000+00:00"},
        ],
    )
    dashboard = build_dashboard(
        tmp_path,
        None,
        as_of=datetime(2026, 9, 8, tzinfo=timezone.utc),
        timezone_name="UTC",
    )
    assert dashboard["metrics"]["user_messages"]["current"]["value"] == 1
