"""The Codex source is bound to the server's dedicated operator configuration."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.__main__ import _load_config
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.executor import child_environment
from mona.hosted_work.native_provider import HostedNativeWorkProvider
from mona.hosted_work.providers import create_provider
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore


def operator_file(tmp_path, *, cli="first-cli", proxy="http://127.0.0.1:7897"):
    cli_path = tmp_path / cli
    cli_path.write_text("not executed", encoding="utf-8")
    path = tmp_path / "operator.json"
    data = {"hosted_work": {
        "operator_config_path": str(tmp_path / "untrusted.json"),
        "codex": {"cli_path": str(cli_path), "local_proxy_url": proxy},
        "max_concurrent_runs": 4,
        "models": {
            "one": {"label": "One", "model": "codex-one", "source": "codex", "billing_mode": "wallet",
                    "native_config_path": str(tmp_path / "other-one.json")},
            "two": {"label": "Two", "model": "codex-two", "source": "codex", "billing_mode": "wallet",
                    "native_config_path": str(tmp_path / "other-two.json")},
            "qwen": {"label": "Qwen", "model": "qwen", "source": "mona", "billing_mode": "free"},
        },
    }}
    path.write_text(json.dumps(data), encoding="utf-8")
    return path, data, cli_path


def allow_codex_for_connection_tests(monkeypatch):
    # These tests exercise the connection independently of model admission.
    monkeypatch.setattr("mona.hosted_work.service.require_model_available",
                        lambda _model, _config, *, billing_authorized=False: None)
    monkeypatch.setattr("mona.hosted_work.providers.require_model_available",
                        lambda _model, _config, *, billing_authorized=False: None)


def test_operator_path_is_bound_by_entry_and_survives_child_serialization(tmp_path):
    path, _, _ = operator_file(tmp_path)
    config = _load_config(path)
    assert config.operator_config_path == str(path.resolve())
    child_config = HostedWorkConfig.model_validate(config.model_dump())
    assert child_config.operator_config_path == str(path.resolve())
    with pytest.raises(ValidationError):
        NewTurn.model_validate({"request_id": "a" * 32, "model_id": "one", "text": "test",
                                "operator_config_path": str(tmp_path / "forged.json")})


@pytest.mark.parametrize("name", ["", "MONA_WORK_BILLING_KEY", "MONA_WORK_BILLING_CLIENT_2"])
def test_billing_key_environment_name_accepts_only_explicit_configuration(name):
    assert HostedWorkConfig(billing_key_env=name).billing_key_env == name


@pytest.mark.parametrize("name", ["MONA_WORK_BILLING_", "MONA_WORK_BILLING_lower", "OTHER_KEY", "actual-secret"])
def test_billing_key_environment_name_rejects_other_values(name):
    with pytest.raises(ValidationError):
        HostedWorkConfig(billing_key_env=name)


def test_codex_provider_uses_dedicated_home_and_configured_executable(tmp_path, monkeypatch):
    allow_codex_for_connection_tests(monkeypatch)
    path, _, executable = operator_file(tmp_path)
    config = _load_config(path)
    resolved = []

    def resolve(engine, supplied):
        resolved.append((engine.value, supplied))
        return executable.resolve(), False

    monkeypatch.setattr("mona.development.executors.discovery.resolve_executable", resolve)
    selection = config.models["one"]
    adapter = create_provider(config, selection, tmp_path / "empty")
    assert isinstance(adapter, HostedNativeWorkProvider)
    assert resolved == [("codex", executable)]
    assert adapter._native_home == (path.parent / "development/native/codex").resolve()
    assert adapter.config.development.enabled_engines == ["codex"]
    assert adapter.config.development.codex_path == str(executable.resolve())
    assert adapter.config.agents.defaults.executor == "codex"
    assert adapter.config.agents.defaults.native_model == "codex-one"
    assert adapter.config.agents.defaults.fallback_models == []
    assert adapter._CHAT_RETRY_DELAYS == ()
    assert not Path(selection.native_config_path).exists()


@pytest.mark.parametrize("value", ["", "relative.json"])
def test_codex_provider_refuses_missing_or_relative_operator_path(tmp_path, monkeypatch, value):
    allow_codex_for_connection_tests(monkeypatch)
    path, _, _ = operator_file(tmp_path)
    config = _load_config(path)
    config.operator_config_path = value
    with pytest.raises(WorkError) as caught:
        create_provider(config, config.models["one"], tmp_path / "empty")
    assert caught.value.code == "native_unavailable"


def test_codex_models_share_home_lock_and_freeze_connection_until_release(tmp_path, monkeypatch):
    allow_codex_for_connection_tests(monkeypatch)
    path, data, executable = operator_file(tmp_path)
    config = _load_config(path)
    store = WorkStore(tmp_path / "state.sqlite3", config)
    service = WorkService(config, store, None, None)
    first, second = owner_key("1"), owner_key("2")
    new_cli = tmp_path / "second-cli"
    new_cli.write_text("not executed", encoding="utf-8")
    try:
        engine = service._acquire(first, "one")
        assert engine == str(path.parent / "development/native/codex") + ":codex"
        assert config.codex.cli_path == str(executable)
        assert child_environment(config, {"action": "turn", "model_id": "one"})["HTTPS_PROXY"] == "http://127.0.0.1:7897"
        data["hosted_work"]["codex"] = {"cli_path": str(new_cli), "local_proxy_url": "http://127.0.0.1:9999"}
        path.write_text(json.dumps(data), encoding="utf-8")
        with pytest.raises(WorkError) as busy:
            service._acquire(second, "two")
        assert busy.value.code == "model_busy"
        assert config.codex.cli_path == str(executable)
        assert child_environment(config, {"action": "turn", "model_id": "one"})["HTTPS_PROXY"] == "http://127.0.0.1:7897"
        third = owner_key("3")
        assert service._acquire(third, "qwen") is None
        service._release(third, None)
        service._release(first, engine)
        next_engine = service._acquire(second, "two")
        assert next_engine == engine
        assert config.codex.cli_path == str(new_cli)
        assert child_environment(config, {"action": "turn", "model_id": "two"})["HTTPS_PROXY"] == "http://127.0.0.1:9999"
        assert "HTTPS_PROXY" not in child_environment(config, {"action": "turn", "model_id": "qwen"})
        service._release(second, next_engine)
    finally:
        store.close()


def test_unknown_codex_run_blocks_other_model_on_the_same_home(tmp_path, monkeypatch):
    allow_codex_for_connection_tests(monkeypatch)
    path, _, _ = operator_file(tmp_path)
    config = _load_config(path)
    store = WorkStore(tmp_path / "state.sqlite3", config)
    first, second, sid, rid = owner_key("1"), owner_key("2"), "a" * 32, "b" * 32
    try:
        store.create_session(first, NewSession(request_id=sid))
        store.create_run(first, sid, NewTurn(request_id=rid, model_id="one", text="test"))
        store.recover()
        service = WorkService(config, store, None, None)
        with pytest.raises(WorkError) as caught:
            service._acquire(second, "two")
        assert caught.value.code == "model_pending"
        assert service.active_engines == set()
        assert service.active_users == set()
        assert store.unknown_count() == 1
    finally:
        store.close()
