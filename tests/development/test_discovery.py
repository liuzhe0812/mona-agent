import os

from mona.config.schema import Config, DevelopmentConfig
from mona.development.executors.discovery import discover_executors


def test_missing_executables_are_not_claimed_ready():
    probes = discover_executors(DevelopmentConfig(), search_path="")
    assert [p.executor.value for p in probes] == ["codex", "claude", "codebuddy"]
    assert all(p.state == "not_detected" and not p.isolation_verified for p in probes)
    assert all(p.authentication == "unknown" and not any(p.capabilities.model_dump().values()) for p in probes)


def test_explicit_path_detection_never_executes_program(tmp_path):
    marker = tmp_path / "executed"
    path = tmp_path / ("codex.cmd" if os.name == "nt" else "codex")
    path.write_text(f'echo should-not-run > "{marker}"')
    path.chmod(0o700)
    probes = discover_executors(DevelopmentConfig(codex_path=str(path.resolve())), search_path="")
    assert probes[0].state == "detected"
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


def test_config_is_explicit_and_camel_case_compatible(tmp_path):
    config = Config.model_validate({"development": {"codexPath": str(tmp_path), "maxProjectSkills": 20}})
    assert config.development.codex_path == str(tmp_path)
    assert config.development.max_project_skills == 20
    assert "hooks" not in DevelopmentConfig.model_fields
    assert "mcp_servers" not in DevelopmentConfig.model_fields
