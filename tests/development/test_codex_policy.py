import copy
import sys
from pathlib import Path

import pytest

from mona.development.context import load_project_context
from mona.development.contracts import Project
from mona.development.executors.codex_policy import (
    disabled_skill_overrides,
    prepare_codex_profile,
    validate_effective_config,
)
from mona.development.executors.rpc import RpcError


def effective():
    return {"config": {
        "features": {"hooks": False, "memories": False, "apps": False, "plugins": False,
                     "remote_plugin": False, "goals": False},
        "notify": [], "mcp_servers": {}, "project_doc_max_bytes": 0,
        "project_doc_fallback_filenames": [], "project_root_markers": [], "allow_login_shell": False,
        "shell_environment_policy": {"inherit": "core", "ignore_default_excludes": False},
    }}


def test_launch_profile_excludes_environment_injection_and_keeps_project_untouched(tmp_path):
    project = tmp_path / "中文 项目"
    project.mkdir()
    (project / "AGENTS.md").write_text("keep", encoding="utf-8")
    original = {str(p.relative_to(project)): p.read_bytes() for p in project.rglob("*") if p.is_file()}
    env = {"PATH": "/native/bin", "PYTHONPATH": "/unexpected", "NODE_OPTIONS": "--require unexpected",
           "CODEX_HOME": "/user/home", "OPENAI_API_KEY": "test-marker-not-a-key", "MONA_TOKEN": "test-marker",
           "CLAUDE_CODE_OAUTH_TOKEN": "test-marker", "USERPROFILE": "/other", "HTTP_PROXY": "http://localhost:1234"}
    profile = prepare_codex_profile(Path(sys.executable), tmp_path / "managed", project, environment=env)
    assert profile.command[:2] == (str(Path(sys.executable).resolve()), "app-server")
    assert profile.environment["CODEX_HOME"] == str(tmp_path / "managed")
    assert profile.environment["HOME"] == profile.environment["USERPROFILE"]
    assert profile.environment["HTTP_PROXY"] == env["HTTP_PROXY"]
    assert not set(profile.environment) & {"PYTHONPATH", "NODE_OPTIONS", "OPENAI_API_KEY", "MONA_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"}
    assert "features.hooks=false" in profile.command
    assert "project_doc_max_bytes=0" in profile.command
    assert any("trust_level=\"untrusted\"" in arg for arg in profile.command)
    assert {str(p.relative_to(project)): p.read_bytes() for p in project.rglob("*") if p.is_file()} == original
    assert "test-marker" not in repr(profile)
    assert prepare_codex_profile(Path(sys.executable), profile.home, project, environment={}).home == profile.home


def test_never_adopts_user_codex_home_or_worktree_as_runtime_state(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    unrelated = tmp_path / "user-home"
    unrelated.mkdir()
    (unrelated / "config.toml").write_text("# user owned", encoding="utf-8")
    with pytest.raises(RpcError):
        prepare_codex_profile(Path(sys.executable), unrelated, project)
    with pytest.raises(RpcError):
        prepare_codex_profile(Path(sys.executable), project / "native", project)
    assert (unrelated / "config.toml").read_text() == "# user owned"


@pytest.mark.parametrize("key,value", [
    ("mcp_servers", {"unwanted": {"command": "never-run"}}),
    ("hooks", {"SessionStart": ["never-run"]}),
    ("plugins", {"unexpected": True}),
    ("notify", ["never-run"]),
    ("developer_instructions", "user marker"),
    ("model_instructions_file", "/user/instructions.md"),
    ("allow_login_shell", True),
    ("project_doc_max_bytes", 2048),
])
def test_effective_config_not_just_requested_flags(tmp_path, key, value):
    config = effective()
    validate_effective_config(config)
    config["config"][key] = value
    with pytest.raises(RpcError):
        validate_effective_config(config)


@pytest.mark.parametrize("feature", ["hooks", "memories", "apps", "plugins", "remote_plugin", "goals"])
def test_missing_feature_ack_is_not_claimed_safe(feature):
    config = effective()
    del config["config"]["features"][feature]
    with pytest.raises(RpcError) as error:
        validate_effective_config(config)
    assert error.value.code == "isolation_unverified"


def test_only_exact_project_skill_index_is_enabled(tmp_path):
    root = tmp_path / "project"
    skill = root / ".agents/skills/check/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: check\ndescription: Unit tests\n---\nRead on demand.", encoding="utf-8")
    context = load_project_context(Project(root_path=str(root), display_name="Project"))
    outsider = tmp_path / "user-skills/outside/SKILL.md"
    data = {"data": [{"cwd": str(root), "skills": [{"path": str(skill)}, {"path": str(outsider)}], "errors": []}]}
    before = copy.deepcopy(data)
    assert disabled_skill_overrides(data, context) == [{"path": str(outsider.parent), "enabled": False}]
    assert data == before
    for invalid in ({"data": []}, {"data": [{"cwd": "/wrong", "skills": [], "errors": []}]},
                    {"data": [{"cwd": str(root), "skills": [], "errors": ["incomplete"]}]}):
        with pytest.raises(RpcError):
            disabled_skill_overrides(invalid, context)
