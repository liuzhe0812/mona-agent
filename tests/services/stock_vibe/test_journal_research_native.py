"""One native journal result remains the source for research and follow-ups."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"

PROBE = r'''
import asyncio
import copy
import json
import shutil
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.mona_operations import _OperationStore
from src.api.security import require_auth
from src.api.sessions_routes import register_sessions_routes
from src.agent.grounding import GroundingLedger
from src.config.paths import get_runtime_root, get_uploads_dir
from src.providers.chat import LLMResponse, LLMRuntimeSnapshot, ToolCallRequest
from src.session.events import EventBus
from src.session.journal_context import journal_record, TradeReviewTool
from src.session.research_context import ResearchContextError
from src.session.service import SessionService
from src.session.store import SessionStore
from src.tools.trade_journal_tool import TradeJournalTool

root = get_runtime_root()
uploads = get_uploads_dir()
uploads.mkdir(parents=True)
fixture = Path(__import__('sys').argv[1])
upload_id, operation_id = 'a' * 32, 'b' * 32
target = uploads / (upload_id + '.csv')
shutil.copyfile(fixture, target)
raw = TradeJournalTool().execute(file_path=str(target), analysis_type='full', filter_expr='')
assert json.loads(raw)['profile']['total_pnl'] == 9
operations = _OperationStore()
operations.create(operation_id, 'analyze_trade_journal', {'upload_id': upload_id}, {'upload_id': upload_id}, {})
operations.update(operation_id, status='completed', raw_result=raw)
review_evidence = json.loads(TradeReviewTool(operation_id).execute())
assert review_evidence['result']['profile']['total_pnl'] == 9
assert json.loads(TradeReviewTool(operation_id).execute(operation_id='c' * 32))['status'] == 'error'
captured = []

def fixed_report(evidence):
    specs = [('result.profile.total_pnl', '配对盈亏', '元', 9),
             ('result.review.settlements[0].recognized_fees', '已识别费用', '元', 11),
             ('result.profile.avg_holding_days', '平均持有', '天', None),
             ('result.total_records', '成交记录', '条', 2),
             ('result.profile.win_rate', '盈利配对占比', '%', 1)]
    text, refs = [], []
    for path, label, unit, expected in specs:
        index, row = next((i, item) for i, item in enumerate(evidence['typed_evidence_rows']) if item['source_path'] == path)
        field = next(key for key in ('amount', 'price', 'ratio', 'days', 'count') if key in row)
        value = row[field]
        assert expected is None or value == expected, row
        shown = str(value * 100 if unit == '%' else value)
        text.append(label + shown + unit + '。')
        refs.append(f"{shown}{'%' if unit == '%' else ''} | observed | {label} | read-review::typed_evidence_rows[{index}].{field}")
    return ''.join(text) + '\n```figures\n' + '\n'.join(refs) + '\n```'

ledger = GroundingLedger(run_dir=root / 'gate', user_message='解释这份成交复盘')
ledger.ingest_tool_result(tool_name='read_trade_review', arguments={}, result=json.dumps(review_evidence), call_id='read-review', success=True)
valid_report = fixed_report(review_evidence)
valid = ledger.validate_final_answer(valid_report)
assert valid.valid, valid.issues
invalid = ledger.validate_final_answer(valid_report.replace('配对盈亏9.0元', '配对盈亏99.0元').replace('9.0 | observed', '99.0 | observed'))
assert not invalid.valid and any(issue['code'] == 'numeric_claim_conflict' for issue in invalid.issues)

class ScriptedLLM:
    model_name = 'journal-research-regression'
    runtime_snapshot = LLMRuntimeSnapshot(provider='fixture', configured_model=model_name, reasoning_effort='')
    def __init__(self, *args, **kwargs):
        self.calls = 0
    def stream_chat(self, messages, **kwargs):
        captured.append(copy.deepcopy(messages))
        self.calls += 1
        if self.calls == 1:
            assert 'trade_review_context' not in messages[0]['content']
            assert operation_id in next(m['content'] for m in reversed(messages) if m['role'] == 'user')
            return LLMResponse(tool_calls=[ToolCallRequest(id='read-review', name='read_trade_review', arguments={})], finish_reason='tool_calls')
        evidence = json.loads(next(m['content'] for m in reversed(messages) if m['role'] == 'tool'))
        assert evidence.get('operation_id') == operation_id, evidence
        assert evidence['result']['profile']['total_pnl'] == 9
        return LLMResponse(content=fixed_report(evidence))
    def close(self):
        pass

store = SessionStore(root / 'sessions')
service = SessionService(store, EventBus(), root / 'runs')
session = service.create_session(title='成交复盘', config={'mona_journal': {'operation_id': operation_id}})

async def run():
    for question in ('解释这份复盘', '哪些结论还缺资料？'):
        with patch('src.providers.chat.ChatLLM', ScriptedLLM):
            accepted = await service.send_message(session.session_id, question)
            await asyncio.wait_for(service._active_tasks[session.session_id], timeout=40)
        attempt = store.get_attempt(session.session_id, accepted['attempt_id'])
        assert attempt.status.value == 'completed', attempt.to_dict()
    users = [m for m in store.get_messages(session.session_id) if m.role == 'user']
    assert [m.content for m in users] == ['解释这份复盘', '哪些结论还缺资料？']
    assert all(m.metadata == {'journal_review': {'operation_id': operation_id}} for m in users)
    replies = [m for m in store.get_messages(session.session_id) if m.role == 'assistant']
    assert all(m.tool_trail[0]['tool'] == 'read_trade_review' and m.tool_trail[0]['status'] == 'ok' for m in replies)
    invalid = service.create_session(config={'mona_journal': {'operation_id': 'c' * 32}})
    try:
        await service.send_message(invalid.session_id, '不能派发')
    except ResearchContextError:
        pass
    else:
        raise AssertionError('unknown review accepted')
    assert store.get_messages(invalid.session_id) == []

asyncio.run(run())
assert all(captured[i][0] == captured[i + 1][0] for i in (0, 2))
restored = SessionService(SessionStore(root / 'sessions'), EventBus(), root / 'runs')
assert restored.get_session(session.session_id).config['mona_journal']['operation_id'] == operation_id
# Filter before limiting, so newer unrelated research cannot hide this record.
for index in range(3):
    service.create_session(title='其他研究')
assert store.list_sessions(1, journal_operation_id=operation_id)[0].session_id == session.session_id

app = FastAPI()
app.dependency_overrides[require_auth] = lambda: None
import api_server
register_sessions_routes(app)
with patch.object(api_server, '_get_session_service', return_value=service), TestClient(app) as client:
    response = client.get('/sessions', params={'limit': 1, 'journal_operation_id': operation_id})
    assert response.status_code == 200, response.text
    assert response.json()[0]['journal_operation_id'] == operation_id
    assert client.get('/sessions', params={'journal_operation_id': '../outside'}).status_code == 422
    bad = client.post('/sessions', json={'config': {'mona_journal': {'operation_id': 'c' * 32}}})
    assert bad.status_code == 422, bad.text
    assert client.get('/sessions/' + session.session_id).json()['journal_operation_id'] == operation_id
print(json.dumps({'native_tool': True, 'same_review_followup': True, 'raw_question_retained': True,
                  'fixed_system': True, 'restored_binding': True, 'invalid_review_not_sent': True}))
'''


def test_native_journal_research_reads_the_exact_saved_operation(tmp_path: Path):
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "home"
    home.mkdir()
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    }}
    env.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
               PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
               PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="a" * 32)
    fixture = ROOT / "tests/fixtures/stock_vibe/shadow/eastmoney-synthetic.csv"
    result = subprocess.run([str(PYTHON), "-c", PROBE, str(fixture)], cwd=home, env=env, capture_output=True,
                            text=True, encoding="utf-8", timeout=100, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
