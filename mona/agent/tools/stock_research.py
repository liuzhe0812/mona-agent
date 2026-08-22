"""Controlled entry points for the packaged stock deep-research workflow.

The tools intentionally delegate execution to the existing hidden stock room
and ``WorkflowRunner``.  They do not maintain a second task registry or a
second status cache.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from mona.agent.pack_bootstrap import STOCK_ROOM_ID
from mona.agent.partners import AgentRegistry
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import StringSchema, tool_parameters_schema
from mona.agent.tools.stock_query import _resolve_instrument
from mona.agent.workflow import TERMINAL_RUN_STATUSES, RunConflictError, serialize_run


def _run_symbols(run: Any) -> set[str]:
    raw = (getattr(run, "inputs", None) or {}).get("symbols")
    return {item for item in raw if isinstance(item, str)} if isinstance(raw, list) else set()


def _is_report_ref(ref: str) -> bool:
    """Keep only final report/digest JSON or Markdown artifacts."""
    name = ref.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    return name in {"report.json", "report.md", "digest.json", "digest.md"}


def _status_payload(run: Any) -> dict[str, Any]:
    current: list[str] = []
    queued: list[str] = []
    completed: list[str] = []
    failed: list[dict[str, str]] = []
    report_refs: list[str] = []
    for step_id, step in run.steps.items():
        if step.status in {"running", "waiting_approval"}:
            current.append(step_id)
        if step.status == "queued":
            queued.append(step_id)
        if step.status == "succeeded":
            completed.append(step_id)
        if step.status == "failed":
            failed.append({"step_id": step_id, "error": step.error or "step failed"})
        output = step.output if isinstance(step.output, dict) else {}
        artifacts = output.get("artifacts")
        if isinstance(artifacts, list):
            report_refs.extend(
                str(ref)
                for ref in artifacts
                if ref and _is_report_ref(str(ref))
            )
    failure_reason = failed[0]["error"] if failed else None
    if failure_reason is None and run.status == "failed":
        failure_reason = "workflow run failed before a step error was persisted"
    return {
        "run_id": run.id,
        "status": run.status,
        "current_steps": current,
        "queued_steps": queued,
        "completed_steps": completed,
        "failed_steps": failed,
        "failure_reason": failure_reason,
        "report_refs": report_refs,
        "run": serialize_run(run),
    }


class _StockResearchToolBase(Tool, ContextAware):
    _scopes = {"subagent"}

    def __init__(self, manager: Any, tool_ctx: Any):
        self._manager = manager
        self._tool_ctx = tool_ctx
        self._request_ctx: RequestContext | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

    def _sessions(self) -> Any | None:
        sessions = getattr(self._manager, "_sessions", None)
        return sessions or getattr(self._tool_ctx, "sessions", None)

    def _room_conversation(self) -> Any | None:
        sessions = self._sessions()
        if sessions is None:
            return None
        return sessions.get_or_create(f"websocket:{STOCK_ROOM_ID}").conversation_metadata

    def _store(self) -> Any:
        return self._manager.run_store_for_room(STOCK_ROOM_ID)

    def _workflow(self) -> Any | None:
        return self._manager.workflow_store_for_room(STOCK_ROOM_ID).get_active(STOCK_ROOM_ID)


@tool_parameters(
    tool_parameters_schema(
        symbol=StringSchema(
            "A-share code: bare 6 digits or EXCHANGE:symbol; starts the packaged "
            "six-agent deep-research workflow for one instrument."
        ),
        user_question=StringSchema(
            "Optional user question to carry into the research run.",
            max_length=2000,
            nullable=True,
        ),
        required=["symbol"],
    )
)
class StockResearchStartTool(_StockResearchToolBase):
    """Start or reuse one hidden-room stock deep-research run."""

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(manager=ctx.subagent_manager, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "stock_research_start"

    @property
    def description(self) -> str:
        return (
            "Start the packaged six-agent stock research workflow asynchronously. "
            "Reuse an unfinished run for the same symbol and return its run_id; "
            "poll stock_research_status for progress."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        symbol: str,
        user_question: str | None = None,
        **kwargs: Any,
    ) -> str:
        if self._manager is None:
            return "Error: stock research is unavailable: no workflow manager."
        try:
            inst = _resolve_instrument(symbol)
        except ValueError as exc:
            return f"Error: {exc}"
        normalized = inst.id
        store = self._store()
        for run in store.list_for_room(STOCK_ROOM_ID):
            if run.status in TERMINAL_RUN_STATUSES:
                continue
            if normalized in _run_symbols(run):
                return json.dumps(_status_payload(run), ensure_ascii=False)
            return (
                f"Error: stock research room already has unfinished run {run.id} "
                f"for {sorted(_run_symbols(run)) or ['unknown symbol']}."
            )

        workflow = self._workflow()
        conversation = self._room_conversation()
        if workflow is None or conversation is None:
            return "Error: stock research is unavailable: hidden room is not bootstrapped."

        inputs: dict[str, Any] = {"symbols": [normalized]}
        if isinstance(user_question, str) and user_question.strip():
            inputs["user_question"] = user_question.strip()
        runner = self._manager.workflow_runner_for_room(STOCK_ROOM_ID)
        registry = AgentRegistry()

        async def _drive() -> None:
            try:
                await runner.run(
                    room_id=STOCK_ROOM_ID,
                    workflow=workflow,
                    conversation=conversation,
                    registry=registry,
                    inputs=inputs,
                    started_by="a-share-analyst",
                )
            except RunConflictError:
                # A concurrent caller won the room lock.  The persisted run is
                # the source of truth; the next status poll observes it.
                return
            except Exception:
                # WorkflowRunner persists failures before propagating driver
                # errors.  Keep the background task from becoming unhandled.
                return

        task = asyncio.create_task(_drive())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

        # runner.run creates and persists the run before its first provider or
        # agent await. Yield a few times to obtain that durable id without
        # waiting for the research itself.
        run = None
        for _ in range(20):
            await asyncio.sleep(0)
            candidates = store.list_for_room(STOCK_ROOM_ID, limit=5)
            run = next((item for item in candidates if normalized in _run_symbols(item)), None)
            if run is not None:
                break
        if run is None:
            return "Error: stock research could not create a durable workflow run."
        return json.dumps(_status_payload(run), ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        run_id=StringSchema("Workflow run id returned by stock_research_start."),
        required=["run_id"],
    )
)
class StockResearchStatusTool(_StockResearchToolBase):
    """Read persisted progress for a stock research run."""

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(manager=ctx.subagent_manager, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "stock_research_status"

    @property
    def description(self) -> str:
        return (
            "Read the persisted status of a six-agent stock research run, "
            "including current/completed steps, failures and report artifacts."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, run_id: str, **kwargs: Any) -> str:
        if self._manager is None:
            return "Error: stock research is unavailable: no workflow manager."
        if not isinstance(run_id, str) or not run_id.strip():
            return "Error: run_id must be non-empty."
        try:
            run = self._store().load(run_id.strip())
        except Exception:
            return f"Error: stock research run {run_id!r} not found."
        if run.room_id != STOCK_ROOM_ID:
            return f"Error: stock research run {run_id!r} not found."
        return json.dumps(_status_payload(run), ensure_ascii=False)
