from __future__ import annotations

from datetime import datetime, timezone

from mona.distill.profile_charts import build_profile_charts

AS_OF = datetime(2026, 9, 8, tzinfo=timezone.utc)


def _event(ref: str, content: str, occurred_at: str) -> dict[str, str]:
    return {"ref": ref, "content": content, "occurred_at": occurred_at}


def _note(ref: str, title: str, occurred_at: str, **extra: object) -> dict[str, object]:
    return {"ref": ref, "title": title, "occurred_at": occurred_at, **extra}


def test_profile_charts_deduplicate_records_and_topics() -> None:
    current_events = [
        _event("e1", "Python Python API RAG", "2026-09-07T01:00:00+00:00"),
        _event("e1", "Python Python API RAG", "2026-09-07T01:00:00+00:00"),
        _event("e2", "Python API", "2026-09-01T01:00:00+00:00"),
    ]
    current_notes = {
        "records": [
            _note(
                "n1",
                "RAG 评估",
                "2026-09-02T01:00:00+00:00",
                tags=["RAG", "RAG", "检索"],
                keywords=["rag"],
            ),
            _note("n1", "RAG 评估", "2026-09-02T01:00:00+00:00"),
        ]
    }

    charts = build_profile_charts(
        current_events=current_events,
        previous_events=[],
        current_notes=current_notes,
        previous_notes={},
        artifacts=[],
        as_of=AS_OF,
        timezone_name="UTC",
    )

    graph = charts["topic_graph"]
    assert not any(node["id"] == "user" for node in graph["nodes"])
    counts = {node["label"]: node["count"] for node in graph["nodes"]}
    assert counts["Python"] == 2
    assert counts["API"] == 2
    assert counts["RAG"] == 2
    assert {tuple(sorted((link["source"], link["target"]))) for link in graph["links"]} >= {
        ("topic:API", "topic:Python"),
        ("topic:API", "topic:RAG"),
    }


def test_profile_charts_uses_four_half_open_week_buckets_and_new_topics() -> None:
    current_events = [
        _event("w1", "RAG", "2026-08-11T00:00:00+00:00"),
        _event("w2", "RAG RAG", "2026-08-18T00:00:00+00:00"),
        _event("w3", "Agent", "2026-08-25T00:00:00+00:00"),
        _event("w4", "Python", "2026-09-01T00:00:00+00:00"),
        _event("end", "Python", "2026-09-08T00:00:00+00:00"),
    ]
    previous_events = [_event("p1", "RAG", "2026-08-08T00:00:00+00:00")]

    charts = build_profile_charts(
        current_events=current_events,
        previous_events=previous_events,
        current_notes={},
        previous_notes={},
        artifacts=[],
        as_of=AS_OF,
        timezone_name="UTC",
    )

    trends = charts["topic_trends"]
    assert trends["labels"] == ["2026-08-11", "2026-08-18", "2026-08-25", "2026-09-01"]
    series = {item["topic"]: item["values"] for item in trends["series"]}
    assert series["RAG"] == [1, 1, 0, 0]
    assert series["Agent"] == [0, 0, 1, 0]
    assert series["Python"] == [0, 0, 0, 1]

    comparison = {item["topic"]: item for item in charts["topic_comparison"]}
    assert comparison["RAG"] == {"topic": "RAG", "current": 2, "previous": 1, "delta": 1}
    new_topics = {item["topic"]: item for item in charts["new_topics"]}
    assert new_topics["Python"]["count"] == 1
    assert new_topics["Python"]["first_seen_at"] == "2026-09-01T00:00:00+00:00"
    assert "Python" not in {item["topic"] for item in charts["topic_comparison"] if item["previous"]}


def test_profile_charts_fixed_categories_and_matrix_counts() -> None:
    charts = build_profile_charts(
        current_events=[
            _event("dev", "Python API 开发", "2026-09-07T00:00:00+00:00"),
            _event("write", "报告写作", "2026-09-06T00:00:00+00:00"),
            _event("design", "UI 交互设计", "2026-09-05T00:00:00+00:00"),
            _event("analyze", "分析 RAG 检索", "2026-09-04T00:00:00+00:00"),
        ],
        previous_events=[],
        current_notes={},
        previous_notes={},
        artifacts=[
            {"id": "doc", "mime": "application/pdf"},
            {"id": "doc", "mime": "application/pdf"},
            {"id": "code", "mime": "text/x-python"},
            {"id": "image", "mime": "image/png"},
            {"id": "other", "mime": "application/octet-stream"},
        ],
        as_of=AS_OF,
        timezone_name="UTC",
    )

    assert charts["collaboration_types"] == [
        {"label": "开发", "count": 1},
        {"label": "分析", "count": 1},
        {"label": "写作", "count": 1},
        {"label": "设计", "count": 1},
    ]
    assert charts["artifact_types"] == [
        {"label": "文档", "count": 1},
        {"label": "代码", "count": 1},
        {"label": "图像", "count": 1},
        {"label": "音频", "count": 0},
        {"label": "视频", "count": 0},
        {"label": "压缩包", "count": 0},
    ]
    matrix = charts["domain_task_matrix"]
    assert matrix["tasks"] == ["开发", "分析", "写作", "设计"]
    assert len(matrix["values"]) == len(matrix["domains"])
    assert all(len(row) == 4 for row in matrix["values"])
    assert sum(sum(row) for row in matrix["values"]) >= 4


def test_profile_charts_empty_input_has_stable_contract() -> None:
    charts = build_profile_charts(
        current_events=[],
        previous_events=[],
        current_notes={},
        previous_notes={},
        artifacts=[],
        as_of=AS_OF,
        timezone_name="UTC",
    )

    assert charts["profile_dimensions"] == []
    assert charts["previous_profile_dimensions"] == []
    assert charts["topic_graph"] == {"nodes": [], "links": []}
    assert charts["collaboration_types"] == [
        {"label": "开发", "count": 0},
        {"label": "分析", "count": 0},
        {"label": "写作", "count": 0},
        {"label": "设计", "count": 0},
    ]
    assert charts["artifact_types"] == [
        {"label": "文档", "count": 0},
        {"label": "代码", "count": 0},
        {"label": "图像", "count": 0},
        {"label": "音频", "count": 0},
        {"label": "视频", "count": 0},
        {"label": "压缩包", "count": 0},
    ]
    assert charts["topic_trends"]["labels"] == [
        "2026-08-11",
        "2026-08-18",
        "2026-08-25",
        "2026-09-01",
    ]
    assert charts["topic_trends"]["series"] == []
    assert charts["topic_comparison"] == []
    assert charts["new_topics"] == []


def test_unmatched_records_do_not_become_categories() -> None:
    charts = build_profile_charts(
        current_events=[_event("unknown", "好的，继续吧", "2026-09-07T00:00:00+00:00")],
        previous_events=[_event("previous", "嗯", "2026-08-07T00:00:00+00:00")],
        current_notes={"records": [_note("n", "随手记", "2026-09-07T00:00:00+00:00")]},
        previous_notes={}, artifacts=[], as_of=AS_OF, timezone_name="UTC",
    )
    assert charts["profile_dimensions"] == []
    assert charts["previous_profile_dimensions"] == []
    assert charts["topic_graph"] == {"nodes": [], "links": []}
    assert charts["topic_trends"]["series"] == []
    assert charts["topic_comparison"] == []
    assert charts["new_topics"] == []
    assert charts["domain_task_matrix"]["domains"] == []
    assert sum(item["count"] for item in charts["collaboration_types"]) == 0


def test_artifact_categories_use_filename_when_mime_is_missing() -> None:
    artifacts = [
        {"id": "slides", "mime": None, "title": "方案.PPTX"},
        {"id": "sheet", "mime": "application/octet-stream", "artifact_ref": {"relative_path": "成果/数据.xlsx"}},
        {"id": "code", "mime": None, "title": "app.tsx"},
        {"id": "image", "mime": "image/png", "title": "截图"},
        {"id": "audio", "mime": "audio/mpeg"},
        {"id": "video", "mime": None, "title": "演示.mp4"},
        {"id": "zip", "mime": "application/zip"},
        {"id": "unknown", "mime": "application/octet-stream", "title": "未命名"},
    ]
    charts = build_profile_charts(
        current_events=[], previous_events=[], current_notes={}, previous_notes={},
        artifacts=artifacts + [artifacts[0]], as_of=AS_OF, timezone_name="UTC",
    )
    assert {item["label"]: item["count"] for item in charts["artifact_types"]} == {
        "文档": 2, "代码": 1, "图像": 1, "音频": 1, "视频": 1, "压缩包": 1,
    }
