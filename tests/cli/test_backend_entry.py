from __future__ import annotations

import tomllib
from pathlib import Path

from typer.main import get_command
from typer.testing import CliRunner

from mona.cli.commands import app
from mona.config.schema import Config

runner = CliRunner()
REPO_ROOT = Path(__file__).resolve().parents[2]


def test_public_commands_only_include_desktop_runtime() -> None:
    assert set(get_command(app).commands) == {"gateway", "services"}


def test_version_option_is_available() -> None:
    from mona import __version__

    result = runner.invoke(app, ["--version"])

    assert result.exit_code == 0
    assert f"v{__version__}" in result.stdout


def test_services_forwards_config_workspace_and_port(monkeypatch, tmp_path: Path) -> None:
    config = Config()
    config_path = tmp_path / "config.json"
    workspace_path = tmp_path / "workspace"
    loaded: dict[str, object] = {}
    started: dict[str, object] = {}

    def _load_runtime_config(config_arg: str | None, workspace: str | None) -> Config:
        loaded.update(config=config_arg, workspace=workspace)
        return config

    monkeypatch.setattr("mona.cli.commands._load_runtime_config", _load_runtime_config)
    monkeypatch.setattr(
        "mona.cli.commands._run_services",
        lambda actual_config, *, port=None: started.update(config=actual_config, port=port),
    )

    result = runner.invoke(
        app,
        [
            "services",
            "--config",
            str(config_path),
            "--workspace",
            str(workspace_path),
            "--port",
            "18174",
        ],
    )

    assert result.exit_code == 0
    assert loaded == {"config": str(config_path), "workspace": str(workspace_path)}
    assert started == {"config": config, "port": 18174}


def test_gateway_package_drops_cli_prompt_dependencies_and_hidden_imports() -> None:
    project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    metadata = project["project"]
    dependencies = list(metadata.get("dependencies", []))
    for extra_dependencies in metadata.get("optional-dependencies", {}).values():
        dependencies.extend(extra_dependencies)

    normalized_dependencies = "\n".join(dependencies).lower().replace("_", "-")
    assert "prompt-toolkit" not in normalized_dependencies
    assert "questionary" not in normalized_dependencies

    spec = (REPO_ROOT / "src-tauri" / "mona-gateway.spec").read_text(encoding="utf-8")
    assert "prompt_toolkit" not in spec
    assert "questionary" not in spec
