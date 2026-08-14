"""Subagent manager for background task execution."""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from loguru import logger

from mona.agent.hook import AgentHook, AgentHookContext
from mona.agent.jobs import (
    JOB_STATUS_RUNNING,
    JOB_STATUS_SUCCEEDED,
    AgentJob,
    AgentJobStore,
    JobNotFoundError,
    JobTransitionError,
)
from mona.agent.partners import (
    MONA_AGENT_ID,
    AgentDefinition,
    AgentRegistry,
    ConversationMetadata,
    normalize_agent_id,
)
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.context import ToolContext
from mona.agent.tools.file_state import FileStates
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.agent.workflow import (
    RUN_STATUS_RUNNING,
    RUN_STATUS_WAITING_APPROVAL,
    STEP_STATUS_WAITING_APPROVAL,
    StepExecutionError,
    WorkflowDefinition,
    WorkflowRun,
    WorkflowRunner,
    WorkflowRunStore,
    WorkflowStep,
    WorkflowStore,
    compose_step_task,
    serialize_run,
    serialize_workflow,
)
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.config.schema import AgentDefaults, ToolsConfig
from mona.providers.base import LLMProvider
from mona.utils.prompt_templates import render_template


@dataclass(slots=True)
class SubagentStatus:
    """Real-time status of a running subagent."""

    task_id: str
    label: str
    task_description: str
    started_at: float          # time.monotonic()
    phase: str = "initializing"  # initializing | awaiting_tools | tools_completed | final_response | done | error
    iteration: int = 0
    tool_events: list = field(default_factory=list)   # [{name, status, detail}, ...]
    usage: dict = field(default_factory=dict)          # token usage
    stop_reason: str | None = None
    error: str | None = None


class _SubagentHook(AgentHook):
    """Hook for subagent execution — logs tool calls and updates status."""

    def __init__(self, task_id: str, status: SubagentStatus | None = None) -> None:
        super().__init__()
        self._task_id = task_id
        self._status = status

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        for tool_call in context.tool_calls:
            args_str = json.dumps(tool_call.arguments, ensure_ascii=False)
            logger.debug(
                "Subagent [{}] executing: {} with arguments: {}",
                self._task_id, tool_call.name, args_str,
            )

    async def after_iteration(self, context: AgentHookContext) -> None:
        if self._status is None:
            return
        self._status.iteration = context.iteration
        self._status.tool_events = list(context.tool_events)
        self._status.usage = dict(context.usage)
        if context.error:
            self._status.error = str(context.error)


class SubagentManager:
    """Manages background subagent execution."""

    def __init__(
        self,
        provider: LLMProvider,
        workspace: Path,
        bus: MessageBus,
        max_tool_result_chars: int,
        model: str | None = None,
        tools_config: ToolsConfig | None = None,
        restrict_to_workspace: bool = False,
        disabled_skills: list[str] | None = None,
        max_iterations: int | None = None,
        llm_wall_timeout_for_session: Callable[[str | None], float | None] | None = None,
        session_manager: Any | None = None,
    ):
        defaults = AgentDefaults()
        self.provider = provider
        self.workspace = workspace
        self.bus = bus
        self.model = model or provider.get_default_model()
        self.tools_config = tools_config or ToolsConfig()
        self.max_tool_result_chars = max_tool_result_chars
        self.restrict_to_workspace = restrict_to_workspace
        self.disabled_skills = set(disabled_skills or [])
        self.max_iterations = (
            max_iterations
            if max_iterations is not None
            else defaults.max_tool_iterations
        )
        self.max_concurrent_subagents = defaults.max_concurrent_subagents
        self.runner = AgentRunner(provider)
        self._llm_wall_timeout_for_session = llm_wall_timeout_for_session
        # Optional SessionManager used to post agent-authored room messages.
        self._sessions = session_manager
        # Job stores are cached by workspace root so per-job locks are shared
        # by every caller going through this manager (guide 6.2).
        self._job_stores: dict[Path, AgentJobStore] = {}
        # Workflow definition/run stores follow the same per-workspace caching.
        self._workflow_stores: dict[Path, WorkflowStore] = {}
        self._run_stores: dict[Path, WorkflowRunStore] = {}
        # room_id -> WorkflowRunner, shared by the WebSocket channel and the
        # cron callback so the per-room active-run lock is process-wide.
        self._workflow_runners: dict[str, WorkflowRunner] = {}
        # Set by the WebSocket channel: (room_id, serialized run) -> None.
        self.workflow_run_observer: Callable[[str, dict[str, Any]], None] | None = None
        # Set by the gateway bootstrap; workflow cron sync writes here.
        self.cron_service: Any | None = None
        # Optional hook invoked with (room_id, serialized_workflow) after the
        # propose_workflow tool persists a draft; the WebSocket channel
        # registers here to broadcast ``workflow_updated`` (phase 3).
        self.workflow_draft_observer: Callable[[str, dict[str, Any]], None] | None = None
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._task_statuses: dict[str, SubagentStatus] = {}
        self._session_tasks: dict[str, set[str]] = {}  # session_key -> {task_id, ...}

    def _subagent_tools_config(self) -> ToolsConfig:
        """Build a ToolsConfig scoped for subagent use."""
        return ToolsConfig(
            exec=self.tools_config.exec,
            web=self.tools_config.web,
            restrict_to_workspace=self.restrict_to_workspace,
        )

    def _build_tools(
        self,
        workspace: Path | None = None,
        tools_config: ToolsConfig | None = None,
    ) -> ToolRegistry:
        """Build an isolated subagent tool registry via ToolLoader."""
        # Inherit the calling session's workspace from the contextvar (set by
        # AgentLoop at turn entry). asyncio.create_task copies the caller's
        # context, so subagents spawned mid-turn inherit the session workspace.
        from mona.agent.tools.path_utils import get_current_workspace

        root = workspace if workspace is not None else get_current_workspace(self.workspace)
        registry = ToolRegistry()
        cfg = tools_config if tools_config is not None else self._subagent_tools_config()
        ctx = ToolContext(
            config=cfg,
            workspace=str(root.resolve()),
            file_state_store=FileStates(),
        )
        ToolLoader().load(ctx, registry, scope="subagent")
        return registry

    def set_provider(self, provider: LLMProvider, model: str) -> None:
        self.provider = provider
        self.model = model
        self.runner.provider = provider

    async def spawn(
        self,
        task: str,
        label: str | None = None,
        origin_channel: str = "cli",
        origin_chat_id: str = "direct",
        session_key: str | None = None,
        origin_message_id: str | None = None,
    ) -> str:
        """Spawn a subagent to execute a task in the background."""
        task_id = str(uuid.uuid4())[:8]
        display_label = label or task[:30] + ("..." if len(task) > 30 else "")
        origin = {"channel": origin_channel, "chat_id": origin_chat_id, "session_key": session_key}

        status = SubagentStatus(
            task_id=task_id,
            label=display_label,
            task_description=task,
            started_at=time.monotonic(),
        )
        self._task_statuses[task_id] = status

        bg_task = asyncio.create_task(
            self._run_subagent(task_id, task, display_label, origin, status, origin_message_id)
        )
        self._running_tasks[task_id] = bg_task
        if session_key:
            self._session_tasks.setdefault(session_key, set()).add(task_id)

        def _cleanup(_: asyncio.Task) -> None:
            self._running_tasks.pop(task_id, None)
            self._task_statuses.pop(task_id, None)
            if session_key and (ids := self._session_tasks.get(session_key)):
                ids.discard(task_id)
                if not ids:
                    del self._session_tasks[session_key]

        bg_task.add_done_callback(_cleanup)

        logger.info("Spawned subagent [{}]: {}", task_id, display_label)
        return f"Subagent [{display_label}] started (id: {task_id}). I'll notify you when it completes."

    async def delegate(
        self,
        *,
        agent_id: str,
        task: str,
        success_criteria: str,
        room_id: str,
        requested_by: str,
        origin_channel: str = "cli",
        origin_chat_id: str = "direct",
        session_key: str | None = None,
        origin_message_id: str | None = None,
        workflow_run_id: str | None = None,
        job_store: AgentJobStore | None = None,
        registry: AgentRegistry | None = None,
    ) -> str:
        """Delegate a task to a named room agent as a tracked AgentJob.

        The ``queued`` job is persisted before the coroutine starts, so the
        room can rebuild projections from the job file after a restart
        (guide 7.4). Room membership is validated by the caller (the
        delegate_agent tool); the registry is re-checked here so an
        uninstalled agent can never launch.
        """
        try:
            target = normalize_agent_id(agent_id)
        except ValueError:
            return f"Cannot delegate: invalid agent id {agent_id!r}."
        registry = registry or AgentRegistry()
        definition = registry.get(target)
        if definition is None:
            return f"Cannot delegate: agent {target!r} is not installed or is disabled."
        running = self.get_running_count()
        limit = self.max_concurrent_subagents
        if running >= limit:
            return (
                f"Cannot delegate to {definition.display_name}: concurrency limit "
                f"reached ({running}/{limit} running). Wait for a running task "
                f"to complete before delegating a new one."
            )

        store = job_store or self._default_job_store()
        job = store.create(
            room_id=room_id,
            requested_by=requested_by,
            assigned_to=target,
            task=task,
            success_criteria=success_criteria,
            workflow_run_id=workflow_run_id,
        )
        task_id = job.id
        origin = {"channel": origin_channel, "chat_id": origin_chat_id, "session_key": session_key}
        status = SubagentStatus(
            task_id=task_id,
            label=definition.display_name,
            task_description=task,
            started_at=time.monotonic(),
        )
        self._task_statuses[task_id] = status

        bg_task = asyncio.create_task(
            self._run_named_agent(
                task_id, job, definition, origin, status, registry, store, origin_message_id
            )
        )
        self._running_tasks[task_id] = bg_task
        if session_key:
            self._session_tasks.setdefault(session_key, set()).add(task_id)

        def _cleanup(_: asyncio.Task) -> None:
            self._running_tasks.pop(task_id, None)
            self._task_statuses.pop(task_id, None)
            if session_key and (ids := self._session_tasks.get(session_key)):
                ids.discard(task_id)
                if not ids:
                    del self._session_tasks[session_key]

        bg_task.add_done_callback(_cleanup)

        logger.info("Delegated job [{}] to agent {!r}: {}", task_id, target, task[:60])
        return (
            f"Delegated to {definition.display_name} (job {task_id}). "
            f"I'll relay their update when the job completes."
        )

    def _default_job_store(self) -> AgentJobStore:
        """Job store under the calling session's workspace (guide 6.1)."""
        from mona.agent.tools.path_utils import get_current_workspace

        root = get_current_workspace(self.workspace)
        return self._job_store(root)

    def _job_store(self, root: Path) -> AgentJobStore:
        """Return the cached job store for a workspace root."""
        key = Path(root).expanduser().resolve()
        store = self._job_stores.get(key)
        if store is None:
            store = AgentJobStore(AgentJobStore.default_dir(key))
            self._job_stores[key] = store
        return store

    def _workspace_root_for_room(self, room_id: str) -> Path:
        """Resolve the workspace backing a room session.

        Project rooms keep state under the project directory; every other
        room falls back to the shared output workspace, matching the
        workspace the delegating turn ran under.
        """
        root: Path | None = None
        if self._sessions is not None:
            try:
                session = self._sessions.get_or_create(f"websocket:{room_id}")
                override = session.metadata.get("workspace")
                if isinstance(override, str) and override.strip():
                    root = Path(override)
            except Exception:
                logger.exception("Cannot resolve workspace for room {}", room_id)
        if root is None:
            from mona.config.paths import get_shared_output_dir

            root = get_shared_output_dir(self.workspace)
        return Path(root).expanduser().resolve()

    def job_store_for_room(self, room_id: str) -> AgentJobStore:
        """Resolve the job store backing a room session's workspace."""
        return self._job_store(self._workspace_root_for_room(room_id))

    def workflow_store_for_room(self, room_id: str) -> WorkflowStore:
        """Resolve the workflow definition store for a room (guide 6.1)."""
        root = self._workspace_root_for_room(room_id)
        store = self._workflow_stores.get(root)
        if store is None:
            store = WorkflowStore(WorkflowStore.default_dir(root))
            self._workflow_stores[root] = store
        return store

    def run_store_for_room(self, room_id: str) -> WorkflowRunStore:
        """Resolve the workflow run store for a room (guide 6.1)."""
        return self._run_store_for_root(self._workspace_root_for_room(room_id))

    def _run_store_for_root(self, root: Path) -> WorkflowRunStore:
        store = self._run_stores.get(root)
        if store is None:
            store = WorkflowRunStore(WorkflowRunStore.default_dir(root))
            self._run_stores[root] = store
        return store

    def workflow_runner_for_room(self, room_id: str) -> WorkflowRunner:
        """Return (or create) the WorkflowRunner bound to a room.

        One runner per room process-wide: the WebSocket channel and the cron
        callback share it, so the per-room active-run lock really is
        exclusive (guide 7.6).
        """
        runner = self._workflow_runners.get(room_id)
        if runner is None:

            def observer(run: WorkflowRun) -> None:
                if self.workflow_run_observer is not None:
                    try:
                        self.workflow_run_observer(room_id, serialize_run(run))
                    except Exception:
                        logger.exception("Workflow run observer failed for {}", room_id)

            async def executor(
                run: WorkflowRun,
                step: WorkflowStep,
                upstream: dict[str, dict[str, Any] | None],
            ) -> str:
                return await self.execute_workflow_step(
                    room_id=room_id, run=run, step=step, upstream=upstream,
                )

            runner = WorkflowRunner(
                run_store=self.run_store_for_room(room_id),
                step_executor=executor,
                observer=observer,
                max_parallel=max(1, self.max_concurrent_subagents),
            )
            self._workflow_runners[room_id] = runner
        return runner

    def sync_workflow_cron(self, room_id: str, workflow: WorkflowDefinition | None) -> None:
        """Sync the room's workflow cron entry with the active revision.

        One entry per room (deterministic job id), replaced on every
        activation so schedules never accumulate; removed when the active
        workflow is manual-only or gone (guide 7.7). No-op when the gateway
        has no cron service wired.
        """
        cron = self.cron_service
        if cron is None:
            return
        from mona.cron.types import CronJob, CronPayload, CronSchedule

        job_id = f"wf_{room_id}"
        trigger = workflow.trigger if workflow is not None else None
        if workflow is None or trigger is None or trigger.type != "cron" or not trigger.expr:
            if cron.remove_job(job_id) == "removed":
                logger.info("Removed workflow cron entry {} (manual trigger)", job_id)
            return
        cron.register_system_job(CronJob(
            id=job_id,
            name=f"workflow:{room_id}",
            enabled=True,
            schedule=CronSchedule(kind="cron", expr=trigger.expr, tz=trigger.tz),
            payload=CronPayload(kind="workflow_run", room_id=room_id),
        ))

    def workflow_attention_for_rooms(
        self, room_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        """Batch IM session-list workflow state for room sessions (IM plan 12.1).

        Returns ``{room_id: {"workflow_run_status", "waiting_approval",
        "scheduled"}}`` sourced from persisted runs and the active workflow
        definition — never from in-flight UI state. Rooms are grouped by
        workspace root so run files are scanned once per root instead of
        once per room. A room whose state cannot be read degrades to empty
        values rather than breaking the whole sessions list.
        """
        state: dict[str, dict[str, Any]] = {
            room_id: {
                "workflow_run_status": None,
                "waiting_approval": False,
                "scheduled": False,
            }
            for room_id in room_ids
        }
        by_root: dict[Path, list[str]] = {}
        for room_id in room_ids:
            try:
                root = self._workspace_root_for_room(room_id)
            except Exception:
                logger.exception("Cannot resolve workspace for room {}", room_id)
                continue
            by_root.setdefault(root, []).append(room_id)
        for root, ids in by_root.items():
            try:
                latest_runs = self._run_store_for_root(root).latest_by_room()
            except Exception:
                logger.exception("Cannot scan workflow runs under {}", root)
                latest_runs = {}
            for room_id in ids:
                run = latest_runs.get(room_id)
                if run is not None:
                    entry = state[room_id]
                    entry["workflow_run_status"] = run.status
                    entry["waiting_approval"] = run.status == RUN_STATUS_WAITING_APPROVAL
                try:
                    active = self.workflow_store_for_room(room_id).get_active(room_id)
                except Exception:
                    logger.exception("Cannot load active workflow for room {}", room_id)
                    continue
                if active is not None and active.trigger.type == "cron" and active.trigger.expr:
                    state[room_id]["scheduled"] = True
        return state

    def propose_workflow_draft(
        self,
        *,
        room_id: str,
        goal: str,
        steps: list[WorkflowStep],
        conversation: ConversationMetadata,
    ) -> WorkflowDefinition:
        """Persist a tool-proposed workflow draft and notify observers.

        Validation (structure, room membership, enabled agents) happens in
        ``WorkflowStore.save_draft``; the observer hook lets the WebSocket
        channel broadcast ``workflow_updated`` so the room editor loads the
        draft for user confirmation (guide 9.5). The draft is never
        activated here — activation stays an explicit user action.
        """
        store = self.workflow_store_for_room(room_id)
        draft = store.save_draft(
            room_id,
            goal=goal,
            trigger=None,
            steps=steps,
            created_by="mona",
            conversation=conversation,
            registry=AgentRegistry(),
        )
        if self.workflow_draft_observer is not None:
            try:
                self.workflow_draft_observer(room_id, serialize_workflow(draft))
            except Exception:
                logger.exception("Workflow draft observer failed for {}", room_id)
        return draft

    async def execute_workflow_step(
        self,
        *,
        room_id: str,
        run: WorkflowRun,
        step: WorkflowStep,
        upstream: dict[str, dict[str, Any] | None],
        registry: AgentRegistry | None = None,
    ) -> str:
        """WorkflowRunner step executor: run one agent step as a blocking job.

        Creates a tracked AgentJob (linked to the run/step), awaits the
        named-agent execution inline and returns the result summary. The job
        file carries every transition, so the room projection survives a
        restart (guide 7.6). Raises :class:`StepExecutionError` when the job
        ends in a non-succeeded terminal state.
        """
        assert step.agent_id is not None  # enforced by the step model
        registry = registry or AgentRegistry()
        definition = registry.get(step.agent_id)
        if definition is None:
            raise StepExecutionError(
                f"agent {step.agent_id!r} is not installed or is disabled"
            )
        store = self.job_store_for_room(room_id)
        task = compose_step_task(step, upstream)
        job = store.create(
            room_id=room_id,
            requested_by=MONA_AGENT_ID,
            assigned_to=step.agent_id,
            task=task,
            success_criteria=step.expected_output,
            workflow_run_id=run.id,
            workflow_step_id=step.id,
        )
        session_key = f"websocket:{room_id}"
        origin = {"channel": "websocket", "chat_id": room_id, "session_key": session_key}
        status = SubagentStatus(
            task_id=job.id,
            label=definition.display_name,
            task_description=task,
            started_at=time.monotonic(),
        )
        self._task_statuses[job.id] = status
        try:
            # announce=False: a workflow run must not wake the room's main
            # agent for every step; step results flow through the run file.
            await self._run_named_agent(
                job.id, job, definition, origin, status, registry, store,
                announce=False,
            )
        finally:
            self._task_statuses.pop(job.id, None)
        final = store.load(job.id)
        if final.status == JOB_STATUS_SUCCEEDED:
            return final.result or ""
        raise StepExecutionError(
            final.error or f"job {job.id} ended in state {final.status!r}"
        )

    async def cancel_job(
        self,
        job_id: str,
        *,
        room_id: str,
        reason: str | None = None,
        job_store: AgentJobStore | None = None,
    ) -> AgentJob:
        """Cancel a queued/running room job (CAS), then stop its local task.

        The persisted state flips to ``cancelled`` first, so a racing
        completion can never overwrite it (terminal states have no outgoing
        transitions). A job whose ``room_id`` does not match is reported as
        not found — cross-room job IDs must not leak.
        """
        store = job_store or self.job_store_for_room(room_id)
        job = store.load(job_id)
        if job.room_id != room_id:
            raise JobNotFoundError(job_id)
        cancelled = store.cancel_job(job_id, reason=reason)
        task = self._running_tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return cancelled

    def _build_named_agent_tools(
        self,
        definition: AgentDefinition,
        job: AgentJob,
    ) -> ToolRegistry:
        """Build the tool registry for a named agent run.

        The manifest allowlist is intersected with the platform-safe table;
        Mona-only tools (spawn/delegate_agent) can never leak into a partner
        agent (loader guarantee, guide 7.2). An empty allowlist means no
        tools at all.
        """
        from mona.agent.tools.path_utils import get_current_workspace

        root = get_current_workspace(self.workspace)
        registry = ToolRegistry()
        ctx = ToolContext(
            config=self._subagent_tools_config(),
            workspace=str(root.resolve()),
            file_state_store=FileStates(),
            agent_id=definition.id,
            conversation_id=job.room_id,
            room_id=job.room_id,
            job_id=job.id,
            workflow_run_id=job.workflow_run_id,
        )
        ToolLoader().load(
            ctx, registry, scope="subagent", tool_allowlist=definition.tool_allowlist
        )
        return registry

    def _build_named_agent_prompt(
        self,
        definition: AgentDefinition,
        registry: AgentRegistry,
    ) -> str:
        """System prompt for a named agent run.

        Package identity (display name + prompt.md) and the agent's private
        long-term memory lead; the shared subagent rules carry the agent's
        visible skills (private + package).
        """
        from mona.agent.context import ContextBuilder
        from mona.agent.memory import MemoryStore
        from mona.agent.skills import SkillsLoader

        parts: list[str] = []
        package_prompt = registry.load_prompt(definition.id).strip()
        if package_prompt:
            parts.append(f"# Agent: {definition.display_name}\n\n{package_prompt}")
        memory = MemoryStore(self.workspace, agent_id=definition.id).get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")
        time_ctx = ContextBuilder._build_runtime_context(None, None)
        skills_summary = SkillsLoader(
            self.workspace,
            disabled_skills=self.disabled_skills,
            agent_id=definition.id,
            package_skill_dirs=registry.resolve_skill_dirs(definition.id),
        ).build_skills_summary()
        parts.append(render_template(
            "agent/subagent_system.md",
            time_ctx=time_ctx,
            workspace=str(self.workspace),
            skills_summary=skills_summary or "",
        ))
        return "\n\n---\n\n".join(parts)

    def _record_agent_job_history(
        self,
        definition: AgentDefinition,
        job: AgentJob,
        outcome: str,
        result: str,
    ) -> None:
        """Append a compact run record to the agent's private history.jsonl.

        Named agents build long-term memory from their own execution history:
        every finished job leaves a trace that later runs (and future memory
        consolidation) can draw on.
        """
        from mona.agent.memory import MemoryStore

        try:
            store = MemoryStore(self.workspace, agent_id=definition.id)
            task_summary = " ".join(job.task.split())[:200]
            result_summary = " ".join(result.split())[:400]
            store.append_history(
                f"Job {job.id} ({outcome}) task: {task_summary} | result: {result_summary}"
            )
        except Exception:
            logger.exception(
                "Failed to record job history for agent {}", definition.id
            )

    async def _run_named_agent(
        self,
        task_id: str,
        job: AgentJob,
        definition: AgentDefinition,
        origin: dict[str, str],
        status: SubagentStatus,
        registry: AgentRegistry,
        store: AgentJobStore,
        origin_message_id: str | None = None,
        announce: bool = True,
    ) -> None:
        """Execute a named-agent job and persist every state transition.

        Order is strict (guide 7.4): CAS to ``running`` before execution;
        write the terminal job state first, then post the agent-authored room
        message and the Mona inject. A late callback that loses the CAS race
        is dropped, never applied over a newer terminal state.
        """
        label = definition.display_name
        logger.debug("Named agent job [{}] starting: {}", task_id, label)

        async def _announce(*args: Any, **kwargs: Any) -> None:
            """Workflow steps skip the bus announce (announce=False)."""
            if not announce:
                return
            await self._announce_result(*args, **kwargs)

        async def _on_checkpoint(payload: dict) -> None:
            status.phase = payload.get("phase", status.phase)
            status.iteration = payload.get("iteration", status.iteration)

        def _finish(target_status: str, **fields: Any) -> bool:
            try:
                store.transition(job.id, target_status, **fields)
                return True
            except JobTransitionError:
                logger.info(
                    "Job [{}] no longer accepts {} (late callback); dropping update",
                    job.id, target_status,
                )
                return False
            except Exception:
                logger.exception("Job [{}] failed to persist {} state", job.id, target_status)
                return False

        def _fail(error: str) -> bool:
            """Persist ``failed`` via the strict running-only CAS (guide 7.4)."""
            try:
                store.fail_job(job.id, error=error)
                return True
            except JobTransitionError:
                logger.info(
                    "Job [{}] no longer accepts 'failed' (late callback); dropping update",
                    job.id,
                )
                return False
            except Exception:
                logger.exception("Job [{}] failed to persist 'failed' state", job.id)
                return False

        try:
            try:
                store.mark_running(job.id)
            except JobTransitionError:
                logger.info("Job [{}] left queued state before start; aborting", job.id)
                return
            tools = self._build_named_agent_tools(definition, job)
            system_prompt = self._build_named_agent_prompt(definition, registry)
            user_content = job.task
            if job.success_criteria:
                user_content += f"\n\n[Success criteria]\n{job.success_criteria}"
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]

            sess_key = origin.get("session_key")
            llm_timeout = (
                self._llm_wall_timeout_for_session(sess_key)
                if self._llm_wall_timeout_for_session
                else None
            )
            result = await self.runner.run(AgentRunSpec(
                initial_messages=messages,
                tools=tools,
                model=self.model,
                max_iterations=self.max_iterations,
                max_tool_result_chars=self.max_tool_result_chars,
                hook=_SubagentHook(task_id, status),
                max_iterations_message="Task completed but no final response was generated.",
                error_message=None,
                fail_on_tool_error=True,
                checkpoint_callback=_on_checkpoint,
                session_key=sess_key,
                llm_timeout_s=llm_timeout,
            ))
            status.phase = "done"
            status.stop_reason = result.stop_reason

            if result.stop_reason == "tool_error":
                status.tool_events = list(result.tool_events)
                partial = self._format_partial_progress(result)
                if not _fail(partial):
                    return
                self._record_agent_job_history(definition, job, "failed", partial)
                self._post_agent_room_message(origin, job, definition, partial)
                await _announce(
                    task_id, label, job.task, partial, origin, "error",
                    origin_message_id, job=job, definition=definition,
                )
            elif result.stop_reason == "error":
                error = result.error or "Error: agent execution failed."
                if not _fail(error):
                    return
                self._record_agent_job_history(definition, job, "failed", error)
                self._post_agent_room_message(origin, job, definition, error)
                await _announce(
                    task_id, label, job.task, error, origin, "error",
                    origin_message_id, job=job, definition=definition,
                )
            else:
                final_result = result.final_content or "Task completed but no final response was generated."
                logger.info("Named agent job [{}] completed successfully", task_id)
                if not _finish("succeeded", result=final_result):
                    return
                self._record_agent_job_history(definition, job, "succeeded", final_result)
                self._post_agent_room_message(origin, job, definition, final_result)
                await _announce(
                    task_id, label, job.task, final_result, origin, "ok",
                    origin_message_id, job=job, definition=definition,
                )

        except asyncio.CancelledError:
            status.phase = "error"
            status.error = "cancelled"
            _finish("cancelled")
            raise
        except Exception as e:
            status.phase = "error"
            status.error = str(e)
            logger.exception("Named agent job [{}] failed", task_id)
            if _fail(str(e)):
                self._post_agent_room_message(origin, job, definition, f"Error: {e}")
            await _announce(
                task_id, label, job.task, f"Error: {e}", origin, "error",
                origin_message_id, job=job, definition=definition,
            )

    def _post_agent_room_message(
        self,
        origin: dict[str, str],
        job: AgentJob,
        definition: AgentDefinition,
        content: str,
    ) -> None:
        """Append the agent-authored message to the room session (best effort).

        A failure here never rolls back a completed job — the room projection
        can be rebuilt from the job file after reconnect (guide 7.4).
        """
        if self._sessions is None or not content.strip():
            return
        try:
            channel = origin.get("channel") or "websocket"
            session = self._sessions.get_or_create(f"{channel}:{job.room_id}")
            session.add_message(
                "assistant",
                content,
                author_id=definition.id,
                message_type="message",
                job_id=job.id,
            )
            self._sessions.save(session)
        except Exception:
            logger.exception("Failed to post room message for job {}", job.id)

    async def _run_subagent(
        self,
        task_id: str,
        task: str,
        label: str,
        origin: dict[str, str],
        status: SubagentStatus,
        origin_message_id: str | None = None,
    ) -> None:
        """Execute the subagent task and announce the result."""
        logger.debug("Subagent [{}] starting task: {}", task_id, label)

        async def _on_checkpoint(payload: dict) -> None:
            status.phase = payload.get("phase", status.phase)
            status.iteration = payload.get("iteration", status.iteration)

        try:
            tools = self._build_tools()
            system_prompt = self._build_subagent_prompt()
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task},
            ]

            sess_key = origin.get("session_key")
            llm_timeout = (
                self._llm_wall_timeout_for_session(sess_key)
                if self._llm_wall_timeout_for_session
                else None
            )
            result = await self.runner.run(AgentRunSpec(
                initial_messages=messages,
                tools=tools,
                model=self.model,
                max_iterations=self.max_iterations,
                max_tool_result_chars=self.max_tool_result_chars,
                hook=_SubagentHook(task_id, status),
                max_iterations_message="Task completed but no final response was generated.",
                error_message=None,
                fail_on_tool_error=True,
                checkpoint_callback=_on_checkpoint,
                session_key=sess_key,
                llm_timeout_s=llm_timeout,
            ))
            status.phase = "done"
            status.stop_reason = result.stop_reason

            if result.stop_reason == "tool_error":
                status.tool_events = list(result.tool_events)
                await self._announce_result(
                    task_id, label, task,
                    self._format_partial_progress(result),
                    origin, "error", origin_message_id,
                )
            elif result.stop_reason == "error":
                await self._announce_result(
                    task_id, label, task,
                    result.error or "Error: subagent execution failed.",
                    origin, "error", origin_message_id,
                )
            else:
                final_result = result.final_content or "Task completed but no final response was generated."
                logger.info("Subagent [{}] completed successfully", task_id)
                await self._announce_result(task_id, label, task, final_result, origin, "ok", origin_message_id)

        except Exception as e:
            status.phase = "error"
            status.error = str(e)
            logger.exception("Subagent [{}] failed", task_id)
            await self._announce_result(task_id, label, task, f"Error: {e}", origin, "error", origin_message_id)

    async def _announce_result(
        self,
        task_id: str,
        label: str,
        task: str,
        result: str,
        origin: dict[str, str],
        status: str,
        origin_message_id: str | None = None,
        job: AgentJob | None = None,
        definition: AgentDefinition | None = None,
    ) -> None:
        """Announce the subagent result to the main agent via the message bus."""
        status_text = "completed successfully" if status == "ok" else "failed"

        announce_content = render_template(
            "agent/subagent_announce.md",
            label=label,
            status_text=status_text,
            task=task,
            result=result,
        )

        # Inject as system message to trigger main agent.
        # Use session_key_override to align with the main agent's effective
        # session key (which accounts for unified sessions) so the result is
        # routed to the correct pending queue (mid-turn injection) instead of
        # being dispatched as a competing independent task.
        override = origin.get("session_key") or f"{origin['channel']}:{origin['chat_id']}"
        metadata: dict[str, Any] = {
            "injected_event": "subagent_result",
            "subagent_task_id": task_id,
        }
        if job is not None:
            metadata["job_id"] = job.id
            metadata["room_id"] = job.room_id
        if definition is not None:
            metadata["agent_author_id"] = definition.id
        if origin_message_id:
            metadata["origin_message_id"] = origin_message_id
        msg = InboundMessage(
            channel="system",
            sender_id="subagent",
            chat_id=f"{origin['channel']}:{origin['chat_id']}",
            content=announce_content,
            session_key_override=override,
            metadata=metadata,
        )

        await self.bus.publish_inbound(msg)
        logger.debug("Subagent [{}] announced result to {}:{}", task_id, origin['channel'], origin['chat_id'])

    @staticmethod
    def _format_partial_progress(result) -> str:
        completed = [e for e in result.tool_events if e["status"] == "ok"]
        failure = next((e for e in reversed(result.tool_events) if e["status"] == "error"), None)
        lines: list[str] = []
        if completed:
            lines.append("Completed steps:")
            for event in completed[-3:]:
                lines.append(f"- {event['name']}: {event['detail']}")
        if failure:
            if lines:
                lines.append("")
            lines.append("Failure:")
            lines.append(f"- {failure['name']}: {failure['detail']}")
        if result.error and not failure:
            if lines:
                lines.append("")
            lines.append("Failure:")
            lines.append(f"- {result.error}")
        return "\n".join(lines) or (result.error or "Error: subagent execution failed.")

    def _build_subagent_prompt(self) -> str:
        """Build a focused system prompt for the subagent."""
        from mona.agent.context import ContextBuilder
        from mona.agent.skills import SkillsLoader

        time_ctx = ContextBuilder._build_runtime_context(None, None)
        skills_summary = SkillsLoader(
            self.workspace,
            disabled_skills=self.disabled_skills,
        ).build_skills_summary()
        return render_template(
            "agent/subagent_system.md",
            time_ctx=time_ctx,
            workspace=str(self.workspace),
            skills_summary=skills_summary or "",
        )

    async def cancel_by_session(self, session_key: str) -> int:
        """Cancel all subagents for the given session. Returns count cancelled."""
        tasks = [self._running_tasks[tid] for tid in self._session_tasks.get(session_key, [])
                 if tid in self._running_tasks and not self._running_tasks[tid].done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return len(tasks)

    async def recover_jobs(
        self,
        *,
        registry: AgentRegistry | None = None,
        job_stores: list[AgentJobStore] | None = None,
    ) -> dict[str, int]:
        """Reconcile non-terminal jobs left behind by a restart (guide 7.4).

        ``queued`` jobs are relaunched (their side effects never started);
        ``running`` jobs are marked failed — a crashed process cannot prove
        they are safe to resume. Returns a small stats dict for logging.
        """
        registry = registry or AgentRegistry()
        stores = job_stores if job_stores is not None else self._recovery_job_stores()
        stats = {"restarted": 0, "failed": 0, "skipped": 0}
        for store in stores:
            try:
                pending = store.list_non_terminal()
            except Exception:
                logger.exception("Job recovery: cannot scan {}", store.jobs_dir)
                continue
            for job in pending:
                if job.status == JOB_STATUS_RUNNING:
                    try:
                        store.fail_job(
                            job.id,
                            error="Process restarted before the job finished; "
                            "a running job cannot be proven safe to resume.",
                        )
                        stats["failed"] += 1
                        logger.warning("Job recovery: running job [{}] marked failed", job.id)
                    except Exception:
                        logger.exception("Job recovery: cannot fail job [{}]", job.id)
                    continue
                definition = registry.get(job.assigned_to)
                if definition is None:
                    try:
                        store.mark_failed(
                            job.id,
                            error=f"Agent {job.assigned_to!r} is not installed or is disabled.",
                        )
                        stats["failed"] += 1
                        logger.warning(
                            "Job recovery: queued job [{}] failed, agent {!r} unavailable",
                            job.id, job.assigned_to,
                        )
                    except Exception:
                        logger.exception("Job recovery: cannot fail job [{}]", job.id)
                    continue
                if self.get_running_count() >= self.max_concurrent_subagents:
                    stats["skipped"] += 1
                    logger.info("Job recovery: job [{}] stays queued (concurrency limit)", job.id)
                    continue
                self._relaunch_job(store, job, definition, registry)
                stats["restarted"] += 1
                logger.info("Job recovery: relaunched queued job [{}]", job.id)
        if any(stats.values()):
            logger.info(
                "Job recovery complete: {} restarted, {} failed, {} skipped",
                stats["restarted"], stats["failed"], stats["skipped"],
            )
        return stats

    def _recovery_job_stores(self) -> list[AgentJobStore]:
        """Job stores to scan on startup: every workspace a session can bind."""
        from mona.config.paths import get_shared_output_dir

        roots: list[Path] = [self.workspace, get_shared_output_dir(self.workspace)]
        if self._sessions is not None:
            try:
                for item in self._sessions.list_sessions():
                    override = item.get("workspace")
                    if isinstance(override, str) and override.strip():
                        roots.append(Path(override))
            except Exception:
                logger.exception("Job recovery: cannot enumerate session workspaces")
        stores: list[AgentJobStore] = []
        seen: set[Path] = set()
        for root in roots:
            key = Path(root).expanduser().resolve()
            if key in seen:
                continue
            seen.add(key)
            stores.append(self._job_store(key))
        return stores

    async def recover_workflow_runs(self) -> dict[str, int]:
        """Reconcile non-terminal workflow runs left by a restart (guide 7.6).

        - ``waiting_approval`` runs stay untouched: the approval card
          survives the restart and resolution resumes the run. Approvals
          that expired while the process was down fail the run instead.
        - ``running`` runs cannot be proven free of side effects: running
          steps are failed and the run fails.
        - ``queued`` runs never started, so re-driving them is safe.
        """
        stats = {"resumed": 0, "failed": 0, "waiting": 0}
        for store in self._recovery_run_stores():
            try:
                pending = store.list_non_terminal()
            except Exception:
                logger.exception("Workflow recovery: cannot scan {}", store.runs_dir)
                continue
            for run in pending:
                try:
                    outcome = self._reconcile_run(store, run)
                    stats[outcome] += 1
                except Exception:
                    logger.exception("Workflow recovery: cannot reconcile run {}", run.id)
        if any(stats.values()):
            logger.info(
                "Workflow recovery complete: {} resumed, {} failed, {} waiting approval",
                stats["resumed"], stats["failed"], stats["waiting"],
            )
        return stats

    def _reconcile_run(self, store: WorkflowRunStore, run: WorkflowRun) -> str:
        if run.status == RUN_STATUS_WAITING_APPROVAL:
            expired = [
                sid
                for sid, step in run.steps.items()
                if step.status == STEP_STATUS_WAITING_APPROVAL
                and step.approval_expires_at is not None
                and step.approval_expires_at <= datetime.now()
            ]
            if not expired:
                return "waiting"
            runner = self.workflow_runner_for_room(run.room_id)
            runner.fail_run(
                run.id,
                failed_step=expired[0],
                reason="Approval expired while the application was closed.",
            )
            return "failed"
        if run.status == RUN_STATUS_RUNNING:
            store.reconcile_interrupted(
                run.id,
                reason="Process restarted before the run finished; a running "
                "step cannot be proven safe to resume.",
            )
            return "failed"
        # queued: the driver never started, so re-driving has no side effects.
        runner = self.workflow_runner_for_room(run.room_id)
        task = asyncio.create_task(runner.resume(run.id))

        def _done(done: asyncio.Task, run_id: str = run.id) -> None:
            if done.cancelled():
                return
            exc = done.exception()
            if exc is not None:
                logger.opt(exception=exc).error(
                    "Workflow recovery: resume of run {} failed", run_id
                )

        task.add_done_callback(_done)
        return "resumed"

    def _recovery_run_stores(self) -> list[WorkflowRunStore]:
        """Run stores to scan on startup: every workspace a session can bind."""
        from mona.config.paths import get_shared_output_dir

        roots: list[Path] = [self.workspace, get_shared_output_dir(self.workspace)]
        if self._sessions is not None:
            try:
                for item in self._sessions.list_sessions():
                    override = item.get("workspace")
                    if isinstance(override, str) and override.strip():
                        roots.append(Path(override))
            except Exception:
                logger.exception("Workflow recovery: cannot enumerate session workspaces")
        stores: list[WorkflowRunStore] = []
        seen: set[Path] = set()
        for root in roots:
            key = Path(root).expanduser().resolve()
            if key in seen:
                continue
            seen.add(key)
            stores.append(self._run_store_for_root(key))
        return stores

    def _relaunch_job(
        self,
        store: AgentJobStore,
        job: AgentJob,
        definition: AgentDefinition,
        registry: AgentRegistry,
    ) -> None:
        """Restart execution of a recovered ``queued`` job in the background."""
        session_key = f"websocket:{job.room_id}"
        origin = {"channel": "websocket", "chat_id": job.room_id, "session_key": session_key}
        status = SubagentStatus(
            task_id=job.id,
            label=definition.display_name,
            task_description=job.task,
            started_at=time.monotonic(),
        )
        self._task_statuses[job.id] = status
        bg_task = asyncio.create_task(
            self._run_named_agent(job.id, job, definition, origin, status, registry, store)
        )
        self._running_tasks[job.id] = bg_task
        self._session_tasks.setdefault(session_key, set()).add(job.id)

        def _cleanup(_: asyncio.Task) -> None:
            self._running_tasks.pop(job.id, None)
            self._task_statuses.pop(job.id, None)
            if ids := self._session_tasks.get(session_key):
                ids.discard(job.id)
                if not ids:
                    del self._session_tasks[session_key]

        bg_task.add_done_callback(_cleanup)

    def get_running_count(self) -> int:
        """Return the number of currently running subagents."""
        return len(self._running_tasks)

    def get_running_count_by_session(self, session_key: str) -> int:
        """Return the number of currently running subagents for a session."""
        tids = self._session_tasks.get(session_key, set())
        return sum(
            1 for tid in tids
            if tid in self._running_tasks and not self._running_tasks[tid].done()
        )
