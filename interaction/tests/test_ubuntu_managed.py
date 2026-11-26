import importlib.util
import json
import shlex
from pathlib import Path

import pytest


def load_helper():
    path = Path(__file__).resolve().parents[1] / "scripts/ubuntu-managed.py"
    spec = importlib.util.spec_from_file_location("ubuntu_managed", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load_helper()


def make_environment(tmp_path):
    root = tmp_path / "runtimes"
    generation = "a" * 32
    environment = root / "python" / "interaction-voice-envs" / generation
    binary = environment / "bin/python"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"test-only")
    binary.chmod(0o755)
    (environment / "environment.json").write_text(json.dumps({
        "schemaVersion": 1, "generation": generation, "pythonRelative": "bin/python",
        "basePack": "python-base@1", "packs": ["python-base@1"],
    }), encoding="utf-8")
    return root, environment, binary


def test_only_recorded_python_inside_runtime_is_accepted(tmp_path):
    root, environment, binary = make_environment(tmp_path)
    assert helper.managed_environment(root, binary, environment) == environment.resolve()
    outside = tmp_path / "outside/python"
    outside.parent.mkdir()
    outside.write_bytes(b"test-only")
    outside.chmod(0o755)
    with pytest.raises(ValueError, match="超出运行时范围"):
        helper.managed_environment(root, outside)
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(environment / "bin", target_is_directory=True)
    except OSError:
        pass  # Creating symlinks may require privileges on Windows.
    else:
        with pytest.raises(ValueError, match="超出运行时范围"):
            helper.managed_environment(root, alias / "python")
    (environment / "environment.json").write_text('{"generation":"invalid"}', encoding="utf-8")
    with pytest.raises(ValueError, match="环境记录"):
        helper.managed_environment(root, binary)


def test_resources_cannot_escape_declared_roots(tmp_path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    inside = allowed / "scene.json"
    inside.write_text("{}", encoding="utf-8")
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    assert helper.bounded_file(str(inside), (allowed.resolve(),)) == inside.resolve()
    with pytest.raises(ValueError, match="超出允许范围"):
        helper.bounded_file(str(allowed / ".." / "outside.json"), (allowed.resolve(),))
    with pytest.raises(ValueError, match="无效字符"):
        helper.bounded_file("bad\nname", (allowed.resolve(),))


def test_production_requires_all_resources_and_never_defaults_to_demo():
    base = ["run", "--runtime-root", "/runtime", "--managed-python", "/python"]
    with pytest.raises(SystemExit):
        helper.parse_args(base)
    assert helper.parse_args([*base, "--demo"]).demo is True
    with pytest.raises(SystemExit):
        helper.parse_args(["install", "--runtime-root", "/runtime", "--managed-python", "/python", "--demo"])


def test_unit_escapes_paths_and_never_embeds_connection_contents(tmp_path, monkeypatch):
    project = tmp_path / 'project %n $VALUE'
    (project / "deploy").mkdir(parents=True)
    (project / "deploy/mona-interaction.service").write_text(
        helper.MARKER + "[Service]\nExecStart=@PYTHON_EXECUTABLE@ -m mona_interaction serve --host 127.0.0.1 --port 17880\n",
        encoding="utf-8",
    )
    connection = tmp_path / "connection.json"
    secret = "private-connection-secret"
    connection.write_text(json.dumps({"token": secret}), encoding="utf-8")
    rendered = helper.service_text(project, tmp_path / "runtime", tmp_path / "python", ["--connection-file", str(connection)])
    assert 'ExecStart=:"/bin/bash"' in rendered
    assert "%%n" in rendered and "$VALUE" in rendered
    assert secret not in rendered
    assert helper.systemd_quote('a\\b"c%n$d') == '"a\\\\b\\"c%%n$d"'
    with pytest.raises(ValueError):
        helper.systemd_quote("line\nbreak")
    monkeypatch.setattr(helper.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    destination = helper.install_service(project, rendered)
    assert destination.read_text(encoding="utf-8") == rendered
    destination.write_text("[Service]\nExecStart=/unrelated\n", encoding="utf-8")
    with pytest.raises(ValueError, match="已保留"):
        helper.install_service(project, rendered)
    assert destination.read_text(encoding="utf-8") == "[Service]\nExecStart=/unrelated\n"


def test_service_arguments_are_accepted_by_the_managed_launcher(tmp_path):
    project = tmp_path / "project"
    (project / "deploy").mkdir(parents=True)
    (project / "deploy/mona-interaction.service").write_text(
        helper.MARKER + "[Service]\nExecStart=@PYTHON_EXECUTABLE@ -m mona_interaction serve --host 127.0.0.1 --port 17880\n",
        encoding="utf-8",
    )
    arguments = ["--port", "17880"]
    for name in helper.RESOURCE_OPTIONS:
        arguments.extend(("--" + name.replace("_", "-"), str(tmp_path / f"{name}.json")))
    unit = helper.service_text(project, tmp_path / "runtime", tmp_path / "python", arguments)
    command = next(line for line in unit.splitlines() if line.startswith("ExecStart=:"))
    argv = shlex.split(command[len("ExecStart=:"):])
    assert argv[:3] == ["/bin/bash", str(project / "scripts/ubuntu-managed-launcher.sh"), "run"]
    parsed = helper.parse_args(["run", "--runtime-root", argv[3], "--managed-python", argv[4], *argv[5:]])
    assert parsed.port == 17880 and all(getattr(parsed, key) for key in helper.RESOURCE_OPTIONS)
