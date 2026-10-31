"""The workbench and other callers share session-creation rules."""

import pytest

from mona.config.schema import Config, DevelopmentConfig, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId, PermissionMode
from mona.development.runtime import DevelopmentRuntime
from mona.development.session_creation import create_session
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.session.manager import SessionManager


@pytest.fixture
def workbench(tmp_path, monkeypatch):
    _resolve_tool_config_refs()
    root = tmp_path / "项目"
    root.mkdir()
    config = Config(development=DevelopmentConfig(enabled_engines=["codex"]))
    config.development.permissions.default_mode = "auto"
    store = DevelopmentStore(tmp_path / "development.sqlite3")
    runtime = DevelopmentRuntime(store, SessionManager(tmp_path / "sessions"), lambda: config)
    monkeypatch.setattr(runtime.native, "describe", lambda _project: [{
        "id": "codex",
        "models": [{"id": "native-model", "reasoningEfforts": ["low"]}],
    }])
    return runtime, store.open_project(root), config


def test_creation_reuses_existing_before_changed_configuration(workbench):
    runtime, project, config = workbench
    options = {
        "request_id": "request_one",
        "executor": ExecutorId.CODEX,
        "model": "native-model",
        "model_reasoning_effort": "low",
        "readonly": True,
    }
    created = create_session(runtime, project.id, **options)
    assert created.permission_mode == PermissionMode.AUTO and created.readonly

    config.development.enabled_engines = []
    config.development.permissions.default_mode = "ask"
    repeated = create_session(runtime, project.id, **options)
    assert repeated.id == created.id and repeated.permission_mode == PermissionMode.AUTO
    with pytest.raises(ConflictError) as error:
        create_session(runtime, project.id, **{**options, "title": "不同任务"})
    assert error.value.code == "creation_request_conflict"
    assert [item.id for item in runtime.store.list_sessions(project.id)] == [created.id]


@pytest.mark.parametrize(("options", "code"), [
    ({"executor": ExecutorId.MONA, "model_reasoning_effort": "high"}, "invalid_model_source"),
    ({"executor": ExecutorId.MONA, "model": "test", "model_provider": "missing"}, "model_source_unavailable"),
    ({"executor": ExecutorId.MONA, "model": "missing-preset"}, "model_preset_not_found"),
    ({"executor": ExecutorId.CODEX, "model_provider": "missing"}, "unsupported_model_route"),
    ({"executor": ExecutorId.CLAUDE}, "engine_disabled"),
    ({"executor": ExecutorId.CODEX, "model": "native-model", "model_reasoning_effort": "high"},
     "unsupported_reasoning_effort"),
])
def test_invalid_model_source_or_effort_creates_no_session(workbench, options, code):
    runtime, project, _config = workbench
    with pytest.raises(DevelopmentError) as error:
        create_session(runtime, project.id, **options)
    assert error.value.code == code
    assert runtime.store.list_sessions(project.id) == []


def test_side_session_inherits_parent_permission_and_stays_readonly(workbench):
    runtime, project, config = workbench
    parent = create_session(runtime, project.id)
    config.development.permissions.default_mode = "ask"
    child = create_session(runtime, project.id, parent_session_id=parent.id, readonly=True)
    assert child.permission_mode == parent.permission_mode == PermissionMode.AUTO
    assert child.readonly
