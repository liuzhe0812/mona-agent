"""Desktop backend process entry points."""

import asyncio
import os
import sys
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any

import typer
from loguru import logger
from rich.console import Console

from mona import __logo__, __version__
from mona.agent.loop import AgentLoop
from mona.config.migrate_workspace_output import run_startup_migrations
from mona.config.paths import is_default_workspace
from mona.config.schema import Config

if TYPE_CHECKING:
    from mona.cron.types import CronJob

# Force UTF-8 encoding for Windows console
if sys.platform == "win32":
    _stdout_ok = sys.stdout is not None and hasattr(sys.stdout, "encoding")
    if _stdout_ok and sys.stdout.encoding != "utf-8":
        os.environ["PYTHONIOENCODING"] = "utf-8"
        # Re-open stdout/stderr with UTF-8 encoding
        with suppress(Exception):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Use the shared log format without exposing exception locals.
logger.remove()
_log_handler_id = logger.add(
    sys.stderr,
    format=(
        "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
        "<level>{level: <5}</level> | "
        "<cyan>{extra[channel]}</cyan> | "
        "<level>{message}</level>"
    ),
    level="INFO",
    colorize=None,
    filter=lambda record: record["extra"].setdefault("channel", "-") or True,
    # P0-5: 关闭异常诊断，避免 logger.exception 把请求局部变量（含解密后的 IMAP/SMTP 凭据）写入日志
    backtrace=False,
    diagnose=False,
)

app = typer.Typer(
    name="mona",
    context_settings={"help_option_names": ["-h", "--help"]},
    help="Mona desktop backend",
    add_completion=False,
    no_args_is_help=True,
)

console = Console()


def version_callback(value: bool):
    if value:
        console.print(f"{__logo__} mona v{__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        None, "--version", "-v", callback=version_callback, is_eager=True
    ),
):
    """Run a Mona desktop backend process."""
    pass


def _model_display(config: Config) -> tuple[str, str]:
    """Return (resolved_model_name, preset_tag) for display strings."""
    resolved = config.resolve_preset()
    name = config.agents.defaults.model_preset
    tag = f" (preset: {name})" if name else ""
    return resolved.model, tag


def _load_runtime_config(config: str | None = None, workspace: str | None = None) -> Config:
    """Load config and optionally override the active workspace."""
    from mona.config.loader import load_config, resolve_config_env_vars, set_config_path

    config_path = None
    if config:
        config_path = Path(config).expanduser().resolve()
        if not config_path.exists():
            console.print(f"[red]Error: Config file not found: {config_path}[/red]")
            raise typer.Exit(1)
        set_config_path(config_path)
        console.print(f"[dim]Using config: {config_path}[/dim]")

    try:
        loaded = resolve_config_env_vars(load_config(config_path))
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
    _warn_deprecated_config_keys(config_path)
    if workspace:
        loaded.agents.defaults.workspace = workspace
    return loaded


def _warn_deprecated_config_keys(config_path: Path | None) -> None:
    """Hint users to remove obsolete keys from their config file."""
    import json

    from mona.config.loader import get_config_path

    path = config_path or get_config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    if "memoryWindow" in raw.get("agents", {}).get("defaults", {}):
        console.print(
            "[dim]Hint: `memoryWindow` in your config is no longer used "
            "and can be safely removed.[/dim]"
        )


def _migrate_cron_store(config: "Config") -> None:
    """One-time migration: move legacy global cron store into the workspace."""
    from mona.config.paths import get_cron_dir

    legacy_path = get_cron_dir() / "jobs.json"
    new_path = config.workspace_path / "cron" / "jobs.json"
    if legacy_path.is_file() and not new_path.exists():
        new_path.parent.mkdir(parents=True, exist_ok=True)
        import shutil

        shutil.move(str(legacy_path), str(new_path))


@app.command()
def gateway(
    port: int | None = typer.Option(None, "--port", "-p", help="Gateway port"),
    workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    config: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
):
    """Start the mona gateway."""
    if verbose:
        logger.remove(_log_handler_id)
        logger.add(
            sys.stderr,
            format=(
                "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
                "<level>{level: <5}</level> | "
                "<cyan>{extra[channel]}</cyan> | "
                "<level>{message}</level>"
            ),
            level="DEBUG",
            colorize=None,
            filter=lambda record: record["extra"].setdefault("channel", "-") or True,
            # P0-5: verbose 模式同样关闭异常诊断，避免凭据泄露
            backtrace=False,
            diagnose=False,
        )
    cfg = _load_runtime_config(config, workspace)
    _run_gateway(cfg, port=port)


async def _run_partner_dream(
    job: "CronJob",
    *,
    agent: AgentLoop,
    dream_cfg: Any,
) -> None:
    """Run a partner agent's private Dream for a ``dream-<agent_id>`` job.

    Builds a lightweight Dream on the agent's private MemoryStore — no full
    PartnerAgentLoop is needed since Dream never enters the agent loop.
    Shares Mona's DreamConfig (maintenance knobs) and provider.
    """
    from mona.agent.memory import Dream, MemoryStore
    from mona.agent.partners import MONA_AGENT_ID, AgentRegistry

    partner_id = (job.payload.agent_id or job.name.removeprefix("dream-")).strip()
    if not partner_id or partner_id == MONA_AGENT_ID:
        await agent.dream.run()
        return
    definition = AgentRegistry().get(partner_id)
    if definition is None:
        logger.warning("Partner dream skipped: agent '{}' is not installed", partner_id)
        return
    # Manifest model pinning mirrors PartnerAgentLoop: "inherit" follows the
    # gateway's current model; any other value pins the partner's Dream.
    manifest_model = (definition.model or "").strip()
    if manifest_model and manifest_model.lower() != "inherit":
        model = manifest_model
    else:
        model = dream_cfg.model_override or agent.model
    from mona.agent.user_config import load_agent_user_config

    disabled_skills = list(load_agent_user_config(partner_id).disabled_skills)
    partner_dream = Dream(
        store=MemoryStore(agent.workspace, agent_id=partner_id),
        provider=agent.provider,
        model=model,
        max_batch_size=dream_cfg.max_batch_size,
        max_iterations=dream_cfg.max_iterations,
        skill_prune_enabled=dream_cfg.skill_prune_enabled,
        archive_after_days=dream_cfg.archive_after_days,
        max_active_user_skills=dream_cfg.max_active_user_skills,
        disabled_skills=disabled_skills,
    )
    await partner_dream.run()


async def _execute_workflow_run_cron(
    job: "CronJob",
    *,
    subagents: Any,
    session_manager: Any,
    config: Any | None = None,
) -> None:
    """Dispatch a packaged or room workflow; retired stock tasks never resume."""
    from mona.agent.pack_templates import load_pack_template
    from mona.agent.workflow import _legacy_stock_workflow
    from mona.cron.service import CronSkip

    room_id = (job.payload.room_id or "").strip()
    if not room_id:
        raise CronSkip("workflow_run payload missing room_id")
    template_ref = (job.payload.template_ref or "").strip()
    if room_id in {"stock_research", "stock_ai_diagnosis"} or template_ref.startswith("package://com.mona.a-share-team/"):
        raise CronSkip("旧股票模块已移除，历史定时任务不会执行")
    if template_ref:
        workflow = load_pack_template(template_ref)
    else:
        workflow = subagents.workflow_store_for_room(room_id).get_active(room_id)
        if workflow is None:
            raise CronSkip(f"room {room_id!r} has no active workflow")
    if _legacy_stock_workflow(room_id, workflow):
        raise CronSkip("旧股票模块已移除，历史定时任务不会执行")
    runner = subagents.workflow_runner_for_room(room_id)
    if runner.active_run_for_room(room_id) is not None:
        raise CronSkip(f"room {room_id!r} already has an active run")
    session = session_manager.get_or_create(f"websocket:{room_id}")
    conversation = session.conversation_metadata
    if conversation.type != "room":
        raise CronSkip(f"chat {room_id!r} is no longer a collaboration room")

    async def _drive_workflow_run() -> None:
        from mona.agent.partners import AgentRegistry
        from mona.agent.workflow import RunConflictError

        try:
            await runner.run(
                room_id=room_id,
                workflow=workflow,
                trigger_type="cron",
                started_by="cron",
                conversation=conversation,
                registry=AgentRegistry(),
            )
        except RunConflictError:
            logger.info("Cron workflow run skipped: room {} already has an active run", room_id)
        except Exception:
            logger.exception("Cron workflow run failed for room {}", room_id)

    asyncio.create_task(_drive_workflow_run())


def _run_gateway(
    config: Config,
    *,
    port: int | None = None,
) -> None:
    """Run the desktop Agent runtime and its channels."""
    os.environ["MONA_PROCESS_ROLE"] = "gateway"
    from mona.agent.tools.cron import CronTool
    from mona.agent.tools.message import MessageTool
    from mona.bus.queue import MessageBus
    from mona.channels.manager import ChannelManager
    from mona.channels.websocket import publish_runtime_model_update
    from mona.cron.service import CronService
    from mona.cron.types import CronJob
    from mona.heartbeat.service import HeartbeatService
    from mona.providers.factory import build_provider_snapshot, load_provider_snapshot
    from mona.providers.image_generation import image_gen_provider_configs
    from mona.providers.video_generation import video_gen_provider_configs
    from mona.session.manager import SessionManager

    port = port if port is not None else config.gateway.port

    console.print(f"{__logo__} Starting mona gateway version {__version__} on port {port}...")
    # Run consolidated startup migrations: global resources → global templates
    # → shared output dir → loose artifact migration. The old
    # sync_workspace_templates + migrate_global_resources pair is superseded
    # by this single call which writes templates to ~/.mona/ (not workspace)
    # and uses move semantics for the migration.
    run_startup_migrations(config.workspace_path)
    bus = MessageBus()
    try:
        provider_snapshot = build_provider_snapshot(config)
    except ValueError as exc:
        console.print(f"[red]Error: {exc}[/red]")
        raise typer.Exit(1) from exc
    session_manager = SessionManager(config.workspace_path)

    # Preserve existing single-workspace installs, but keep custom workspaces clean.
    if is_default_workspace(config.workspace_path):
        _migrate_cron_store(config)

    # Create cron service with workspace-scoped store
    cron_store_path = config.workspace_path / "cron" / "jobs.json"
    cron = CronService(cron_store_path)

    # ScheduleService now lives in the services process. The gateway's agent
    # accesses it via an HTTP client (ScheduleServiceClient) so the tool works
    # identically whether services is local or remote.
    from mona.schedule import ScheduleServiceClient, TodoServiceClient

    schedule_client = ScheduleServiceClient.from_port(config.services.port)
    todo_client = TodoServiceClient.from_port(config.services.port)

    # Create agent with cron service
    agent = AgentLoop.from_config(
        config, bus,
        provider=provider_snapshot.provider,
        model=provider_snapshot.model,
        context_window_tokens=provider_snapshot.context_window_tokens,
        auto_compact_token_limit=provider_snapshot.auto_compact_token_limit,
        cron_service=cron,
        schedule_service=schedule_client,
        todo_service=todo_client,
        session_manager=session_manager,
        image_generation_provider_configs=image_gen_provider_configs(config),
        video_generation_provider_configs=video_gen_provider_configs(config),
        provider_snapshot_loader=load_provider_snapshot,
        runtime_model_publisher=lambda model, preset: publish_runtime_model_update(
            bus,
            model,
            preset,
        ),
        provider_signature=provider_snapshot.signature,
    )


    from mona.agent.loop import UNIFIED_SESSION_KEY
    from mona.bus.events import OutboundMessage

    def _channel_session_key(channel: str, chat_id: str) -> str:
        return (
            UNIFIED_SESSION_KEY
            if config.agents.defaults.unified_session
            else f"{channel}:{chat_id}"
        )

    async def _deliver_to_channel(
        msg: OutboundMessage, *, record: bool = False, session_key: str | None = None,
    ) -> None:
        """Publish a user-visible message and mirror it into that channel's session."""
        metadata = dict(msg.metadata or {})
        record = record or bool(metadata.pop("_record_channel_delivery", False))
        if metadata != (msg.metadata or {}):
            msg = OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=msg.content,
                reply_to=msg.reply_to,
                media=msg.media,
                metadata=metadata,
                buttons=msg.buttons,
            )
        if (
            record
            and msg.channel != "cli"
            and msg.content.strip()
            and hasattr(session_manager, "get_or_create")
            and hasattr(session_manager, "save")
        ):
            key = session_key or _channel_session_key(msg.channel, msg.chat_id)
            session = session_manager.get_or_create(key)
            extra: dict[str, Any] = {"_channel_delivery": True}
            if msg.media:
                extra["media"] = list(msg.media)
            session.add_message("assistant", msg.content, **extra)
            session_manager.save(session)
        await bus.publish_outbound(msg)

    message_tool = getattr(agent, "tools", {}).get("message")
    if isinstance(message_tool, MessageTool):
        message_tool.set_send_callback(_deliver_to_channel)

    # Set cron callback (needs agent)
    async def on_cron_job(job: CronJob) -> str | None:
        """Execute a cron job through the agent."""
        # Dream is an internal job — run directly, not through the agent loop.
        # Partner dreams ("dream-<agent_id>") run that agent's PRIVATE Dream so
        # its history.jsonl is consolidated into its own MEMORY.md, instead of
        # only Mona's memory being maintained (multi-agent phase 3).
        if job.name == "dream" or job.name.startswith("dream-"):
            try:
                if job.name == "dream":
                    await agent.dream.run()
                else:
                    await _run_partner_dream(
                        job,
                        agent=agent,
                        dream_cfg=dream_cfg,
                    )
                logger.info("Dream cron job '{}' completed", job.name)
            except Exception:
                logger.exception("Dream cron job '{}' failed", job.name)
            return None

        # Distillation jobs — run directly without agent loop
        if job.payload.kind == "system_event" and job.payload.message.startswith("distill"):
            from mona.distill.service import DistillService

            svc = DistillService()
            try:
                await svc.handle_system_event(job.payload.message)
            except Exception:
                logger.exception("Distill cron job '{}' failed", job.name)
            return None

        # Check workflow admission before dispatching a scheduled task.
        if job.payload.kind == "workflow_run":
            await _execute_workflow_run_cron(
                job,
                subagents=agent.subagents,
                session_manager=session_manager,
                config=config,
            )
            return None

        from mona.utils.evaluator import evaluate_response

        reminder_note = (
            "The scheduled time has arrived. Deliver this reminder to the user now, "
            "as a brief and natural message in their language. Speak directly to them — "
            "do not narrate progress, summarize, include user IDs, or add status reports "
            "like 'Done' or 'Reminded'.\n\n"
            f"Reminder: {job.payload.message}"
        )

        cron_tool = agent.tools.get("cron")
        cron_token = None
        if isinstance(cron_tool, CronTool):
            cron_token = cron_tool.set_cron_context(True)

        async def _silent(*_args, **_kwargs):
            pass

        message_record_token = None
        if isinstance(message_tool, MessageTool):
            message_record_token = message_tool.set_record_channel_delivery(True)

        try:
            resp = await agent.process_direct(
                reminder_note,
                session_key=f"cron:{job.id}",
                channel=job.payload.channel or "cli",
                chat_id=job.payload.to or "direct",
                on_progress=_silent,
            )
        finally:
            if isinstance(cron_tool, CronTool) and cron_token is not None:
                cron_tool.reset_cron_context(cron_token)
            if isinstance(message_tool, MessageTool) and message_record_token is not None:
                message_tool.reset_record_channel_delivery(message_record_token)

        response = resp.content if resp else ""

        if job.payload.deliver and isinstance(message_tool, MessageTool) and message_tool._sent_in_turn:
            return response

        if job.payload.deliver and job.payload.to and response:
            should_notify = await evaluate_response(
                response, reminder_note, agent.provider, agent.model,
            )
            if should_notify:
                await _deliver_to_channel(
                    OutboundMessage(
                        channel=job.payload.channel or "cli",
                        chat_id=job.payload.to,
                        content=response,
                        metadata=dict(job.payload.channel_meta),
                    ),
                    record=True,
                    session_key=job.payload.session_key,
                )
        return response

    cron.on_job = on_cron_job
    # Workflow cron sync (activate/deactivate) writes through the manager.
    agent.subagents.cron_service = cron

    def _webui_runtime_model_name() -> str | None:
        model = getattr(agent, "model", None)
        if isinstance(model, str):
            stripped = model.strip()
            return stripped or None
        return None

    # Create channel manager (forwards SessionManager so the WebSocket channel
    # can serve the embedded webui's REST surface).
    channels = ChannelManager(
        config,
        bus,
        session_manager=session_manager,
        webui_runtime_model_name=_webui_runtime_model_name,
        subagent_manager=agent.subagents,
        runtime_tool_registry=agent.tools,
    )

    def _pick_heartbeat_target() -> tuple[str, str]:
        """Pick a routable channel/chat target for heartbeat-triggered messages."""
        enabled = set(channels.enabled_channels)
        # Prefer the most recently updated non-internal session on an enabled channel.
        for item in session_manager.list_sessions():
            key = item.get("key") or ""
            if ":" not in key:
                continue
            channel, chat_id = key.split(":", 1)
            if channel in {"cli", "system"}:
                continue
            if channel in enabled and chat_id:
                return channel, chat_id
        # Fallback keeps prior behavior but remains explicit.
        return "cli", "direct"

    # Create heartbeat service
    heartbeat_preamble = (
        "[Your response will be delivered directly to the user's messaging app. "
        "Output ONLY the final user-facing message. Never reference internal "
        "files (HEARTBEAT.md, AWARENESS.md, etc.), your instructions, or your "
        "decision process. If nothing needs reporting, respond with just "
        "'All clear.' and nothing else.]\n\n"
    )

    async def on_heartbeat_execute(tasks: str) -> str:
        """Phase 2: execute heartbeat tasks through the full agent loop."""
        channel, chat_id = _pick_heartbeat_target()

        async def _silent(*_args, **_kwargs):
            pass

        resp = await agent.process_direct(
            heartbeat_preamble + tasks,
            session_key="heartbeat",
            channel=channel,
            chat_id=chat_id,
            on_progress=_silent,
        )

        # Keep a small tail of heartbeat history so the loop stays bounded
        # without losing all short-term context between runs.
        session = agent.sessions.get_or_create("heartbeat")
        session.retain_recent_legal_suffix(hb_cfg.keep_recent_messages)
        agent.sessions.save(session)

        return resp.content if resp else ""

    async def on_heartbeat_notify(response: str) -> None:
        """Deliver a heartbeat response to the user's channel.

        In addition to publishing the outbound message, this injects the
        delivered text as an assistant turn into the *target channel's*
        session.  Without this, a user reply on the channel (e.g. "Sure")
        lands in a session that has no context about the heartbeat message
        and the agent cannot follow through.
        """
        channel, chat_id = _pick_heartbeat_target()
        if channel == "cli":
            return  # No external channel available to deliver to

        await _deliver_to_channel(
            OutboundMessage(channel=channel, chat_id=chat_id, content=response),
            record=True,
        )

    hb_cfg = config.gateway.heartbeat
    heartbeat = HeartbeatService(
        workspace=config.workspace_path,
        llm_runtime=agent.llm_runtime,
        on_execute=on_heartbeat_execute,
        on_notify=on_heartbeat_notify,
        interval_s=hb_cfg.interval_s,
        enabled=hb_cfg.enabled,
        timezone=config.agents.defaults.timezone,
    )

    if channels.enabled_channels:
        console.print(f"[green]✓[/green] Channels enabled: {', '.join(channels.enabled_channels)}")
    else:
        console.print("[yellow]Warning: No channels enabled[/yellow]")

    cron_status = cron.status()
    if cron_status["jobs"] > 0:
        console.print(f"[green]✓[/green] Cron: {cron_status['jobs']} scheduled jobs")

    console.print(f"[green]✓[/green] Heartbeat: every {hb_cfg.interval_s}s")

    shutdown_event = asyncio.Event()

    async def _http_server(host: str, http_port: int):
        """Run the aiohttp gateway app (create_app) on the gateway port.

        This serves /health AND all business routes (/email/*, /api/kb/*,
        /v1/chat/completions, …) registered in mona.api.server.create_app.
        The websocket channel port only handles WS + a limited set of GET
        routes (websockets' process_request cannot read POST bodies reliably).
        """
        from aiohttp import web

        from mona.api.server import create_app

        app = create_app(
            agent,
            model_name=_model_display(config)[0],
            request_timeout=120.0,
        )

        async def on_cleanup(_app):
            await agent.close_mcp()

        app.on_cleanup.append(on_cleanup)

        app["shutdown_event"] = shutdown_event
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, http_port)
        await site.start()
        console.print(f"[green]✓[/green] HTTP endpoint: http://{host}:{http_port}/health")
        # Keep the task alive until POST /shutdown sets the app's shutdown_event.
        try:
            await app["shutdown_event"].wait()
        finally:
            await runner.cleanup()
    # Register Dream system job (always-on, idempotent on restart)
    dream_cfg = config.agents.defaults.dream
    if dream_cfg.model_override:
        agent.dream.model = dream_cfg.model_override
    agent.dream.max_batch_size = dream_cfg.max_batch_size
    agent.dream.max_iterations = dream_cfg.max_iterations
    # Skill lifecycle: stats/cap/manual ops always on; automatic archival
    # is opt-in via skillPruneEnabled (default False). See
    # docs/design/skill-lifecycle-design.md.
    agent.dream.skill_prune_enabled = dream_cfg.skill_prune_enabled
    agent.dream.archive_after_days = dream_cfg.archive_after_days
    agent.dream.max_active_user_skills = dream_cfg.max_active_user_skills
    from mona.agent.partners import MONA_AGENT_ID
    from mona.agent.user_config import load_agent_user_config

    agent.dream.disabled_skills = list(load_agent_user_config(MONA_AGENT_ID).disabled_skills)
    from mona.cron.types import CronJob, CronPayload
    cron.register_system_job(CronJob(
        id="dream",
        name="dream",
        schedule=dream_cfg.build_schedule(config.agents.defaults.timezone),
        payload=CronPayload(kind="system_event"),
    ))
    console.print(f"[green]✓[/green] Dream: {dream_cfg.describe_schedule()}")

    # Register one Dream job per partner agent so each agent's private
    # history.jsonl is consolidated into its own MEMORY.md on the same
    # schedule (multi-agent phase 3). Idempotent on restart like Mona's job;
    # agents installed later pick up their job at the next gateway start.
    from mona.agent.partners import AgentRegistry
    partner_dream_ids: list[str] = []
    for definition in AgentRegistry().list_agents():
        if definition.id == MONA_AGENT_ID:
            continue
        cron.register_system_job(CronJob(
            id=f"dream-{definition.id}",
            name=f"dream-{definition.id}",
            schedule=dream_cfg.build_schedule(config.agents.defaults.timezone),
            payload=CronPayload(kind="system_event", agent_id=definition.id),
        ))
        partner_dream_ids.append(definition.id)
    if partner_dream_ids:
        console.print(
            f"[green]✓[/green] Partner dreams: {', '.join(partner_dream_ids)}"
        )

    # Register distillation system jobs (weekly, Sunday 03:00 local time)
    from mona.distill.service import register_distill_jobs
    register_distill_jobs(cron, timezone=config.agents.defaults.timezone or "Asia/Shanghai")
    console.print("[green]✓[/green] Distillation: weekly (Sunday 03:00)")


    async def run():
        runtime_task = None
        shutdown_task = None
        try:
            await cron.start()
            await heartbeat.start()
            tasks = [
                agent.run(),
                channels.start_all(),
                _http_server(config.gateway.host, port),
            ]
            runtime_task = asyncio.gather(*tasks)
            shutdown_task = asyncio.create_task(shutdown_event.wait())
            done, _ = await asyncio.wait(
                (runtime_task, shutdown_task), return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                task.result()
        except KeyboardInterrupt:
            console.print("\nShutting down...")
        except Exception:
            import traceback

            console.print("\n[red]Error: Gateway crashed unexpectedly[/red]")
            console.print(traceback.format_exc())
        finally:
            pending_tasks = [task for task in (runtime_task, shutdown_task) if task is not None]
            for task in pending_tasks:
                task.cancel()
            await asyncio.gather(*pending_tasks, return_exceptions=True)
            await agent.close_mcp()
            heartbeat.stop()
            cron.stop()
            agent.stop()
            await channels.stop_all()
            # Flush all cached sessions to durable storage before exit.
            # This prevents data loss on filesystems with write-back
            # caching (rclone VFS, NFS, FUSE mounts, etc.).
            flushed = agent.sessions.flush_all()
            if flushed:
                logger.info("Shutdown: flushed {} session(s) to disk", flushed)

    asyncio.run(run())


@app.command()
def services(
    port: int | None = typer.Option(None, "--port", "-p", help="Services port"),
    workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    config: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
):
    """Start the mona services process (email/contacts/video/materials/profile/schedule)."""
    if verbose:
        logger.remove(_log_handler_id)
        logger.add(
            sys.stderr,
            format=(
                "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
                "<level>{level: <5}</level> | "
                "<cyan>{extra[channel]}</cyan> | "
                "<level>{message}</level>"
            ),
            level="DEBUG",
            colorize=None,
            filter=lambda record: record["extra"].setdefault("channel", "-") or True,
            backtrace=False,
            diagnose=False,
        )
    cfg = _load_runtime_config(config, workspace)
    _run_services(cfg, port=port)


def _run_services(config: Config, *, port: int | None = None) -> None:
    """Run the services process: business HTTP routes without an AgentLoop.

    Owns the ScheduleService and a dedicated CronService (separate store from
    the gateway's cron/jobs.json so mirrored AI-task jobs never double-fire).
    AI tasks execute by calling the gateway's /v1/chat/completions as a
    regular API client — no private protocol between the two processes.
    """
    os.environ["MONA_PROCESS_ROLE"] = "services"
    import httpx

    from mona.cron.service import CronService
    from mona.cron.types import CronJob
    from mona.email_intel.schedule_extract import init_pending_store
    from mona.schedule import ScheduleService, TodoService
    from mona.services import create_services_app

    port = port if port is not None else config.services.port
    host = config.services.host or "127.0.0.1"
    console.print(f"{__logo__} Starting mona services version {__version__} on port {port}...")
    # Global migrations belong to the Gateway startup. Services may run in the
    # same desktop launch, so repeating them here only serializes both processes
    # on shared filesystem locks. Runtime components still migrate lazily when a
    # services feature first requests one.
    config.workspace_path.mkdir(parents=True, exist_ok=True)

    schedule_dir = config.workspace_path / "schedule"
    cron = CronService(schedule_dir / "cron_jobs.json")

    # 初始化邮件日程提取的 pending 持久化（避免 services 重启丢失数据）
    init_pending_store(schedule_dir / "pending_confirmations.json")

    # 一次性迁移：旧架构下 schedule AI 任务的镜像 job 持久化在 gateway 的
    # cron/jobs.json 中。items.json 是唯一事实源（services 启动时会重新镜像），
    # 直接从旧 store 删除这些镜像，避免 gateway 与 services 双触发。
    legacy_cron = CronService(config.workspace_path / "cron" / "jobs.json")
    removed = 0
    for job in legacy_cron.list_jobs(include_disabled=True):
        if job.name.startswith("schedule:"):
            legacy_cron.remove_job(job.id)
            removed += 1
    if removed:
        logger.info("Migrated {} schedule mirror job(s) out of gateway cron store", removed)

    schedule_service = ScheduleService(
        schedule_dir / "items.json",
        cron_service=cron,
        # 个人提醒的通知经 _pending_notifications 队列由 Rust 轮询弹出，
        # 本进程没有 message bus，不再投递聊天流。
        notify_callback=None,
    )

    todo_service = TodoService(schedule_dir / "todos.json")

    gateway_base = f"http://{config.gateway.host or '127.0.0.1'}:{config.gateway.port}"

    async def on_cron_job(job: CronJob) -> str | None:
        """Execute a schedule AI task through the gateway as a regular API client."""
        reminder_note = (
            "The scheduled time has arrived. Deliver this reminder to the user now, "
            "as a brief and natural message in their language. Speak directly to them — "
            "do not narrate progress, summarize, include user IDs, or add status reports "
            "like 'Done' or 'Reminded'.\n\n"
            f"Reminder: {job.payload.message}"
        )
        content = ""
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(300.0, connect=5.0)
            ) as client:
                resp = await client.post(
                    f"{gateway_base}/v1/chat/completions",
                    json={
                        "messages": [{"role": "user", "content": reminder_note}],
                        "session_id": job.payload.session_key or f"schedule:{job.id}",
                        "stream": False,
                    },
                )
            if resp.status_code == 200:
                choices = (resp.json() or {}).get("choices") or []
                if choices:
                    content = (choices[0].get("message") or {}).get("content") or ""
            else:
                logger.warning(
                    "Schedule AI task '{}' gateway call failed: HTTP {}",
                    job.name,
                    resp.status_code,
                )
        except Exception:
            logger.exception("Schedule AI task '{}' gateway call failed", job.name)

        if job.payload.deliver and content:
            item_id = (job.payload.channel_meta or {}).get("schedule_item_id", "")
            schedule_service._pending_notifications.append(
                {"title": "日程任务", "body": content[:500], "item_id": item_id}
            )
        return content or None

    cron.on_job = on_cron_job

    async def run():
        from aiohttp import web

        await cron.start()
        await schedule_service.start()
        await todo_service.start()

        app = create_services_app(schedule_service, todo_service, workspace=config.workspace_path)

        async def on_cleanup(_app):
            schedule_service.stop()
            todo_service.stop()
            cron.stop()

        app.on_cleanup.append(on_cleanup)

        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        await site.start()
        console.print(f"[green]✓[/green] services endpoint: http://{host}:{port}/health")
        try:
            await app["shutdown_event"].wait()
        finally:
            await runner.cleanup()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        console.print("\nShutting down services...")


if __name__ == "__main__":
    app()
