"""Reference paper trades exercise original engine accounting and durable native HTTP receipts."""
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
import hashlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backtest.engines.china_a import ChinaAEngine
from src.api import mona_paper_account as paper
from src.api import mona_workbench_market as market
from src.api.request_ledger import RequestLedger, register_native_request_ledger
from src.api.security import require_auth
from src.config.paths import get_sessions_dir
from src.session.models import Attempt, AttemptStatus, Message, Session
from src.session.store import SessionStore

scenario = sys.argv[1]
price = 10.0
quote_status = 'ok'
quote_source = 'tencent'
quote_adjustment = 'none'
quote_symbol = None
quote_state = 'closed'


def snapshot(symbol, interval):
    assert interval == 'intraday'
    return {'status': quote_status, 'symbol': quote_symbol or symbol, 'interval': interval,
        'source': quote_source, 'adjustment': quote_adjustment, 'observed_at': '2026-06-09T15:01:00+08:00',
        'market_state': quote_state, 'quote': {'price': price, 'name': '合成行情样本', 'as_of': '2026-06-09T15:00:00+08:00'}}


market.market_snapshot = snapshot
ChinaAEngine.run_backtest = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('not a backtest'))
app = FastAPI()
paper.register_mona_paper_account(app)
register_native_request_ledger(app, require_auth)
client = TestClient(app)


def post(path, body, request_id):
    return client.post('/mona/paper/'+path, json=body, headers={'X-Mona-Request-ID': request_id})


def account():
    response = client.get('/mona/paper/account')
    assert response.status_code == 200, response.text
    return response.json()


def preview(side='buy', quantity=100, symbol='002460.SZ'):
    response = client.get('/mona/paper/preview', params={'symbol': symbol, 'side': side, 'quantity': quantity})
    assert response.status_code == 200, response.text
    return response.json()


def fill(request_id, side='buy', quantity=100, **extra):
    quote = preview(side, quantity)
    assert quote['status'] == 'ready', quote
    response = post('trades', {'preview_id': quote['preview_id'], **extra}, request_id)
    assert response.status_code == 200, response.text
    return response.json()['trade']


def initialize(cash=100000):
    response = post('account', {'initial_cash': cash}, 'init')
    assert response.status_code == 200, response.text
    assert response.json() == account()
    return response.json()


if scenario == 'initialize':
    empty = account()
    native = ChinaAEngine({})
    assert empty['status'] == 'uninitialized' and empty['account'] is None
    assert empty['defaults']['initial_cash'] == native.initial_capital
    assert empty['defaults']['fee_model']['commission_rate'] == native.commission_rate
    assert empty['defaults']['fee_model']['slippage'] == 0
    assert preview()['code'] == 'account_uninitialized'
    for index, value in enumerate((0, -1, True, '1000', 10**15)):
        assert post('account', {'initial_cash': value}, 'bad'+str(index)).status_code == 422
    first = initialize()
    assert post('account', {'initial_cash': 100000}, 'init').json() == first
    assert post('account', {'initial_cash': 200000}, 'init').status_code == 409
    assert post('account', {'initial_cash': 200000}, 'another-init').status_code == 409
    assert account()['account']['cash'] == 100000
    assert client.post('/mona/paper/account', json={'initial_cash': 5}).status_code == 400

elif scenario == 'accounting':
    initialize()
    first = fill('open', note='研究后先做模拟记录')
    assert first['fee'] == 5.01 and first['cash_after'] == 98994.99
    price = 12
    second = fill('increase', quantity=200)
    assert second['fee'] == 5.024
    pos = account()['positions'][0]
    average_price = (100*10 + 200*12)/300
    assert abs(pos['average_cost'] - (3400+5.01+5.024)/300) < 1e-12
    price = 13
    reduced = fill('reduce', 'sell', 100)
    native = ChinaAEngine({'slippage': 0})
    sell_fee = native.calc_commission(100, 13, 1, is_open=False)
    allocated_buy_fee = (5.01+5.024)/3
    assert abs(reduced['realized_gross_pnl'] - (13-average_price)*100) < 1e-10
    assert abs(reduced['realized_pnl'] - ((13-average_price)*100-allocated_buy_fee-sell_fee)) < 1e-10
    assert reduced['quantity_after'] == 200
    state = account()
    assert abs(state['account']['total_pnl'] - state['account']['realized_pnl'] - state['account']['unrealized_pnl']) < 1e-9
    price = 9
    closed = fill('close', 'sell', 200)
    state = account()
    assert state['positions'] == [] and closed['quantity_after'] == 0
    assert abs(state['account']['cash'] - 100000 - state['account']['realized_pnl']) < 1e-9
    assert abs(state['account']['total_pnl'] - (reduced['realized_pnl']+closed['realized_pnl'])) < 1e-9
    history = client.get('/mona/paper/trades?limit=2&offset=1').json()
    assert history['total'] == 4 and [row['request_id'] for row in history['items']] == ['reduce', 'increase']
    assert first['quote']['as_of'] == '2026-06-09T15:00:00+08:00'
    assert first['note'] == '研究后先做模拟记录'

elif scenario == 'refusals':
    initialize(cash=1000)
    assert preview()['code'] == 'insufficient_cash'
    assert preview(quantity=101)['code'] == 'invalid_quantity'
    assert preview('sell')['code'] == 'insufficient_quantity'
    assert client.get('/mona/paper/preview?symbol=002460.SZ&side=buy&quantity=10.5').status_code == 422
    assert client.get('/mona/paper/preview?symbol=002460.SZ&side=buy&quantity=100&price=1').status_code == 422
    assert client.get('/mona/paper/trades?limit=0').status_code == 422
    price = 0
    assert preview()['code'] == 'quote_unavailable'
    price = float('nan')
    assert preview()['code'] == 'quote_unavailable'
    price = 1
    quote_status = 'unavailable'
    assert preview(symbol='920001.BJ')['code'] == 'quote_unavailable'
    quote_status = 'ok'
    quote_source = 'wrong-source'
    assert preview()['code'] == 'quote_unavailable'
    quote_source = 'tencent'
    quote_adjustment = 'qfq'
    assert preview()['code'] == 'quote_unavailable'
    quote_adjustment = 'none'
    quote_symbol = '600519.SH'
    assert preview()['code'] == 'quote_unavailable'
    quote_symbol = None
    quote_state = 'stale'
    assert preview()['code'] == 'quote_unavailable'
    quote_state = None
    assert preview()['code'] == 'quote_unavailable'
    quote_state = 'closed'
    ready = preview()
    assert post('trades', {'preview_id': ready['preview_id'], 'price': .1}, 'tamper').status_code == 422
    assert post('trades', {'preview_id': ready['preview_id'], 'note': 'x'*501}, 'note').status_code == 422
    assert post('trades', {'preview_id': ready['preview_id'], 'note': False}, 'note-type').status_code == 422
    with paper.PaperAccountStore().connection() as connection:
        row = json.loads(connection.execute('SELECT payload_json FROM paper_previews WHERE preview_id=?', (ready['preview_id'],)).fetchone()[0])
        row['expires_at'] = (paper._now()-timedelta(seconds=1)).isoformat()
        connection.execute('UPDATE paper_previews SET payload_json=? WHERE preview_id=?', (json.dumps(row), ready['preview_id']))
    expired = post('trades', {'preview_id': ready['preview_id']}, 'expired')
    assert expired.status_code == 409 and expired.json()['detail']['error'] == 'preview_expired'
    assert account()['account']['cash'] == 1000

elif scenario == 'idempotency':
    initialize()
    quote = preview()
    payload = {'preview_id': quote['preview_id'], 'note': 'immutable'}
    first = post('trades', payload, 'trade-first')
    assert first.status_code == 200, first.text
    assert post('trades', payload, 'trade-first').json() == first.json()
    assert post('trades', {**payload, 'note': 'changed'}, 'trade-first').status_code == 409
    consumed = post('trades', payload, 'trade-another-id')
    assert consumed.status_code == 409 and consumed.json()['detail']['error'] == 'preview_consumed'
    rejected = client.get('/mona/requests/trade-another-id').json()
    assert rejected['status'] == 'rejected' and rejected['receipt']['body'] == consumed.json()
    ledger = RequestLedger()
    with ledger._connection() as connection:
        connection.execute("UPDATE requests SET status='unknown',response_status=NULL,response_json=NULL WHERE request_id='trade-first'")
    recovered = client.get('/mona/requests/trade-first').json()
    assert recovered['status'] == 'completed' and recovered['receipt']['body'] == first.json()
    assert post('trades', payload, 'trade-first').json() == first.json()
    assert client.get('/mona/paper/trades').json()['total'] == 1
    assert account()['positions'][0]['quantity'] == 100
    # A different, already-started operation with no business receipt remains unknown and is never replayed.
    ledger.claim('never-committed', 'x'*64)
    assert client.get('/mona/requests/never-committed').json()['status'] == 'unknown'

elif scenario == 'concurrency':
    initialize(cash=2010.02)
    quotes = [preview(), preview()]
    def commit(index):
        with TestClient(app) as concurrent_client:
            return concurrent_client.post('/mona/paper/trades', json={'preview_id': quotes[index]['preview_id']},
                headers={'X-Mona-Request-ID': 'concurrent-'+str(index)})
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(commit, range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert account()['positions'][0]['quantity'] == 100
    assert account()['account']['cash'] >= 0
    same = preview('sell')
    def sell(index):
        with TestClient(app) as concurrent_client:
            return concurrent_client.post('/mona/paper/trades', json={'preview_id': same['preview_id']},
                headers={'X-Mona-Request-ID': 'sell-'+str(index)})
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(sell, range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert [response.json()['detail']['error'] for response in responses if response.status_code == 409] == ['preview_consumed']
    assert account()['positions'] == []
    assert client.get('/mona/paper/trades').json()['total'] == 2

elif scenario == 'research':
    initialize()
    store = SessionStore(get_sessions_dir())
    session = Session(title='原始研究', config={'mona_workbench': {'symbol': '002460.SZ', 'task': 'technical', 'mode': 'swing'}})
    store.create_session(session)
    attempt = Attempt(session_id=session.session_id, status=AttemptStatus.COMPLETED, summary='实际报告摘要', completed_at=paper._now().isoformat())
    store.create_attempt(attempt)
    store.append_message(Message(session_id=session.session_id, role='user', metadata={'research': {'symbol': '002460.SZ', 'task': 'technical', 'mode': 'swing'}}))
    store.append_message(Message(session_id=session.session_id, role='assistant', linked_attempt_id=attempt.attempt_id, content=attempt.summary))
    ref = {'session_id': session.session_id, 'attempt_id': attempt.attempt_id}
    first = fill('research-trade', research=ref)
    assert first['research']['summary_sha256'] == hashlib.sha256('实际报告摘要'.encode()).hexdigest()
    assert first['research']['title'] == '原始研究'
    attempt.summary = '更改后的报告'
    store.update_attempt(attempt)
    session.title = '更改标题'
    store.update_session(session)
    saved = client.get('/mona/paper/trades').json()['items'][0]['research']
    assert saved == first['research']
    attempt.status = AttemptStatus.RUNNING
    store.update_attempt(attempt)
    quote = preview()
    assert post('trades', {'preview_id': quote['preview_id'], 'research': ref}, 'unfinished').status_code == 422
    attempt.status = AttemptStatus.COMPLETED
    store.update_attempt(attempt)
    other = Session(title='另一只股票', config={'mona_workbench': {'symbol': '600519.SH', 'task': 'risk', 'mode': 'swing'}})
    store.create_session(other)
    wrong = Attempt(session_id=other.session_id, status=AttemptStatus.COMPLETED, summary='其他公司', completed_at=paper._now().isoformat())
    store.create_attempt(wrong)
    assert post('trades', {'preview_id': quote['preview_id'], 'research': {'session_id': other.session_id, 'attempt_id': wrong.attempt_id}}, 'wrong-symbol').status_code == 422
    assert post('trades', {'preview_id': quote['preview_id'], 'research': {**ref, 'summary': 'forged'}}, 'forged').status_code == 422
    assert account()['positions'][0]['quantity'] == 100

elif scenario == 'persist-write':
    initialize()
    fill('persist-open')
    price = 12
    fill('persist-increase')

elif scenario == 'persist-read':
    quote_status = 'unavailable'
    restored = account()
    assert restored['positions'][0]['quantity'] == 200
    assert restored['positions'][0]['mark_price'] == 12
    assert restored['positions'][0]['mark_status'] == 'last_recorded_quote'
    assert restored['valuation']['cached'] is True and restored['status'] == 'partial'
    assert restored['positions'][0]['mark_as_of'] == '2026-06-09T15:00:00+08:00'
    assert preview()['code'] == 'quote_unavailable'
    assert client.get('/mona/paper/trades').json()['total'] == 2
    with paper.PaperAccountStore().connection() as connection:
        state = paper.PaperAccountStore.state(connection)
        state['last_quotes'] = {}
        paper.PaperAccountStore.save(connection, state)
    incomplete = account()
    assert incomplete['account']['equity'] is None and incomplete['account']['total_pnl'] is None
    assert incomplete['positions'][0]['mark_price'] is None and incomplete['positions'][0]['market_value'] is None
    assert incomplete['valuation']['missing_symbols'] == ['002460.SZ']

else:
    raise AssertionError(scenario)
print(json.dumps({'scenario': scenario, 'passed': True, 'market_fixture': 'synthetic'}))
'''


@pytest.fixture(scope="module")
def native_source(tmp_path_factory):
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path_factory.mktemp("paper-source") / "native"
    prepare(ROOT / "third_party/vibe-trading", source)
    return source / "agent"


def _run(source, home, scenario):
    home.mkdir(exist_ok=True)
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    }}
    environment.update(PYTHONPATH=str(source), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", HOME=str(home), USERPROFILE=str(home),
        APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(PYTHON), "-c", _PROBE, scenario], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=70, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout.splitlines()[-1])["passed"]


@pytest.mark.parametrize("scenario", ["initialize", "accounting", "refusals", "idempotency", "concurrency", "research"])
def test_native_paper_account(native_source, tmp_path, scenario):
    _run(native_source, tmp_path / "home", scenario)


def test_native_paper_account_survives_process_restart_and_marks_unavailable_quotes(native_source, tmp_path):
    home = tmp_path / "home"
    _run(native_source, home, "persist-write")
    _run(native_source, home, "persist-read")
