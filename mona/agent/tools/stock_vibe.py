"""Thin, idempotent Mona task/query adapter for the hosted Stock Vibe API."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import uuid
from contextvars import ContextVar
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import ArraySchema, IntegerSchema, StringSchema, tool_parameters_schema
from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token

_PREFIX = "/api/stock-vibe"
_SYMBOL = re.compile(r"^[0-9]{6}\.(SH|SZ|BJ)$")
_OBJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_ACTIONS = ("start_research", "continue_research", "read_research", "list_research", "submit_research", "query", "cancel")
_TASKS = ("comprehensive", "fundamental", "technical", "risk")
_MODES = {
    "ultrashort": "超短线（当日及随后数日）",
    "swing": "波段（3、5、10 个交易日）",
    "medium": "中短线（10、20、40 个交易日）",
}
_PARAMETERS = tool_parameters_schema(
    action=StringSchema("一般研究用 start_research；同一研究追问用 continue_research；读取实际进度和报告用 read_research。submit_research 仅固定区间行情复核团队。", enum=_ACTIONS),
    symbol=StringSchema("可选单只 A 股六位代码；系统识别交易所。行业、多公司研究留空，在问题中说明。", max_length=9),
    start_date=StringSchema("研究起始日期，YYYY-MM-DD。", max_length=10),
    end_date=StringSchema("研究结束日期，YYYY-MM-DD。", max_length=10),
    question=StringSchema("研究问题；不能包含凭据或任意 URL。", max_length=5000),
    mode=StringSchema("单股新研究默认 swing；通用问题省略则不预设周期。续问沿用原周期。", enum=tuple(_MODES)),
    task=StringSchema("可选单股研究类别，默认 comprehensive。只用于新研究。", enum=_TASKS),
    session_id=StringSchema("原研究的 session_id。续问和读取可省略，以恢复当前主会话最后绑定的研究。不要从标题猜 ID。", max_length=128),
    attachments=ArraySchema(StringSchema("当前工作区或用户已提供的本地资料路径，不接受 URL。续问省略则沿用原资料，空数组则不附资料。"), max_items=10),
    query_kind=StringSchema("固定查询对象类型。", enum=("request", "swarm", "session", "operation")),
    object_id=StringSchema("对应宿主记录的对象标识。", max_length=128),
    query=StringSchema("list_research 可选标题筛选，仅筛选实际读取的近期研究，不是全历史搜索。", max_length=120),
    limit=IntegerSchema(description="list_research 读取近期研究数量，默认 50，最多 100。", minimum=1, maximum=100),
    required=["action"],
)


def _reparse_point(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _stock_symbol(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.upper()
    if re.fullmatch(r"[0-9]{6}", value):
        suffix = "SH" if value.startswith("6") else "BJ" if value.startswith(("4", "8", "92")) else "SZ"
        value += "." + suffix
    return value if _SYMBOL.fullmatch(value) else None


@tool_parameters(_PARAMETERS)
class StockVibeTaskTool(Tool, ContextAware):
    """Submit, inspect, or cancel work through the authenticated local host API."""

    _scopes = {"core", "subagent"}
    _plugin_discoverable = False

    def __init__(self, tool_context: Any):
        self._tool_context = tool_context
        self._request_context: ContextVar[RequestContext | None] = ContextVar(
            f"stock_vibe_request_context_{id(self)}", default=None
        )

    @classmethod
    def create(cls, ctx: Any) -> StockVibeTaskTool:
        return cls(ctx)

    def set_context(self, ctx: RequestContext) -> None:
        self._request_context.set(ctx)

    @property
    def name(self) -> str:
        return "stock_vibe_task"

    @property
    def description(self) -> str:
        return (
            "Use Vibe's native financial research tools and skills for company, industry, event, "
            "document, valuation, risk or strategy questions. Prefer start_research for a new "
            "question, continue_research for follow-ups in the SAME session, and read_research "
            "for actual progress, evidence and final report. list_research finds saved recent research "
            "by title so the user need not supply IDs; it is not an all-history search. "
            "Supports user-provided local documents. "
            "A submission receipt is NOT a finished report; only report completed when the native "
            "attempt status is completed. If a read is still running, show progress and keep its IDs; "
            "do not repeatedly poll unchanged results or start a replacement task. "
            "submit_research is the narrower fixed-date market-evidence team. "
            "query/cancel inspect or cancel existing native objects."
        )

    async def execute(
        self,
        action: str,
        symbol: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        question: str | None = None,
        mode: str | None = None,
        task: str | None = None,
        session_id: str | None = None,
        attachments: list[str] | None = None,
        query_kind: str | None = None,
        object_id: str | None = None,
        query: str | None = None,
        limit: int | None = None,
        **kwargs: Any,
    ) -> str:
        if kwargs:
            return "无法执行：包含不支持的参数。"
        if action == "list_research":
            if any(value is not None for value in (symbol, start_date, end_date, question, mode, task,
                                                   session_id, attachments, query_kind, object_id)):
                return "无法列出研究：请只提供可选的标题筛选和数量。"
            return await self._list_research(query, limit)
        if query is not None or limit is not None:
            return "标题筛选和数量仅用于 list_research。"
        if action in {"start_research", "continue_research", "read_research"}:
            if any(value is not None for value in (start_date, end_date, query_kind, object_id)):
                return "无法研究：通用研究不使用固定区间或查询对象参数，请在问题中说明时间范围。"
            if action != "start_research" and any(value is not None for value in (symbol, mode, task)):
                return "无法续用研究：对象和周期沿用原研究，请勿用当前股票覆盖。"
            if action == "read_research":
                if question is not None or attachments is not None:
                    return "无法读取：读取报告不提交新问题或附件。"
                return await self._read_research(session_id)
            return await self._session_research(action, question, symbol, mode, task, session_id, attachments)
        if any(value is not None for value in (task, session_id, attachments)):
            return "无法执行：这些研究参数仅用于通用研究。"
        if action == "submit_research":
            if query_kind is not None or object_id is not None:
                return "无法提交：请移除查询参数。"
            payload, error = self._research_payload(symbol, start_date, end_date, question, mode)
            if error:
                return error
            return await self._write("submit_research", "POST", "/swarm/runs", payload)
        if action == "query":
            if any(value is not None for value in (symbol, start_date, end_date, question, mode)):
                return "无法查询：请只提供 query_kind 和 object_id。"
            if query_kind not in {"request", "swarm", "session", "operation"}:
                return "无法查询：对象类型无效。"
            if not _OBJECT_ID.fullmatch(object_id or ""):
                return "无法查询：对象标识无效。"
            route = {
                "request": f"/requests/{object_id}",
                "swarm": f"/swarm/runs/{object_id}",
                "session": f"/sessions/{object_id}",
                "operation": f"/operations/{object_id}",
            }[query_kind]
            status, result = await self._request("GET", route)
            if status == 200 and isinstance(result, dict):
                return json.dumps({"result": result}, ensure_ascii=False, separators=(",", ":"))
            return "没有找到该宿主记录。" if status == 404 else "暂时无法读取宿主记录，请稍后查询。"
        if action == "cancel":
            if any(value is not None for value in (symbol, start_date, end_date, question, mode)):
                return "无法取消：请只提供 query_kind 和 object_id。"
            if query_kind not in {"swarm", "session"} or not _OBJECT_ID.fullmatch(object_id or ""):
                return "无法取消：只支持已有会话或 Swarm。"
            route = f"/{'swarm/runs' if query_kind == 'swarm' else 'sessions'}/{object_id}/cancel"
            return await self._write("cancel", "POST", route, {})
        return "无法执行：操作类型无效。"

    def _binding_path(self) -> Path:
        from mona.config.paths import get_data_dir

        ctx = self._request_context.get()
        actor = getattr(self._tool_context, "agent_id", None)
        if ctx is None or not ctx.channel or not ctx.chat_id or not isinstance(actor, str) or not actor:
            raise ValueError("缺少可信会话身份")
        key = json.dumps([actor, ctx.channel, ctx.chat_id, ctx.session_key], ensure_ascii=False)
        root = Path(get_data_dir()).resolve()
        folder = root / "stock-vibe" / "tool-bindings"
        if any(path.exists() and _reparse_point(path) for path in (folder.parent, folder)):
            raise ValueError("会话绑定路径不可用")
        folder.mkdir(parents=True, exist_ok=True)
        if not folder.resolve().is_relative_to(root):
            raise ValueError("会话绑定路径不可用")
        path = folder / f"{hashlib.sha256(key.encode()).hexdigest()}.json"
        if path.exists() and _reparse_point(path):
            raise ValueError("会话绑定文件不可用")
        return path

    def _bound_session(self, session_id: str | None) -> str:
        if session_id is None:
            path = self._binding_path()
            if not path.exists():
                raise ValueError("当前会话尚未关联研究，请先开始研究或提供原研究标识")
            session_id = json.loads(path.read_text(encoding="utf-8")).get("session_id")
        if not isinstance(session_id, str) or not _OBJECT_ID.fullmatch(session_id):
            raise ValueError("研究标识无效")
        return session_id

    def _bind_session(self, session_id: str, attempt_id: str | None = None) -> None:
        path = self._binding_path()
        temporary = path.with_name(f".{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump({"session_id": session_id, "attempt_id": attempt_id}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _research_plan_path(self, action: str, intent: dict[str, Any]) -> Path:
        ctx = self._request_context.get()
        identity = next((value for value in (ctx.message_id if ctx else None,
                                             getattr(self._tool_context, "job_id", None),
                                             getattr(self._tool_context, "workflow_run_id", None))
                         if isinstance(value, str) and value.strip()), None)
        if identity is None:
            raise ValueError("缺少可信消息身份")
        binding = self._binding_path()
        digest = hashlib.sha256(json.dumps([binding.stem, identity, action, intent],
                                          ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        path = binding.with_name(f"plan-{digest}.json")
        if path.exists() and _reparse_point(path):
            raise ValueError("研究计划不可用")
        return path

    @staticmethod
    def _freeze_plan(path: Path, plan: dict[str, Any]) -> dict[str, Any]:
        try:
            with path.open("x", encoding="utf-8") as handle:
                json.dump(plan, handle, ensure_ascii=False, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            pass
        saved = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(saved, dict):
            raise ValueError("研究计划无效")
        return saved

    def _attachment_payloads(self, attachments: list[str] | None) -> list[dict[str, str]]:
        from mona.services.stock_vibe.contracts import Upload

        if attachments is None:
            return []
        if not isinstance(attachments, list) or len(attachments) > 10:
            raise ValueError("一次最多添加 10 份资料")
        workspace = get_current_workspace(Path(self._tool_context.workspace)).resolve()
        ctx = self._request_context.get()
        trusted = (ctx.metadata or {}).get("_attachment_paths", []) if ctx else []
        trusted = trusted if isinstance(trusted, list) else []
        trusted_paths = {resolve_workspace_path(raw, workspace) for raw in trusted if isinstance(raw, str)}
        uploads = []
        seen = set()
        for raw in attachments:
            if not isinstance(raw, str) or not raw or "://" in raw:
                raise ValueError("请使用当前工作区或已提供的本地资料")
            path = resolve_workspace_path(raw, workspace)
            if not path.is_relative_to(workspace) and path not in trusted_paths:
                raise PermissionError("资料不在当前工作区或可信附件中")
            Upload.safe_filename(path.name)
            if path in seen:
                raise ValueError("资料重复")
            seen.add(path)
            with path.open("rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
                    raise ValueError("每份资料须为不超过 8 MB 的普通文件")
                data = handle.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024 or path.resolve() != path:
                raise ValueError("资料发生变化，请重新选择")
            uploads.append({"filename": path.name, "data_base64": base64.b64encode(data).decode("ascii")})
        return uploads

    @staticmethod
    def _receipt_body(record: dict[str, Any]) -> dict[str, Any] | None:
        receipt = record.get("receipt")
        if record.get("status") != "completed" or not isinstance(receipt, dict):
            return None
        code = receipt.get("status_code")
        body = receipt.get("body")
        return body if type(code) is int and 200 <= code < 300 and isinstance(body, dict) else None

    async def _session_state(self, session_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
        code, response = await self._request("GET", f"/sessions/{session_id}")
        session = response.get("native") if code == 200 and response else None
        if not isinstance(session, dict) or session.get("session_id") != session_id:
            raise ValueError("暂时无法读取原研究，请稍后用同一研究标识查询")
        code, response = await self._request("GET", f"/sessions/{session_id}/messages")
        messages = response.get("native") if code == 200 and response else None
        if not isinstance(messages, list) or any(not isinstance(item, dict) for item in messages):
            raise ValueError("暂时无法读取研究记录，请稍后查询")
        attempt = None
        attempt_id = session.get("last_attempt_id")
        if attempt_id is not None:
            if not isinstance(attempt_id, str) or not _OBJECT_ID.fullmatch(attempt_id):
                raise ValueError("研究状态尚未核实")
            code, response = await self._request("GET", f"/sessions/{session_id}/attempts/{attempt_id}")
            attempt = response.get("native") if code == 200 and response else None
            if (not isinstance(attempt, dict) or attempt.get("session_id") != session_id
                or attempt.get("attempt_id") != attempt_id
                or attempt.get("status") not in {"pending", "running", "waiting_user", "completed", "failed", "cancelled", "interrupted"}):
                raise ValueError("研究状态尚未核实，请稍后查询，不会重复提交")
        return session, messages, attempt

    async def _session_research(self, action: str, question: str | None, symbol: str | None,
                                mode: str | None, task: str | None, session_id: str | None,
                                attachments: list[str] | None) -> str:
        if not isinstance(question, str) or not question.strip() or len(question.strip()) > 5000:
            return "无法研究：请提供不超过 5000 字的研究问题。"
        try:
            self._binding_path()
            uploads = self._attachment_payloads(attachments)
        except FileNotFoundError:
            return "资料不存在，请重新选择文件。本次尚未提交研究。"
        except PermissionError:
            return "无法读取资料：请使用当前工作区或本次会话中用户提供的文件。本次尚未提交研究。"
        except (OSError, ValueError, TypeError) as exc:
            logger.warning("Stock Vibe tool input failed: action={} error={}", action, type(exc).__name__)
            return "无法开始研究：请检查会话身份及资料路径、类型和大小；每份资料最多 8 MB。本次尚未提交研究。"
        try:
            plan_path = self._research_plan_path(action, {"question": question.strip(), "symbol": symbol,
                                                        "mode": mode, "task": task, "session_id": session_id,
                                                        "attachments": attachments})
            local_uploads = [{"filename": item["filename"], "sha256": hashlib.sha256(
                item["data_base64"].encode("ascii")).hexdigest()} for item in uploads]
            plan = json.loads(plan_path.read_text(encoding="utf-8")) if plan_path.exists() else None
            if plan is not None and (not isinstance(plan, dict) or plan.get("local_uploads") != local_uploads):
                return "本次研究所选资料已发生变化，旧请求不会重新提交。请先查询原研究；使用新资料时重新明确发起请求。"
            if plan is None and action == "start_research":
                if session_id is not None:
                    return "新研究不使用原研究标识，继续原研究请使用 continue_research。"
                if symbol:
                    symbol = _stock_symbol(symbol)
                    if symbol is None:
                        return "请输入六位 A 股代码。"
                if mode is not None and mode not in _MODES or task is not None and task not in _TASKS:
                    return "研究周期或类别无效，请从可用选项中选择。"
                research = {"symbol": symbol or None, "mode": mode or "swing"} if symbol or mode else None
                plan = {"session_id": None, "research": research, "attachments": [], "local_uploads": local_uploads}
                if symbol:
                    plan["workbench"] = {**research, "task": task or "comprehensive"}
            elif plan is None:
                session_id = self._bound_session(session_id)
                session, messages, _attempt = await self._session_state(session_id)
                config = session.get("config") or {}
                original = config.get("mona_workbench") if isinstance(config, dict) else None
                research = {key: original.get(key) for key in ("symbol", "mode")} if isinstance(original, dict) else None
                inherited = []
                for message in reversed(messages):
                    metadata = message.get("metadata")
                    if message.get("role") == "user" and isinstance(metadata, dict):
                        research = metadata.get("research") or research
                        inherited = (metadata.get("attachments") or []) if attachments is None else []
                        break
                plan = {"session_id": session_id, "research": research, "attachments": inherited, "local_uploads": local_uploads}
            plan = self._freeze_plan(plan_path, plan)
            if plan.get("local_uploads") != local_uploads:
                return "本次研究所选资料已发生变化，旧请求不会重新提交。请先查询原研究。"
            research = plan["research"]
            inherited = plan["attachments"]
            busy = False
            if action == "start_research":
                create = {"title": question.strip()[:80]}
                if plan.get("workbench"):
                    create["workbench"] = plan["workbench"]
                intent = {"question": question.strip(), "research": research, "create": create,
                          "attachments": local_uploads}
                intent_hash = hashlib.sha256(json.dumps(intent, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                record = await self._write_record("start_research:create:" + intent_hash, "POST", "/sessions", create)
                body = self._receipt_body(record)
                if body is None or not _OBJECT_ID.fullmatch(str(body.get("session_id", ""))):
                    return self._present(record, "start_research:create")
                session_id = body["session_id"]
                self._bind_session(session_id)
            else:
                session_id = self._bound_session(plan["session_id"])
                _session, _messages, attempt = await self._session_state(session_id)
                busy = bool(attempt and attempt["status"] in {"pending", "running"})
            prepared = list(inherited)
            for upload in uploads:
                record = await self._write_record("research:upload", "POST", "/uploads", upload, dispatch=not busy)
                if record.get("status") == "not_sent":
                    return await self._busy_followup(session_id)
                body = self._receipt_body(record)
                if body is None:
                    return self._present(record, "research:upload")
                from mona.services.stock_vibe.contracts import ResearchAttachment

                prepared.append(ResearchAttachment.model_validate({key: body.get(key) for key in ("file_path", "filename")}).model_dump())
            payload = {"content": question.strip()}
            if research is not None:
                payload["research"] = research
            if prepared:
                payload["attachments"] = list({item["file_path"]: item for item in prepared}.values())
            from mona.services.stock_vibe.contracts import SendMessage

            payload = SendMessage.model_validate(payload).model_dump(mode="json")
            record = await self._write_record(action + ":send", "POST", f"/sessions/{session_id}/messages", payload, dispatch=not busy)
            if record.get("status") == "not_sent":
                return await self._busy_followup(session_id)
            body = self._receipt_body(record)
            attempt_id = body.get("attempt_id") if body else None
            if not isinstance(attempt_id, str) or not _OBJECT_ID.fullmatch(attempt_id):
                return self._present({**record, "session_id": session_id}, action + ":send")
            self._bind_session(session_id, attempt_id)
            return json.dumps({"session_id": session_id, "attempt_id": attempt_id, "status": "accepted",
                               "notice": "研究请求已接收，报告尚未完成；使用 read_research 读取真实进度、依据和报告。"}, ensure_ascii=False)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            logger.warning("Stock Vibe tool operation failed: action={} error={}", action, type(exc).__name__)
            return "研究操作未完成：请核对原研究标识、资料路径、类型和大小；若已提交，请读取原研究确认进度，不要重复新建。"

    async def _busy_followup(self, session_id: str) -> str:
        response = await self._read_research(session_id)
        try:
            result = json.loads(response)
        except ValueError:
            result = {"session_id": session_id, "status": "unknown"}
        return json.dumps({**result, "submission": "not_sent",
                           "notice": "原研究仍在运行，本次追问尚未提交；可待其结束后再发送。"}, ensure_ascii=False)

    async def _list_research(self, query: str | None, limit: int | None) -> str:
        limit = 50 if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= 100 or query is not None and (not isinstance(query, str) or len(query) > 120):
            return "无法列出研究：数量须为 1 至 100，标题筛选最多 120 字。"
        code, response = await self._request("GET", f"/sessions?limit={limit}")
        sessions = response.get("native") if code == 200 and response else None
        if not isinstance(sessions, list) or any(not isinstance(item, dict) for item in sessions):
            return "暂时无法读取已保存研究，请稍后再试。"
        rows = [{key: item.get(key) for key in ("session_id", "title", "status", "created_at", "updated_at", "last_attempt_id")}
                for item in sessions if not query or query.casefold() in str(item.get("title", "")).casefold()]
        return json.dumps({"sessions": rows, "scope": "近期研究；标题筛选仅作用于本次实际读取的记录，不代表全部历史",
                           "limit": limit, "loaded": len(sessions), "query": query or ""}, ensure_ascii=False)

    async def _read_research(self, session_id: str | None) -> str:
        try:
            session_id = self._bound_session(session_id)
            _session, messages, attempt = await self._session_state(session_id)
            status = attempt["status"] if attempt else "idle"
            attempt_id = attempt["attempt_id"] if attempt else None
            relevant = [item for item in messages if item.get("linked_attempt_id") == attempt_id] if attempt_id else []
            reply = next((item.get("content") for item in reversed(relevant) if item.get("role") == "assistant"), None)
            progress = {"idle": "研究已建立，尚未提交问题", "pending": "等待研究", "running": "正在研究",
                        "waiting_user": "需要你补充信息，请在同一研究继续回答", "completed": "研究已完成",
                        "failed": "研究未完成，现有记录已保留", "cancelled": "研究已取消", "interrupted": "研究中断，现有记录已保留"}[status]
            return json.dumps({"session_id": session_id, "attempt_id": attempt_id, "status": status,
                               "progress": progress, "report": (attempt.get("summary") or reply) if status == "completed" else None,
                               "reply": reply, "grounding_validation": attempt.get("grounding_validation") if attempt else None,
                               "tool_trail": [entry for item in relevant for entry in item.get("tool_trail", [])]}, ensure_ascii=False)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            logger.warning("Stock Vibe tool read failed: error={}", type(exc).__name__)
            return "暂时无法读取研究：请提供原研究标识，或在发起研究的同一主会话中查询。不会自动重建或重发研究。"

    @staticmethod
    def _research_payload(symbol: str | None, start_date: str | None, end_date: str | None,
                          question: str | None, mode: str | None) -> tuple[dict[str, Any] | None, str | None]:
        symbol = _stock_symbol(symbol)
        if symbol is None:
            return None, "无法提交：请输入六位 A 股代码。"
        try:
            start = date.fromisoformat(start_date or "")
            end = date.fromisoformat(end_date or "")
        except ValueError:
            return None, "无法提交：起止日期须使用 YYYY-MM-DD。"
        if start.isoformat() != start_date or end.isoformat() != end_date or end < start or end > date.today():
            return None, "无法提交：研究日期区间无效。"
        if not isinstance(question, str) or not question.strip() or len(question.strip()) > 5000:
            return None, "无法提交：请提供不超过 5000 字的研究问题。"
        if mode is not None and mode not in _MODES:
            return None, "无法提交：研究期限无效。"
        normalized_question = question.strip()
        if mode is not None:
            hint = f"\n\n研究期限参考：{_MODES[mode]}。"
            if len(normalized_question) + len(hint) > 5000:
                return None, "无法提交：研究问题过长。"
            normalized_question += hint
        return {
            "preset_name": "mona_ashare_research",
            "user_vars": {
                "symbol": symbol,
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "question": normalized_question,
            },
        }, None

    def _marker_state(self, request_id: str, payload_sha256: str, *, create: bool = True) -> str:
        from mona.config.paths import get_data_dir

        data_root = Path(get_data_dir()).resolve()
        stock_root, outbox = data_root / "stock-vibe", data_root / "stock-vibe" / "tool-outbox"
        if any(path.exists() and _reparse_point(path) for path in (stock_root, outbox)):
            return "blocked"
        outbox.mkdir(parents=True, exist_ok=True)
        if not outbox.resolve().is_relative_to(data_root):
            return "blocked"
        marker = outbox / f"{request_id}.json"
        if not create:
            return "existing" if marker.exists() else "absent"
        record = {"request_id": request_id, "payload_sha256": payload_sha256}
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(marker, flags, 0o600)
        except FileExistsError:
            return "existing"
        except OSError:
            return "blocked"
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(record, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError:
            return "blocked"
        return "new"

    async def _write(self, action: str, method: str, path: str, payload: dict[str, Any]) -> str:
        return self._present(await self._write_record(action, method, path, payload), action)

    async def _write_record(self, action: str, method: str, path: str, payload: dict[str, Any], *, dispatch: bool = True) -> dict[str, Any]:
        request_context = self._request_context.get()
        candidates = (("message", request_context.message_id if request_context else None),
                      ("job", getattr(self._tool_context, "job_id", None)),
                      ("workflow", getattr(self._tool_context, "workflow_run_id", None)))
        identity = next(({"kind": kind, "id": value.strip()} for kind, value in candidates
                         if isinstance(value, str) and value.strip() and len(value) <= 512), None)
        actor = getattr(self._tool_context, "agent_id", None)
        if identity is None or not isinstance(actor, str) or not actor.strip():
            return {"status": "rejected", "error_category": "trusted_identity_required"}
        if ":" in action and request_context:
            identity = {**identity, "channel": request_context.channel, "chat_id": request_context.chat_id,
                        "session_key": request_context.session_key}
        canonical = json.dumps({"actor": actor.strip(), "identity": identity, "action": action,
                                "payload": {"method": method, "path": path, "payload": payload}},
                               ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        request_id = uuid.uuid5(uuid.NAMESPACE_URL, "mona-stock-vibe:" + canonical).hex
        payload_sha256 = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        try:
            marker_state = self._marker_state(request_id, payload_sha256, create=dispatch)
        except OSError:
            marker_state = "blocked"
        if marker_state == "blocked":
            return {"status": "unknown", "request_id": request_id, "error_category": "outbox_unavailable"}
        if marker_state == "absent":
            return {"status": "not_sent", "request_id": request_id}
        if marker_state == "existing":
            status, result = await self._request("GET", f"/requests/{request_id}")
            if status == 200 and isinstance(result, dict):
                return result
            return {"status": "unknown", "request_id": request_id, "error_category": "receipt_unconfirmed"}
        status, result = await self._request(method, path, payload=payload, request_id=request_id)
        if status is not None and isinstance(result, dict) and result.get("request_id") == request_id:
            return result
        status, result = await self._request("GET", f"/requests/{request_id}")
        if status == 200 and isinstance(result, dict):
            return result
        return {"status": "unknown", "request_id": request_id, "error_category": "receipt_unconfirmed"}

    async def _request(
        self, method: str, path: str, *, payload: dict[str, Any] | None = None, request_id: str | None = None
    ) -> tuple[int | None, dict[str, Any] | None]:
        port = getattr(self._tool_context, "services_port", 17174)
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            return None, None
        url = f"http://127.0.0.1:{port}{_PREFIX}{path}"
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(90.0, connect=2.0)) as client:
                headers = {SERVICES_TOKEN_HEADER: get_services_token()}
                if request_id is not None:
                    headers["X-Mona-Request-ID"] = request_id
                response = await client.request(method, url, headers=headers,
                                                json=payload if method == "POST" else None)
            data = response.json()
            return response.status_code, data if isinstance(data, dict) else None
        except (httpx.HTTPError, ValueError):
            return None, None

    @staticmethod
    def _present(result: dict[str, Any], action: str) -> str:
        status = result.get("status")
        if result.get("error_category") == "trusted_identity_required":
            notice = "无法写入：当前请求没有可信的会话消息或任务身份。"
        elif action != "cancel":
            if status == "completed":
                notice = "宿主已返回请求回执；这表示请求被记录，不表示研究报告已完成。请查询原研究或回执中的任务标识。"
            elif status == "rejected":
                notice = "宿主拒绝了请求，未确认研究任务已启动。"
            else:
                notice = "请求结果尚未核实；不会自动重发，可稍后查询同一请求。"
        elif status == "completed":
            notice = "取消请求已有宿主回执；请查询原对象确认最终状态。"
        elif status == "rejected":
            notice = "宿主拒绝了取消请求。"
        else:
            notice = "取消结果尚未核实；不会自动重发，可稍后查询同一请求。"
        return json.dumps({"result": result, "notice": notice}, ensure_ascii=False, separators=(",", ":"))

__all__ = ["StockVibeTaskTool"]
