"""Partner Dream cron jobs (``dream-<agent_id>``) run the agent's PRIVATE Dream.

Each partner's history.jsonl must be consolidated into its own MEMORY.md via a
Dream built on that agent's private MemoryStore — sharing Mona's Dream would
only maintain Mona's memory (multi-agent phase 3).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.user_config import save_agent_user_config
from mona.cli.commands import _run_partner_dream
from mona.config import loader as config_loader
from mona.cron.types import CronJob, CronPayload, CronSchedule

PARTNER = "com.example.partner"


class _FakeDream:
    """Captures constructor kwargs; run() is an AsyncMock."""

    instances: list["_FakeDream"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.run = AsyncMock()
        _FakeDream.instances.append(self)


class _FakeMemoryStore:
    calls: list[tuple[Path, str]] = []

    def __init__(self, workspace: Path, *, agent_id: str):
        _FakeMemoryStore.calls.append((workspace, agent_id))


def _job(name: str, *, agent_id: str | None = None) -> CronJob:
    return CronJob(
        id=name,
        name=name,
        schedule=CronSchedule(kind="every", every_ms=86_400_000),
        payload=CronPayload(kind="system_event", agent_id=agent_id),
    )


def _agent(tmp_path: Path) -> SimpleNamespace:
    return SimpleNamespace(
        workspace=tmp_path,
        provider=object(),
        model="gpt-main",
        dream=SimpleNamespace(run=AsyncMock()),
    )


def _dream_cfg(**overrides) -> SimpleNamespace:
    base = {
        "model_override": "",
        "max_batch_size": 20,
        "max_iterations": 10,
        "skill_prune_enabled": False,
        "archive_after_days": 90,
        "max_active_user_skills": 100,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def _reset_fakes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _FakeDream.instances.clear()
    _FakeMemoryStore.calls.clear()
    monkeypatch.setattr(config_loader, "_current_config_path", tmp_path / "config.json")
    monkeypatch.setattr(
        "mona.config.paths.get_agent_dir",
        lambda agent_id: tmp_path / "agent-configs" / agent_id,
    )


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch):
    """Fake AgentRegistry; ``definitions`` maps agent_id -> manifest model."""
    definitions: dict[str, str] = {}

    class _FakeRegistry:
        def get(self, agent_id: str):
            model = definitions.get(agent_id)
            if model is None:
                return None
            return SimpleNamespace(model=model)

    monkeypatch.setattr("mona.agent.partners.AgentRegistry", _FakeRegistry)
    monkeypatch.setattr("mona.agent.memory.Dream", _FakeDream)
    monkeypatch.setattr("mona.agent.memory.MemoryStore", _FakeMemoryStore)
    return definitions


class TestPartnerDream:
    async def test_runs_private_dream_with_manifest_model(
        self, tmp_path: Path, registry
    ) -> None:
        registry[PARTNER] = "gpt-partner"
        agent = _agent(tmp_path)
        save_agent_user_config(
            "mona", {"disabled_skills": ["mona-only"]}, expected_revision=0
        )
        save_agent_user_config(
            PARTNER, {"disabled_skills": ["legacy-skill"]}, expected_revision=0
        )

        await _run_partner_dream(
            _job(f"dream-{PARTNER}", agent_id=PARTNER),
            agent=agent,
            dream_cfg=_dream_cfg(),
        )

        # MemoryStore is bound to the partner's private dir, not Mona's.
        assert _FakeMemoryStore.calls == [(tmp_path, PARTNER)]
        assert len(_FakeDream.instances) == 1
        dream = _FakeDream.instances[0]
        assert dream.kwargs["model"] == "gpt-partner"
        assert dream.kwargs["provider"] is agent.provider
        assert dream.kwargs["disabled_skills"] == ["legacy-skill"]
        assert "mona-only" not in dream.kwargs["disabled_skills"]
        dream.run.assert_awaited_once()
        # Mona's own Dream was NOT used for the partner job.
        agent.dream.run.assert_not_called()

    async def test_inherit_model_uses_gateway_model(
        self, tmp_path: Path, registry
    ) -> None:
        registry[PARTNER] = "inherit"
        agent = _agent(tmp_path)

        await _run_partner_dream(
            _job(f"dream-{PARTNER}", agent_id=PARTNER),
            agent=agent,
            dream_cfg=_dream_cfg(),
        )

        assert _FakeDream.instances[0].kwargs["model"] == "gpt-main"

    async def test_inherit_model_prefers_dream_model_override(
        self, tmp_path: Path, registry
    ) -> None:
        registry[PARTNER] = "inherit"
        agent = _agent(tmp_path)

        await _run_partner_dream(
            _job(f"dream-{PARTNER}", agent_id=PARTNER),
            agent=agent,
            dream_cfg=_dream_cfg(model_override="gpt-dream"),
        )

        assert _FakeDream.instances[0].kwargs["model"] == "gpt-dream"

    async def test_uninstalled_agent_skips_gracefully(
        self, tmp_path: Path, registry
    ) -> None:
        agent = _agent(tmp_path)

        # Registry has no such agent — must not raise, must not run anything.
        await _run_partner_dream(
            _job("dream-com.example.ghost", agent_id="com.example.ghost"),
            agent=agent,
            dream_cfg=_dream_cfg(),
        )

        assert _FakeDream.instances == []
        agent.dream.run.assert_not_called()

    async def test_mona_payload_falls_back_to_main_dream(
        self, tmp_path: Path, registry
    ) -> None:
        agent = _agent(tmp_path)

        await _run_partner_dream(
            _job("dream-mona", agent_id="mona"),
            agent=agent,
            dream_cfg=_dream_cfg(),
        )

        agent.dream.run.assert_awaited_once()
        assert _FakeDream.instances == []

    async def test_agent_id_derived_from_job_name_when_payload_empty(
        self, tmp_path: Path, registry
    ) -> None:
        registry[PARTNER] = "inherit"
        agent = _agent(tmp_path)

        await _run_partner_dream(
            _job(f"dream-{PARTNER}"),
            agent=agent,
            dream_cfg=_dream_cfg(),
        )

        assert _FakeMemoryStore.calls == [(tmp_path, PARTNER)]


class TestCronPayloadAgentId:
    def test_agent_id_round_trip_through_from_dict(self) -> None:
        job = _job(f"dream-{PARTNER}", agent_id=PARTNER)
        from dataclasses import asdict

        restored = CronJob.from_dict(asdict(job))
        assert restored.payload.agent_id == PARTNER

    def test_legacy_payload_without_agent_id_defaults_none(self) -> None:
        job = CronJob.from_dict({
            "id": "dream",
            "name": "dream",
            "schedule": {"kind": "every", "every_ms": 86_400_000},
            "payload": {"kind": "system_event"},
        })
        assert job.payload.agent_id is None
