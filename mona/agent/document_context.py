"""Document agent context builder: profile 驱动的 soul prompt,无 memory / 无 history。

泛化自 PPTContextBuilder,从 DocumentProfile 读取 soul_template 和 skill_name,
不再硬编码 ppt_soul.md / mona-ppt。文档 agent 是单任务聚焦 loop,不加载长期 memory、
不重放历史、不加载 bootstrap 文件。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mona.agent.context import ContextBuilder
from mona.utils.prompt_templates import render_template

if TYPE_CHECKING:
    # 避免与 document_loop.py 的循环导入(运行时 profile 是普通对象,鸭子类型足够)
    from mona.agent.document_loop import DocumentProfile


class DocumentContextBuilder(ContextBuilder):
    """Context builder for document agents (PPT / video / flowchart).

    Differences from the default ContextBuilder:
    - Identity: profile.soul_template 替代 identity.md
    - No bootstrap files (no SOUL.md/USER.md/AGENTS.md loading)
    - No long-term memory context
    - No recent history replay
    - Only profile.skill_name is advertised (always-on, no skill menu)
    """

    def __init__(
        self,
        workspace: Any,
        profile: DocumentProfile,
        *,
        timezone: Any = None,
        disabled_skills: list[str] | None = None,
    ) -> None:
        super().__init__(workspace, timezone=timezone, disabled_skills=disabled_skills)
        self._profile = profile

    def build_system_prompt(
        self,
        skill_names: list[str] | None = None,
        channel: str | None = None,
        session_summary: str | None = None,
    ) -> str:
        """Build a focused system prompt: soul + tool_contract + profile.skill_name skill."""
        parts: list[str] = [self._get_identity(channel=channel)]

        parts.append(render_template("agent/tool_contract.md"))

        # profile.skill_name 是唯一被通告的 skill,强制 always-on
        from mona.agent.skills import SkillsLoader
        doc_skills = SkillsLoader(
            self.workspace,
            disabled_skills=None,
        )
        always = doc_skills.get_always_skills()
        if self._profile.skill_name not in always:
            always = [*always, self._profile.skill_name]
        always_content = doc_skills.load_skills_for_context(always)
        if always_content:
            parts.append(f"# Active Skills\n\n{always_content}")

        if session_summary:
            parts.append(f"[Archived Context Summary]\n\n{session_summary}")

        return "\n\n---\n\n".join(parts)

    def _get_identity(self, channel: str | None = None) -> str:
        """Return the document agent identity from profile.soul_template."""
        import platform

        system = platform.system()
        runtime = (
            f"{'macOS' if system == 'Darwin' else system} "
            f"{platform.machine()}, Python {platform.python_version()}"
        )
        return render_template(
            self._profile.soul_template,
            runtime=runtime,
            channel=channel or "",
        )

    def _load_bootstrap_files(self) -> str:
        """Document agent does not load SOUL/USER/AGENTS bootstrap files."""
        return ""

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str,
        skill_names: list[str] | None = None,
        media: list[str] | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
        current_role: str = "user",
        sender_id: str | None = None,
        session_summary: str | None = None,
        session_metadata: dict[str, Any] | None = None,
        message_metadata: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Build messages without memory/history context injection.

        Document sessions are stateless: each turn is built from the system prompt
        (soul + skill) plus the explicit conversation history.
        """
        user_content = self._build_user_content(current_message, media)
        runtime_ctx = self._build_runtime_context(
            channel,
            chat_id,
            self.timezone,
            sender_id=sender_id,
        )
        if isinstance(user_content, str):
            merged = f"{user_content}\n\n{runtime_ctx}"
        else:
            merged = user_content + [{"type": "text", "text": runtime_ctx}]

        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": self.build_system_prompt(
                    skill_names, channel=channel, session_summary=session_summary,
                ),
            },
            *history,
        ]
        if messages and messages[-1].get("role") == current_role:
            last = dict(messages[-1])
            last["content"] = self._merge_message_content(
                last.get("content"), merged,
            )
            messages[-1] = last
        else:
            messages.append({"role": current_role, "content": merged})
        return messages


__all__ = ["DocumentContextBuilder"]
