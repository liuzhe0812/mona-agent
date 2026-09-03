from __future__ import annotations

import pytest

from mona.config.loader import load_config, save_config
from mona.config.schema import Config
from mona.webui import settings_api


def test_runtime_auto_download_defaults_and_round_trips(tmp_path) -> None:
    config = Config()

    assert config.runtime.auto_download is True
    assert config.model_dump(by_alias=True)["runtime"]["autoDownload"] is True

    config.runtime.auto_download = False
    config_path = tmp_path / "config.json"
    save_config(config, config_path)

    assert load_config(config_path).runtime.auto_download is False


def test_settings_payload_exposes_runtime_auto_download(monkeypatch: pytest.MonkeyPatch) -> None:
    config = Config()
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "_channels_payload", lambda _config: {"available": []})
    monkeypatch.setattr(settings_api, "_chat_provider_rows", lambda _config: [])
    monkeypatch.setattr(settings_api, "_image_generation_provider_rows", lambda _config: [])
    monkeypatch.setattr(settings_api, "_video_generation_provider_rows", lambda _config: [])
    monkeypatch.setattr(
        settings_api,
        "_tts_payload",
        lambda _config: {
            "provider": "edge",
            "voice": "",
            "api_base": None,
            "model": None,
            "api_key_configured": False,
            "api_key_hint": None,
        },
    )

    payload = settings_api.settings_payload()

    assert payload["runtime"]["auto_download"] is True


@pytest.mark.parametrize("query_key", ["auto_download", "autoDownload"])
def test_update_agent_settings_persists_auto_download_without_restart(
    monkeypatch: pytest.MonkeyPatch,
    query_key: str,
) -> None:
    config = Config()
    saved: list[Config] = []
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", saved.append)
    monkeypatch.setattr(
        settings_api,
        "settings_payload",
        lambda *, requires_restart=False: {
            "runtime": {"auto_download": config.runtime.auto_download},
            "requires_restart": requires_restart,
        },
    )

    payload = settings_api.update_agent_settings({query_key: ["false"]})

    assert config.runtime.auto_download is False
    assert saved == [config]
    assert payload == {"runtime": {"auto_download": False}, "requires_restart": False}


def test_update_agent_settings_rejects_invalid_auto_download(monkeypatch: pytest.MonkeyPatch) -> None:
    config = Config()
    monkeypatch.setattr(settings_api, "load_config", lambda: config)

    with pytest.raises(settings_api.WebUISettingsError, match="auto_download must be boolean"):
        settings_api.update_agent_settings({"auto_download": ["sometimes"]})
