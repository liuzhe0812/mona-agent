"""Project-list metadata and explicit chat archiving; never deletes project files."""
from __future__ import annotations

import asyncio
import re
from urllib.parse import urlsplit

from aiohttp import web
from pydantic import Field

from mona.development.contracts import Contract, Identifier
from mona.development.store import DevelopmentError
from mona.development.workspace import _git, project_path


class ProjectUpdate(Contract):
    revision: int = Field(ge=0)
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None
    removed: bool | None = None


class ArchiveChats(Contract):
    revisions: dict[Identifier, int] = Field(min_length=1, max_length=2000)


class DeleteSession(Contract):
    revision: int = Field(ge=0)


def repository_label(raw: str) -> str | None:
    """Only a repository identity reaches the UI, never userinfo/query/fragment."""
    try:
        if "://" in raw:
            value = urlsplit(raw)
            if value.scheme not in {"https", "http", "ssh", "git"}:
                return None
            host, path = value.hostname, value.path
        else:
            if "::" in raw or re.match(r"^[A-Za-z]:[/\\]", raw):
                return None
            match = re.fullmatch(r"(?:[^/@:\s]+@)?([A-Za-z0-9.-]+):([^?#\s]+)(?:[?#].*)?", raw)
            if not match:
                return None
            host, path = match.groups()
        path = path.strip("/").removesuffix(".git")
        if not host or not path or len(path) > 512 or any(ord(c) < 32 for c in path):
            return None
        return path if host.lower() == "github.com" else f"{host}/{path}"
    except ValueError:
        return None


async def project_info(request):
    from mona.development.api import get_runtime
    store = get_runtime(request).store
    project = store.get_project(request.match_info["project_id"])
    result = {"repository": None, "repositoryState": "local", "reason": ""}
    try:
        root = project_path(project)
        code, _ = await _git(root, "rev-parse", "--show-toplevel", checking_repository=True)
        if code:
            return web.json_response(result)
        code, remotes = await _git(root, "remote")
        if code:
            raise DevelopmentError("git_read_failed", "仓库信息读取失败。")
        names = remotes.decode("utf-8", "replace").splitlines()
        if not names:
            return web.json_response(result)
        name = "origin" if "origin" in names else names[0]
        code, output = await _git(root, "remote", "get-url", "--", name)
        label = None if code else repository_label(output.decode("utf-8", "replace").strip())
        result.update(repository=label, repositoryState="ready" if label else "unavailable",
                      reason="" if label else "未能读取可展示的远程仓库信息。")
    except (DevelopmentError, OSError, asyncio.TimeoutError):
        result.update(repositoryState="unavailable", reason="仓库信息暂不可用，项目目录和聊天仍保留。")
    return web.json_response(result)


async def update_project(request):
    from mona.development.api import get_runtime
    body = ProjectUpdate.model_validate(await request.json())
    project = get_runtime(request).store.update_project(request.match_info["project_id"], body.revision,
        display_name=body.display_name, pinned=body.pinned, removed=body.removed)
    return web.json_response(project.model_dump(mode="json", by_alias=True))


async def archive_chats(request):
    from mona.development.api import get_runtime
    body = ArchiveChats.model_validate(await request.json())
    if any(revision < 0 for revision in body.revisions.values()):
        raise ValueError("Invalid session revision")
    rows = get_runtime(request).store.archive_project_sessions(request.match_info["project_id"], body.revisions)
    return web.json_response([row.model_dump(mode="json", by_alias=True) for row in rows])


async def delete_session(request):
    from mona.development.api import get_runtime
    from mona.development.deletion import delete_session as delete_task
    runtime = get_runtime(request)
    body = DeleteSession.model_validate(await request.json())
    return web.json_response(await delete_task(runtime, request.match_info["session_id"], body.revision))


def register_project_routes(app):
    prefix = "/api/development/projects/{project_id}"
    app.router.add_get(prefix + "/info", project_info)
    app.router.add_patch(prefix, update_project)
    app.router.add_post(prefix + "/archive-chats", archive_chats)
    app.router.add_delete("/api/development/sessions/{session_id}", delete_session)
