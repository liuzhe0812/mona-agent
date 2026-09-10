from __future__ import annotations

import json

import pytest

from mona.distill.base import DistillResult
from mona.distill.snapshot import build_user_profile_snapshot
from mona.distill.store import (
    ProfileRevisionConflictError,
    effective_context,
    ensure_profile_v3,
    read_rich_profile,
    update_advice_feedback,
    update_explicit_context,
    write_distill_result,
)


def test_legacy_explicit_sections_are_imported_and_override_observations(tmp_path) -> None:
    (tmp_path / "USER.md").write_text(
        "# User Profile\n\n## Preferences\n\n回答简洁。\n\n"
        "## Special Instructions\n\n不要替我发送消息。\n\n"
        "## Current Focus\n\n旧的自动焦点。\n",
        encoding="utf-8",
    )
    (tmp_path / "profile.rich.json").write_text(
        json.dumps(
            {
                "version": "2.0",
                "revision": 7,
                "profile": {
                    "understanding": [
                        {"field": "preferences", "text": "自动偏好", "source_refs": ["a"]},
                        {"field": "current_focus", "text": "近期目标", "source_refs": ["b"]},
                    ]
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    migrated = ensure_profile_v3(tmp_path)
    items = {item["field"]: item for item in effective_context(migrated)}

    assert migrated["revision"] == 8
    assert items["preferences"]["value"] == "回答简洁。"
    assert items["preferences"]["origin"] == "confirmed"
    assert items["special_instructions"]["value"] == "不要替我发送消息。"
    assert items["current_focus"]["value"] == "近期目标"

    snapshot = build_user_profile_snapshot(profile_dir=tmp_path)
    assert snapshot["content"]["preferences"] == {
        "explicit": "回答简洁。",
        "special_instructions": "不要替我发送消息。",
    }
    assert snapshot["content"]["current_focus"]["explicit"] == "近期目标"


def test_context_revision_conflict_and_suppression(tmp_path) -> None:
    data = ensure_profile_v3(tmp_path)
    updated, warning = update_explicit_context(
        tmp_path,
        field="current_focus",
        mode="suppress",
        value="",
        expected_context_revision=data["facts"]["context_revision"],
    )
    assert warning is None
    assert updated["facts"]["context_revision"] == 1
    assert "current_focus" not in build_user_profile_snapshot(profile_dir=tmp_path)["content"]

    with pytest.raises(ProfileRevisionConflictError) as exc:
        update_explicit_context(
            tmp_path,
            field="current_focus",
            mode="reset",
            value="",
            expected_context_revision=0,
        )
    assert exc.value.current_revision == 1


def test_feedback_survives_advice_regeneration_and_does_not_change_distilled_time(tmp_path) -> None:
    initial = ensure_profile_v3(tmp_path)
    first = DistillResult(
        task_name="profile",
        success=True,
        confidence=1,
        data={"understanding": [], "context_revision_used": 0},
    )
    write_distill_result(tmp_path, first)
    distilled_at = read_rich_profile(tmp_path)["last_distilled_at"]
    advice = {
        "current_ids": ["advice-a"],
        "items": [{"id": "advice-a", "title": "先做一步"}],
        "context_revision_used": 0,
    }
    write_distill_result(
        tmp_path,
        DistillResult(task_name="advice", success=True, confidence=1, data=advice),
    )
    feedback = update_advice_feedback(
        tmp_path,
        "advice-a",
        {"disposition": "completed", "dismiss_reason": None},
        expected_item_revision=0,
    )
    assert feedback["revision"] == 1
    assert read_rich_profile(tmp_path)["last_distilled_at"] == distilled_at

    write_distill_result(
        tmp_path,
        DistillResult(task_name="advice", success=True, confidence=1, data=advice),
    )
    final = read_rich_profile(tmp_path)
    assert final["feedback"]["advice"]["advice-a"]["disposition"] == "completed"
    assert final["advice"]["current_ids"] == []
    assert final["revision"] > initial["revision"]
