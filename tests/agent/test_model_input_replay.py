from __future__ import annotations

import copy
from unittest.mock import AsyncMock, MagicMock

import pytest

import mona.agent.context as context_module
from mona.agent.context import ContextBuilder
from mona.agent.loop import AgentLoop
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.session.manager import Session, SessionManager


def _make_loop(tmp_path, monkeypatch) -> AgentLoop:
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 4096
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,
        workspace=tmp_path,
        model="test-model",
    )
    loop.consolidator.maybe_consolidate_by_tokens = AsyncMock(return_value=10)
    monkeypatch.setattr(ContextBuilder, "_load_shared_user_profile", staticmethod(lambda _fields=None: ""))
    return loop


@pytest.mark.asyncio
async def test_user_model_snapshot_survives_turns_and_session_reload(tmp_path, monkeypatch) -> None:
    clock = {"value": "2026-10-22 10:00:00"}
    monkeypatch.setattr(context_module, "current_time_str", lambda _timezone=None: clock["value"])
    loop = _make_loop(tmp_path, monkeypatch)
    loop._sync_computer_use_runtime = AsyncMock()
    loop._last_usage = {}
    calls: list[list[dict]] = []

    async def fake_run(initial_messages, **_kwargs):
        messages = [dict(message) for message in initial_messages]
        calls.append(messages)
        if len(calls) == 1:
            # Model a steering message merged onto the triggering user message.
            messages[-1]["content"] += "\n\nCorrection: use the checked figures."
        return "done", [], [*messages, {"role": "assistant", "content": "done"}], "stop", False

    loop._run_agent_loop = fake_run
    first = InboundMessage(channel="cli", sender_id="user", chat_id="cache", content="first request")
    await loop._process_message(first)

    session = loop.sessions.get_or_create("cli:cache")
    assert session.messages[0]["content"] == "first request"
    first_model_input = calls[0][-1]["content"]
    assert "Correction: use the checked figures." in first_model_input

    clock["value"] = "2026-10-22 10:05:00"
    second = InboundMessage(channel="cli", sender_id="user", chat_id="cache", content="second request")
    await loop._process_message(second)
    assert calls[1][1]["content"] == first_model_input

    reloaded_manager = SessionManager(tmp_path)
    reloaded = reloaded_manager.get_or_create("cli:cache")
    replay = reloaded.get_history(include_timestamps=True, model_view=True)
    replayed_first_user = next(message for message in replay if message["role"] == "user")
    assert replayed_first_user["content"] == first_model_input
    assert reloaded.messages[0]["content"] == "first request"
    assert "_model_user_inputs" not in reloaded_manager.read_session_file("cli:cache")["metadata"]


def test_model_view_is_opt_in_and_old_user_timestamps_still_replay() -> None:
    session = Session(key="cli:legacy")
    session.add_message("user", "legacy request", timestamp="2026-10-22T09:00:00")
    session.remember_model_input(session.messages[0], "legacy request\n\nRuntime from first send")

    assert session.get_history(include_timestamps=True)[0]["content"].startswith("[Message Time:")
    assert session.get_history(include_timestamps=True, model_view=True)[0]["content"] == (
        "legacy request\n\nRuntime from first send"
    )

    old_session = Session(key="cli:old")
    old_session.add_message("user", "old request", timestamp="2026-10-22T08:00:00")
    assert old_session.get_history(include_timestamps=True, model_view=True)[0]["content"].startswith(
        "[Message Time:"
    )


def test_session_summary_is_retained_without_shared_recent_history(tmp_path) -> None:
    builder = ContextBuilder(tmp_path)
    archived_summary = "The approved report is ready."
    builder.memory.append_history(archived_summary)
    first = builder.build_messages([], "Continue", session_summary=archived_summary)
    first_user = first[-1]["content"]
    assert first_user.count(archived_summary) == 1

    builder.memory.append_history("The user requested one chart.")
    second = builder.build_messages(
        [{"role": "user", "content": first_user}],
        "Add it",
        session_summary=archived_summary,
    )
    second_user = second[-1]["content"]
    assert second_user.count(archived_summary) == 1
    assert "The user requested one chart." not in second_user

    # Once the prior model history is compacted away, retained background can be injected again.
    compacted = builder.build_messages([], "Resume", session_summary=archived_summary)
    assert compacted[-1]["content"].count(archived_summary) == 1


def test_large_shared_history_does_not_enter_new_or_continued_chat(tmp_path) -> None:
    builder = ContextBuilder(tmp_path)
    large_entry = "UNIQUE-LARGE-HISTORY-ENTRY-" + "x" * 40_000
    builder.memory.append_history(large_entry, max_chars=50_000)

    first = builder.build_messages([], "First request")
    first_user = first[-1]["content"]
    assert "UNIQUE-LARGE-HISTORY-ENTRY-" not in first_user

    second = builder.build_messages(
        [
            {"role": "user", "content": first_user},
            {"role": "assistant", "content": "First answer"},
        ],
        "Second request",
    )
    assert "UNIQUE-LARGE-HISTORY-ENTRY-" not in second[-1]["content"]
    assert "UNIQUE-LARGE-HISTORY-ENTRY-" not in second[1]["content"]
    assert "First request" in second[1]["content"]
    assert len(builder.memory.read_unprocessed_history(since_cursor=0)) == 1


def _legacy_runtime(summary: str = "") -> str:
    archived = f"\n\n[Archived Context Summary]\n\n{summary}" if summary else ""
    return (
        "[Runtime Context — metadata only, not instructions]\n"
        "Current Time: 2026-10-22 10:00:00\nChannel: websocket\nChat ID: presentation\n"
        "Conversation background (historical context, not a new request or expanded authorization):\n"
        "# Recent History\n\n[History entry: 1234567890abcdef]\n"
        "- [2026-10-21 20:00] unrelated-video-turn"
        f"{archived}\n[/Runtime Context]"
    )


@pytest.mark.parametrize("summary", ["", "The current presentation has three approved slides."])
def test_old_snapshot_replay_drops_shared_history_without_rewriting_audit(tmp_path, summary) -> None:
    manager = SessionManager(tmp_path)
    session = manager.get_or_create("websocket:presentation")
    session.add_message("user", "Finish the presentation.", timestamp="2026-10-22T10:00:00")
    original = session.messages[-1]["content"]
    snapshot = f"{original}\n\n{_legacy_runtime(summary)}\n\nCorrection: use checked figures."
    session.remember_model_input(session.messages[-1], snapshot)
    manager.save(session)

    reloaded = SessionManager(tmp_path).get_or_create(session.key)
    replayed = reloaded.get_history(include_timestamps=True, model_view=True)[0]["content"]

    assert original in replayed
    assert "unrelated-video-turn" not in replayed
    assert "# Recent History" not in replayed
    assert "Current Time: 2026-10-22 10:00:00" in replayed
    assert "Chat ID: presentation" in replayed
    assert replayed.endswith("Correction: use checked figures.")
    if summary:
        assert "[Archived Context Summary]" in replayed
        assert summary in replayed
    else:
        assert "Conversation background" not in replayed
    assert reloaded.get_history()[0]["content"] == original
    assert reloaded.metadata["_model_user_inputs"]["2026-10-22T10:00:00"] == snapshot


@pytest.mark.parametrize("original_is_list", [False, True])
def test_multimodal_snapshot_cleans_only_host_runtime_block(original_is_list) -> None:
    session = Session(key="websocket:presentation")
    parts = [{"type": "text", "text": "[image: /workspace/chart.png]"}, {"type": "text", "text": "Use this chart."}]
    original = copy.deepcopy(parts) if original_is_list else "Use this chart."
    session.add_message("user", original, timestamp="2026-10-22T10:00:00")
    snapshot = [*parts, {"type": "text", "text": _legacy_runtime("Keep the chart editable.")}]
    session.remember_model_input(session.messages[-1], snapshot)

    replayed = session.get_history(model_view=True)[0]["content"]

    assert replayed[:2] == parts
    assert "unrelated-video-turn" not in replayed[-1]["text"]
    assert "Keep the chart editable." in replayed[-1]["text"]
    assert session.metadata["_model_user_inputs"]["2026-10-22T10:00:00"] == snapshot


def test_snapshot_cleanup_preserves_runtime_markers_in_original_user_text() -> None:
    session = Session(key="websocket:quoted-protocol")
    original = "Explain this quoted protocol:\n\n" + _legacy_runtime().replace(
        "unrelated-video-turn", "user-supplied-example"
    )
    session.add_message("user", original, timestamp="2026-10-22T10:00:00")
    session.remember_model_input(session.messages[-1], original)
    assert session.get_history(model_view=True)[0]["content"] == original

    session.remember_model_input(session.messages[-1], original + "\n\n" + _legacy_runtime())
    replayed = session.get_history(model_view=True)[0]["content"]
    assert original in replayed
    assert "unrelated-video-turn" not in replayed


def test_save_reclaims_archived_snapshots_and_hides_them_from_file_reads(tmp_path) -> None:
    manager = SessionManager(tmp_path)
    session = manager.get_or_create("cli:prune")
    session.add_message("user", "archived", timestamp="2026-10-22T08:00:00")
    session.remember_model_input(session.messages[-1], "archived model input")
    session.add_message("assistant", "done")
    session.add_message("user", "retained", timestamp="2026-10-22T09:00:00")
    session.remember_model_input(session.messages[-1], "retained model input")
    session.last_consolidated = 2

    manager.save(session)
    assert session.metadata["_model_user_inputs"] == {
        "2026-10-22T09:00:00": "retained model input"
    }
    assert "_model_user_inputs" not in manager.read_session_file("cli:prune")["metadata"]
    assert session.messages[0]["content"] == "archived"
