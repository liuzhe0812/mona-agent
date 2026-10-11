import os
import sys
from pathlib import Path

from mona.config.schema import Config, DevelopmentConfig
from mona.development.executors.discovery import discover_executors


def test_missing_executables_are_not_claimed_ready():
    probes = discover_executors(DevelopmentConfig(), search_path="")
    assert [p.executor.value for p in probes] == ["codex", "claude", "codebuddy"]
    assert all(p.state == "not_detected" and not p.isolation_verified for p in probes)
    assert all(
        p.authentication == "unknown"
        and not any(value for key, value in p.capabilities.model_dump().items() if key != "permission_modes")
        for p in probes
    )


def test_explicit_path_detection_never_executes_program(tmp_path):
    marker = tmp_path / "executed"
    path = tmp_path / ("codex.cmd" if os.name == "nt" else "codex")
    path.write_text(f'echo should-not-run > "{marker}"')
    path.chmod(0o700)
    probes = discover_executors(DevelopmentConfig(codex_path=str(path.resolve())), search_path="")
    assert probes[0].state == ("invalid_path" if os.name == "nt" else "detected")
    assert not probes[0].isolation_verified
    assert not marker.exists()


def test_bad_explicit_path_never_falls_back_to_another_program(monkeypatch):
    def which(name, path=None):
        if name == "codex":
            raise AssertionError("must not fall back")
        return None
    monkeypatch.setattr("mona.development.executors.discovery.shutil.which", which)
    result = discover_executors(DevelopmentConfig(codex_path="relative/codex"))
    assert result[0].state == "invalid_path"


def test_managed_discovery_can_be_excluded_from_local_program_detection(monkeypatch):
    import mona.development.executors.discovery as discovery

    monkeypatch.setattr(discovery, "_codex_desktop_candidates", lambda _home: [])
    monkeypatch.setattr(discovery, "_standard_candidates", lambda _executor, _home: [])
    monkeypatch.setattr(discovery.shutil, "which", lambda _name, path=None: None)
    managed = Path(sys.executable).resolve()
    monkeypatch.setattr(
        discovery,
        "managed_executor_path",
        lambda executor: managed if executor == "codex" else None,
    )

    with_managed = discover_executors(DevelopmentConfig())
    local_only = discover_executors(DevelopmentConfig(), include_managed=False)

    assert with_managed[0].state == "detected" and with_managed[0].source == "managed_runtime"
    assert local_only[0].state == "not_detected"


def test_config_is_explicit_and_camel_case_compatible(tmp_path):
    config = Config.model_validate({"development": {"codexPath": str(tmp_path), "maxProjectSkills": 20}})
    assert config.development.codex_path == str(tmp_path)
    assert config.development.max_project_skills == 20
    assert "hooks" not in DevelopmentConfig.model_fields
    assert "mcp_servers" not in DevelopmentConfig.model_fields
