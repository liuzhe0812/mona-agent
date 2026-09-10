"""Contract tests for Agent-private skill metadata and editing."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import mona.agent.agent_management as agent_management
import mona.agent.skill_usage as skill_usage
import mona.config.paths as paths
from mona.agent.agent_management import (
    AgentManagementError,
    SkillManager,
    create_custom_agent,
)
from mona.agent.partners import AgentRegistry
from mona.agent.user_config import AgentUserConfig
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.runtime.agent_env import AgentRuntimeError
from mona.runtime.skill_env import (
    PythonSkillDependencies,
    SkillRuntimeSpec,
)

AGENT_ID = "com.example.skill-owner"
LEARNED_SKILL = "learned-skill"
PACKAGE_SKILL = "external-skill"


def _skill_content(name: str, description: str, body: str = "# Skill") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n{body}\n"


@pytest.fixture
def skill_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[SkillManager, Path]:
    package_root = tmp_path / "packages" / AGENT_ID
    package_skill_dir = package_root / "skills" / PACKAGE_SKILL
    package_skill_dir.mkdir(parents=True)
    (package_root / "agent.json").write_text(
        json.dumps(
            {
                "id": AGENT_ID,
                "displayName": "Skill Owner",
                "prompt": "prompt.md",
                "toolAllowlist": ["skill_script_run"],
                "skills": [f"skills/{PACKAGE_SKILL}"],
            }
        ),
        encoding="utf-8",
    )
    (package_root / "prompt.md").write_text("You own skills.", encoding="utf-8")
    (package_skill_dir / "SKILL.md").write_text(
        _skill_content(PACKAGE_SKILL, "A package-provided skill."),
        encoding="utf-8",
    )

    private_skills = tmp_path / "private-skills"
    monkeypatch.setattr(paths, "get_agent_skills_dir", lambda _agent_id: private_skills)
    monkeypatch.setattr(agent_management, "get_agent_skills_dir", lambda _agent_id: private_skills)
    monkeypatch.setattr(skill_usage, "get_agent_skills_dir", lambda _agent_id: private_skills)
    monkeypatch.setattr(
        agent_management, "get_workspace_path", lambda _workspace=None: tmp_path / "workspace"
    )
    monkeypatch.setattr(
        agent_management, "load_agent_user_config", lambda _agent_id: AgentUserConfig()
    )

    registry = AgentRegistry(
        builtin_dir=tmp_path / "packages",
        installed_dir=tmp_path / "installed",
    )
    return SkillManager(AGENT_ID, registry=registry), private_skills


def test_lists_and_updates_agent_created_private_skill(
    skill_manager: tuple[SkillManager, Path],
) -> None:
    manager, private_skills = skill_manager
    skill_dir = private_skills / LEARNED_SKILL
    skill_dir.mkdir(parents=True)
    original = _skill_content(LEARNED_SKILL, "A learned research workflow.")
    (skill_dir / "SKILL.md").write_text(original, encoding="utf-8")
    (private_skills / ".usage.json").write_text(
        json.dumps({LEARNED_SKILL: {"created_by": "agent"}}),
        encoding="utf-8",
    )

    row = next(item for item in manager.list() if item["name"] == LEARNED_SKILL)
    assert row["category"] == "self_learning"
    assert row["provenance"] == "agent"
    assert row["description"] == "A learned research workflow."
    assert row["editable"] is True

    updated_content = _skill_content(
        LEARNED_SKILL,
        "An updated research workflow.",
        "# Updated Skill",
    )
    updated = manager.update_private(
        LEARNED_SKILL,
        updated_content,
        expected_hash=row["contentHash"],
    )

    assert updated["content"] == updated_content
    assert (skill_dir / "SKILL.md").read_text(encoding="utf-8") == updated_content
    refreshed = next(item for item in manager.list() if item["name"] == LEARNED_SKILL)
    assert refreshed["description"] == "An updated research workflow."


def test_update_private_rejects_non_private_and_missing_skills(
    skill_manager: tuple[SkillManager, Path],
) -> None:
    manager, _private_skills = skill_manager
    package_content = _skill_content(PACKAGE_SKILL, "A changed package skill.")

    with pytest.raises(AgentManagementError, match="only active private skills"):
        manager.update_private(PACKAGE_SKILL, package_content, expected_hash=None)

    with pytest.raises(AgentManagementError, match="only active private skills"):
        manager.update_private("missing-skill", package_content, expected_hash=None)


def test_package_skill_script_approval_is_bound_to_effective_content(
    skill_manager: tuple[SkillManager, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _private_skills = skill_manager
    skill_dir = manager.active_skill_dir(PACKAGE_SKILL)
    (skill_dir / "scripts").mkdir()
    (skill_dir / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")
    current = AgentUserConfig()

    def load(_agent_id: str) -> AgentUserConfig:
        return current

    def save(_agent_id: str, update: dict, *, expected_revision=None) -> AgentUserConfig:
        nonlocal current
        del expected_revision
        current = AgentUserConfig.model_validate({**current.model_dump(), **update})
        return current

    monkeypatch.setattr(agent_management, "load_agent_user_config", load)
    monkeypatch.setattr(agent_management, "save_agent_user_config", save)
    monkeypatch.setattr(
        "mona.runtime.agent_env.AgentEnvironmentManager.assert_skill_ready",
        lambda *args, **kwargs: None,
    )

    manager.action(PACKAGE_SKILL, "enable_scripts")

    approved = next(row for row in manager.list() if row["name"] == PACKAGE_SKILL)
    assert approved["scriptsEnabled"] is True
    assert current.script_enabled_skill_hashes[PACKAGE_SKILL] == approved["executionHash"]

    cache = skill_dir / "scripts" / "__pycache__"
    cache.mkdir()
    (cache / "run.cpython-313.pyc").write_bytes(b"generated")
    cached = next(row for row in manager.list() if row["name"] == PACKAGE_SKILL)
    assert cached["scriptsEnabled"] is True

    (skill_dir / "SKILL.md").write_text(
        _skill_content(PACKAGE_SKILL, "Updated package skill."),
        encoding="utf-8",
    )
    changed = next(row for row in manager.list() if row["name"] == PACKAGE_SKILL)
    assert changed["scriptsEnabled"] is False


def test_create_custom_agent_is_local_and_registry_loadable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    monkeypatch.setattr(agent_management, "get_agents_dir", lambda: agents_dir)

    definition = create_custom_agent(
        "法律文书专家",
        description="审阅合同和法律文书",
        instructions="识别风险并用通俗语言解释，不替代律师意见。",
    )

    package_root = agents_dir / definition.id
    assert definition.id.startswith("local.custom.")
    assert (package_root / "agent.json").is_file()
    assert "识别风险" in (package_root / "prompt.md").read_text(encoding="utf-8")
    registry = AgentRegistry(
        builtin_dir=tmp_path / "builtin",
        installed_dir=agents_dir,
        package_store_dir=tmp_path / "packages",
    )
    assert registry.require(definition.id).display_name == "法律文书专家"


def test_private_skill_scripts_use_shared_agent_environment_without_custom_metadata(
    skill_manager: tuple[SkillManager, Path],
) -> None:
    manager, _private_skills = skill_manager
    content = _skill_content("scripted-skill", "Runs a script.")

    proposal = manager.stage(
        name="scripted-skill",
        files={
            "SKILL.md": content,
            "pyproject.toml": (
                '[project]\nname = "scripted-skill"\nversion = "1.0.0"\n'
                'dependencies = ["requests>=2"]\n'
            ),
            "scripts/run.py": "print('ok')\n",
        },
        source="user:test",
    )

    assert proposal["preview"]["runtime"] is None
    assert proposal["preview"]["hasScripts"] is True


def test_private_skill_dependency_versions_must_be_exact(
    skill_manager: tuple[SkillManager, Path],
) -> None:
    manager, _private_skills = skill_manager
    content = (
        "---\n"
        "name: scripted-skill\n"
        "description: Runs a script.\n"
        "metadata:\n"
        "  mona:\n"
        "    runtime:\n"
        "      python:\n"
        "        requirements: [requests>=2]\n"
        "---\n"
    )

    with pytest.raises(AgentManagementError, match="name==version"):
        manager.stage(
            name="scripted-skill",
            files={"SKILL.md": content, "scripts/run.py": "print('ok')\n"},
            source="user:test",
        )


def test_skill_install_preview_exposes_dependency_plan(
    skill_manager: tuple[SkillManager, Path],
) -> None:
    manager, _private_skills = skill_manager
    content = (
        "---\n"
        "name: scripted-skill\n"
        "description: Runs a script.\n"
        "metadata:\n"
        "  mona:\n"
        "    runtime:\n"
        "      python:\n"
        "        requirements: [requests==2.32.5]\n"
        "---\n"
    )

    proposal = manager.stage(
        name="scripted-skill",
        files={"SKILL.md": content, "scripts/run.py": "print('ok')\n"},
        source="user:test",
    )

    assert proposal["preview"]["runtime"] == {
        "packs": [],
        "python": {
            "requirements": ["requests==2.32.5"],
        },
    }


def test_scripted_skill_cannot_activate_before_environment_is_ready(
    skill_manager: tuple[SkillManager, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, private_skills = skill_manager
    monkeypatch.setattr(paths, "get_managed_runtimes_dir", lambda: tmp_path / "runtimes")
    content = (
        "---\n"
        "name: scripted-skill\n"
        "description: Runs a script.\n"
        "metadata:\n"
        "  mona:\n"
        "    runtime:\n"
        "      python:\n"
        "        requirements: [requests==2.32.5]\n"
        "---\n"
    )
    proposal = manager.stage(
        name="scripted-skill",
        files={"SKILL.md": content, "scripts/run.py": "print('ok')\n"},
        source="user:test",
    )

    with pytest.raises(AgentRuntimeError, match="environment is not prepared"):
        manager._activate(proposal)  # noqa: SLF001

    assert not (private_skills / "scripted-skill").exists()


async def test_websocket_approval_prepares_skill_environment_before_activation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    staged = tmp_path / "staged"
    staged.mkdir()
    spec = SkillRuntimeSpec(python=PythonSkillDependencies(requirements=["requests==2.32.5"]))

    monkeypatch.setattr(
        agent_management,
        "get_staged_skill_for_approval",
        lambda *args, **kwargs: (staged, spec),
    )

    def resolve(*args, **kwargs):
        order.append("activate")
        return {"kind": "skill_install", "status": "approved"}

    monkeypatch.setattr(agent_management, "resolve_change_proposal", resolve)

    async def prepare_all(self, skill_dir, runtime_spec):
        del self
        assert skill_dir == staged
        assert runtime_spec == spec
        order.append("prepare")

    monkeypatch.setattr(
        "mona.runtime.agent_env.AgentEnvironmentManager.prepare_all",
        prepare_all,
    )
    channel = WebSocketChannel({}, MessageBus())
    channel._send_event = AsyncMock()  # type: ignore[method-assign]  # noqa: SLF001
    channel._broadcast_agent_event = AsyncMock()  # type: ignore[method-assign]  # noqa: SLF001

    await channel._handle_resolve_agent_change_envelope(  # noqa: SLF001
        object(),
        {
            "agent_id": AGENT_ID,
            "proposal_id": "proposal-1",
            "token": "token-1",
            "approve": True,
        },
    )

    assert order == ["prepare", "activate"]
    assert channel._send_event.await_args.kwargs["ok"] is True  # type: ignore[union-attr]


async def test_websocket_starts_skill_setup_without_waiting_for_install() -> None:
    job = SimpleNamespace(
        model_dump=lambda **kwargs: {
            "jobId": "setup-1",
            "state": "queued",
            "skillName": PACKAGE_SKILL,
        }
    )
    jobs = SimpleNamespace(start=lambda agent_id, name, registry: job)
    channel = WebSocketChannel({}, MessageBus())
    channel._send_event = AsyncMock()  # type: ignore[method-assign]  # noqa: SLF001
    channel._skill_setup_job_manager = lambda: jobs  # type: ignore[method-assign]  # noqa: SLF001

    await channel._handle_agent_skill_setup_start_envelope(  # noqa: SLF001
        object(),
        {"agent_id": AGENT_ID, "name": PACKAGE_SKILL, "request_id": "request-1"},
    )

    assert channel._send_event.await_args.args[1] == "agent_skill_setup_start_result"  # type: ignore[union-attr]
    assert channel._send_event.await_args.kwargs["ok"] is True  # type: ignore[union-attr]
    assert channel._send_event.await_args.kwargs["job"]["jobId"] == "setup-1"  # type: ignore[union-attr]
