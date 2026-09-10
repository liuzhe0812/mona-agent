"""Document agent loop: focused, single-task, tool-whitelisted.

泛化自 PPTAgentLoop,按 ``agent_kind`` 声明式加载 DocumentProfile:
- soul prompt(ppt_soul.md / video_soul.md)
- skill(mona-ppt / mona-video)
- tools whitelist

DocumentAgentLoop 不直接消费 message bus。主 AgentLoop 在
``session.metadata.agent_kind`` 命中 DOCUMENT_PROFILES 时委派给本 loop,
保持 bus 单消费者,避免路由歧义。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from loguru import logger

from mona.agent.document_context import DocumentContextBuilder
from mona.agent.loop import AgentLoop
from mona.agent.tools.registry import ToolRegistry

# PPT 子集:与原 PPT_TOOLS_WHITELIST 完全一致(回归保障)
_PPT_TOOLS: frozenset[str] = frozenset({
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "exec",
    "web_search",
    "web_fetch",
    "generate_image",
    "skill_read",
    "skill_script_run",
    "skill_reference_read",
    "skill_asset_copy",
    "memory_read",
})

# Video 复用 PPT 的通用工具集。PPT 特有的 pptx 操作不在白名单中(走
# exec / skill_script_run),因此无需移除任何工具;视频渲染依赖
# (hyperframes_cli / merge_scenes)同样通过 exec 调用,无需新增专用工具。
# 保留 generate_image 供场景素材生成。
_VIDEO_TOOLS: frozenset[str] = frozenset({
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "exec",
    "web_search",
    "web_fetch",
    "generate_image",
    "skill_read",
    "skill_script_run",
    "skill_reference_read",
    "skill_asset_copy",
    "memory_read",
})

@dataclass(frozen=True)
class DocumentProfile:
    """单个文档子类型的声明式配置。"""

    agent_kind: str
    soul_template: str
    skill_name: str
    tools_whitelist: frozenset[str]


DOCUMENT_PROFILES: dict[str, DocumentProfile] = {
    "ppt": DocumentProfile(
        agent_kind="ppt",
        soul_template="agent/ppt_soul.md",
        skill_name="mona-ppt",
        tools_whitelist=_PPT_TOOLS,
    ),
    "video": DocumentProfile(
        agent_kind="video",
        soul_template="agent/video_soul.md",
        skill_name="mona-video",
        tools_whitelist=_VIDEO_TOOLS,
    ),
}


class DocumentAgentLoop(AgentLoop):
    """Agent loop 变体,用于复杂文档生成任务(PPT / 视频)。

    与主 loop 共享 provider/sessions/bus 等运行时依赖,但:
    - 替换 context builder 为 DocumentContextBuilder(profile 驱动的 soul prompt)
    - 按 profile.tools_whitelist 过滤工具注册表
    """

    def __init__(self, *args: Any, agent_kind: str, **kwargs: Any) -> None:
        if agent_kind not in DOCUMENT_PROFILES:
            raise ValueError(f"Unknown agent_kind: {agent_kind!r}")
        self._profile = DOCUMENT_PROFILES[agent_kind]
        super().__init__(*args, **kwargs)
        self.context = DocumentContextBuilder(
            self.workspace,
            profile=self._profile,
            timezone=self.context.timezone,
            disabled_skills=None,
        )
        self._filter_tools_to_whitelist(self._profile.tools_whitelist)

    def _filter_tools_to_whitelist(self, whitelist: frozenset[str]) -> None:
        """Unregister every tool not in the given whitelist."""
        self._tool_allowlist = set(whitelist)
        if not isinstance(self.tools, ToolRegistry):
            logger.warning(
                "DocumentAgentLoop.tools is not a ToolRegistry; skipping whitelist filter"
            )
            return
        all_names = list(self.tools._tools.keys())  # noqa: SLF001 — registry has no public iterator
        removed: list[str] = []
        for name in all_names:
            if name not in whitelist:
                self.tools.unregister(name)
                removed.append(name)
        logger.info(
            "DocumentAgentLoop({}) whitelist: kept {}, removed {}",
            self._profile.agent_kind,
            sorted(whitelist & set(all_names)),
            removed,
        )


__all__ = ["DocumentAgentLoop", "DocumentProfile", "DOCUMENT_PROFILES"]
