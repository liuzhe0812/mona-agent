from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from mona.distill.collectors.artifact_collector import collect_artifacts


def _ref(
    *,
    artifact_id: str,
    path: str = "reports/plan.md",
    created_at: str | None = "2026-09-01T08:00:00+00:00",
) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": artifact_id,
        "owner_kind": "agent",
        "owner_id": "mona",
        "relative_path": path,
        "created_by_agent_id": "mona",
        "mime": "text/markdown",
        "session_id": "websocket:source",
    }
    if created_at is not None:
        payload["created_at"] = created_at
    return payload


def _write_transcript(root: Path, session_key: str, records: list[dict[str, object]]) -> None:
    path = root / f"{session_key.replace(':', '_')}.jsonl"
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def test_collects_only_explicit_deliver_files_and_deduplicates_by_plan_key(
    tmp_path: Path, monkeypatch
) -> None:
    from mona.distill.collectors import artifact_collector

    monkeypatch.setattr(
        artifact_collector.transcript,
        "webui_transcript_path",
        lambda key: tmp_path / f"{key.replace(':', '_')}.jsonl",
    )
    _write_transcript(
        tmp_path,
        "websocket:a",
        [
            {"event": "message", "tool_events": [{"name": "deliver_file"}]},
            {
                "event": "deliver_files",
                "files": [
                    {
                        "name": "plan.md",
                        "artifact_ref": _ref(
                            artifact_id="first-id",
                            created_at="2026-09-01T08:00:00+00:00",
                        ),
                    }
                ],
            },
        ],
    )
    _write_transcript(
        tmp_path,
        "websocket:b",
        [
            {
                "event": "deliver_files",
                "files": [
                    {
                        "name": "plan.md",
                        "artifact_ref": _ref(
                            artifact_id="second-id",
                            created_at="2026-09-02T08:00:00+00:00",
                        ),
                    }
                ],
            }
        ],
    )

    stats = collect_artifacts(
        ["websocket:a", "websocket:b"],
        source_scope_id="scope-a",
    )

    assert stats.total_artifacts == 1
    item = stats.artifacts[0]
    assert item.first_recorded_at == "2026-09-01T08:00:00+00:00"
    assert item.artifact_ref_ids == ["first-id", "second-id"]
    assert item.session_key == "websocket:a"
    assert item.id == collect_artifacts(["websocket:a"], source_scope_id="scope-a").artifacts[0].id


def test_missing_created_at_is_not_filled_and_is_excluded_from_recent_window(
    tmp_path: Path, monkeypatch
) -> None:
    from mona.distill.collectors import artifact_collector

    monkeypatch.setattr(
        artifact_collector.transcript,
        "webui_transcript_path",
        lambda key: tmp_path / f"{key.replace(':', '_')}.jsonl",
    )
    _write_transcript(
        tmp_path,
        "websocket:unknown",
        [
            {
                "event": "deliver_files",
                "files": [{"artifact_ref": _ref(artifact_id="unknown", created_at=None)}],
            }
        ],
    )

    all_stats = collect_artifacts(["websocket:unknown"])
    assert all_stats.total_artifacts == 1
    assert all_stats.artifacts[0].first_recorded_at is None
    assert "created_at" not in all_stats.artifacts[0].artifact_ref
    assert all_stats.unknown_time_count == 1

    recent = collect_artifacts(
        ["websocket:unknown"],
        since=datetime(2026, 8, 1),
    )
    assert recent.artifacts == []
    assert recent.unknown_time_count == 1


def test_oversize_and_corrupt_transcripts_mark_partial(
    tmp_path: Path, monkeypatch
) -> None:
    from mona.distill.collectors import artifact_collector

    monkeypatch.setattr(
        artifact_collector.transcript,
        "webui_transcript_path",
        lambda key: tmp_path / f"{key.replace(':', '_')}.jsonl",
    )
    (tmp_path / "websocket_large.jsonl").write_bytes(b"x" * (8 * 1024 * 1024 + 1))
    (tmp_path / "websocket_bad.jsonl").write_text("{not-json}\n", encoding="utf-8")

    stats = collect_artifacts(["websocket:large", "websocket:bad"])

    assert stats.partial is True
    assert "transcript_too_large" in stats.partial_reasons
    assert "transcript_corrupt" in stats.partial_reasons
