from __future__ import annotations

import json
from pathlib import Path

from mona.agent.partners import BUILTIN_AGENTS_DIR, AgentRegistry
from mona.agent.agent_management import agent_tool_catalog
from mona.agent.skills import SkillsLoader
from mona.agent.tools.context import ToolContext
from mona.agent.tools.image_generation import ImageGenerationToolConfig
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.skill_tools import SkillAssetCopyTool, SkillReferenceReadTool
from mona.config import schema as config_schema
from mona.providers.image_generation import _openai_size
from mona.agent.tools.video_generation import VideoGenerationToolConfig

config_schema._resolve_tool_config_refs()
ToolsConfig = config_schema.ToolsConfig


AGENT_ID = "com.mona.xhs-operator"
ROOT = BUILTIN_AGENTS_DIR / AGENT_ID


def test_xhs_operator_exposes_safe_analysis_and_cover_tools() -> None:
    manifest = json.loads((ROOT / "agent.json").read_text(encoding="utf-8"))
    tools = set(manifest["toolAllowlist"])

    assert {
        "browser_open",
        "browser_navigate",
        "browser_read",
        "browser_snapshot",
        "browser_screenshot",
        "generate_image",
        "generate_video",
        "skill_reference_read",
        "skill_asset_copy",
    } <= tools
    assert {"browser_click", "browser_type"}.isdisjoint(tools)


def test_xhs_operator_package_skill_loads(tmp_path: Path) -> None:
    registry = AgentRegistry(
        builtin_dir=BUILTIN_AGENTS_DIR,
        installed_dir=tmp_path / "no-installed",
    )
    loader = SkillsLoader(
        workspace=tmp_path,
        builtin_skills_dir=None,
        agent_id=AGENT_ID,
        package_skill_dirs=registry.resolve_skill_dirs(AGENT_ID),
    )

    assert "xhs-content-operations" in {
        skill["name"] for skill in loader.list_skills(filter_unavailable=False)
    }


def test_xhs_tool_catalog_uses_this_agents_manifest_ceiling(tmp_path: Path) -> None:
    definition = AgentRegistry(
        builtin_dir=BUILTIN_AGENTS_DIR,
        installed_dir=tmp_path / "no-installed",
    ).require(AGENT_ID)
    catalog = agent_tool_catalog(definition, workspace=tmp_path)

    assert [tool["name"] for tool in catalog] == definition.tool_allowlist
    assert all("description" in tool and "available" in tool for tool in catalog)


def test_generate_image_is_available_to_allowlisted_partner(tmp_path: Path) -> None:
    manifest = json.loads((ROOT / "agent.json").read_text(encoding="utf-8"))
    tools = ToolRegistry()

    registered = ToolLoader().load(
        ToolContext(
            config=ToolsConfig(
                image_generation=ImageGenerationToolConfig(enabled=True),
                video_generation=VideoGenerationToolConfig(enabled=True),
            ),
            workspace=str(tmp_path),
            agent_id=AGENT_ID,
        ),
        tools,
        scope="subagent",
        tool_allowlist=manifest["toolAllowlist"],
    )

    assert {
        "generate_image",
        "generate_video",
        "skill_reference_read",
        "skill_asset_copy",
    } <= set(registered)
    assert tools.get("generate_image") is not None
    assert tools.get("generate_video") is not None


def test_agnes_xhs_cover_uses_a_true_three_to_four_size() -> None:
    assert _openai_size("agnes-image-2.1-flash", "3:4", "1K") == "768x1024"


async def test_xhs_operator_can_read_references_and_copy_assets(tmp_path: Path) -> None:
    reference = await SkillReferenceReadTool(agent_id=AGENT_ID).execute(
        skill="xhs-content-operations",
        ref_path="video-script.md",
    )
    assert "15 秒" in reference

    destination = tmp_path / "editorial-clean.png"
    result = await SkillAssetCopyTool(agent_id=AGENT_ID).execute(
        skill="xhs-content-operations",
        asset="covers/editorial-clean.png",
        dest=str(destination),
    )
    assert "Successfully copied" in result
    assert destination.stat().st_size > 100_000
