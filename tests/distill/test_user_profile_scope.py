from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from mona.agent.jobs import AgentJobStore
from mona.agent.workflow import (
    WORKFLOW_STATUS_ACTIVE,
    WorkflowDefinition,
    WorkflowRunStore,
    WorkflowStep,
)
from mona.distill.base import DistillContext, DistillResult
from mona.distill.snapshot import build_user_profile_snapshot
from mona.distill.store import (
    ensure_user_profile_store,
    read_rich_profile,
    write_distill_result,
)
from mona.distill.tasks.profile import ProfileTask
from mona.distill.tasks.work_pattern import WorkPatternTask


def test_legacy_profile_migration_is_non_destructive_and_idempotent(tmp_path, monkeypatch):
    legacy = tmp_path / "agents" / "mona" / "memory"
    destination = tmp_path / "profile"
    legacy.mkdir(parents=True)
    (legacy / "profile.rich.json").write_text(
        json.dumps({"version": "1.0", "profile": {"interests": ["AI"]}}),
        encoding="utf-8",
    )
    (legacy / "USER.md").write_text("# User Profile\n\n## Preferences\n\n简洁", encoding="utf-8")

    import mona.config.paths as paths

    monkeypatch.setattr(paths, "get_memory_dir", lambda: legacy)
    monkeypatch.setattr(paths, "get_user_profile_dir", lambda: destination)

    assert ensure_user_profile_store() == destination
    assert (destination / "profile.rich.json").is_file()
    assert (destination / "USER.md").is_file()

    (legacy / "USER.md").write_text("changed legacy", encoding="utf-8")
    assert ensure_user_profile_store() == destination
    assert "简洁" in (destination / "USER.md").read_text(encoding="utf-8")
    assert "changed legacy" in (legacy / "USER.md").read_text(encoding="utf-8")


def test_shared_snapshot_is_stable_and_excludes_sensitive_fields(tmp_path):
    (tmp_path / "profile.rich.json").write_text(
        json.dumps(
            {
                "revision": 7,
                "last_distilled_at": "2026-08-31T10:00:00",
                "profile": {
                    "understanding": [
                        {
                            "field": "interests",
                            "text": "多 Agent",
                            "source_refs": ["session-message:test"],
                        }
                    ],
                    "identity": {"primary_role": "开发者", "timezone_hint": "Asia/Shanghai"},
                    "tech_stack": [{"area": "语言", "items": ["Python"]}],
                    "interests": ["多 Agent"],
                    "knowledge_structure": {"deep_areas": ["AI"]},
                    "pain_points": [{"topic": "private pain"}],
                    "relationships": {"frequent_contacts": ["secret@example.com"]},
                },
                "work_patterns": {"output_style": "detailed"},
                "evidence": {"top_senders": ["secret@example.com"]},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (tmp_path / "USER.md").write_text(
        "# User Profile\n\n## Preferences\n\n回答简洁。\n\n"
        "## Work Context\n\n负责桌面应用。\n\n"
        "## Current Focus\n\n多 Agent。\n",
        encoding="utf-8",
    )

    first = build_user_profile_snapshot(profile_dir=tmp_path)
    second = build_user_profile_snapshot(profile_dir=tmp_path)

    assert first == second
    assert first["profile_revision"] == 8
    payload = json.dumps(first, ensure_ascii=False)
    assert "回答简洁" in payload
    assert "负责桌面应用" not in payload
    assert "多 Agent" not in payload
    assert "private pain" not in payload
    assert "secret@example.com" not in payload
    assert "detailed" not in payload

    advice = build_user_profile_snapshot(
        profile_dir=tmp_path,
        allowed_fields=("preferences", "work_context", "current_focus"),
    )
    advice_payload = json.dumps(advice, ensure_ascii=False)
    assert "回答简洁" in advice_payload
    assert "负责桌面应用" in advice_payload
    assert "多 Agent" in advice_payload


def test_concurrent_distill_writes_merge_without_losing_task_results(tmp_path):
    results = [
        DistillResult(
            task_name="work-pattern",
            success=True,
            confidence=0.6,
            data={"frequent_tasks": ["search"]},
            markdown="Agent 常协助搜索。",
            user_section="Agent Assistance Patterns",
        ),
        DistillResult(
            task_name="profile",
            success=True,
            confidence=0.7,
            data={"interests": ["AI"]},
            markdown="关注 AI。",
            user_section="Profile",
        ),
    ]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda result: write_distill_result(tmp_path, result), results))

    profile = read_rich_profile(tmp_path)
    assert profile["work_patterns"]["frequent_tasks"] == ["search"]
    assert profile["profile"]["interests"] == ["AI"]
    assert len(profile["trajectory"]) == 2
    assert profile["revision"] == 2


def test_jobs_and_workflow_runs_capture_one_durable_profile_version(tmp_path, monkeypatch):
    snapshot = {
        "schema_version": 1,
        "profile_version": "profile-v1",
        "allowed_fields": ["preferences"],
        "content": {"preferences": {"explicit": "简洁"}},
    }
    monkeypatch.setattr(
        "mona.distill.snapshot.build_user_profile_snapshot",
        lambda: snapshot,
    )

    jobs = AgentJobStore(tmp_path / "jobs")
    job = jobs.create(
        room_id="room-a",
        requested_by="mona",
        assigned_to="com.example.writer",
        task="write",
    )
    assert jobs.load(job.id).user_profile_snapshot == snapshot

    workflow = WorkflowDefinition(
        id="wf_profile",
        room_id="room-a",
        revision=1,
        status=WORKFLOW_STATUS_ACTIVE,
        goal="write",
        steps=[WorkflowStep(id="draft", agent_id="com.example.writer", task="write")],
    )
    runs = WorkflowRunStore(tmp_path / "runs")
    run = runs.create(room_id="room-a", workflow=workflow)
    assert runs.load(run.id).user_profile_snapshot == snapshot


def test_no_model_profile_returns_an_empty_grounded_understanding(tmp_path):
    ctx = DistillContext(workspace=tmp_path, memory_dir=tmp_path, provider=None)
    work_result = asyncio.run(
        WorkPatternTask().distill(
            ctx,
            {
                "total_calls": 1,
                "top_tools": [{"tool": "search", "count": 1}],
                "tool_chains": [],
                "hourly_distribution": {"9": 1},
                "daily_distribution": {"2026-08-31": 1},
                "tool_success": {"search": {"success": 1, "total": 1}},
                "by_agent": {"mona": {"total_calls": 1}},
            },
        )
    )
    assert work_result.success
    assert "evidence" in work_result.data
    assert "visualizations" in work_result.data

    profile_result = asyncio.run(
        ProfileTask().distill(
            ctx,
            {
                "notes": {
                    "total_notes": 1,
                    "title_keywords": [{"keyword": "Python", "count": 1}],
                    "notebook_distribution": [],
                    "tag_distribution": [],
                    "monthly_distribution": {},
                    "keyword_first_seen": {},
                },
                "email": {"total_emails": 0, "top_senders": [], "top_subjects": []},
                "work_patterns": {},
                "sessions": {"total_sessions": 0, "topics": []},
                "prev_trajectory": [],
            },
        )
    )
    assert profile_result.success
    assert profile_result.status == "empty"
    assert profile_result.data["understanding"] == []
    assert not (tmp_path / "profile_snapshots").exists()


def test_distill_pipeline_is_ordered_and_rejects_duplicate_run(monkeypatch, tmp_path):
    import mona.distill.service as service

    events: list[str] = []

    def fake_dashboard(_ctx):
        events.append("dashboard")
        return DistillResult(task_name="dashboard", success=True)

    async def fake_work(_ctx):
        events.append("work")
        await asyncio.sleep(0.01)
        return DistillResult(task_name="work-pattern", success=True)

    async def fake_profile(_ctx):
        events.append("profile")
        await asyncio.sleep(0.01)
        return DistillResult(task_name="profile", success=True)

    async def fake_advice(_ctx):
        events.append("advice")
        return DistillResult(task_name="advice", success=True)

    from types import SimpleNamespace

    monkeypatch.setattr(
        service,
        "build_context",
        lambda: DistillContext(
            tmp_path,
            tmp_path,
            profile_config=SimpleNamespace(pipeline_timeout_seconds=10),
        ),
    )
    monkeypatch.setattr(service, "_prepare_dashboard", fake_dashboard)
    monkeypatch.setattr(service, "_run_work_pattern", fake_work)
    monkeypatch.setattr(service, "_run_profile", fake_profile)
    monkeypatch.setattr(service, "_run_advice", fake_advice)

    async def run_two():
        first = asyncio.create_task(service.run_all_distill())
        await asyncio.sleep(0)
        with pytest.raises(service.ProfileBusyError):
            await service.run_all_distill()
        await first

    asyncio.run(run_two())
    assert events == ["dashboard", "work", "profile", "advice"]


def test_cron_registers_one_active_profile_pipeline():
    from mona.distill.service import JOB_PROFILE, JOB_WORK_PATTERN, register_distill_jobs

    class Cron:
        def __init__(self):
            self.jobs = []

        def register_system_job(self, job):
            self.jobs.append(job)

    cron = Cron()
    register_distill_jobs(cron)
    jobs = {job.id: job for job in cron.jobs}
    assert jobs[JOB_WORK_PATTERN].enabled is False
    assert jobs[JOB_PROFILE].enabled is True
    assert jobs[JOB_PROFILE].payload.message == "distill-all"
