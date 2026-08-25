"""Contract tests for the academic researcher partner package."""

from __future__ import annotations

import json
from pathlib import Path

from mona.agent.partners import BUILTIN_AGENTS_DIR, AgentRegistry
from mona.agent.skills import SkillsLoader
from mona.agent.tools.context import ToolContext
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import ToolsConfig
from mona.session.manager import SessionManager

AGENT_ID = "com.mona.academic-researcher"
ROOT = BUILTIN_AGENTS_DIR / AGENT_ID
SKILL_NAMES = (
    "research-evidence",
    "research-design",
    "research-execution",
    "research-writing",
)


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
    assert manifest["skills"] == [f"skills/{name}" for name in SKILL_NAMES]
    assert set(manifest["toolAllowlist"]) >= {
        "academic_search",
        "web_search",
        "web_fetch",
        "http_request",
        "read_file",
        "document",
        "materials_read",
        "knowledge_search",
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
        "memory_edit",
    }
    assert not {"spawn", "delegate_agent", "propose_workflow", "run_collaboration"} & set(
        manifest["toolAllowlist"]
    )
    assert (ROOT / "prompt.md").is_file()
    for name in SKILL_NAMES:
        skill = ROOT / "skills" / name / "SKILL.md"
        assert skill.is_file()
        metadata = _frontmatter(skill)
        assert set(metadata) == {"name", "description"}
        assert metadata["name"] == name
        assert metadata["description"]


def test_academic_researcher_registry_visibility_and_skill_isolation(tmp_path: Path) -> None:
    registry = AgentRegistry(
        builtin_dir=BUILTIN_AGENTS_DIR,
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
    assert {entry["name"] for entry in academic_loader.list_skills(filter_unavailable=False)} >= set(
        SKILL_NAMES
    )

    other_loader = SkillsLoader(
        workspace=tmp_path,
        builtin_skills_dir=None,
        agent_id="com.mona.xhs-operator",
        package_skill_dirs=registry.resolve_skill_dirs("com.mona.xhs-operator"),
    )
    assert not set(SKILL_NAMES) & {
        entry["name"] for entry in other_loader.list_skills(filter_unavailable=False)
    }


def test_academic_researcher_allowlist_registers_all_available_subagent_tools(tmp_path: Path) -> None:
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


def test_research_evidence_skill_contains_evidence_loop_and_failure_rules() -> None:
    content = (ROOT / "skills" / "research-evidence" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "academic_search",
        "research_record",
        "search_log.jsonl",
        "sources.jsonl",
        "claims.jsonl",
        "source_id",
        "evidence_text",
        "locator",
        "abstract",
        "反证",
        "去重",
        "insufficient_evidence",
        "fact",
        "inference",
        "hypothesis",
        "知识地图",
    ):
        assert marker in content, marker
    assert "不得编造" in content
    assert "普通简短问答" in content


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
    ):
        assert marker in prompt, marker
    assert "## 研究证据" not in prompt


def test_research_design_skill_has_complete_design_contract() -> None:
    content = (ROOT / "skills" / "research-design" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "academic_search",
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


def test_research_execution_skill_has_real_analysis_and_algorithm_contract() -> None:
    content = (ROOT / "skills" / "research-execution" / "SKILL.md").read_text(encoding="utf-8")
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


def test_research_writing_skill_has_evidence_bounded_deliverables() -> None:
    content = (ROOT / "skills" / "research-writing" / "SKILL.md").read_text(encoding="utf-8")
    for marker in (
        "sources.jsonl",
        "claims.jsonl",
        "实验记录",
        "事实边界",
        "论文",
        "大纲",
        "引言",
        "相关工作",
        "方法",
        "结果",
        "讨论",
        "局限",
        "基金",
        "立项依据",
        "研究目标",
        "技术路线",
        "创新点",
        "风险",
        "替代方案",
        "摘要",
        "评审回复",
        "原评论",
        "决定",
        "修改位置",
        "证据",
        "source_id",
        "实验 run",
        "事实",
        "推断",
        "假设",
        "建议",
        "不声明不存在的实验",
        "伦理批准",
        "利益冲突",
        "已完成修改",
        "不伪造引用",
        "Markdown",
        "deliver_file",
        "task-relative",
        "research/<task_id>/",
        "deliverable_register",
        "docx",
        "作者",
        "研究者负责最终审阅",
    ):
        assert marker in content, marker
