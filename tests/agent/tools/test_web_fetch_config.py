from __future__ import annotations

from mona.agent.tools.web import WebFetchConfig
from mona.config.loader import _migrate_config


def test_web_fetch_config_has_no_jina_reader_option() -> None:
    assert "use_jina_reader" not in WebFetchConfig.model_fields


def test_legacy_jina_reader_options_are_removed_from_config() -> None:
    data = {
        "tools": {
            "web": {
                "fetch": {
                    "useJinaReader": True,
                    "use_jina_reader": True,
                    "browserFallback": True,
                }
            }
        }
    }

    migrated = _migrate_config(data)

    assert migrated["tools"]["web"]["fetch"] == {"browserFallback": True}
