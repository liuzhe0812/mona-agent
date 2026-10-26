"""Tests for the Dream class — two-phase memory consolidation via AgentRunner."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent import agent_management, skill_usage
from mona.agent.memory import Dream, MemoryStore
from mona.agent.runner import AgentRunResult
from mona.agent.skills import BUILTIN_SKILLS_DIR
from mona.config import paths as config_paths


@pytest.fixture
def store(tmp_path):
    s = MemoryStore(tmp_path)
    s.write_soul("# Soul\n- Helpful")
    s.write_user("# User\n- Developer")
    s.write_memory("# Memory\n- Project X active")
    return s


@pytest.fixture
def mock_provider():
    p = MagicMock()
    p.chat_with_retry = AsyncMock()
    return p


@pytest.fixture
def mock_runner():
    return MagicMock()


@pytest.fixture
def dream(store, mock_provider, mock_runner):
    d = Dream(store=store, provider=mock_provider, model="test-model", max_batch_size=5)
    d._runner = mock_runner
    return d


def _make_run_result(
    stop_reason="completed",
    final_content=None,
    tool_events=None,
    usage=None,
):
    return AgentRunResult(
        final_content=final_content or stop_reason,
        stop_reason=stop_reason,
        messages=[],
        tools_used=[],
        usage={},
        tool_events=tool_events or [],
    )


class TestDreamRun:
    async def test_noop_when_no_unprocessed_history(self, dream, mock_provider, mock_runner, store):
        """Dream should not call LLM when there's nothing to process."""
        result = await dream.run()
        assert result is False
        mock_provider.chat_with_retry.assert_not_called()
        mock_runner.run.assert_not_called()

    async def test_calls_runner_for_unprocessed_entries(self, dream, mock_provider, mock_runner, store):
        """Dream should call AgentRunner when there are unprocessed history entries."""
        store.append_history("User prefers dark mode")
        mock_provider.chat_with_retry.return_value = MagicMock(content="New fact")
        mock_runner.run = AsyncMock(return_value=_make_run_result(
            tool_events=[{"name": "edit_file", "status": "ok", "detail": "memory/MEMORY.md"}],
        ))
        result = await dream.run()
        assert result is True
        mock_runner.run.assert_called_once()
        spec = mock_runner.run.call_args[0][0]
        assert spec.max_iterations == 10
        assert spec.fail_on_tool_error is False

    async def test_advances_dream_cursor(self, dream, mock_provider, mock_runner, store):
        """Dream should advance the cursor after processing."""
        store.append_history("event 1")
        store.append_history("event 2")
        mock_provider.chat_with_retry.return_value = MagicMock(content="Nothing new")
        mock_runner.run = AsyncMock(return_value=_make_run_result())
        await dream.run()
        assert store.get_last_dream_cursor() == 2

    async def test_compacts_processed_history(self, dream, mock_provider, mock_runner, store):
        """Dream should compact history after processing."""
        store.append_history("event 1")
        store.append_history("event 2")
        store.append_history("event 3")
        mock_provider.chat_with_retry.return_value = MagicMock(content="Nothing new")
        mock_runner.run = AsyncMock(return_value=_make_run_result())
        await dream.run()
        # After Dream, cursor is advanced and 3, compact keeps last max_history_entries
        entries = store.read_unprocessed_history(since_cursor=0)
        assert all(e["cursor"] > 0 for e in entries)

    async def test_skill_phase_uses_dedicated_skill_creator_tools(self, dream, mock_provider, mock_runner, store):
        """Dream should access the skill-creator reference through the hard-boundary tool."""
        store.append_history("Repeated workflow one")
        store.append_history("Repeated workflow two")
        mock_provider.chat_with_retry.return_value = MagicMock(content="[SKILL] test-skill: test description")
        mock_runner.run = AsyncMock(return_value=_make_run_result())

        await dream.run()

        spec = mock_runner.run.call_args[0][0]
        system_prompt = spec.initial_messages[0]["content"]
        assert 'skill_read(name="skill-creator")' in system_prompt
        assert "skill_create" in system_prompt
        assert str(BUILTIN_SKILLS_DIR / "skill-creator" / "SKILL.md") not in system_prompt

    async def test_skill_creation_activates_private_skill(self, dream, store, monkeypatch):
        """Dream must activate private Skills through skill_create, never workspace writes."""
        skills_root = store.workspace / "agent-skills"
        skills_root.mkdir()
        monkeypatch.setattr(config_paths, "get_agent_skills_dir", lambda _agent_id: skills_root)
        monkeypatch.setattr(agent_management, "get_agent_skills_dir", lambda _agent_id: skills_root)
        monkeypatch.setattr(skill_usage, "get_agent_skills_dir", lambda _agent_id: skills_root)
        skill_tool = dream._tools.get("skill_create")
        assert skill_tool is not None

        result = await skill_tool.execute(
            name="test-skill",
            content="---\nname: test-skill\ndescription: Test\n---\n",
        )

        assert "created and is active" in result
        assert (skills_root / "test-skill" / "SKILL.md").exists()
        assert not (store.workspace / "skills" / "test-skill" / "SKILL.md").exists()

    async def test_phase1_prompt_uses_current_memory_without_version_metadata(self, dream, mock_provider, mock_runner, store):
        store.append_history("some event")
        mock_provider.chat_with_retry.return_value = MagicMock(content="[SKIP]")
        mock_runner.run = AsyncMock(return_value=_make_run_result())

        await dream.run()

        call_args = mock_provider.chat_with_retry.call_args
        user_msg = call_args.kwargs.get("messages", call_args[1].get("messages"))[1]["content"]
        assert "## Current MEMORY.md" in user_msg
        assert "Project X active" in user_msg
        assert "\u2190" not in user_msg
        assert not (store.memory_dir / ".git").exists()

    async def test_phase1_keeps_persona_unannotated_and_excludes_private_user(self, dream, mock_provider, mock_runner, store):
        """Dream sees the Agent persona, without the old private user profile."""
        store.append_history("some event")
        mock_provider.chat_with_retry.return_value = MagicMock(content="[SKIP]")
        mock_runner.run = AsyncMock(return_value=_make_run_result())

        await dream.run()

        call_args = mock_provider.chat_with_retry.call_args
        user_msg = call_args.kwargs.get("messages", call_args[1].get("messages"))[1]["content"]
        soul_section = user_msg.split("## Current SOUL.md")[1]
        assert "\u2190" not in soul_section
        assert "Current USER.md" not in user_msg
        assert "Developer" not in user_msg

    async def test_phase1_prompt_works_without_git(self, dream, mock_provider, mock_runner, store):
        store.append_history("some event")
        mock_provider.chat_with_retry.return_value = MagicMock(content="[SKIP]")
        mock_runner.run = AsyncMock(return_value=_make_run_result())

        await dream.run()

        mock_provider.chat_with_retry.assert_called_once()
        call_args = mock_provider.chat_with_retry.call_args
        user_msg = call_args.kwargs.get("messages", call_args[1].get("messages"))[1]["content"]
        assert "## Current MEMORY.md" in user_msg

    async def test_dream_keeps_only_the_previous_memory_after_multiple_tool_edits(
        self, dream, mock_provider, mock_runner, store,
    ):
        store.append_history("new project knowledge")
        mock_provider.chat_with_retry.return_value = MagicMock(content="[MEMORY] new project")

        async def update_memory(_spec):
            tool = dream._tools.get("memory_edit")
            await tool.execute(file="memory", content="intermediate knowledge")
            await tool.execute(file="memory", content="latest knowledge")
            return _make_run_result(tool_events=[{"name": "memory_edit", "status": "ok", "detail": "saved"}])

        mock_runner.run = AsyncMock(side_effect=update_memory)
        await dream.run()
        assert store.read_memory() == "latest knowledge"
        assert store.read_previous("memory") == "intermediate knowledge"
        assert len(list(store.memory_dir.glob("*.previous"))) == 1
        assert not (store.memory_dir / ".git").exists()


class TestDreamPromptCaps:
    """Dream's Phase 1/2 prompt must not be poisoned by a legacy oversized
    history entry or a runaway MEMORY.md. Without caps, a single pre-#3412
    raw_archive dump in history.jsonl would make every subsequent Dream run
    exceed the context window and silently advance the cursor past real work.
    """

    async def test_phase1_caps_huge_memory_file(
        self, dream, mock_provider, mock_runner, store,
    ):
        """A MEMORY.md much larger than _MEMORY_FILE_MAX_CHARS must be truncated
        in the prompt preview (full content is still reachable via read_file)."""
        store.write_memory("M" * (dream._MEMORY_FILE_MAX_CHARS * 5))
        store.append_history("some event")
        mock_provider.chat_with_retry.return_value = MagicMock(content="[SKIP]")
        mock_runner.run = AsyncMock(return_value=_make_run_result())

        await dream.run()

        user_msg = mock_provider.chat_with_retry.call_args.kwargs["messages"][1]["content"]
        memory_section = user_msg.split("## Current MEMORY.md")[1].split("## Current SOUL.md")[0]
        assert len(memory_section) < dream._MEMORY_FILE_MAX_CHARS + 500

    async def test_phase1_caps_huge_history_entry(
        self, dream, mock_provider, mock_runner, store,
    ):
        """A legacy oversized history entry (e.g. pre-#3412 raw_archive dump)
        must not explode the Phase 1 prompt — each entry is capped in the
        preview, even though the JSONL record itself stays full-size."""
        # Bypass the append_history cap by writing directly, simulating a
        # record that was written by an older mona build before any caps.
        store.history_file.write_text(
            json.dumps({
                "cursor": 1,
                "timestamp": "2026-04-01 10:00",
                "content": "H" * (dream._HISTORY_ENTRY_PREVIEW_MAX_CHARS * 8),
            }) + "\n",
            encoding="utf-8",
        )
        mock_provider.chat_with_retry.return_value = MagicMock(content="[SKIP]")
        mock_runner.run = AsyncMock(return_value=_make_run_result())

        await dream.run()

        user_msg = mock_provider.chat_with_retry.call_args.kwargs["messages"][1]["content"]
        history_section = user_msg.split("## Conversation History\n")[1].split("\n\n## Current Date")[0]
        assert len(history_section) < dream._HISTORY_ENTRY_PREVIEW_MAX_CHARS + 500
