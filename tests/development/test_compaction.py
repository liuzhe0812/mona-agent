from __future__ import annotations

import asyncio
import copy

import pytest

from mona.development.compaction import KEY, compact_if_needed, summary_text
from mona.development.context import build_coding_messages, load_project_context
from mona.development.contracts import DevelopmentSession, Project
from mona.development.store import DevelopmentError
from mona.providers.base import LLMProvider, LLMResponse
from mona.session.manager import SessionManager


class SummaryModel(LLMProvider):
    def __init__(self, content="Keep manual notes. Tests failed; parser fix remains pending.", reason="stop", callback=None):
        super().__init__()
        self.content, self.reason, self.callback = content, reason, callback
        self.requests = []

    async def chat(self, messages, tools=None, **kwargs):
        self.requests.append(copy.deepcopy(messages))
        assert tools is None
        if self.callback:
            self.callback()
        return LLMResponse(self.content, finish_reason=self.reason)

    def get_default_model(self):
        return "summary-test"


def setup(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    project = Project(root_path=str(root), display_name="test")
    session = DevelopmentSession(project_id=project.id)
    sessions = SessionManager(tmp_path / "history")
    transcript = sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "Original task: preserve manual notes. " + "history evidence detail " * 3000)
    transcript.add_message("assistant", "", tool_calls=[{"id": "read-old", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"parser.py"}'}}])
    transcript.add_message("tool", "Old source and actual test failure", tool_call_id="read-old", name="read_file")
    transcript.add_message("assistant", "Fix pending.")
    transcript.add_message("user", "CURRENT_REQUEST must stay verbatim")
    sessions.save(transcript)
    return project, session, sessions, transcript


async def compact(project, session, sessions, transcript, model, trigger=4096):
    return await compact_if_needed(load_project_context(project), session, transcript, sessions, model,
        model="summary-test", context_window_tokens=65536, max_output_tokens=4096,
        tools=[], trigger_tokens=trigger)


@pytest.mark.asyncio
async def test_summary_is_session_local_atomic_and_preserves_full_history(tmp_path):
    project, session, sessions, transcript = setup(tmp_path)
    original = copy.deepcopy(transcript.messages)
    model = SummaryModel()
    result = await compact(project, session, sessions, transcript, model)
    assert result and result["through"] == 4 and result["estimatedAfter"] < result["estimatedBefore"]
    assert transcript.messages == original
    assert len(model.requests) == 1
    reloaded = SessionManager(tmp_path / "history").get_or_create(session.transcript_key)
    assert reloaded.last_consolidated == 4 and summary_text(reloaded) == model.content
    messages = build_coding_messages(load_project_context(project), session, reloaded, summary=summary_text(reloaded))
    assert messages[-1]["content"] == "CURRENT_REQUEST must stay verbatim"
    assert "history evidence detail" not in str(messages)
    assert "Tests failed" in str(messages)
    assert not (tmp_path / "project" / "memory").exists()


@pytest.mark.parametrize("text,reason", [("", "stop"), ("incomplete", "length"), ("error", "error")])
@pytest.mark.asyncio
async def test_bad_summary_never_advances_cursor_or_deletes_history(tmp_path, text, reason):
    project, session, sessions, transcript = setup(tmp_path)
    before = copy.deepcopy(transcript.messages)
    with pytest.raises(DevelopmentError, match="摘要"):
        await compact(project, session, sessions, transcript, SummaryModel(text, reason))
    assert transcript.messages == before and transcript.last_consolidated == 0
    assert KEY not in transcript.metadata


@pytest.mark.asyncio
async def test_appended_queued_input_survives_compaction(tmp_path):
    project, session, sessions, transcript = setup(tmp_path)
    def queued():
        transcript.add_message("user", "QUEUED_NEXT_TASK", _ui_only=True)
    await compact(project, session, sessions, transcript, SummaryModel(callback=queued))
    assert transcript.messages[-1]["content"] == "QUEUED_NEXT_TASK"
    request = build_coding_messages(load_project_context(project), session, transcript, summary=summary_text(transcript))
    assert "QUEUED_NEXT_TASK" not in str(request)
    assert request[-1]["content"] == "CURRENT_REQUEST must stay verbatim"


@pytest.mark.asyncio
async def test_source_changed_or_save_failed_does_not_commit_summary(tmp_path, monkeypatch):
    project, session, sessions, transcript = setup(tmp_path)
    def changed():
        transcript.messages[0]["content"] += " amended"
    with pytest.raises(DevelopmentError, match="历史发生变化"):
        await compact(project, session, sessions, transcript, SummaryModel(callback=changed))
    assert transcript.last_consolidated == 0 and KEY not in transcript.metadata
    def fail(*_args, **_kwargs):
        raise OSError("disk unavailable")
    monkeypatch.setattr(sessions, "save", fail)
    with pytest.raises(OSError):
        await compact(project, session, sessions, transcript, SummaryModel())
    assert transcript.last_consolidated == 0 and KEY not in transcript.metadata


@pytest.mark.asyncio
async def test_small_history_does_not_add_model_call(tmp_path):
    project, session, sessions, transcript = setup(tmp_path)
    transcript.messages = transcript.messages[-1:]
    model = SummaryModel()
    assert await compact(project, session, sessions, transcript, model) is None
    assert model.requests == []


@pytest.mark.asyncio
async def test_cancelled_summary_keeps_cursor(tmp_path):
    project, session, sessions, transcript = setup(tmp_path)
    def cancel():
        raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await compact(project, session, sessions, transcript, SummaryModel(callback=cancel))
    assert transcript.last_consolidated == 0 and KEY not in transcript.metadata
