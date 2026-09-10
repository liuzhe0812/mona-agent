"""Persistent, user-visible setup jobs for Skill execution environments."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from mona.config.schema import Base


class SkillSetupJob(Base):
    schema_version: int = 1
    job_id: str
    agent_id: str
    skill_name: str
    content_hash: str
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    stage: str = "queued"
    error: str | None = None
    created_at: int
    updated_at: int
    finished_at: int | None = None


class SkillSetupJobManager:
    def __init__(self, state_path: Path) -> None:
        self.state_path = state_path
        self._jobs: dict[str, SkillSetupJob] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._registries: dict[str, Any] = {}
        self._load()

    def start(self, agent_id: str, skill_name: str, registry: Any) -> SkillSetupJob:
        from mona.agent.agent_management import SkillManager

        manager = SkillManager(agent_id, registry=registry)
        skill_dir = manager.assert_script_setup_allowed(skill_name)
        content_hash = self._content_hash(skill_dir)
        for job in self._jobs.values():
            if (
                job.agent_id == agent_id
                and job.skill_name == skill_name
                and job.content_hash == content_hash
                and job.state in {"queued", "running"}
            ):
                return job.model_copy(deep=True)
        now = self._now()
        job = SkillSetupJob(
            jobId=uuid.uuid4().hex,
            agentId=agent_id,
            skillName=skill_name,
            contentHash=content_hash,
            state="queued",
            createdAt=now,
            updatedAt=now,
        )
        self._jobs[job.job_id] = job
        self._registries[job.job_id] = registry
        self._tasks[job.job_id] = asyncio.create_task(self._run(job.job_id))
        self._persist()
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> SkillSetupJob:
        try:
            return self._jobs[job_id].model_copy(deep=True)
        except KeyError as exc:
            raise KeyError("skill setup job not found") from exc

    def latest(self, agent_id: str, skill_name: str) -> SkillSetupJob | None:
        rows = [
            job for job in self._jobs.values()
            if job.agent_id == agent_id and job.skill_name == skill_name
        ]
        if not rows:
            return None
        return max(rows, key=lambda item: item.created_at).model_copy(deep=True)

    async def cancel(self, job_id: str) -> SkillSetupJob:
        job = self._jobs.get(job_id)
        task = self._tasks.get(job_id)
        if job is None:
            raise KeyError("skill setup job not found")
        if task is None or task.done() or job.state not in {"queued", "running"}:
            raise ValueError("skill setup job is not running")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return self.get(job_id)

    async def _run(self, job_id: str) -> None:
        job = self._jobs[job_id]
        registry = self._registries[job_id]
        try:
            from mona.agent.agent_management import SkillManager
            from mona.config.paths import get_managed_runtimes_dir
            from mona.runtime.agent_env import AgentEnvironmentManager
            from mona.runtime.skill_env import runtime_spec_from_skill_markdown

            manager = SkillManager(job.agent_id, registry=registry)
            skill_dir = manager.active_skill_dir(job.skill_name)
            content = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
            if self._content_hash(skill_dir) != job.content_hash:
                raise ValueError("技能内容已更新，请重新检查并配置")
            job.state = "running"
            job.stage = "preparing_runtime"
            self._touch(job)
            await AgentEnvironmentManager(get_managed_runtimes_dir()).prepare_all(
                skill_dir,
                runtime_spec_from_skill_markdown(content),
            )
            if self._content_hash(skill_dir) != job.content_hash:
                raise ValueError("技能内容在准备期间发生变化，请重新配置")
            job.stage = "checking"
            self._touch(job)
            manager.action(job.skill_name, "enable_scripts")
            job.state = "completed"
            job.stage = "ready"
        except asyncio.CancelledError:
            job.state = "cancelled"
            job.stage = "cancelled"
            job.error = "准备已取消，可稍后继续"
        except Exception as exc:
            job.state = "failed"
            job.stage = "failed"
            job.error = str(exc)[:2_000]
        finally:
            job.updated_at = self._now()
            job.finished_at = job.updated_at
            self._registries.pop(job_id, None)
            self._persist()

    def _touch(self, job: SkillSetupJob) -> None:
        job.updated_at = self._now()
        self._persist()

    def _load(self) -> None:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            rows = payload.get("jobs", []) if isinstance(payload, dict) else []
            for raw in rows:
                job = SkillSetupJob.model_validate(raw)
                if job.state in {"queued", "running"}:
                    job.state = "failed"
                    job.stage = "interrupted"
                    job.error = "Mona 上次退出时准备被中断，可重新开始"
                    job.updated_at = self._now()
                    job.finished_at = job.updated_at
                self._jobs[job.job_id] = job
        except (OSError, ValueError, json.JSONDecodeError):
            self._jobs = {}
        self._persist()

    def _persist(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "jobs": [
                job.model_dump(by_alias=True, mode="json")
                for job in sorted(
                    self._jobs.values(), key=lambda item: item.created_at, reverse=True
                )[:100]
            ],
        }
        fd, temp_name = tempfile.mkstemp(
            prefix=".skill-setups-", suffix=".tmp", dir=str(self.state_path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.state_path)
        except Exception:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise

    @staticmethod
    def _content_hash(skill_dir: Path) -> str:
        from mona.agent.agent_management import skill_execution_hash

        return skill_execution_hash(skill_dir)

    @staticmethod
    def _now() -> int:
        return int(time.time() * 1000)


__all__ = ["SkillSetupJob", "SkillSetupJobManager"]
