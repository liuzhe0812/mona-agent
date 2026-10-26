"""Complete industry metadata survives repeated reads without hiding invalid data."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]

_PROBE = r'''
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from curl_cffi import requests as curl_requests
from curl_cffi.requests import Response
from curl_cffi.requests.exceptions import ConnectionError,HTTPError,ProxyError,SSLError,Timeout
from src.api import mona_strategy_scope as scopes

rows=[{'f12':f'BK{number:04d}','f13':90,'f14':f'Industry {number}'} for number in range(1,102)]
calls=[]
throttle=patch('backtest.loaders._http._THROTTLE.wait').start()
def provider(url,*,params):
    calls.append(int(params['pn']))
    page=int(params['pn'])
    return {'data':{'total':len(rows),'diff':rows[(page-1)*100:page*100]}}

def response_for(payload):
    response=Response()
    response.status_code=200
    response.ok=True
    response.content=json.dumps(payload).encode()
    return response

def transport(url,*,params,**kwargs):
    return response_for(provider(url,params=params))

# Exercise the real metadata request builder and JSON/HTTP response parser.
native_session=curl_requests.Session
with patch('curl_cffi.requests.Session',side_effect=native_session) as session, \
        patch.object(native_session,'get',side_effect=transport) as get, \
        patch('requests.utils.get_environ_proxies',return_value={'http':'http://fixture.invalid:8080','https':'http://fixture.invalid:8080','ftp':'ignored'}), \
        patch('backtest.loaders.eastmoney_client._min_interval',return_value=1.25):
    assert len(scopes._complete_rows('m:90+t:2'))==101
    assert session.call_count==1 and get.call_count==2
    assert session.call_args.kwargs=={'trust_env':False,'verify':True,'impersonate':'chrome'}
    assert get.call_args.args==('https://push2.eastmoney.com/api/qt/clist/get',)
    assert get.call_args.kwargs['allow_redirects'] is False and get.call_args.kwargs['timeout']==15
    assert get.call_args.kwargs['proxies']=={'http':'http://fixture.invalid:8080','https':'http://fixture.invalid:8080'}
    assert get.call_args.kwargs['params']['fields']=='f12,f13,f14'
    assert throttle.call_args.args==('eastmoney',1.25)
calls.clear()

clock=[1000.0]
with patch.object(scopes,'_INDUSTRY_CACHE',None), patch.object(scopes.time,'monotonic',lambda:clock[0]), \
        patch('curl_cffi.requests.Session.get',side_effect=transport), \
        patch.object(scopes,'_stamp',side_effect=['2026-10-22T09:00:00+08:00','2026-10-22T09:10:00+08:00']):
    first=scopes.industry_catalog()
    assert len(first['items'])==101 and calls==[1,2]
    first['items'][0]['name']='caller mutation'
    clock[0]+=599
    second=scopes.industry_catalog()
    assert calls==[1,2] and second['items'][0]['name']=='Industry 1'
    assert second['fetched_at']=='2026-10-22T09:00:00+08:00'
    clock[0]+=1
    refreshed=scopes.industry_catalog()
    assert calls==[1,2,1,2] and refreshed['fetched_at']=='2026-10-22T09:10:00+08:00'

calls.clear()
with patch.object(scopes,'_INDUSTRY_CACHE',None), patch('curl_cffi.requests.Session.get',side_effect=transport):
    with ThreadPoolExecutor(max_workers=6) as pool:
        results=list(pool.map(lambda _:scopes.industry_catalog(),range(6)))
    assert calls==[1,2] and all(result==results[0] for result in results)

calls.clear()
attempts=[0]
def transient(url,*,params,**kwargs):
    attempts[0]+=1
    if attempts[0]<=2:
        raise Timeout('temporary connection')
    return transport(url,params=params)
with patch.object(scopes,'_INDUSTRY_CACHE',None), patch('curl_cffi.requests.Session.get',side_effect=transient), \
        patch.object(scopes.time,'sleep') as sleep:
    result=scopes.industry_catalog()
    assert len(result['items'])==101 and attempts[0]==4 and sleep.call_count==2

for error,expected in ((ConnectionError('connection closed'),3),(ProxyError('proxy connection closed'),3),(SSLError('certificate failure'),1),
                       (HTTPError('HTTP error'),1),(ValueError('bad JSON'),1)):
    with patch.object(scopes,'_INDUSTRY_CACHE',None), \
            patch('curl_cffi.requests.Session.get',side_effect=error) as get, \
            patch.object(scopes.time,'sleep') as sleep:
        try: scopes.industry_catalog()
        except scopes.ScopeUnavailableError as exc: assert exc.code=='scope_provider_unavailable'
        else: raise AssertionError('failed request accepted')
        assert get.call_count==expected and sleep.call_count==expected-1
        # A failed fetch must not poison the next read.
        with patch('curl_cffi.requests.Session.get',side_effect=transport):
            assert len(scopes.industry_catalog()['items'])==101

for payload in ({'data':{'total':0,'diff':[]}},
                {'data':{'total':2,'diff':rows[:1]}},
                {'data':{'total':1,'diff':[{'f12':'bad','f13':90,'f14':'bad identity'}]}}):
    with patch.object(scopes,'_INDUSTRY_CACHE',None), \
            patch('curl_cffi.requests.Session.get',return_value=response_for(payload)) as get, \
            patch.object(scopes.time,'sleep') as sleep:
        try: scopes.industry_catalog()
        except scopes.ScopeUnavailableError: pass
        else: raise AssertionError('incomplete or invalid directory accepted')
        assert get.call_count==1 and sleep.call_count==0
        with patch('curl_cffi.requests.Session.get',side_effect=transport):
            assert len(scopes.industry_catalog()['items'])==101

response=response_for({})
response.status_code=503
response.ok=False
response.reason='Service Unavailable'
with patch.object(scopes,'_INDUSTRY_CACHE',None), \
        patch('curl_cffi.requests.Session.get',return_value=response) as get, \
        patch.object(scopes.time,'sleep') as sleep:
    try: scopes.industry_catalog()
    except scopes.ScopeUnavailableError as exc: assert isinstance(exc.__cause__,HTTPError)
    else: raise AssertionError('HTTP failure accepted')
    assert get.call_count==1 and sleep.call_count==0

print(json.dumps({'complete_response_cached_with_original_time':True,'cache_expires_after_ten_minutes':True,
    'concurrent_reads_fetch_once':True,'transient_connection_retries_bounded':True,
    'certificate_http_and_format_failures_not_retried':True,'failed_empty_invalid_not_cached':True}))
'''


def test_native_scope_metadata_cache_and_transient_retries(tmp_path: Path) -> None:
    python = Path(os.environ.get("MONA_VIBE_TEST_PYTHON", str(ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe")))
    if not python.is_file():
        pytest.skip("explicit native Vibe Python environment required")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "home"
    home.mkdir()
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    }}
    env.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(python), "-c", _PROBE], cwd=home, env=env,
        capture_output=True, text=True, encoding="utf-8", timeout=45, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
