import json
from pathlib import Path

import pytest

from mona.config.schema import DevelopmentConfig
from mona.development.context import CODING_SYSTEM, build_coding_messages, load_project_context
from mona.development.contracts import DevelopmentSession, Project
from mona.development.store import DevelopmentError
from mona.session.manager import Session


def make_project(root):
    root.mkdir(parents=True, exist_ok=True)
    return Project(root_path=str(root.resolve()), display_name="示例项目")


def skill(root, name="lint", *, extra="", body="SKILL_BODY_ONLY_READ_ON_DEMAND"):
    path = root / ".agents" / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: project skill description\n{extra}---\n{body}\n", encoding="utf-8")
    return path


def test_only_project_rule_and_skill_index_are_loaded(tmp_path, monkeypatch):
    root = tmp_path / "project"
    project = make_project(root)
    (root / "AGENTS.md").write_text("PROJECT_RULE_MARKER", encoding="utf-8")
    for name in ("SOUL.md", "USER.md", "MEMORY.md", "CLAUDE.md", "CODEBUDDY.md", ".mcp.json"):
        (root / name).write_text("FORBIDDEN_AMBIENT_BODY", encoding="utf-8")
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    (fake_home / "AGENTS.md").write_text("FORBIDDEN_HOME_RULE")
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    skill(root)
    from mona.agent.memory import MemoryStore
    from mona.agent.skills import SkillsLoader
    def reject(*args, **kwargs):
        raise AssertionError("general assistant resources must not be constructed")
    monkeypatch.setattr(MemoryStore, "__init__", reject)
    monkeypatch.setattr(SkillsLoader, "__init__", reject)
    ctx = load_project_context(project)
    text = ctx.model_context()
    assert "PROJECT_RULE_MARKER" in text
    assert "project skill description" in text
    assert "SKILL_BODY_ONLY_READ_ON_DEMAND" not in text
    assert "FORBIDDEN_AMBIENT_BODY" not in text
    assert "FORBIDDEN_HOME_RULE" not in text
    assert ctx.skills[0].path == ".agents/skills/lint/SKILL.md"
    assert any("未自动合并" in issue for issue in ctx.issues)


@pytest.mark.parametrize("extra", ["hooks: {}\n", "mcpServers: {}\n", "plugins: []\n", "metadata:\n  hooks: []\n", "metadata:\n  mcp_servers: {}\n"])
def test_runtime_skill_metadata_is_not_enabled(tmp_path, extra):
    project = make_project(tmp_path / "project")
    skill(Path(project.root_path), extra=extra)
    ctx = load_project_context(project)
    assert not ctx.skills
    assert "不在共享范围" in ctx.issues[0]


def test_malformed_and_unsafe_yaml_are_diagnostic_not_executed(tmp_path):
    project = make_project(tmp_path / "project")
    path = skill(Path(project.root_path))
    path.write_text("---\n!!python/object/apply:os.system ['echo should-not-run']\n---\n", encoding="utf-8")
    ctx = load_project_context(project)
    assert not ctx.skills and ctx.issues
    path.write_text("just markdown", encoding="utf-8")
    assert "缺少" in load_project_context(project).issues[0]


def test_duplicate_skill_name_does_not_silently_shadow(tmp_path):
    project = make_project(tmp_path / "project")
    a = skill(Path(project.root_path), "first")
    b = skill(Path(project.root_path), "second")
    b.write_bytes(a.read_bytes())
    with pytest.raises(DevelopmentError) as info:
        load_project_context(project)
    assert info.value.code == "duplicate_skill"


def test_fingerprint_tracks_rules_and_skill_body_independently(tmp_path):
    project = make_project(tmp_path / "project")
    root = Path(project.root_path)
    rule = root / "AGENTS.md"
    rule.write_text("rule one")
    path = skill(root)
    a = load_project_context(project)
    path.write_text(path.read_text() + "changed body")
    b = load_project_context(project)
    assert a.rules_fingerprint == b.rules_fingerprint
    assert a.skills_fingerprint != b.skills_fingerprint
    rule.write_text("rule two")
    c = load_project_context(project)
    assert b.rules_fingerprint != c.rules_fingerprint
    assert b.skills_fingerprint == c.skills_fingerprint
    assert a.rules[0].content == "rule one"


def test_resource_limits_do_not_silently_truncate(tmp_path):
    project = make_project(tmp_path / "project")
    root = Path(project.root_path)
    (root / "AGENTS.md").write_text("x" * 1025)
    with pytest.raises(DevelopmentError) as info:
        load_project_context(project, DevelopmentConfig(max_rule_bytes=1024))
    assert info.value.code == "resource_too_large"
    (root / "AGENTS.md").unlink()
    skill(root, "one")
    skill(root, "two")
    with pytest.raises(DevelopmentError) as info:
        load_project_context(project, DevelopmentConfig(max_project_skills=1))
    assert info.value.code == "too_many_skills"


def test_symlink_escape_is_rejected(tmp_path):
    project = make_project(tmp_path / "project")
    outside = tmp_path / "outside.md"
    outside.write_text("PRIVATE_DATA")
    link = Path(project.root_path) / "AGENTS.md"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Windows account does not permit symlink creation")
    with pytest.raises(DevelopmentError) as info:
        load_project_context(project)
    assert info.value.code == "resource_outside_project"


def test_history_is_session_scoped_and_not_mutated(tmp_path):
    project = make_project(tmp_path / "project")
    session = DevelopmentSession(project_id=project.id)
    history = Session(key=session.transcript_key)
    history.add_message("system", "IMPORTED_GLOBAL_SYSTEM")
    history.metadata["memory"] = "PRIVATE_MEMORY_MARKER"
    history.add_message("user", "fix this")
    history.add_message("assistant", "answer")
    before = json.dumps(history.messages)
    ctx = load_project_context(project)
    messages = build_coding_messages(ctx, session, history)
    assert messages[0]["content"] == CODING_SYSTEM
    assert "PRIVATE_MEMORY_MARKER" not in json.dumps(messages)
    assert "IMPORTED_GLOBAL_SYSTEM" not in json.dumps(messages)
    messages[-1]["content"] = "changed copy"
    assert json.dumps(history.messages) == before
    wrong = Session(key="websocket:normal")
    with pytest.raises(DevelopmentError):
        build_coding_messages(ctx, session, wrong)
    other = make_project(tmp_path / "other")
    with pytest.raises(DevelopmentError):
        build_coding_messages(load_project_context(other), session, history)


def test_summary_cursor_only_applies_with_explicit_summary(tmp_path):
    project = make_project(tmp_path / "project")
    session = DevelopmentSession(project_id=project.id)
    history = Session(key=session.transcript_key)
    history.add_message("user", "old goal")
    history.add_message("assistant", "old answer")
    history.add_message("user", "continue")
    history.last_consolidated = 2
    ctx = load_project_context(project)
    assert "old goal" in json.dumps(build_coding_messages(ctx, session, history))
    summarized = build_coding_messages(ctx, session, history, summary="known work")
    assert "old goal" not in json.dumps(summarized)
    assert "known work" in json.dumps(summarized)
    assert len(history.messages) == 3
    history.last_consolidated = 10
    with pytest.raises(DevelopmentError):
        build_coding_messages(ctx, session, history, summary="known work")
