import json

import pytest

from mona.development.settings import read_settings, update_settings
from mona.development.store import ConflictError, DevelopmentError


def test_native_engines_are_disabled_by_default(tmp_path):
    path = tmp_path / "config.json"

    settings = read_settings(path)

    assert settings["enabledEngines"] == []
    assert not path.exists()


def test_settings_merge_raw_config_and_never_persist_resolved_secrets(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    raw = {"providers": {"configured": {"apiKey": "${UNRESOLVED_TEST_REFERENCE}"}},
           "other": {"preserve": [1, 2]}, "development": {"maxRuleBytes": 8000}}
    path.write_text(json.dumps(raw), encoding="utf8")
    monkeypatch.setenv("MY_TEST_AUTH", "synthetic-test-value")
    initial = read_settings(path)
    result = update_settings(initial["revision"], {"claudeApiKeyEnv": "MY_TEST_AUTH"}, path)
    assert result["credentialPresent"]["claude"]
    saved = json.loads(path.read_text(encoding="utf8"))
    assert saved["providers"] == raw["providers"] and saved["other"] == raw["other"]
    assert saved["development"]["maxRuleBytes"] == 8000
    assert "synthetic-test-value" not in str(result) + path.read_text(encoding="utf8")
    before = path.read_bytes()
    with pytest.raises(ConflictError):
        update_settings(initial["revision"], {"codebuddyPath": None}, path)
    assert path.read_bytes() == before


def test_enabled_engine_only_update_preserves_raw_settings_and_rejects_stale_revision(
    tmp_path, monkeypatch
):
    path = tmp_path / "config.json"
    raw = {
        "providers": {"configured": {"apiKey": "${UNRESOLVED_TEST_REFERENCE}"}},
        "other": {"preserve": [1, 2]},
        "development": {
            "codexPath": str(tmp_path / "codex.exe"),
            "claudeApiKeyEnv": "MY_CLAUDE_AUTH",
            "codebuddyApiKeyEnv": "MY_CODEBUDDY_AUTH",
        },
    }
    path.write_text(json.dumps(raw), encoding="utf8")
    monkeypatch.setenv("MY_CLAUDE_AUTH", "synthetic-claude-secret")
    monkeypatch.setenv("MY_CODEBUDDY_AUTH", "synthetic-codebuddy-secret")
    initial = read_settings(path)

    result = update_settings(
        initial["revision"], {}, path, enabled_engines=["codex", "claude", "codex"]
    )

    saved = json.loads(path.read_text(encoding="utf8"))
    assert result["enabledEngines"] == ["codex", "claude"]
    assert result["values"] == initial["values"]
    assert result["credentialPresent"] == {"claude": True, "codebuddy": True}
    assert saved["providers"] == raw["providers"] and saved["other"] == raw["other"]
    assert saved["development"] == {
        **raw["development"],
        "enabledEngines": ["codex", "claude"],
    }
    assert "synthetic-claude-secret" not in str(result) + path.read_text(encoding="utf8")
    assert "synthetic-codebuddy-secret" not in str(result) + path.read_text(encoding="utf8")

    before_stale_update = path.read_bytes()
    with pytest.raises(ConflictError):
        update_settings(initial["revision"], {}, path, enabled_engines=["codebuddy"])
    assert path.read_bytes() == before_stale_update


def test_settings_reject_unknown_fields_shell_scripts_and_key_contents(tmp_path):
    path = tmp_path / "config.json"
    initial = read_settings(path)
    for changes in [{"apiKey": "not-permitted"}, {"claudeApiKeyEnv": "not a variable"}, {"codexPath": "relative.exe"}]:
        with pytest.raises(DevelopmentError):
            update_settings(initial["revision"], changes, path)
    script = tmp_path / "launcher.cmd"
    script.write_text("not executed")
    with pytest.raises(DevelopmentError):
        update_settings(initial["revision"], {"codexPath": str(script)}, path)
    assert not path.exists()
