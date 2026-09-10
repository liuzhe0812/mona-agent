from __future__ import annotations

import json

from mona.agent.context import ContextBuilder
from mona.agent.partners import AgentDefinition
from mona.agent.subagent import SubagentManager


class _Registry:
    def __init__(self, definition: AgentDefinition):
        self.definition = definition

    def get(self, agent_id: str):
        return self.definition if agent_id == self.definition.id else None

    def load_prompt(self, agent_id: str) -> str:
        return "You are the writer." if agent_id == self.definition.id else ""

    def resolve_skill_dirs(self, agent_id: str):
        return []


def _configure_profile_paths(tmp_path, monkeypatch, agent_id: str):
    import mona.config.paths as paths

    profile_dir = tmp_path / "profile"
    profile_dir.mkdir()
    (profile_dir / ".migrated-from-mona-memory-v1").write_text("done", encoding="utf-8")
    (profile_dir / "profile.rich.json").write_text(
        json.dumps(
            {
                "version": "3.0",
                "revision": 2,
                "last_distilled_at": "2026-08-31T10:00:00",
                "facts": {
                    "explicit_context": {},
                    "context_revision": 0,
                    "legacy_explicit_imported": True,
                },
                "profile": {
                    "understanding": [
                        {
                            "field": "interests",
                            "text": "多 Agent",
                            "source_refs": ["session-message:test"],
                        }
                    ]
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    agent_dir = tmp_path / "agents" / agent_id
    memory_dir = agent_dir / "memory"
    memory_dir.mkdir(parents=True)
    (memory_dir / "SOUL.md").write_text("private soul", encoding="utf-8")
    (memory_dir / "USER.md").write_text("private user preferences", encoding="utf-8")
    (memory_dir / "AGENTS.md").write_text("private agent rules", encoding="utf-8")

    monkeypatch.setattr(paths, "get_user_profile_dir", lambda: profile_dir)
    monkeypatch.setattr(paths, "get_memory_dir", lambda: tmp_path / "legacy")
    monkeypatch.setattr(paths, "get_agent_memory_dir", lambda _agent_id: memory_dir)
    monkeypatch.setattr(paths, "get_agent_skills_dir", lambda _agent_id: agent_dir / "skills")
    monkeypatch.setattr(paths, "get_agent_dir", lambda _agent_id: agent_dir)
    return profile_dir


def test_partner_direct_context_has_private_bootstrap_and_shared_profile(tmp_path, monkeypatch):
    agent_id = "com.example.writer"
    _configure_profile_paths(tmp_path, monkeypatch, agent_id)
    definition = AgentDefinition(id=agent_id, display_name="Writer")
    context = ContextBuilder(
        tmp_path,
        agent_id=agent_id,
        agent_registry=_Registry(definition),
    )

    rendered = context.build_personalization_context()

    assert "private soul" in rendered
    assert "private user preferences" in rendered
    assert "private agent rules" in rendered
    assert "Shared User Profile (read-only)" in rendered
    assert "多 Agent" in rendered


def test_named_room_agent_prompt_uses_job_snapshot_and_private_bootstrap(tmp_path, monkeypatch):
    agent_id = "com.example.writer"
    _configure_profile_paths(tmp_path, monkeypatch, agent_id)
    definition = AgentDefinition(id=agent_id, display_name="Writer")
    registry = _Registry(definition)
    manager = object.__new__(SubagentManager)
    manager.workspace = tmp_path
    manager.disabled_skills = []
    durable_snapshot = {
        "profile_version": "fixed-v1",
        "allowed_fields": ["current_focus"],
        "content": {"current_focus": {"interests": ["固定版本"]}},
    }

    rendered = manager._build_named_agent_prompt(definition, registry, durable_snapshot)

    assert "private soul" in rendered
    assert "private user preferences" in rendered
    assert "private agent rules" in rendered
    assert "fixed-v1" in rendered
    assert "固定版本" in rendered
