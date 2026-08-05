"""3D project HTTP API routes.

Registers /api/three/* endpoints for project CRUD and file access.
Uses ThreeAdapter for underlying project operations.
"""

from __future__ import annotations

from pathlib import Path

from aiohttp import web
from loguru import logger

from mona.api.three_adapter import StaleCandidateError, ThreeAdapter


def _json_response(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _adapter(workspace: Path | None = None) -> ThreeAdapter:
    return ThreeAdapter(workspace=workspace)


async def handle_three_projects(request: web.Request) -> web.Response:
    """GET /api/three/projects — list all 3D projects."""
    try:
        adapter = _adapter(request.app.get("workspace"))
        projects = adapter.list_projects()
        return _json_response({"projects": projects})
    except Exception as e:
        logger.exception("three projects list error")
        return _error(str(e), 500)


async def handle_three_project_create(request: web.Request) -> web.Response:
    """POST /api/three/project — create a new 3D project."""
    try:
        body = await request.json()
    except Exception:
        return _error("Invalid JSON body")
    name = str(body.get("name", "") or "").strip()
    if not name:
        return _error("name is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        adapter.create_project(name)
        return _json_response({"ok": True, "name": name})
    except ValueError as e:
        return _error(str(e), 400)
    except FileExistsError as e:
        return _error(str(e), 409)
    except Exception as e:
        logger.exception("three project create error")
        return _error(str(e), 500)


async def handle_three_project(request: web.Request) -> web.Response:
    """GET /api/three/project?name= — aggregate project state."""
    name = request.query.get("name") or ""
    if not name:
        return _error("name is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        return _json_response(adapter.get_project_state(name))
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three project get error")
        return _error(str(e), 500)


async def handle_three_project_file(request: web.Request) -> web.Response:
    """GET /api/three/project/file?name=&path= — read whitelisted artifacts."""
    name = request.query.get("name") or ""
    path = request.query.get("path") or ""
    if not name or not path:
        return _error("name and path are required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        content, content_type = adapter.read_project_file(name, path)
        mime, _, charset = content_type.partition(";")
        kwargs: dict = {"content_type": mime.strip()}
        if charset:
            kwargs["charset"] = charset.split("=", 1)[-1].strip()
        return web.Response(body=content, **kwargs)
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError as e:
        return _error(str(e), 404)
    except Exception as e:
        logger.exception("three project file error")
        return _error(str(e), 500)


async def handle_three_project_delete(request: web.Request) -> web.Response:
    """DELETE /api/three/project?name= — delete a project."""
    name = request.query.get("name") or ""
    if not name:
        return _error("name is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        adapter.delete_project(name)
        return _json_response({"ok": True})
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three project delete error")
        return _error(str(e), 500)


_ACTIONS = frozenset({"save-render"})


async def handle_three_project_action(request: web.Request) -> web.Response:
    """POST /api/three/project/action — controlled project actions.

    Only fixed action enums are accepted; the server never executes
    client-provided commands or arbitrary paths.
    """
    try:
        body = await request.json()
    except Exception:
        return _error("Invalid JSON body")
    name = str(body.get("name", "") or "").strip()
    action = str(body.get("action", "") or "").strip()
    if not name:
        return _error("name is required")
    if action not in _ACTIONS:
        return _error(f"unknown action: {action}")
    try:
        adapter = _adapter(request.app.get("workspace"))
        if action == "save-render":
            path = adapter.save_render(name, str(body.get("dataUrl", "") or ""))
            return _json_response({"ok": True, "path": str(path)})
        return _error(f"unknown action: {action}")  # unreachable guard
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three project action error")
        return _error(str(e), 500)


async def handle_three_project_candidate_diff(request: web.Request) -> web.Response:
    """GET /api/three/project/candidate/diff?name= — field-level candidate diff."""
    name = request.query.get("name") or ""
    if not name:
        return _error("name is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        return _json_response(adapter.candidate_diff(name))
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three candidate diff error")
        return _error(str(e), 500)


async def handle_three_project_candidate_apply(request: web.Request) -> web.Response:
    """POST /api/three/project/candidate/apply — atomic apply with baseline check."""
    try:
        body = await request.json()
    except Exception:
        return _error("Invalid JSON body")
    name = str(body.get("name", "") or "").strip()
    if not name:
        return _error("name is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        adapter.apply_candidate_spec(name)
        return _json_response({"ok": True})
    except StaleCandidateError as e:
        return _error(str(e), 409)
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three candidate apply error")
        return _error(str(e), 500)


async def handle_three_project_candidate_discard(request: web.Request) -> web.Response:
    """POST /api/three/project/candidate/discard — drop the candidate spec."""
    try:
        body = await request.json()
    except Exception:
        return _error("Invalid JSON body")
    name = str(body.get("name", "") or "").strip()
    if not name:
        return _error("name is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        adapter.discard_candidate_spec(name)
        return _json_response({"ok": True})
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three candidate discard error")
        return _error(str(e), 500)


async def handle_three_project_save_chat_id(request: web.Request) -> web.Response:
    """POST /api/three/project/save-chat-id — persist chatId in project meta."""
    try:
        body = await request.json()
    except Exception:
        return _error("Invalid JSON body")
    name = str(body.get("name", "") or "").strip()
    chat_id = str(body.get("chatId", "") or "").strip()
    if not name or not chat_id:
        return _error("name and chatId are required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        adapter.save_chat_id(name, chat_id)
        return _json_response({"ok": True})
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three save-chat-id error")
        return _error(str(e), 500)


async def handle_three_project_upload_reference(request: web.Request) -> web.Response:
    """POST /api/three/project/reference — upload a reference image data URL.

    Body: ``{name, dataUrl, filename?}``. The image is decoded and written to
    ``three_projects/<name>/references/`` with a timestamped filename.
    """
    try:
        body = await request.json()
    except Exception:
        return _error("Invalid JSON body")
    name = str(body.get("name", "") or "").strip()
    data_url = str(body.get("dataUrl", "") or "")
    filename = body.get("filename")
    if filename is not None:
        filename = str(filename)
    if not name:
        return _error("name is required")
    if not data_url:
        return _error("dataUrl is required")
    try:
        adapter = _adapter(request.app.get("workspace"))
        path = adapter.save_reference(name, data_url, filename)
        return _json_response({
            "ok": True,
            "path": f"references/{path.name}",
            "name": path.name,
        })
    except ValueError as e:
        return _error(str(e), 400)
    except FileNotFoundError:
        return _error("project not found", 404)
    except Exception as e:
        logger.exception("three reference upload error")
        return _error(str(e), 500)


def create_three_projects_app(workspace: Path | None = None) -> web.Application:
    """Create a standalone aiohttp app for 3D project routes (for testing)."""
    app = web.Application()
    app["workspace"] = workspace
    app.router.add_get("/api/three/projects", handle_three_projects)
    app.router.add_post("/api/three/project", handle_three_project_create)
    app.router.add_get("/api/three/project", handle_three_project)
    app.router.add_delete("/api/three/project", handle_three_project_delete)
    app.router.add_post("/api/three/project/action", handle_three_project_action)
    app.router.add_get("/api/three/project/file", handle_three_project_file)
    app.router.add_get("/api/three/project/candidate/diff", handle_three_project_candidate_diff)
    app.router.add_post("/api/three/project/candidate/apply", handle_three_project_candidate_apply)
    app.router.add_post("/api/three/project/candidate/discard", handle_three_project_candidate_discard)
    app.router.add_post("/api/three/project/save-chat-id", handle_three_project_save_chat_id)
    app.router.add_post("/api/three/project/reference", handle_three_project_upload_reference)
    return app


def register_three_routes(app: web.Application, workspace: Path | None = None) -> None:
    """Register 3D project routes on an existing aiohttp app."""
    app["workspace"] = workspace
    app.router.add_get("/api/three/projects", handle_three_projects)
    app.router.add_post("/api/three/project", handle_three_project_create)
    app.router.add_get("/api/three/project", handle_three_project)
    app.router.add_delete("/api/three/project", handle_three_project_delete)
    app.router.add_post("/api/three/project/action", handle_three_project_action)
    app.router.add_get("/api/three/project/file", handle_three_project_file)
    app.router.add_get("/api/three/project/candidate/diff", handle_three_project_candidate_diff)
    app.router.add_post("/api/three/project/candidate/apply", handle_three_project_candidate_apply)
    app.router.add_post("/api/three/project/candidate/discard", handle_three_project_candidate_discard)
    app.router.add_post("/api/three/project/save-chat-id", handle_three_project_save_chat_id)
    app.router.add_post("/api/three/project/reference", handle_three_project_upload_reference)
