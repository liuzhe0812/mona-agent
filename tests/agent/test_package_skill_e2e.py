"""Real-manifest package-skill end-to-end closure (completion guide 8.4).

Unlike ``test_skill_tools_agent_scope.py`` (which mocks
``resolve_skill_dirs``), every test here loads the REAL shipped builtin
manifests and drives the real assembly chain:

    agent.json  ->  AgentRegistry  ->  resolve_skill_dirs  ->  SkillsLoader
                ->  SkillReadTool / SkillCreateTool / ToolLoader

Only the agent-private layer (``~/.mona/agents/<id>/skills``) is redirected
to tmp_path so tests never touch user data.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent import agent_management, partners, skill_usage
from mona.agent.partners import MONA_AGENT_ID, AgentRegistry
from mona.agent.skills import SkillsLoader
from mona.agent.tools.context import ToolContext
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.skill_tools import (
    SkillCreateTool,
    SkillReadTool,
    SkillReferenceReadTool,
)
from mona.config import paths as config_paths

XHS = "com.mona.xhs-operator"
XHS_PACKAGE_SKILL = "xhs-content-operations"
PRIVATE_AGENT_IDS = (MONA_AGENT_ID, XHS)
EXPERT_SOURCE_ROOT = Path(__file__).parents[2] / "expert-library" / "agents"


@pytest.fixture(autouse=True)
def combined_package_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    combined = tmp_path / "package-sources"
    combined.mkdir()
    shutil.copytree(
        EXPERT_SOURCE_ROOT / XHS,
        combined / XHS,
    )
    monkeypatch.setattr(partners, "BUILTIN_AGENTS_DIR", combined)
    return combined


@pytest.fixture
def private_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Redirect per-agent private skills dirs to tmp; keep packages real."""
    roots = {agent_id: tmp_path / "private" / agent_id for agent_id in PRIVATE_AGENT_IDS}
    for p in roots.values():
        p.mkdir(parents=True)

    def _resolve(agent_id: str) -> Path:
        return roots[agent_id]

    monkeypatch.setattr(config_paths, "get_agent_skills_dir", _resolve)
    monkeypatch.setattr(skill_usage, "get_agent_skills_dir", _resolve)
    monkeypatch.setattr(agent_management, "get_agent_skills_dir", _resolve)
    monkeypatch.setattr(
        agent_management,
        "get_agent_memory_dir",
        lambda agent_id: tmp_path / "memory-roots" / agent_id / "memory",
    )
    return roots


@pytest.fixture
def registry(tmp_path: Path, combined_package_sources: Path) -> AgentRegistry:
    """Real shipped builtin tree; no installed agents."""
    return AgentRegistry(
        builtin_dir=combined_package_sources, installed_dir=tmp_path / "no-installed"
    )


def _loader(registry: AgentRegistry, agent_id: str) -> SkillsLoader:
    return SkillsLoader(
        workspace=Path("."),
        builtin_skills_dir=None,  # exercise private + package layers only
        agent_id=agent_id,
        package_skill_dirs=registry.resolve_skill_dirs(agent_id),
    )


def _skill_content(name: str, body: str) -> str:
    return (
        "---\n"
        f"name: {name}\n"
        "description: Test-only private skill.\n"
        "---\n\n"
        f"{body}"
    )


async def _create_skill(agent_id: str, name: str, body: str) -> str:
    result = await SkillCreateTool(agent_id=agent_id).execute(
        name=name,
        content=_skill_content(name, body),
    )
    assert "created and is active" in result
    return _skill_content(name, body)


class TestRealManifestLoading:
    def test_real_package_manifests_load(self, registry: AgentRegistry) -> None:
        assert registry.get(XHS) is not None

    def test_registry_lists_package_skills(self, registry: AgentRegistry) -> None:
        names = {e["name"] for e in _loader(registry, XHS).list_skills(filter_unavailable=False)}
        assert XHS_PACKAGE_SKILL in names


class TestRealAllowlist:
    def test_tool_loader_registers_skill_resource_tools_from_real_allowlist(
        self, registry: AgentRegistry, tmp_path: Path
    ) -> None:
        definition = registry.require(XHS)
        assert "skill_read" in definition.tool_allowlist
        assert "skill_reference_read" in definition.tool_allowlist

        ctx = ToolContext(config=SimpleNamespace(), workspace=str(tmp_path / "ws"), agent_id=XHS)
        tools = ToolRegistry()
        registered = ToolLoader().load(
            ctx, tools, scope="subagent", tool_allowlist=definition.tool_allowlist
        )
        assert "skill_read" in registered
        assert tools.get("skill_read") is not None
        assert "skill_reference_read" in registered
        assert tools.get("skill_reference_read") is not None

    def test_mona_only_tools_stay_stripped_for_partners(
        self, registry: AgentRegistry, tmp_path: Path
    ) -> None:
        # Naming a Mona-only tool in the allowlist must not register it.
        definition = registry.require(XHS)
        registered = ToolLoader().load(
            ToolContext(config=SimpleNamespace(), workspace=str(tmp_path / "ws")),
            ToolRegistry(),
            scope="subagent",
            tool_allowlist=definition.tool_allowlist + ["delegate_agent"],
        )
        assert "delegate_agent" not in registered

class TestPackageSkillAccess:
    async def test_xhs_reads_own_package_skill(self, registry: AgentRegistry) -> None:
        content = await SkillReadTool(agent_id=XHS).execute(name=XHS_PACKAGE_SKILL)
        assert "not found" not in content
        assert "小红书内容运营" in content

    async def test_xhs_reads_own_package_reference(self, registry: AgentRegistry) -> None:
        content = await SkillReferenceReadTool(agent_id=XHS).execute(
            skill=XHS_PACKAGE_SKILL,
            ref_path="title-copy.md",
        )
        assert "Error:" not in content
        assert "# 标题、选题与正文模板库" in content

    async def test_mona_cannot_read_xhs_package_reference(
        self, registry: AgentRegistry
    ) -> None:
        content = await SkillReferenceReadTool(agent_id=MONA_AGENT_ID).execute(
            skill=XHS_PACKAGE_SKILL,
            ref_path="title-copy.md",
        )
        assert "not found" in content

    async def test_mona_cannot_read_partner_package_skill(self, registry: AgentRegistry) -> None:
        content = await SkillReadTool(agent_id=MONA_AGENT_ID).execute(name=XHS_PACKAGE_SKILL)
        assert "not found" in content


class TestSelfCreatedSkillLifecycle:
    async def test_created_skill_readable_in_next_run(
        self, registry: AgentRegistry, private_roots: dict[str, Path]
    ) -> None:
        expected = await _create_skill(
            XHS, "my-research-checklist", "# checklist\n"
        )

        # A later run/tool instance resolves it through the same chain.
        content = await SkillReadTool(agent_id=XHS).execute(name="my-research-checklist")
        assert content == expected

    async def test_created_skill_invisible_to_other_agents(
        self, registry: AgentRegistry, private_roots: dict[str, Path]
    ) -> None:
        await _create_skill(XHS, "my-research-checklist", "# checklist\n")
        content = await SkillReadTool(agent_id=MONA_AGENT_ID).execute(
            name="my-research-checklist"
        )
        assert "not found" in content, MONA_AGENT_ID

    async def test_private_skill_cannot_shadow_package_skill(
        self, registry: AgentRegistry, private_roots: dict[str, Path]
    ) -> None:
        result = await SkillCreateTool(agent_id=XHS).execute(
            name=XHS_PACKAGE_SKILL,
            content=_skill_content(XHS_PACKAGE_SKILL, "# private override\n"),
        )
        assert "conflicts with a package or platform skill" in result
        content = await SkillReadTool(agent_id=XHS).execute(name=XHS_PACKAGE_SKILL)
        assert "# 小红书内容运营" in content


class TestIsolationSurvivesRestart:
    async def test_package_and_private_isolation_after_reload(
        self, registry: AgentRegistry, private_roots: dict[str, Path]
    ) -> None:
        await _create_skill(XHS, "my-research-checklist", "# checklist\n")

        # Simulate a process restart: fresh registry + fresh loaders.
        fresh_registry = AgentRegistry(
            builtin_dir=partners.BUILTIN_AGENTS_DIR,
            installed_dir=private_roots[XHS].parent.parent / "no-installed",
        )
        xhs = _loader(fresh_registry, XHS)
        xhs_names = {e["name"] for e in xhs.list_skills(filter_unavailable=False)}
        assert {XHS_PACKAGE_SKILL, "my-research-checklist"} <= xhs_names

        mona = _loader(fresh_registry, MONA_AGENT_ID)
        mona_names = {e["name"] for e in mona.list_skills(filter_unavailable=False)}
        assert XHS_PACKAGE_SKILL not in mona_names
        assert "my-research-checklist" not in mona_names
