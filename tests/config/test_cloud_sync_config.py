import json

import pytest

from mona.cloud.coordinator import SyncPreferences
from mona.config.loader import load_config, save_config
from mona.config.schema import CloudSyncConfig


@pytest.mark.parametrize("root_key", ["cloudSync", "cloud_sync"])
def test_full_config_load_and_save_preserve_cloud_scope(tmp_path, root_key):
    path = tmp_path / "config.json"
    scope = CloudSyncConfig(enabled=True, account_id="1", vault_id="a" * 32,
        sync_planning=True, sync_notes=True, notes_vault_token="b" * 64,
        sync_operations=True, sync_operations_credentials=True,
        session_keys=["websocket:work-1"])
    path.write_text(json.dumps({root_key: scope.model_dump(by_alias=True), "services": {"port": 18074}}), encoding="utf-8")
    loaded = load_config(path)
    assert loaded.cloud_sync == scope
    assert loaded.services.port == 18074
    save_config(loaded, path)
    assert SyncPreferences(path).read() == scope
    assert load_config(path).cloud_sync == scope


def test_scope_writer_keeps_full_config_valid_without_changing_other_settings(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"cloudSync": {"enabled": False}, "services": {"port": 18074},
        "agents": {"defaults": {"maxTokens": 1234}}}), encoding="utf-8")
    preferences = SyncPreferences(path)
    scope = CloudSyncConfig(enabled=True, sync_planning=True, sync_notes=True,
        notes_vault_token="b" * 64, session_keys=["websocket:work-1"])
    preferences.write(scope)
    loaded = load_config(path)
    assert loaded.cloud_sync == scope
    assert loaded.services.port == 18074
    assert loaded.agents.defaults.max_tokens == 1234
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["services"] == {"port": 18074}
    assert "cloudSync" not in saved and "cloud_sync" in saved
    assert SyncPreferences(path).read() == scope
