from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest
from test_workbench_api import AUTH, setup_client
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.config.schema import (
    DevelopmentSubagentConfig,
    ProviderConfig,
    builtin_development_subagents,
)
from mona.development.contracts import ExecutorId, ReviewSource
from mona.development.executors.host_tools import SUBAGENT_INSTRUCTIONS
from mona.development.store import DevelopmentError, DevelopmentStore

BUILTIN_IDS = ("builtin_explorer", "builtin_worker")


def _by_id(project, preset_id: str) -> DevelopmentSubagentConfig:
    return next(preset for preset in project.subagents if preset.id == preset_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("preset_id", BUILTIN_IDS)
async def test_builtin_role_description_guides_parent_without_instructing_child_to_delegate(tmp_path, monkeypatch, preset_id):
    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    builtin = _by_id(runtime.store.get_project(project.id), preset_id)
    try:
        presets = runtime.collaboration.presets(parent.id)
        assert next(p for p in presets if p["id"] == preset_id)["description"] == builtin.description
        task = await runtime.collaboration.start_preset(parent.id, "builtin_role_request", preset_id, "Inspect the project")
        await wait_done(runtime, task["childSessionId"])
        request = model.requests[-1]
        assert SUBAGENT_INSTRUCTIONS in request["messages"][0]["content"]
        assert not any(builtin.instructions in message.get("content", "") for message in request["messages"]
                       if isinstance(message.get("content"), str))
        assert _by_id(runtime.store.get_project(project.id), preset_id).instructions == builtin.instructions
        repeated = await runtime.collaboration.start_preset(parent.id, "builtin_role_request", preset_id, "Inspect the project")
        assert repeated["id"] == task["id"] and len(runtime.store.list_runs(task["childSessionId"])) == 1

        custom = DevelopmentSubagentConfig(id="custom_role", name="Reviewer", readonly=True,
                                          instructions="CUSTOM_CHILD_INSTRUCTION_SENTINEL")
        current = runtime.store.get_project(project.id)
        runtime.store.save_subagents(project.id, current.revision, [*current.subagents, custom])
        second = await runtime.collaboration.start_preset(parent.id, "custom_role_request", custom.id, "Inspect a file")
        await wait_done(runtime, second["childSessionId"])
        assert any(custom.instructions in message.get("content", "") for message in model.requests[-1]["messages"]
                   if isinstance(message.get("content"), str))
    finally:
        await runtime.close()


def _raw_project_payload(store: DevelopmentStore, project_id: str) -> str:
    with sqlite3.connect(store.path) as db:
        row = db.execute("SELECT payload FROM projects WHERE id=?", (project_id,)).fetchone()
    assert row is not None
    return row[0]


def _configure_provider(config, name: str, model: str, effort: str) -> None:
    config.providers.cindy[name] = ProviderConfig(
        display_name=name,
        api_key="synthetic-not-sent",
        api_base="http://127.0.0.1:9999/v1",
        discovered_models=[{
            "id": model,
            "type": "chat",
            "reasoning_efforts": [effort],
            "default_reasoning_effort": effort,
        }],
        enabled_models=[model],
    )


@pytest.mark.asyncio
async def test_new_and_legacy_project_reads_supply_builtins_without_rewriting(
    tmp_path, monkeypatch
):
    runtime, project, _parent, _root = make_runtime(tmp_path, monkeypatch, Model())
    try:
        defaults = builtin_development_subagents()
        templates = {preset.id: preset for preset in defaults}
        created = runtime.store.get_project(project.id)
        assert [preset.id for preset in created.subagents] == list(BUILTIN_IDS)
        assert [(preset.name, preset.readonly, preset.enabled, preset.inherit_model) for preset in created.subagents] == [
            ("explorer", True, True, True),
            ("worker", False, True, True),
        ]
        assert created.subagents == defaults

        legacy_custom = DevelopmentSubagentConfig(
            id="project_reviewer",
            name="项目审查员",
            instructions="检查当前项目代码。",
            readonly=True,
        )
        legacy_explorer = templates["builtin_explorer"].model_copy(update={
            "description": "旧版 explorer 描述",
            "instructions": "旧版 explorer 职责",
            "enabled": False,
            "inherit_model": False,
            "model": "legacy-explorer-model",
            "provider": "legacy-explorer-provider",
        })
        legacy_worker = templates["builtin_worker"].model_copy(update={
            "description": "旧版 worker 描述",
            "instructions": "旧版 worker 职责",
            "enabled": True,
            "inherit_model": False,
            "model": "legacy-worker-model",
            "provider": "legacy-worker-provider",
            "effort": "medium",
            "readonly": True,
        })
        legacy_payload = json.loads(_raw_project_payload(runtime.store, project.id))
        serialized_explorer = legacy_explorer.model_dump(mode="json")
        serialized_worker = legacy_worker.model_dump(mode="json")
        serialized_custom = legacy_custom.model_dump(mode="json")
        serialized_custom.pop("inherit_model", None)
        legacy_payload["subagents"] = [serialized_explorer, serialized_worker, serialized_custom]
        legacy_payload["subagents_revision"] = 4
        with sqlite3.connect(runtime.store.path) as db:
            db.execute(
                "UPDATE projects SET payload=? WHERE id=?",
                (json.dumps(legacy_payload, ensure_ascii=False), project.id),
            )

        before_read = _raw_project_payload(runtime.store, project.id)
        restored = DevelopmentStore(runtime.store.path).get_project(project.id)
        assert [preset.id for preset in restored.subagents] == [*BUILTIN_IDS, "project_reviewer"]
        assert [(preset.description, preset.instructions) for preset in restored.subagents[:2]] == [
            (templates[preset_id].description, templates[preset_id].instructions)
            for preset_id in BUILTIN_IDS
        ]
        assert (
            restored.subagents[0].enabled,
            restored.subagents[0].inherit_model,
            restored.subagents[0].model,
            restored.subagents[0].provider,
        ) == (False, False, "legacy-explorer-model", "legacy-explorer-provider")
        assert (
            restored.subagents[1].enabled,
            restored.subagents[1].inherit_model,
            restored.subagents[1].model,
            restored.subagents[1].provider,
            restored.subagents[1].effort,
            restored.subagents[1].readonly,
        ) == (True, False, "legacy-worker-model", "legacy-worker-provider", "medium", True)
        assert restored.subagents[-1].inherit_model is False
        assert restored.subagents[-1].instructions == legacy_custom.instructions
        assert restored.subagents_revision == 4
        assert _raw_project_payload(runtime.store, project.id) == before_read
        assert not runtime.tasks and not runtime.native.hosts
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_builtin_settings_round_trip_omission_custom_deletion_and_capacity(
    tmp_path, monkeypatch
):
    runtime, project, parent, _root = make_runtime(tmp_path, monkeypatch, Model())
    try:
        current = runtime.store.get_project(project.id)
        canonical_worker = next(
            preset for preset in builtin_development_subagents() if preset.id == "builtin_worker"
        )
        explorer = _by_id(current, "builtin_explorer").model_copy(update={"enabled": False})
        worker_template = _by_id(current, "builtin_worker")
        worker = worker_template.model_copy(update={
            "model": "worker-model",
            "provider": "custom-worker-provider",
        })
        for field in ("description", "instructions"):
            changed_builtin = worker_template.model_copy(update={field: "试图覆盖内置职责"})
            with pytest.raises(DevelopmentError) as error:
                runtime.store.save_subagents(project.id, 0, [explorer, changed_builtin])
            assert error.value.code == "builtin_subagent_readonly"
            assert runtime.store.get_project(project.id).subagents_revision == 0
        custom = DevelopmentSubagentConfig(
            id="custom_reviewer",
            name="自定义审查员",
            instructions="读取文件并报告问题。",
        )
        saved = runtime.store.save_subagents(project.id, 0, [explorer, worker, custom])
        restored = DevelopmentStore(runtime.store.path).get_project(project.id)
        assert restored.subagents_revision == saved.subagents_revision == 1
        assert _by_id(restored, "builtin_explorer").enabled is False
        assert (
            _by_id(restored, "builtin_worker").model,
            _by_id(restored, "builtin_worker").provider,
            _by_id(restored, "builtin_worker").instructions,
            _by_id(restored, "builtin_worker").inherit_model,
        ) == (
            "worker-model",
            "custom-worker-provider",
            canonical_worker.instructions,
            True,
        )

        # 提交面省略内置项时，服务端保留项目中已有的内置设置。
        edited_custom = custom.model_copy(update={
            "description": "更新自定义职责",
            "instructions": "保留并更新自定义职责内容。",
        })
        omitted = runtime.store.save_subagents(project.id, 1, [edited_custom])
        assert [preset.id for preset in omitted.subagents] == [*BUILTIN_IDS, "custom_reviewer"]
        assert _by_id(omitted, "builtin_explorer").enabled is False
        assert _by_id(omitted, "builtin_worker").model == "worker-model"
        assert (
            _by_id(omitted, "custom_reviewer").description,
            _by_id(omitted, "custom_reviewer").instructions,
        ) == (edited_custom.description, edited_custom.instructions)

        # 空的自定义列表删除自定义项，但不删除两个内置项。
        without_custom = runtime.store.save_subagents(project.id, 2, [])
        assert [preset.id for preset in without_custom.subagents] == list(BUILTIN_IDS)
        closed = runtime.store.save_subagents(project.id, 3, [
            preset.model_copy(update={"enabled": False}) for preset in without_custom.subagents
        ])
        assert closed.subagents_revision == 4
        assert all(not preset.enabled for preset in closed.subagents)
        disabled_context = runtime.collaboration.scheduling_context(parent.id)
        disabled_payload = json.loads(disabled_context.splitlines()[1])
        assert disabled_payload == {
            "developmentSubagents": [],
            "developmentDelegationEnabled": False,
        }

        visible_custom = DevelopmentSubagentConfig(
            id="custom_visible",
            name="自定义调查员",
            instructions="调查指定模块。",
        )
        visible = runtime.store.save_subagents(project.id, 4, [visible_custom])
        visible_payload = json.loads(runtime.collaboration.scheduling_context(parent.id).splitlines()[1])
        assert visible.subagents_revision == 5
        assert visible_payload["developmentDelegationEnabled"] is True
        assert [item["id"] for item in visible_payload["developmentSubagents"]] == ["custom_visible"]

        custom32 = [
            DevelopmentSubagentConfig(
                id=f"custom_worker_{index:02d}",
                name=f"自定义任务 {index}",
                instructions="完成指定项目任务。",
            )
            for index in range(32)
        ]
        at_capacity = runtime.store.save_subagents(project.id, 5, custom32)
        assert len(at_capacity.subagents) == 34
        assert {preset.id for preset in at_capacity.subagents if preset.id not in BUILTIN_IDS} == {
            preset.id for preset in custom32
        }

        with pytest.raises(DevelopmentError):
            runtime.store.save_subagents(project.id, 6, [*custom32, DevelopmentSubagentConfig(
                id="custom_worker_extra",
                name="额外任务",
                instructions="不应挤掉已有任务。",
            )])
        after_rejection = runtime.store.get_project(project.id)
        assert after_rejection.subagents_revision == 6
        assert {preset.id for preset in after_rejection.subagents if preset.id not in BUILTIN_IDS} == {
            preset.id for preset in custom32
        }
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_subagent_api_keeps_builtin_names_and_rejects_disabled_dispatch(
    tmp_path, monkeypatch
):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    url = f"/api/development/projects/{project.id}/subagents"
    try:
        response = await client.get(url, headers=AUTH)
        assert response.status == 200
        payload = await response.json()
        explorer, worker = payload["presets"]
        assert (explorer["id"], explorer["name"], explorer["readonly"], explorer["inheritModel"]) == (
            "builtin_explorer", "explorer", True, True
        )
        assert (worker["id"], worker["name"], worker["readonly"], worker["inheritModel"]) == (
            "builtin_worker", "worker", False, True
        )

        renamed = {**explorer, "name": "researcher"}
        rejected_rename = await client.put(
            url,
            headers=AUTH,
            json={"revision": payload["revision"], "presets": [renamed, worker]},
        )
        assert rejected_rename.status in {400, 422}
        unchanged = await (await client.get(url, headers=AUTH)).json()
        assert unchanged["revision"] == payload["revision"]
        assert [preset["name"] for preset in unchanged["presets"]] == ["explorer", "worker"]

        disabled_explorer = {**explorer, "enabled": False}
        disabled_response = await client.put(
            url,
            headers=AUTH,
            json={"revision": unchanged["revision"], "presets": [disabled_explorer]},
        )
        assert disabled_response.status == 200
        saved = await disabled_response.json()
        assert [preset["id"] for preset in saved["presets"]] == list(BUILTIN_IDS)
        assert saved["presets"][0]["enabled"] is False
        assert saved["presets"][1]["enabled"] is True

        parent = runtime.store.create_session(project.id)
        sessions_before = runtime.store.list_sessions(project.id)
        response = await client.post(
            f"/api/development/sessions/{parent.id}/subagents/builtin_explorer/run",
            headers=AUTH,
            json={"requestId": "disabled_builtin", "goal": "不应创建子任务"},
        )
        assert response.status == 422
        assert (await response.json())["error"]["code"] == "subagent_unavailable"
        assert runtime.store.list_sessions(project.id) == sessions_before
        assert runtime.store.list_runs(parent.id) == []
        assert runtime.store.list_collaborations(parent.id) == []
        assert not runtime.tasks and not runtime.native.hosts
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_collaboration_routes_builtin_from_parent_and_keeps_custom_override(
    tmp_path, monkeypatch
):
    model = Model()
    runtime, project, _session, _root = make_runtime(tmp_path, monkeypatch, model)
    config = runtime.config_loader()
    _configure_provider(config, "custom-parent", "parent-model", "high")
    _configure_provider(config, "custom-worker", "worker-model", "low")
    _configure_provider(config, "custom-reviewer", "custom-model", "medium")
    parent = runtime.store.create_session(
        project.id,
        ExecutorId.MONA,
        model="parent-model",
        model_provider="custom-parent",
        model_reasoning_effort="high",
    )
    try:
        configured = runtime.store.get_project(project.id)
        explorer = _by_id(configured, "builtin_explorer")
        worker = _by_id(configured, "builtin_worker").model_copy(update={
            "inherit_model": False,
            "model": "worker-model",
            "provider": "custom-worker",
            "effort": "low",
        })
        custom = DevelopmentSubagentConfig(
            id="custom_reviewer",
            name="自定义审查员",
            instructions="使用项目自定义模型路由。",
            executor="mona",
            model="custom-model",
            provider="custom-reviewer",
            effort="medium",
            readonly=True,
        )
        runtime.store.save_subagents(project.id, 0, [explorer, worker, custom])

        explorer_result = await runtime.collaboration.start_preset(
            parent.id, "builtin_explorer_inherited", explorer.id, "检查文件"
        )
        inherited_child = runtime.store.get_session(explorer_result["childSessionId"])
        assert (
            inherited_child.executor,
            inherited_child.model,
            inherited_child.model_provider,
            inherited_child.model_reasoning_effort,
            inherited_child.readonly,
        ) == (ExecutorId.MONA, "parent-model", "custom-parent", "high", True)
        await wait_done(runtime, inherited_child.id)

        worker_result = await runtime.collaboration.start_preset(
            parent.id, "builtin_worker_override", worker.id, "实现小范围改动"
        )
        worker_child = runtime.store.get_session(worker_result["childSessionId"])
        assert (
            worker_child.executor,
            worker_child.model,
            worker_child.model_provider,
            worker_child.model_reasoning_effort,
            worker_child.readonly,
        ) == (ExecutorId.MONA, "worker-model", "custom-worker", "low", False)
        await wait_done(runtime, worker_child.id)

        custom_result = await runtime.collaboration.start_preset(
            parent.id, "custom_route_preserved", custom.id, "按自定义路由审查"
        )
        custom_child = runtime.store.get_session(custom_result["childSessionId"])
        assert (
            custom_child.executor,
            custom_child.model,
            custom_child.model_provider,
            custom_child.model_reasoning_effort,
            custom_child.readonly,
        ) == (ExecutorId.MONA, "custom-model", "custom-reviewer", "medium", True)
        await wait_done(runtime, custom_child.id)
        assert not runtime.native.hosts
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_start_preset_rechecks_builtin_after_readonly_preparation_wait(
    tmp_path, monkeypatch
):
    runtime, project, parent, _root = make_runtime(tmp_path, monkeypatch, Model())
    entered_read = asyncio.Event()
    release_read = asyncio.Event()
    source = ReviewSource(path="source.py", version="a" * 64)

    async def paused_read_review_diff(*_args, **_kwargs):
        entered_read.set()
        await release_read.wait()
        return {"source": source.model_dump(mode="json"), "sha256": "b" * 64, "diff": "+answer = 2\n"}

    monkeypatch.setattr(
        "mona.development.collaboration.read_review_diff", paused_read_review_diff
    )
    sessions_before = runtime.store.list_sessions(project.id)
    dispatch = asyncio.create_task(runtime.collaboration.start_preset(
        parent.id,
        "disabled_during_prepare",
        "builtin_explorer",
        "检查项目",
        review_source=source,
    ))
    try:
        await asyncio.wait_for(entered_read.wait(), timeout=1)
        current = runtime.store.get_project(project.id)
        explorer = _by_id(current, "builtin_explorer")
        worker = _by_id(current, "builtin_worker")
        runtime.store.save_subagents(
            project.id,
            current.subagents_revision,
            [explorer.model_copy(update={"enabled": False}), worker],
        )
        release_read.set()

        with pytest.raises(DevelopmentError) as error:
            await dispatch
        assert error.value.code == "subagent_unavailable"
        assert runtime.store.list_sessions(project.id) == sessions_before
        assert runtime.store.list_runs(parent.id) == []
        assert runtime.store.list_collaborations(parent.id) == []
        assert not runtime.tasks and not runtime.native.hosts
    finally:
        release_read.set()
        if not dispatch.done():
            dispatch.cancel()
            await asyncio.gather(dispatch, return_exceptions=True)
        await runtime.close()
