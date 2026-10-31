"""Tests for cache-friendly prompt construction."""

from __future__ import annotations

import datetime as datetime_module
from datetime import datetime as real_datetime
from importlib.resources import files as pkg_files
from pathlib import Path

from mona.agent.context import ContextBuilder


class _FakeDatetime(real_datetime):
    current = real_datetime(2026, 2, 24, 13, 59)

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return cls.current


def _make_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True)
    return workspace


def _copy_memory_template(builder: ContextBuilder, name: str) -> None:
    source = pkg_files("mona") / "templates" / name
    target = builder.memory.memory_dir / Path(name).name
    target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def test_bootstrap_files_are_backed_by_templates() -> None:
    template_dir = pkg_files("mona") / "templates"

    for filename in ContextBuilder.BOOTSTRAP_FILES:
        assert (template_dir / filename).is_file(), f"missing bootstrap template: {filename}"


def test_system_prompt_stays_stable_when_clock_changes(tmp_path, monkeypatch) -> None:
    """System prompt should not change just because wall clock minute changes."""
    monkeypatch.setattr(datetime_module, "datetime", _FakeDatetime)

    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    _FakeDatetime.current = real_datetime(2026, 2, 24, 13, 59)
    prompt1 = builder.build_system_prompt()

    _FakeDatetime.current = real_datetime(2026, 2, 24, 14, 0)
    prompt2 = builder.build_system_prompt()

    assert prompt1 == prompt2


def test_system_prompt_reflects_current_dream_memory_contract(tmp_path) -> None:
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)
    _copy_memory_template(builder, "AGENTS.md")

    prompt = builder.build_system_prompt()

    assert 'sources=["events"]' in prompt
    assert "automatically managed by Dream" in prompt
    assert "do not edit them in normal chats" in prompt
    assert "outside workspace file-tool boundaries" in prompt
    assert "memory/HISTORY.md" not in prompt
    assert "write important facts here" not in prompt


def test_runtime_context_is_separate_untrusted_user_message(tmp_path) -> None:
    """Runtime metadata should be merged with the user message."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[],
        current_message="Return exactly: OK",
        channel="cli",
        chat_id="direct",
    )

    assert messages[0]["role"] == "system"
    assert "## Current Session" not in messages[0]["content"]

    # Runtime context is now merged with user message into a single message
    assert messages[-1]["role"] == "user"
    user_content = messages[-1]["content"]
    assert isinstance(user_content, str)
    assert ContextBuilder._RUNTIME_CONTEXT_TAG in user_content
    assert "Current Time:" in user_content
    assert "Channel: cli" in user_content
    assert "Chat ID: direct" in user_content
    assert "Return exactly: OK" in user_content


def test_runtime_context_appended_after_user_content(tmp_path) -> None:
    """User content must precede runtime context for prompt-cache prefix stability."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[],
        current_message="hello world",
        channel="cli",
        chat_id="direct",
    )

    content = messages[-1]["content"]
    user_pos = content.find("hello world")
    tag_pos = content.find(ContextBuilder._RUNTIME_CONTEXT_TAG)
    assert user_pos < tag_pos, "user content must precede runtime context for prefix stability"


def test_runtime_context_includes_sender_id_when_provided(tmp_path) -> None:
    """Sender ID should be included in runtime context when provided."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[],
        current_message="Return exactly: OK",
        channel="cli",
        chat_id="direct",
        sender_id="user-12345",
    )

    user_content = messages[-1]["content"]
    assert isinstance(user_content, str)
    assert "Sender ID: user-12345" in user_content


def test_runtime_context_includes_active_browser_tab_id(tmp_path) -> None:
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[],
        current_message="Inspect this page",
        channel="websocket",
        chat_id="direct",
        message_metadata={
            "browser_tab_id": "tab-123",
            "browser_page_title": "Docs",
            "browser_page_url": "https://example.com/docs",
        },
    )

    assert (
        "Mona Built-in Browser Page: Docs (https://example.com/docs) [Tab ID: tab-123]"
        in messages[-1]["content"]
    )


def test_runtime_context_excludes_sender_id_when_not_provided(tmp_path) -> None:
    """Sender ID should not be present in runtime context when not provided."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[],
        current_message="Return exactly: OK",
        channel="cli",
        chat_id="direct",
        sender_id=None,
    )

    user_content = messages[-1]["content"]
    assert isinstance(user_content, str)
    assert "Sender ID:" not in user_content


def test_unprocessed_history_is_not_automatic_model_context(tmp_path) -> None:
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    builder.memory.append_history("User asked about weather in Tokyo")
    builder.memory.append_history("Agent fetched forecast via web_search")

    messages = builder.build_messages([], "Create a product presentation", chat_id="new-presentation")
    assert all("# Recent History" not in message["content"] for message in messages)
    assert all("User asked about weather in Tokyo" not in message["content"] for message in messages)
    assert all("Agent fetched forecast via web_search" not in message["content"] for message in messages)
    assert len(builder.memory.read_unprocessed_history(since_cursor=0)) == 2
    assert builder.memory.get_last_dream_cursor() == 0


def test_dream_cursor_does_not_select_chat_background(tmp_path) -> None:
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    builder.memory.append_history("old conversation about Python")
    c2 = builder.memory.append_history("old conversation about Rust")
    builder.memory.append_history("recent question about Docker")
    builder.memory.append_history("recent question about K8s")

    builder.memory.set_last_dream_cursor(c2)

    prompt = builder.build_messages([], "Continue")[-1]["content"]
    assert "# Recent History" not in prompt
    assert "old conversation about Python" not in prompt
    assert "old conversation about Rust" not in prompt
    assert "recent question about Docker" not in prompt
    assert "recent question about K8s" not in prompt


def test_execution_contract_is_injected_with_custom_soul(tmp_path) -> None:
    """Work completion requirements do not depend on the user's persona copy."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)
    builder.memory.soul_file.write_text("Speak plainly in Chinese.", encoding="utf-8")

    prompt = builder.build_system_prompt()
    assert "Speak plainly in Chinese." in prompt
    assert "carry the authorized work through to a verifiable result" in prompt
    assert "After meaningful changes, run the smallest reliable verification" in prompt
    assert "material uncertainty or unfinished work" in prompt


def test_identity_has_no_behavioral_instructions(tmp_path) -> None:
    """Identity template should not contain behavioral rules or hardcoded name."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    identity = builder._get_identity(channel=None)
    assert "You are mona" not in identity
    assert "Act, don't narrate" not in identity
    assert "Execution Rules" not in identity


def test_system_prompt_does_not_warn_about_message_time_markers(tmp_path) -> None:
    """Parroting is prevented by not annotating assistant turns in history;
    no prompt-level warning about ``[Message Time: ...]`` is needed."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    prompt = builder.build_system_prompt()

    assert "Message Time" not in prompt


def test_channel_format_hint_telegram(tmp_path) -> None:
    """Telegram channel should get messaging-app format hint."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    prompt = builder.build_system_prompt(channel="telegram")
    assert "Format Hint" in prompt
    assert "messaging app" in prompt


def test_channel_format_hint_whatsapp(tmp_path) -> None:
    """WhatsApp should get plain-text format hint."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    prompt = builder.build_system_prompt(channel="whatsapp")
    assert "Format Hint" in prompt
    assert "plain text only" in prompt


def test_channel_format_hint_absent_for_unknown(tmp_path) -> None:
    """Unknown or None channel should not inject a format hint."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    prompt = builder.build_system_prompt(channel=None)
    assert "Format Hint" not in prompt

    prompt2 = builder.build_system_prompt(channel="feishu")
    assert "Format Hint" not in prompt2


def test_build_messages_passes_channel_to_system_prompt(tmp_path) -> None:
    """build_messages should pass channel through to build_system_prompt."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[], current_message="hi",
        channel="telegram", chat_id="123",
    )
    system = messages[0]["content"]
    assert "Format Hint" in system
    assert "messaging app" in system


def test_system_prompt_keeps_message_tool_out_of_current_chat_replies(tmp_path) -> None:
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    prompt = builder.build_system_prompt(channel="slack")

    assert "Reply directly in the current conversation" in prompt
    assert "not the normal current-chat reply" in prompt
    assert "Generated images are delivered through `message`" in prompt
    assert "returned artifact paths in `media`" in prompt
    assert "Wait for the tool results, then answer once" not in prompt


def test_subagent_result_does_not_create_consecutive_assistant_messages(tmp_path) -> None:
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    messages = builder.build_messages(
        history=[{"role": "assistant", "content": "previous result"}],
        current_message="subagent result",
        channel="cli",
        chat_id="direct",
        current_role="assistant",
    )

    for left, right in zip(messages, messages[1:]):
        assert not (left.get("role") == right.get("role") == "assistant")


def test_always_skills_excluded_from_skills_index(tmp_path) -> None:
    """Always skills should appear in Active Skills but NOT in the skills index."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)

    prompt = builder.build_system_prompt()

    # memory skill should be in Active Skills section
    assert "# Active Skills" in prompt
    assert "### Skill: memory" in prompt

    # memory skill should NOT appear in the skills index
    skills_section = prompt.split("# Skills\n", 1)
    if len(skills_section) > 1:
        index_text = skills_section[1].split("\n\n---")[0]
        assert "**memory**" not in index_text


def test_template_memory_md_is_skipped(tmp_path) -> None:
    """MEMORY.md matching the bundled template should not inject the Memory section."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)
    _copy_memory_template(builder, "memory/MEMORY.md")
    prompt = builder.build_system_prompt()

    # The "# Memory\n\n## Long-term Memory" block is produced only by
    # build_system_prompt() when MEMORY.md is injected.  The memory skill
    # also contains "# Memory" but is followed by "## Structure", not
    # "## Long-term Memory".
    assert "# Memory\n\n## Long-term Memory" not in prompt
    assert "This file is automatically updated by mona" not in prompt


def test_customized_memory_md_is_injected(tmp_path) -> None:
    """A Dream-populated MEMORY.md should be injected normally."""
    workspace = _make_workspace(tmp_path)
    builder = ContextBuilder(workspace)
    builder.memory.memory_file.write_text(
        "# Long-term Memory\n\nUser prefers dark mode.\n", encoding="utf-8"
    )
    prompt = builder.build_system_prompt()

    assert "# Memory\n\n## Long-term Memory" in prompt
    assert "User prefers dark mode" in prompt
