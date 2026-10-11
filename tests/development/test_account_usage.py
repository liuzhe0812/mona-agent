"""Public usage contract through the production API and native RPC transport."""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import setup, trace

from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId
from mona.development.executors.account_usage import account_identity, with_usage
from mona.development.executors.codex import CodexExecutor


def snapshot():
    return {"account": {"type": "chatgpt", "email": "demo@example.invalid", "planType": "pro", "token": "PRIVATE"},
        "usage": {"rateLimits": {"secondary": {"usedPercent": 93, "windowDurationMins": 10080, "resetsAt": 1800000000},
            "credits": {"balance": "62500.00", "hasCredits": True, "unlimited": False, "token": "PRIVATE"}},
            "rateLimitsByLimitId": {"codex": {"limitId": "codex", "secondary": {"usedPercent": 93,
                "windowDurationMins": 10080, "resetsAt": 1800000000, "token": "PRIVATE"}}},
            "rateLimitResetCredits": {"availableCount": 1, "credits": [{"id": "PRIVATE"}]}, "token": "PRIVATE"}}


def test_multi_bucket_usage_keeps_real_zero_and_missing_values_distinct():
    data = snapshot()
    data["usage"]["rateLimitsByLimitId"]["codex"]["primary"] = {"usedPercent": 0, "resetsAt": None}
    data["usage"]["rateLimitResetCredits"]["availableCount"] = 0
    result = with_usage(account_identity(data), data["usage"]).model_dump(by_alias=True)
    assert result["limits"][0]["primary"]["usedPercent"] == 0
    assert result["limits"][0]["primary"]["windowDurationMins"] is None
    assert result["availableResets"] == 0
    assert result["credits"]["balance"] == "62500.00"
    assert "PRIVATE" not in json.dumps(result)
    legacy = with_usage(account_identity(data), {"rateLimits": {"primary": {"usedPercent": 100}}})
    assert legacy.limits[0].primary.used_percent == 100
    assert legacy.available_resets is None and legacy.credits is None


def test_settings_never_borrow_model_specific_quota_or_override_an_empty_generic_bucket():
    data = snapshot()
    identity = account_identity(data)
    model_only = {"spark": {"limitId": "spark", "primary": {"usedPercent": 1}}}
    for table in ({}, model_only):
        result = with_usage(identity, {**data["usage"], "rateLimitsByLimitId": table})
        assert result.limits == []
    table = {**model_only, "__default__": {"primary": {"usedPercent": 5}}, "codex": {}}
    result = with_usage(identity, {**data["usage"], "rateLimitsByLimitId": table})
    assert len(result.limits) == 1 and result.limits[0].primary is None


def test_generic_bucket_staleness_and_reset_credit_expiry_follow_cindy():
    data = snapshot()
    old_reset = int(time.time()) - 172800
    future = int(time.time()) + 3600
    data["usage"]["rateLimitsByLimitId"] = {
        "codex": {"primary": {"usedPercent": 99, "resetsAt": old_reset},
                  "secondary": {"usedPercent": 91, "resetsAt": old_reset}},
        "__default__": {"primary": {"usedPercent": 25, "resetsAt": future}},
    }
    data["usage"]["rateLimitResetCredits"] = {"availableCount": 0, "credits": [
        {"status": "available", "expiresAt": -1}, {"status": "available", "expiresAt": future},
        {"status": "redeemed", "expiresAt": future - 100},
    ]}
    result = with_usage(account_identity(data), data["usage"])
    assert result.limits[0].primary.used_percent == 25
    assert result.available_resets == 0 and result.reset_credits_expire_at == future
    data["usage"]["rateLimitsByLimitId"]["codex"]["secondary"]["resetsAt"] = None
    result = with_usage(account_identity(data), data["usage"])
    assert result.limits[0].primary.used_percent == 99


@pytest.mark.asyncio
async def test_usage_api_reads_account_and_limits_without_login_tasks_or_credential_exposure(tmp_path, monkeypatch):
    runtime, project, root, original = await setup(tmp_path)
    host = CodexExecutor(original.profile, account_changed=lambda identity: runtime.native._notify_account_usage(identity, account_host=True))
    runtime.native.hosts[(project.id, ExecutorId.CODEX)] = host
    runtime.native.hosts[("", ExecutorId.CODEX)] = host
    data = snapshot()
    data["echo"] = True
    (root / "account-usage.json").write_text(json.dumps(data), encoding="utf8")
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-usage-test")
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    url = "/api/development/provider-executors/codex/usage"
    headers = {"X-Mona-Token": "synthetic-usage-test"}
    try:
        assert (await client.get(url)).status == 401
        response = await client.get(url, headers=headers)
        assert response.status == 200
        reply = await response.json()
        assert reply["connected"] and reply["email"] == "demo@example.invalid" and reply["planType"] == "pro"
        assert reply["availableResets"] == 1 and reply["limits"][0]["secondary"]["usedPercent"] == 93
        assert reply["fetchedAt"] and reply["revision"] == 0
        assert "PRIVATE" not in json.dumps(reply)
        assert not any(row.get("method") in {"turn/start", "thread/start", "account/login/start"} for row in trace(root))
        assert runtime.store.list_sessions(project.id) == []

        changed = asyncio.create_task(runtime.native.account_usage_changes(ExecutorId.CODEX, reply["revision"]))
        await host._client.request("test/usage/push", {"identity": False})
        assert (await asyncio.wait_for(changed, 2)) == {"revision": 1, "identityChanged": False}
        await host._client.request("test/usage/push", {"identity": True})
        event = await (await client.get(url + "/changes?after=1", headers=headers)).json()
        assert event == {"revision": 2, "identityChanged": True}

        second = snapshot()
        second["account"]["email"] = "second@example.invalid"
        second["usage"]["rateLimitsByLimitId"]["codex"]["secondary"]["usedPercent"] = 22
        data["switchAccountDuringRead"] = second
        (root / "account-usage.json").write_text(json.dumps(data), encoding="utf8")
        mixed = await (await client.get(url, headers=headers)).json()
        assert mixed["email"] == "second@example.invalid" and mixed["error"] and not mixed["limits"]
        current = await (await client.get(url, headers=headers)).json()
        assert current["email"] == "second@example.invalid" and current["limits"][0]["secondary"]["usedPercent"] == 22
        data.pop("switchAccountDuringRead")

        data["error"] = True
        (root / "account-usage.json").write_text(json.dumps(data), encoding="utf8")
        unavailable = await (await client.get(url, headers=headers)).json()
        assert unavailable["connected"] and unavailable["error"] and not unavailable["limits"]
        assert unavailable["availableResets"] is None and unavailable["fetchedAt"] is None
        assert "PRIVATE" not in json.dumps(unavailable)
        await host.logout()
        disconnected = await (await client.get(url, headers=headers)).json()
        assert not disconnected["connected"] and disconnected["email"] is None and disconnected["credits"] is None
    finally:
        await client.close()
