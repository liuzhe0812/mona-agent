from pathlib import Path

import pytest

from mona.config import loader as config_loader
from mona.config.loader import ConfigLoadError, load_config, save_config
from mona.config.schema import Config


def test_save_config_round_trips_model_configuration(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.provider = "deepseek"
    config.agents.defaults.model = "deepseek-chat"
    config.providers.deepseek.api_key = "test-key"

    save_config(config, path)

    restored = load_config(path)
    assert restored.agents.defaults.provider == "deepseek"
    assert restored.agents.defaults.model == "deepseek-chat"
    assert restored.providers.deepseek.api_key == "test-key"


def test_save_config_failure_preserves_previous_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "config.json"
    previous = b'{"sentinel":"keep"}'
    path.write_bytes(previous)

    def fail_after_partial_write(data: object, stream: object, **kwargs: object) -> None:
        del data, kwargs
        stream.write('{"partial"')
        raise RuntimeError("simulated write failure")

    monkeypatch.setattr(config_loader.json, "dump", fail_after_partial_write)

    with pytest.raises(RuntimeError, match="simulated write failure"):
        save_config(Config(), path)

    assert path.read_bytes() == previous
    assert not list(tmp_path.glob(".config.json.*.tmp"))


def test_load_config_rejects_invalid_json_without_changing_it(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    invalid = b'{"providers":'
    path.write_bytes(invalid)

    with pytest.raises(ConfigLoadError, match="Invalid Mona config"):
        load_config(path)

    assert path.read_bytes() == invalid
