"""Contract tests for the academic researcher partner package."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from mona.agent import partners
from mona.agent.loop import AgentLoop
from mona.agent.partners import AgentRegistry
from mona.agent.skills import SkillsLoader
from mona.agent.tools.context import ToolContext
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.skill_tools import SkillReferenceReadTool, SkillScriptRunTool
from mona.agent.user_config import load_agent_user_config
from mona.config.schema import ToolsConfig
from mona.runtime.agent_env import AgentEnvironmentResolution
from mona.session.manager import SessionManager

AGENT_ID = "com.mona.academic-researcher"
EXPERT_SOURCE_ROOT = Path(__file__).parents[2] / "expert-library" / "agents"
ROOT = EXPERT_SOURCE_ROOT / AGENT_ID
SKILL_NAMES = (
    "literature-search",
    "paper-reading",
    "citation-audit",
    "research-design",
    "analysis-experiment",
    "manuscript-editing",
    "review-response",
)


@pytest.fixture(autouse=True)
def load_expert_sources_as_test_builtins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(partners, "BUILTIN_AGENTS_DIR", EXPERT_SOURCE_ROOT)


def _manifest() -> dict:
    return json.loads((ROOT / "agent.json").read_text(encoding="utf-8"))


def _frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    _, raw, _ = text.split("---\n", 2)
    values: dict[str, str] = {}
    for line in raw.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            values[key.strip()] = value.strip()
    return values


def test_academic_researcher_manifest_and_package_skills() -> None:
    manifest = _manifest()
    assert manifest["id"] == AGENT_ID
    assert manifest["visibility"] == "partner"
    assert manifest["model"] == "inherit"
    assert manifest["canDelegate"] is False
    assert manifest["prompt"] == "prompt.md"
    assert manifest["packageVersion"] == "2.1.0"
    assert manifest["skills"] == [f"skills/{name}" for name in SKILL_NAMES]
    assert set(manifest["toolAllowlist"]) >= {
        "academic_search",
        "web_search",
        "web_fetch",
        "http_request",
        "browser_open",
        "browser_snapshot",
        "browser_type",
        "browser_click",
        "browser_read",
        "browser_close",
        "read_file",
        "document",
        "materials_search",
        "materials_read",
        "find_files",
        "grep",
        "research_record",
        "write_file",
        "edit_file",
        "deliver_file",
        "dataframe_query",
        "chart",
        "exec",
        "apply_patch",
        "scientific_tool",
        "long_task",
        "complete_goal",
        "skill_read",
        "skill_reference_read",
        "skill_script_run",
        "memory_edit",
        "skill_create",
    }
    assert not {"spawn", "delegate_agent", "propose_workflow", "run_collaboration"} & set(
        manifest["toolAllowlist"]
    )
    assert (ROOT / "prompt.md").is_file()
    for name in SKILL_NAMES:
        skill = ROOT / "skills" / name / "SKILL.md"
        assert skill.is_file()
        metadata = _frontmatter(skill)
        assert {"name", "description"} <= set(metadata)
        assert metadata["name"] == name
        assert metadata["description"]


def test_academic_skills_bundle_integrated_nature_resources() -> None:
    required_scripts = {
        "literature-search": {
            "academic_search.py",
            "format-converter.py",
            "preflight.py",
            "batch_download.mjs",
        },
        "paper-reading": {"prepare_paper.py", "audit_paper_card.py", "validate_reader_math.py"},
        "citation-audit": {"nature_citation.py"},
        "research-design": {"build_proposal_docx.py"},
        "analysis-experiment": {"validate_figure.py", "audit_figure_collisions.py"},
        "review-response": {"check_package_consistency.py"},
    }
    for name in SKILL_NAMES:
        skill_dir = ROOT / "skills" / name
        assert (skill_dir / "references" / "resource-map.md").is_file()
        upstream = skill_dir / "references" / "upstream"
        assert upstream.is_dir()
        assert any(path.is_file() for path in upstream.rglob("*"))
        for script in required_scripts.get(name, set()):
            assert (skill_dir / "scripts" / script).is_file()

    assert (ROOT / "THIRD_PARTY_NOTICES.md").is_file()
    assert (ROOT / "licenses" / "Apache-2.0.txt").is_file()
    assert (ROOT / "licenses" / "nature-downloader-MIT.txt").is_file()
    assert (ROOT / "licenses" / "nature-experiment-log-MIT.txt").is_file()
    assert (ROOT / "licenses" / "nature-proposal-writer-MIT.txt").is_file()
    assert (ROOT / "skills" / "literature-search" / "data" / "publishers.json").is_file()
    assert (
        ROOT / "skills" / "literature-search" / "scripts" / "lib" / "publisher-providers.mjs"
    ).is_file()


def test_academic_sources_are_excluded_from_base_wheel() -> None:
    project = tomllib.loads((ROOT.parents[2] / "pyproject.toml").read_text(encoding="utf-8"))
    includes = set(project["tool"]["hatch"]["build"]["include"])
    assert "mona/**/*.py" in includes
    assert not any("academic-researcher" in pattern for pattern in includes)
    assert (ROOT / "package-manifest.json").is_file()


def test_academic_resource_maps_use_directly_readable_reference_paths() -> None:
    for name in SKILL_NAMES:
        references = ROOT / "skills" / name / "references"
        resource_map = references / "resource-map.md"
        paths = re.findall(
            r"`(upstream/[^`]+)`",
            resource_map.read_text(encoding="utf-8"),
        )
        assert paths, name
        for relative_path in paths:
            assert (references / relative_path).is_file(), f"{name}: {relative_path}"


async def test_academic_skill_resources_are_readable_through_agent_scope() -> None:
    content = await SkillReferenceReadTool(agent_id=AGENT_ID, track_usage=False).execute(
        skill="paper-reading",
        ref_path="resource-map.md",
    )
    assert "Nature Reader" in content
    assert "prepare_paper.py" in content


async def test_academic_package_script_uses_managed_runtime() -> None:
    output = await SkillScriptRunTool(
        agent_id=AGENT_ID,
        track_usage=False,
        agent_environment=_TestRuntimeManager(),  # type: ignore[arg-type]
    ).execute(
        skill="literature-search",
        script="academic_search.py",
        args="--help",
    )
    assert "usage:" in output.lower()


class _TestRuntimeManager:
    async def prepare_for_skill(
        self, suffix: str, _skill_dir: Path, _spec
    ) -> AgentEnvironmentResolution:
        executable = Path(sys.executable)
        if suffix.lower() == ".mjs":
            node = shutil.which("node")
            assert node is not None
            executable = Path(node)
        return AgentEnvironmentResolution(executable=executable, env=os.environ.copy())


async def test_academic_export_scripts_require_workspace_output_paths(tmp_path: Path) -> None:
    runner = SkillScriptRunTool(
        agent_id=AGENT_ID,
        workspace=tmp_path,
        track_usage=False,
        agent_environment=_TestRuntimeManager(),  # type: ignore[arg-type]
    )
    missing = await runner.execute(
        skill="literature-search",
        script="format-converter.py",
        args="--pmid 1",
    )
    assert "--output is required" in missing

    relative = await runner.execute(
        skill="literature-search",
        script="format-converter.py",
        args="--pmid 1 --output relative-output",
    )
    assert "--output must be an absolute path" in relative

    outside = tmp_path.parent / "outside-academic-export"
    escaped = await runner.execute(
        skill="literature-search",
        script="format-converter.py",
        args=f'--pmid 1 --output "{outside}"',
    )
    assert "--output must stay inside the active Mona workspace" in escaped

    if shutil.which("node") is not None:
        node_missing = await runner.execute(
            skill="literature-search",
            script="batch_download.mjs",
            args='--title "test paper" --no-si',
        )
        assert "--out is required" in node_missing

        node_relative = await runner.execute(
            skill="literature-search",
            script="batch_download.mjs",
            args='--title "test paper" --out relative-output --no-si',
        )
        assert "--out must be an absolute path" in node_relative

        node_escaped = await runner.execute(
            skill="literature-search",
            script="batch_download.mjs",
            args=f'--title "test paper" --out "{outside}" --no-si',
        )
        assert "--out must stay inside the active Mona workspace" in node_escaped


def test_academic_researcher_registry_visibility_and_skill_isolation(tmp_path: Path) -> None:
    registry = AgentRegistry(
        builtin_dir=EXPERT_SOURCE_ROOT,
        installed_dir=tmp_path / "no-installed",
    )
    definition = registry.require(AGENT_ID)
    assert definition.visibility == "partner"
    assert definition.can_delegate is False
    assert set(path.name for path in registry.resolve_skill_dirs(AGENT_ID)) == set(SKILL_NAMES)

    academic_loader = SkillsLoader(
        workspace=tmp_path,
        builtin_skills_dir=None,
        agent_id=AGENT_ID,
        package_skill_dirs=registry.resolve_skill_dirs(AGENT_ID),
    )
    assert {
        entry["name"] for entry in academic_loader.list_skills(filter_unavailable=False)
    } >= set(SKILL_NAMES)

    other_loader = SkillsLoader(
        workspace=tmp_path,
        builtin_skills_dir=None,
        agent_id="com.mona.xhs-operator",
        package_skill_dirs=registry.resolve_skill_dirs("com.mona.xhs-operator"),
    )
    assert not set(SKILL_NAMES) & {
        entry["name"] for entry in other_loader.list_skills(filter_unavailable=False)
    }


def test_academic_researcher_allowlist_registers_all_available_subagent_tools(
    tmp_path: Path,
) -> None:
    manifest = _manifest()
    ctx = ToolContext(
        config=ToolsConfig(),
        workspace=str(tmp_path),
        sessions=SessionManager(tmp_path / "sessions"),
        agent_id=AGENT_ID,
    )
    registry = ToolRegistry()
    registered = set(
        ToolLoader().load(
            ctx,
            registry,
            scope="subagent",
            tool_allowlist=manifest["toolAllowlist"],
        )
    )
    assert not set(manifest["toolAllowlist"]) - registered


def test_literature_search_skill_has_search_and_failure_contract() -> None:
    content = (ROOT / "skills" / "literature-search" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "academic_search",
        "research_record",
        "search_log.jsonl",
        "sources.jsonl",
        "provider",
        "中文",
        "英文",
        "去重",
        "不可用",
        "没有文献",
        "有限重试",
        "继续检索",
        "PMCID/PMID",
        "期刊官网",
        "分开记录和报告",
    ):
        assert marker in content, marker
    assert "严禁编造" in content


def test_paper_reading_skill_requires_located_evidence() -> None:
    content = (ROOT / "skills" / "paper-reading" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "研究问题",
        "样本",
        "方法",
        "主要结果",
        "作者结论",
        "局限",
        "页码",
        "章节",
        "图表",
        "abstract",
        "locator",
    ):
        assert marker in content, marker


def test_citation_audit_skill_separates_existence_from_claim_support() -> None:
    content = (ROOT / "skills" / "citation-audit" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "DOI",
        "PMID",
        "文献存在",
        "支持",
        "partial",
        "contradicts",
        "not_addressed",
        "insufficient_evidence",
        "定位",
        "严禁编造",
    ):
        assert marker in content, marker


def test_prompt_defers_detail_to_skills_and_keeps_core_research_rules() -> None:
    prompt = (ROOT / "prompt.md").read_text(encoding="utf-8")
    for marker in (
        "先验证来源",
        "事实",
        "推断",
        "假设",
        "实际运行",
        "证据/工具不足",
        "long_task",
        "complete_goal",
        "skill_read",
        "literature-search",
        "paper-reading",
        "citation-audit",
        "analysis-experiment",
        "manuscript-editing",
        "review-response",
        "只选择一个主要 Skill",
        "最终要拿到的交付物",
        "查文献后写引言",
        "检查并修改论文",
        "先问一个简短问题",
        "完成该事务即停止",
    ):
        assert marker in prompt, marker
    assert "## 研究证据" not in prompt


def test_completed_turn_records_a_bounded_agent_learning_signal() -> None:
    loop = AgentLoop.__new__(AgentLoop)
    memory = MagicMock()
    memory.agent_id = AGENT_ID
    loop.context = SimpleNamespace(memory=memory)

    loop._record_completed_turn_history("user question", "assistant answer")

    memory.append_history.assert_called_once()
    entry = memory.append_history.call_args.args[0]
    assert entry == "Conversation turn\nUser: user question\nAssistant: assistant answer"
    assert memory.append_history.call_args.kwargs == {"max_chars": 4_000}


def test_research_design_skill_has_complete_design_contract() -> None:
    content = (ROOT / "skills" / "research-design" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "literature-search",
        "相近论文",
        "预印本",
        "注册研究",
        "证据依据",
        "可证伪",
        "替代解释",
        "确认条件",
        "否证条件",
        "待验证",
        "自变量",
        "因变量",
        "控制变量",
        "混杂因素",
        "对照",
        "样本/数据",
        "主要终点",
        "评价指标",
        "失败模式",
        "资源风险",
        "伦理",
        "隐私",
        "专业审核",
        "标记为需求",
        "不虚构",
    ):
        assert marker in content, marker
    assert "已验证创新" in content
    assert "相近工作" in content


def test_analysis_experiment_skill_has_real_analysis_and_algorithm_contract() -> None:
    content = (ROOT / "skills" / "analysis-experiment" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "scientific_tool",
        "discover",
        "inspect",
        "run",
        "dataframe_query",
        "exec",
        "文件",
        "字段",
        "类型",
        "缺失值",
        "分析目标",
        "实际运行",
        "退出码",
        "日志",
        "输出文件",
        "数据哈希",
        "代码",
        "命令",
        "依赖版本",
        "参数",
        "随机种子",
        "指标",
        "生成文件",
        "research_record",
        "research/<task_id>/experiments/<run_id>/",
        "基线",
        "唯一主指标",
        "优化方向",
        "预算",
        "隔离副本",
        "原始代码",
        "原始数据",
        "本轮无改进",
        "最终测试集",
        "不得模拟结果",
    ):
        assert marker in content, marker
    assert "退出码非零" in content
    assert "不能报告成功" in content


def test_manuscript_editing_skill_preserves_evidence_boundaries() -> None:
    content = (ROOT / "skills" / "manuscript-editing" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "sources.jsonl",
        "claims.jsonl",
        "事实边界",
        "论文",
        "大纲",
        "引言",
        "相关工作",
        "方法",
        "结果",
        "讨论",
        "局限",
        "创新点",
        "事实",
        "推断",
        "假设",
        "建议",
        "作者",
        "研究者负责最终审阅",
    ):
        assert marker in content, marker


def test_review_response_skill_tracks_each_comment_and_real_completion() -> None:
    content = (ROOT / "skills" / "review-response" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "稳定编号",
        "原评论",
        "处理决定",
        "修改位置",
        "回复草稿",
        "剩余风险",
        "已修改",
        "已补充",
        "citation-audit",
    ):
        assert marker in content, marker


def test_legacy_academic_skill_preferences_are_mapped_without_touching_identity(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "disabled_skills": ["research-evidence", "research-writing"],
                "script_enabled_skills": ["research-execution"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "mona.agent.user_config.get_agent_user_config_path",
        lambda _agent_id: config_path,
    )

    config = load_agent_user_config(AGENT_ID)

    assert config.disabled_skills == [
        "literature-search",
        "paper-reading",
        "citation-audit",
        "manuscript-editing",
        "review-response",
    ]
    assert config.script_enabled_skills == ["analysis-experiment"]
