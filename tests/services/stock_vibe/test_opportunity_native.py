"""Retired opportunity records remain readable without new custom quant jobs."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"


@pytest.fixture(scope="module")
def native_source(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path_factory.mktemp("vibe-opportunity-native") / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(item["path"] == "0033-hosted-opportunity.json" for item in receipt["patches"])
    return source


_PROBE = r'''
import json
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from src.api import mona_opportunity as service
from src.api import mona_operations as operations
from src.api.security import require_auth
from src.config.paths import get_runtime_root
from backtest.loaders.tencent_loader import DataLoader
from src.market_data import fetch_market_data_json
from src.session.models import Session, Attempt, AttemptStatus
from src.session.store import SessionStore

fetch_symbol = "600000.SH"
fetch_dates = ("2025-01-01", "2025-01-31")
with patch.dict("os.environ", {"VIBE_TRADING_DATA_CACHE": "false"}):
    loader = DataLoader()
    with patch.object(loader, "_fetch_one", side_effect=[OSError("fixture fetch failure"), None]):
        assert loader.fetch([fetch_symbol], *fetch_dates, interval="1D") == {}
        assert loader.fetch_errors == {fetch_symbol: "fetch_failed"}
        assert loader.fetch([fetch_symbol], *fetch_dates, interval="1D") == {}
        assert loader.fetch_errors == {}

    with patch.object(DataLoader, "_fetch_one", side_effect=OSError("fixture fetch failure")):
        fetch_payload = json.loads(fetch_market_data_json(
            codes=[fetch_symbol], start_date=fetch_dates[0], end_date=fetch_dates[1],
            source="tencent", loader_resolver=lambda _: DataLoader,
            fallback_chain_provider=lambda _: ["tencent"],
        ))
assert fetch_payload["status"] == "error"
fetch_attempts = fetch_payload["_diagnostics"][fetch_symbol]["attempts"]
assert fetch_attempts == [{"source": "tencent", "reason": "fetch_failed"}]
assert all(item["reason"] != "no_data" for item in fetch_attempts)

symbols = [f"{code:06}.SH" for code in range(600000, 600012)]
context = {"plan_id": "multifactor", "mode": "swing", "universe": "watchlist",
           "symbols": symbols, "conditions": ""}
assert service.validate_context(context) == context
for invalid in ({**context, "unexpected": True}, {**context, "symbols": [symbols[0]]*2},
                {**context, "symbols": [{}]}, {**context, "plan_id": "custom"},
                {**context, "universe": "whole_market"}):
    try:
        service.validate_context(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid context accepted")
assert service.validate_context({**context, "plan_id": "custom", "conditions": "避开银行"})["plan_id"] == "custom"

# Persist real session/attempt objects. Saving early cannot publish candidates;
# cross-session identities and references to unobserved source calls fail.
store = SessionStore(get_runtime_root()/"sessions")
session = Session(session_id="opportunity-session", config={"mona_opportunity": context}, last_attempt_id="attempt-one")
store.create_session(session)
attempt = Attempt(attempt_id="attempt-one", session_id=session.session_id, status=AttemptStatus.RUNNING)
store.create_attempt(attempt)
foreign = Session(session_id="other-session", config={"mona_opportunity": context}, last_attempt_id="attempt-other")
store.create_session(foreign)
store.create_attempt(Attempt(attempt_id="attempt-other", session_id=foreign.session_id, status=AttemptStatus.COMPLETED))
trail = [{"tool": "get_stock_profile", "call_id": "observed-call", "status": "ok",
          "arguments": {"symbol": symbols[0]},
          "preview": json.dumps({"symbol": symbols[0], "name": "fixture issuer"})}]
candidate = {"symbol": symbols[0], "support": ["本轮资料已核对"], "risks": ["缺少历史财报"],
             "evidence_call_ids": ["observed-call"]}
for preview in ("", json.dumps({"status": "error", "symbol": symbols[0], "error": "source unavailable"})):
    try:
        service.save_candidates(session.session_id, attempt.attempt_id,
                                [{**trail[0], "preview": preview}], [candidate], "2024-06-14", [])
    except ValueError:
        pass
    else:
        raise AssertionError("empty or failed source preview accepted")
try:
    service.save_candidates(session.session_id, attempt.attempt_id, trail,
                            [{**candidate, "evidence_call_ids": ["not-observed"]}], "2024-06-14", [])
except ValueError:
    pass
else:
    raise AssertionError("missing source call accepted")
saved = service.save_candidates(session.session_id, attempt.attempt_id, trail, [candidate], "2024-06-14", ["fixture evidence"])
assert saved["saved"] and saved["candidate_count"] == 1
automatic = {key:value for key,value in candidate.items() if key != "evidence_call_ids"}
saved = service.save_candidates(session.session_id, attempt.attempt_id, trail, json.dumps([automatic]), "2024-06-14", ["fixture evidence"])
assert saved["saved"] and saved["candidate_count"] == 1
assert service._session_result(store, session.session_id, attempt.attempt_id)["candidates"] == []
attempt.status = AttemptStatus.COMPLETED
store.update_attempt(attempt)
projection = service._session_result(store, session.session_id, attempt.attempt_id)
assert projection["candidates"][0]["symbol"] == symbols[0]
assert projection["session_id"] == session.session_id and projection["attempt_id"] == attempt.attempt_id
for sid, aid in ((session.session_id, "attempt-other"), (foreign.session_id, attempt.attempt_id)):
    try:
        service._session_result(store, sid, aid)
    except HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("foreign attempt accepted")

from src.tools.opportunity_candidates_tool import ScreenOpportunitiesTool
retired = ScreenOpportunitiesTool(session.session_id, attempt.attempt_id, context)
assert json.loads(retired.execute(plan_id="multifactor"))["error_code"] == "custom_quant_screen_retired"

app = FastAPI()
app.dependency_overrides[require_auth] = lambda: None
service.register_mona_opportunity(app)
operations.register_mona_operations(app)
payload = {"operation": "opportunity_screen", **context}
with TestClient(app) as client:
    catalog = client.get("/mona/opportunity-plans")
    assert catalog.status_code == 200
    before_records = operations._OperationStore().list(100)
    for request in (payload, {**payload, "source_path": "C:/outside"},
                    {**payload, "plan_ids": ["multifactor", "low_volatility"]}):
        response = client.post("/mona/operations", json=request)
        assert response.status_code == 422, response.text
    assert operations._OperationStore().list(100) == before_records

print(json.dumps({"archive_context": True, "session_evidence_identity": True,
                  "retired_custom_dispatch": True, "tencent_fetch_failure_diagnostics": True}))
'''


def test_retired_opportunity_archive_reads_and_rejects_new_quant_dispatch(
    native_source: Path, tmp_path: Path
) -> None:
    home = tmp_path / "native-home"
    home.mkdir()
    environment = {
        key: value for key, value in os.environ.items()
        if key.upper() in {
            "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME",
            "USERPROFILE", "LOCALAPPDATA", "APPDATA",
        }
    }
    environment.update(
        PYTHONPATH=str(native_source / "agent"), PYTHONUTF8="1",
        PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1",
        VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1", PYTHON_DOTENV_DISABLED="1",
        MONA_VIBE_INSTANCE_ID="d" * 32,
    )
    result = subprocess.run(
        [str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=180, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout.splitlines()[-1])
    assert evidence == {
        "archive_context": True, "session_evidence_identity": True,
        "retired_custom_dispatch": True, "tencent_fetch_failure_diagnostics": True,
    }
