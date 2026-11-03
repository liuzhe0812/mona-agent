"""Renderer RPC for the unchanged canvas editor and tool protocol."""
from __future__ import annotations

import re
import time

from aiohttp import web

from mona.hosted_work.contracts import WorkError, identifier

_REQUEST = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


class EditorBridge:
    def __init__(self, desktop):
        self.desktop = desktop

    async def tool(self, request: web.Request):
        body = await request.json()
        if not isinstance(body, dict) or set(body) != {"run_id", "session_id", "command", "args"}:
            raise WorkError("invalid_request", "编辑请求格式无效。")
        owner = request["owner"]
        sid, rid = identifier(body["session_id"]), identifier(body["run_id"])
        self.desktop.state.session(owner, sid)
        run = self.desktop.service.store.run(owner, rid)
        if run["session_id"] != sid or run["status"] != "running":
            raise WorkError("execution_stopped", "本轮已经结束，未继续编辑。", 409)
        args, command = body["args"], body["command"]
        if not isinstance(args, dict) or command not in {"canvas_activate_sidebar", "canvas_agent_request"}:
            raise WorkError("invalid_request", "此编辑命令不可用。")
        canvas_id = args.get("canvasId")
        path = args.get("path") or (f"/workspace/canvases/{canvas_id}.mona-canvas" if canvas_id else None)
        saved = self.desktop.files.invoke(owner, "workspace_canvas_read", {"workspaceRoot": "/workspace", "path": path})
        if saved["canvas"]["id"] != canvas_id:
            raise WorkError("not_found", "未找到此画布。", 404)
        if command == "canvas_activate_sidebar":
            await self.desktop.wire.emit_to_chat(owner, sid, {
                "event": "hosted_platform_event", "name": "canvas-agent-activate-sidebar",
                "payload": {"canvasId": canvas_id, "path": saved["path"], "chatId": sid}})
            return web.json_response({"result": {"ok": True}})
        request_id = args.get("requestId")
        if not isinstance(request_id, str) or not _REQUEST.fullmatch(request_id):
            raise WorkError("invalid_request", "编辑请求标识无效。")
        if args.get("action") not in {"open", "inspect", "apply", "export"}:
            raise WorkError("invalid_request", "画布操作无效。")
        timeout = args.get("timeoutMs", 25000)
        if type(timeout) is not int or not 1 <= timeout <= 25000:
            raise WorkError("invalid_request", "编辑等待时限无效。")
        payload = {key: args[key] for key in ("requestId", "canvasId", "action", "patch", "includeVisual", "format") if key in args}
        payload["deadlineMs"] = int(time.time() * 1000) + timeout
        try:
            result = await self.desktop.wire.request_platform(owner, sid, {
                "event": "hosted_platform_event", "name": "canvas-agent-request",
                "request_id": request_id, "payload": payload}, timeout=timeout / 1000)
        except TimeoutError:
            await self.desktop.wire.emit_to_chat(owner, sid, {"event": "hosted_platform_event", "name": "canvas-agent-cancel",
                                                           "payload": {"requestId": request_id}})
            result = {"ok": False, "status": "outcome_unknown" if args["action"] == "apply" else "unavailable",
                      "requestId": request_id, "message": "编辑结果尚未确认，请先读取当前文档核对，不要重复修改。"}
        return web.json_response({"result": result})

    async def platform(self, owner: str, command: str, args: dict):
        request_id = args.get("requestId")
        if not isinstance(request_id, str) or not _REQUEST.fullmatch(request_id):
            raise WorkError("invalid_request", "编辑回执标识无效。")
        if command == "canvas_agent_respond":
            if not isinstance(args.get("result"), dict):
                raise WorkError("invalid_request", "编辑回执格式无效。")
            self.desktop.wire.platform_result(owner, request_id, args["result"])
            return None
        if command == "canvas_agent_stage":
            if not self.desktop.wire.platform_pending(owner, request_id):
                raise WorkError("not_found", "编辑请求已结束。", 404)
            return None
        raise WorkError("feature_unavailable", "此编辑命令未开放。")
