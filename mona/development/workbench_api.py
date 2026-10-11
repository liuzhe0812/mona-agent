"""Project-owned subagent configuration; independent of native connection setup."""
import asyncio
from typing import Literal

from aiohttp import web
from pydantic import Field

from mona.config.schema import DevelopmentSubagentConfig
from mona.development.contracts import Contract, Identifier, ReviewSource


class PresetsBody(Contract):
    revision: int = Field(ge=0)
    presets: list[DevelopmentSubagentConfig] = Field(max_length=34)


class PresetTaskBody(Contract):
    request_id: Identifier
    goal: str = Field(min_length=1, max_length=16000)
    expected_output: str = Field(default="", max_length=8000)
    expected_readonly: bool | None = None
    review_source: ReviewSource | None = None


class ContinueResultBody(Contract):
    confirmed: Literal[True]
    revision: int = Field(ge=0)


async def continue_result(request):
    from mona.development.api import get_runtime
    manager = get_runtime(request).collaboration
    parent_id, identifier = request.match_info["session_id"], request.match_info["collaboration_id"]
    if request.method == "GET":
        return web.json_response(manager.inspect_result(parent_id, identifier))
    body = ContinueResultBody.model_validate(await request.json())
    return web.json_response(await manager.continue_result(parent_id, identifier, body.revision))


async def presets(request):
    from mona.development.api import get_runtime
    runtime = get_runtime(request)
    project_id = request.match_info["project_id"]
    if request.method == "PUT":
        body = PresetsBody.model_validate(await request.json())
        project = runtime.store.save_subagents(project_id, body.revision, body.presets)
    else:
        project = runtime.store.get_project(project_id)
    return web.json_response({"revision": project.subagents_revision,
        "presets": [p.model_dump(mode="json", by_alias=True) for p in project.subagents]})


async def dispatch(request):
    from mona.development.api import get_runtime
    body = PresetTaskBody.model_validate(await request.json())
    result = await get_runtime(request).collaboration.start_preset(request.match_info["session_id"],
        body.request_id, request.match_info["preset_id"], body.goal, body.expected_output,
        expected_readonly=body.expected_readonly, review_source=body.review_source)
    return web.json_response(result)


async def collaboration_request(request):
    from mona.development.api import get_runtime
    runtime = get_runtime(request)
    record = runtime.store.find_collaboration_request(request.match_info["session_id"],
                                                      request.match_info["request_id"])
    # Observation must remain available after a preset/model is removed or changed.
    return web.json_response(runtime.collaboration.describe(record) if record else None)


async def review_diff(request):
    from mona.development.api import get_runtime
    from mona.development.review import read_review_diff
    project = get_runtime(request).store.get_project(request.match_info["project_id"])
    return web.json_response(await read_review_diff(project, request.query.get("path", "")))


async def review_source(request):
    from mona.development.api import get_runtime
    return web.json_response(await get_runtime(request).collaboration.check_review_source(
        request.match_info["session_id"], request.match_info["collaboration_id"]))


async def project_media(request):
    from mona.development.api import get_runtime
    from mona.development.workspace import read_project_media

    project = get_runtime(request).store.get_project(request.match_info["project_id"])
    raw, content_type = await asyncio.to_thread(
        read_project_media, project, request.query.get("path", ""))
    return web.Response(body=raw, content_type=content_type, headers={
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
    })


def register_workbench_routes(app):
    from mona.development.browser import browser_binding_api
    from mona.development.git_api import register_git_routes
    from mona.development.project_api import register_project_routes
    register_project_routes(app)
    register_git_routes(app)
    prefix = "/api/development"
    app.router.add_get(prefix + "/projects/{project_id}/media", project_media)
    app.router.add_get(prefix + "/projects/{project_id}/review-diff", review_diff)
    app.router.add_get(prefix + "/sessions/{session_id}/collaborations/{collaboration_id}/source", review_source)
    result_path = prefix + "/sessions/{session_id}/collaborations/{collaboration_id}/follow-up"
    app.router.add_get(result_path, continue_result)
    app.router.add_post(result_path, continue_result)
    app.router.add_get(prefix + "/sessions/{session_id}/collaboration-requests/{request_id}", collaboration_request)
    app.router.add_put(prefix + "/sessions/{session_id}/browser", browser_binding_api)
    app.router.add_get(prefix + "/projects/{project_id}/subagents", presets)
    app.router.add_put(prefix + "/projects/{project_id}/subagents", presets)
    app.router.add_post(prefix + "/sessions/{session_id}/subagents/{preset_id}/run", dispatch)
