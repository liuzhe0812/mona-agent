"""PPT agent context builder: ppt_soul.md identity, no memory, no history.

The PPT agent is a single-task focused loop. It must NOT load long-term memory,
recent history, or Dream-managed files. Its identity comes from ``ppt_soul.md``
and its only skill is ``mona-ppt``.
"""

from __future__ import annotations

from typing import Any

from mona.agent.context import ContextBuilder
from mona.utils.prompt_templates import render_template


class PPTContextBuilder(ContextBuilder):
    """Context builder for the PPT agent.

    Differences from the default ContextBuilder:
    - Identity: ``ppt_soul.md`` instead of ``identity.md``
    - No bootstrap files (no SOUL.md/USER.md/AGENTS.md loading)
    - No long-term memory context
    - No recent history replay
    - Only ``mona-ppt`` skill is advertised (always-on, no skill menu)
    """

    def build_system_prompt(
        self,
        skill_names: list[str] | None = None,
        channel: str | None = None,
        session_summary: str | None = None,
    ) -> str:
        """Build a focused system prompt: ppt_soul + tool_contract + mona-ppt skill."""
        parts: list[str] = [self._get_identity(channel=channel)]

        # Tool contract (shared with main agent — describes available tools).
        parts.append(render_template("agent/tool_contract.md"))

        # mona-ppt skill is the ONLY skill advertised. Load it as always-on.
        from mona.agent.skills import SkillsLoader
        ppt_skills = SkillsLoader(
            self.workspace,
            disabled_skills=None,
        )
        always = ppt_skills.get_always_skills()
        # Force mona-ppt into the always-on set even if it isn't flagged always.
        if "mona-ppt" not in always:
            always = [*always, "mona-ppt"]
        always_content = ppt_skills.load_skills_for_context(always)
        if always_content:
            parts.append(f"# Active Skills\n\n{always_content}")

        if session_summary:
            parts.append(f"[Archived Context Summary]\n\n{session_summary}")

        return "\n\n---\n\n".join(parts)

    def _get_identity(self, channel: str | None = None) -> str:
        """Return the PPT agent identity from ppt_soul.md."""
        import platform

        system = platform.system()
        runtime = (
            f"{'macOS' if system == 'Darwin' else system} "
            f"{platform.machine()}, Python {platform.python_version()}"
        )
        return render_template(
            "agent/ppt_soul.md",
            runtime=runtime,
            channel=channel or "",
        )

    def _load_bootstrap_files(self) -> str:
        """PPT agent does not load SOUL/USER/AGENTS bootstrap files."""
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

        PPT sessions are stateless: each turn is built from the system prompt
        (ppt_soul + mona-ppt skill) plus the explicit conversation history.
        No long-term memory, no recent history replay, no bootstrap files.
        """
        # Reuse the parent's history/role-merge logic, but with our trimmed
        # system prompt (no memory, no bootstrap, no skill menu).
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


__all__ = ["PPTContextBuilder"]
