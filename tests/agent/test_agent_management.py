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
    agent_tool_catalog,
    create_custom_agent,
)
from mona.agent.partners import MONA_AGENT_ID, AgentRegistry
from mona.agent.user_config import (
    AGENT_EXCLUSIVE_TOOLS,
    COMMON_AGENT_TOOLS,
    REQUIRED_AGENT_TOOLS,
    AgentUserConfig,
)
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.session.manager import SessionManager

AGENT_ID = "com.example.skill-owner"
LEARNED_SKILL = "learned-skill"
PACKAGE_SKILL = "external-skill"


def _skill_content(name: str, description: str, body: str = "# Skill") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n{body}\n"


def test_mona_tool_catalog_includes_dynamic_and_uninstalled_computer_tools(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        agent_management,
        "load_agent_user_config",
        lambda _agent_id: AgentUserConfig(),
    )
    dynamic_tool = SimpleNamespace(
        name="mcp_demo_search",
        description="Search a connected service",
        read_only=True,
        requires_explicit_permission=True,
    )
    internal_tool = SimpleNamespace(
        name="my",
        description="Inspect runtime state",
        read_only=True,
        requires_explicit_permission=False,
        system_managed=True,
    )
    runtime_registry = SimpleNamespace(
        tool_names=[dynamic_tool.name, internal_tool.name],
        has=lambda name: name in {dynamic_tool.name, internal_tool.name},
        get=lambda name: (
            dynamic_tool if name == dynamic_tool.name
            else internal_tool if name == internal_tool.name
            else None
        ),
    )

    rows = agent_tool_catalog(
        AgentRegistry().require(MONA_AGENT_ID),
        workspace=tmp_path,
        runtime_registry=runtime_registry,
        sessions=SessionManager(tmp_path / "sessions"),
    )
    by_name = {row["name"]: row for row in rows}

    assert by_name["computer_observe"]["available"] is True
    assert by_name["computer_observe"]["requiresExplicitPermission"] is True
    assert by_name["computer_act"]["requiresExplicitPermission"] is True
    assert by_name["mcp_demo_search"]["requiresExplicitPermission"] is True
    assert by_name["canvas"]["systemManaged"] is True
    assert by_name["long_task"]["systemManaged"] is True
    assert by_name["complete_goal"]["systemManaged"] is True
    assert by_name["update_plan"]["systemManaged"] is True
    assert by_name["my"]["systemManaged"] is True
    assert all(
        by_name[name]["systemManaged"] is True
        for name in ("delegate_agent", "propose_workflow", "run_collaboration", "spawn")
    )
    assert all(
        by_name[name]["systemManaged"] is True
        for name in REQUIRED_AGENT_TOOLS
        if name in by_name
    )
    assert "guitar_tab" not in by_name
    assert "music_score" not in by_name
    assert "academic_search" not in by_name
    assert "chart" not in by_name
    assert "dataframe_query" not in by_name
    assert by_name["notes_search"]["available"] is True
    assert by_name["knowledge_search"]["available"] is True
    assert by_name["knowledge_read"]["available"] is True
    assert by_name["schedule"]["category"] == "planning"
    assert by_name["todo"]["category"] == "planning"


def test_mona_tool_catalog_does_not_restore_removed_tools_from_an_old_selection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        agent_management,
        "load_agent_user_config",
        lambda _agent_id: AgentUserConfig(granted_tools=["removed_tool"]),
    )

    rows = agent_tool_catalog(
        AgentRegistry().require(MONA_AGENT_ID),
        workspace=tmp_path,
        sessions=SessionManager(tmp_path / "sessions"),
    )

    assert "removed_tool" not in {row["name"] for row in rows}


def test_expert_tool_catalogs_share_common_tools_and_isolate_exclusive_tools(
    tmp_path: Path,
) -> None:
    registry = AgentRegistry()
    academic = registry.require("com.mona.academic-researcher")
    musician = registry.require("com.mona.musician")

    academic_names = {
        row["name"]
        for row in agent_tool_catalog(
            academic,
            workspace=tmp_path,
            sessions=SessionManager(tmp_path / "academic-sessions"),
        )
    }
    musician_names = {
        row["name"]
        for row in agent_tool_catalog(
            musician,
            workspace=tmp_path,
            sessions=SessionManager(tmp_path / "musician-sessions"),
        )
    }

    assert COMMON_AGENT_TOOLS <= academic_names
    assert COMMON_AGENT_TOOLS <= musician_names
    assert {"computer_observe", "computer_act"} <= academic_names
    assert {"computer_observe", "computer_act"} <= musician_names
    assert AGENT_EXCLUSIVE_TOOLS[academic.id] <= academic_names
    assert AGENT_EXCLUSIVE_TOOLS[musician.id] <= musician_names
    assert not (AGENT_EXCLUSIVE_TOOLS[academic.id] & musician_names)
    assert not (AGENT_EXCLUSIVE_TOOLS[musician.id] & academic_names)


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


def test_package_skill_scripts_need_no_approval_after_install_or_update(
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

    approved = next(row for row in manager.list() if row["name"] == PACKAGE_SKILL)
    assert approved["scriptsEnabled"] is True
    assert current.script_enabled_skill_hashes == {}

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
    assert changed["scriptsEnabled"] is True
    manager.action(PACKAGE_SKILL, "disable")
    assert PACKAGE_SKILL in current.disabled_skills
    assert not agent_management.is_skill_script_enabled(manager.agent_id, PACKAGE_SKILL)


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
