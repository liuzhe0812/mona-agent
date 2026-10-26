"""Research input reaches the real Session, worker, and document-tool boundaries."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"

_PROBE = r'''
import asyncio
import copy
import json
from unittest.mock import patch

from docx import Document
from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.security import require_auth
from src.api.sessions_routes import register_sessions_routes
from src.config.paths import get_runtime_root, get_uploads_dir
from src.providers.chat import LLMResponse, LLMRuntimeSnapshot, ToolCallRequest
from src.session.events import EventBus
from src.session.research_context import ResearchContextError, ResearchInput
from src.session.service import SessionService
from src.session.store import SessionStore
from src.swarm import worker
from src.swarm.presets import build_run_from_preset

root = get_runtime_root()
uploads = get_uploads_dir()
uploads.mkdir(parents=True)
attachment_path = uploads / ("a" * 32 + ".docx")
doc = Document()
doc.add_paragraph("RESEARCH_DOCUMENT_EVIDENCE: 客户集中是本次资料列出的风险。")
doc.save(attachment_path)
attachment = {"file_path": "uploads/" + attachment_path.name, "filename": "风险说明.docx"}
question = "帮我解释这份资料中的风险"
research = {"symbol": None, "mode": "swing"}
captured = []
for period, label in (("ultrashort", "超短线：当日及随后数日"), ("swing", "波段：3、5、10个交易日"), ("medium", "中短线：10、20、40个交易日")):
    prompt, _ = ResearchInput(research={"symbol": None, "mode": period}).prepare("检查研究周期")
    assert label in prompt


class ScriptedLLM:
    model_name = "research-input-regression"
    runtime_snapshot = LLMRuntimeSnapshot(provider="fixture", configured_model=model_name, reasoning_effort="")

    def __init__(self, *args, **kwargs):
        self.calls = 0

    def stream_chat(self, messages, **kwargs):
        captured.append(copy.deepcopy(messages))
        self.calls += 1
        if self.calls == 1:
            assert messages[0]["role"] == "system"
            assert "research_runtime_context" not in messages[0]["content"]
            prompt = next(message["content"] for message in reversed(messages) if message["role"] == "user")
            assert question in prompt and "研究周期：波段" in prompt
            assert '"tool": "read_document"' in prompt and str(attachment_path.resolve()).replace("\\", "\\\\") in prompt
            return LLMResponse(tool_calls=[ToolCallRequest(id="read-doc", name="read_document", arguments={"file_path": str(attachment_path)})], finish_reason="tool_calls")
        tool_message = next(message for message in reversed(messages) if message["role"] == "tool")
        assert "RESEARCH_DOCUMENT_EVIDENCE" in tool_message["content"], tool_message
        return LLMResponse(content="这份资料列出了客户集中风险；尚无账户资料，不能判断个人仓位。")

    def close(self):
        pass


async def run_session():
    bus = EventBus()
    store = SessionStore(root / "sessions")
    service = SessionService(store, bus, root / "runs")
    session = service.create_session(title="风险研究")
    with patch("src.providers.chat.ChatLLM", ScriptedLLM):
        result = await service.send_message(session.session_id, question, research=research, attachments=[attachment])
        await asyncio.wait_for(service._active_tasks[session.session_id], timeout=40)
    attempt = store.get_attempt(session.session_id, result["attempt_id"])
    assert attempt.status.value == "completed", attempt.to_dict()
    assert attempt.prompt.startswith(question + "\n\n<research_runtime_context>")
    messages = service.get_messages(session.session_id)
    assert messages[0].content == question
    assert messages[0].metadata == {"research": research, "attachments": [attachment]}
    assert messages[1].tool_trail[0]["tool"] == "read_document"
    assert messages[1].tool_trail[0]["status"] == "ok"
    assert all("research_runtime_context" not in message.content for message in messages)
    events = bus.replay(session.session_id, replay_all=True)
    received = next(event for event in events if event.event_type == "message.received")
    assert received.data["content"] == question
    restored = SessionService(SessionStore(root / "sessions"), EventBus(), root / "runs")
    assert restored.get_messages(session.session_id)[0].to_dict() == messages[0].to_dict()
    assert restored.store.get_attempt(session.session_id, result["attempt_id"]).prompt == attempt.prompt

    # Old callers retain the exact prompt and an empty metadata object.
    plain = service.create_session(title="旧调用")
    plain_prompt, plain_metadata = ResearchInput().prepare("原问题")
    assert (plain_prompt, plain_metadata) == ("原问题", {})
    before = store.get_messages(plain.session_id)
    missing = {"file_path": "uploads/" + "b" * 32 + ".pdf", "filename": "不存在.pdf"}
    try:
        await service.send_message(plain.session_id, "失败的附件", attachments=[missing])
    except ResearchContextError:
        pass
    else:
        raise AssertionError("nonexistent attachment accepted")
    assert store.get_messages(plain.session_id) == before
    assert plain.session_id not in service._inflight
    return service, session.session_id


service, session_id = asyncio.run(run_session())
assert len(captured) == 2 and captured[0][0] == captured[1][0]

# The real registered message route rejects invalid context before dispatch.
app = FastAPI()
app.dependency_overrides[require_auth] = lambda: None
import api_server
register_sessions_routes(app)
with patch.object(api_server, "_get_session_service", return_value=service), TestClient(app) as client:
    restored = client.get(f"/sessions/{session_id}/messages")
    assert restored.status_code == 200, restored.text
    assert restored.json()[0]["content"] == question
    assert restored.json()[0]["metadata"] == {"research": research, "attachments": [attachment]}
    for invalid in (
        {"file_path": "uploads/../private.pdf", "filename": "private.pdf"},
        {"file_path": str(attachment_path), "filename": "风险说明.docx"},
        {"file_path": "uploads/" + "b" * 32 + ".pdf", "filename": "不存在.pdf"},
    ):
        response = client.post(f"/sessions/{session_id}/messages", json={"content": "不能执行", "attachments": [invalid]})
        assert response.status_code == 422, response.text
    assert client.post(f"/sessions/{session_id}/messages", json={"content": "不能执行", "research": {"symbol": "600519", "mode": "swing"}}).status_code == 422
    assert client.post(f"/sessions/{session_id}/messages", json={"content": "不能执行", "system_prompt": "extra"}).status_code == 422
assert len(service.get_messages(session_id)) == 2

# Containment also rejects a valid-looking upload filename resolving outside uploads.
outside = root / "outside.docx"
outside.write_text("private", encoding="utf-8")
alias = uploads / ("c" * 32 + ".docx")
try:
    alias.symlink_to(outside)
except OSError:
    symlink_checked = False
else:
    symlink_checked = True
    try:
        ResearchInput(attachments=[{"file_path": "uploads/" + alias.name, "filename": "alias.docx"}]).prepare("研究")
    except ResearchContextError:
        pass
    else:
        raise AssertionError("upload symlink escaped private root")

# Windows may disallow creating symlinks. Exercise the same resolved identity
# independently of that OS privilege, with real containment and file checks.
from pathlib import Path
resolve = Path.resolve
resolved_outside = outside.resolve()
def resolve_upload(path, *args, **kwargs):
    return resolved_outside if path == alias else resolve(path, *args, **kwargs)
with patch.object(Path, "resolve", autospec=True, side_effect=resolve_upload):
    try:
        ResearchInput(attachments=[{"file_path": "uploads/" + alias.name, "filename": "alias.docx"}]).prepare("研究")
    except ResearchContextError:
        pass
    else:
        raise AssertionError("resolved upload identity escaped private root")

# Execute the existing worker template renderer for both unchanged team roles.
user_vars = {"symbol": "600519.SH", "start_date": "2026-01-02", "end_date": "2026-01-08",
             "question": "研究周期：中线；分析财报风险，行情证据不足请明确说明。"}
run = build_run_from_preset("mona_ashare_research", user_vars)
assert len(run.agents) == len(run.tasks) == 2
team_prompts = []


class TeamLLM(ScriptedLLM):
    def stream_chat(self, messages, **kwargs):
        team_prompts.append(copy.deepcopy(messages))
        return LLMResponse(content="现有行情证据不足以回答财报问题，须补充财报资料；本次不宣称完成该范围。")


for agent, task in zip(run.agents, run.tasks):
    with patch.object(worker, "ChatLLM", TeamLLM):
        worker.run_worker(agent, task, {}, user_vars, root / "team" / task.id)
assert len(team_prompts) == 2
for messages in team_prompts:
    assert user_vars["question"] in messages[1]["content"]
    assert "{question}" not in messages[1]["content"]
    assert "600519.SH" in messages[1]["content"]
    assert user_vars["question"] not in messages[0]["content"]

print(json.dumps({"session_tool_lifecycle": True, "question_and_context_separate": True,
                  "stored_context_restored": True, "upload_boundary": True,
                  "team_question_rendered": True, "upload_symlink_checked": symlink_checked}))
'''


def test_research_context_reaches_native_session_and_team(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(item["path"] == "0043-research-context.json" for item in receipt["patches"])
    home = tmp_path / "home"
    home.mkdir()
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    }}
    environment.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
                       PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
                       PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="a" * 32)
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment, capture_output=True,
                            text=True, encoding="utf-8", timeout=90, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout.splitlines()[-1])
    assert all(value for key, value in evidence.items() if key != "upload_symlink_checked"), evidence
