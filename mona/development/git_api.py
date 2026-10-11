"""Git action confirmation is separate from model execution and chat drafts."""
from typing import Literal

from aiohttp import web
from pydantic import Field

from mona.development.contracts import Contract, Identifier


class PrepareGit(Contract):
    request_id: Identifier
    kind: Literal["stage", "commit", "push", "create_branch", "switch_branch", "commit_and_push", "commit_and_switch"]
    paths: list[str] = Field(default_factory=list, max_length=2000)
    message: str = Field(default="", max_length=4000)
    remote: str = Field(default="", max_length=128)
    branch: str = Field(default="", max_length=256)
    include_unstaged: bool = True
    context_token: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class GenerateGitMessage(Contract):
    include_unstaged: bool = True
    context_token: str = Field(pattern=r"^[a-f0-9]{64}$")


class ConfirmGit(Contract):
    confirmed: Literal[True]


def manager(request):
    from mona.development.api import get_runtime
    return get_runtime(request).git_operations


async def context(request):
    return web.json_response(await manager(request).context(request.match_info["session_id"],
        refresh=request.query.get("refresh") == "true"))


async def branches(request):
    return web.json_response(await manager(request).branches(request.match_info["session_id"]))


async def preview(request):
    return web.json_response(await manager(request).preview(request.match_info["session_id"], request.query.get("includeUnstaged", "true") != "false"))


async def generate_message(request):
    from mona.development.api import get_runtime
    from mona.development.git_generation import generate_commit_message
    body = GenerateGitMessage.model_validate(await request.json())
    return web.json_response(await generate_commit_message(get_runtime(request), request.match_info["session_id"], body.include_unstaged, body.context_token))


async def graph(request):
    from mona.development.store import DevelopmentError
    try:
        skip = int(request.query.get("skip", "0"))
        if not 0 <= skip <= 100000:
            raise ValueError()
    except ValueError as exc:
        raise DevelopmentError("invalid_page", "历史页码无效。") from exc
    return web.json_response(await manager(request).graph(request.match_info["session_id"], skip))


async def commit_detail(request):
    return web.json_response(await manager(request).commit_detail(request.match_info["session_id"], request.match_info["sha"], request.query.get("path")))


async def prepare(request):
    body = PrepareGit.model_validate(await request.json())
    result = await manager(request).prepare(request.match_info["session_id"], **body.model_dump())
    return web.json_response(result)


async def action(request):
    service = manager(request)
    session_id, operation_id = request.match_info["session_id"], request.match_info["operation_id"]
    if request.method == "GET":
        return web.json_response(service.get(session_id, operation_id))
    ConfirmGit.model_validate(await request.json())
    if request.match_info.get("action") == "acknowledge":
        return web.json_response(service.acknowledge(session_id, operation_id))
    result = await service.execute(session_id, operation_id)
    return web.json_response(result, status=202 if result["status"] == "running" else 200)


async def recent(request):
    return web.json_response(manager(request).recent(request.match_info["session_id"]))


def register_git_routes(app):
    prefix = "/api/development/sessions/{session_id}/git-actions"
    app.router.add_get(prefix, recent)
    app.router.add_get(prefix + "/context", context)
    app.router.add_get(prefix + "/branches", branches)
    app.router.add_get(prefix + "/preview", preview)
    app.router.add_get(prefix + "/graph", graph)
    app.router.add_get(prefix + "/commits/{sha}", commit_detail)
    app.router.add_post(prefix + "/generate-message", generate_message)
    app.router.add_post(prefix + "/prepare", prepare)
    app.router.add_get(prefix + "/{operation_id}", action)
    app.router.add_post(prefix + "/{operation_id}/{action:execute|acknowledge}", action)
