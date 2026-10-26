"""Atomic development metadata; conversation bodies stay in SessionManager.

Database transactions only serialize short metadata commits. There is no project
execution lock: independent sessions in the same project can run concurrently.
"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, TypeVar

from mona.development.contracts import (
    INPUT_TRANSITIONS,
    RUN_TRANSITIONS,
    SCHEMA_VERSION,
    TERMINAL_RUN_STATUSES,
    Binding,
    Collaboration,
    Contract,
    DevelopmentSession,
    DevelopmentView,
    Event,
    ExecutorId,
    InputState,
    PendingHandoff,
    PermissionMode,
    Project,
    ReviewSource,
    Run,
    RunInput,
    RunStatus,
    new_id,
    now,
)

T = TypeVar("T", bound=Contract)


class DevelopmentError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class NotFoundError(DevelopmentError):
    def __init__(self):
        super().__init__("not_found", "开发项目、会话或执行记录不存在。")


class ConflictError(DevelopmentError):
    def __init__(self, message: str = "记录已变化，请刷新后重试。"):
        super().__init__("conflict", message)


_TABLES = {Project: "projects", DevelopmentSession: "sessions", Binding: "bindings",
           Run: "runs", RunInput: "inputs", DevelopmentView: "views", Collaboration: "collaborations"}
_DDL = """
CREATE TABLE projects (id TEXT PRIMARY KEY, root_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE TABLE bindings (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    executor TEXT NOT NULL, native_id TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE(executor, native_id));
CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    request_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE(session_id, request_id));
CREATE UNIQUE INDEX runs_one_active_session ON runs(session_id)
    WHERE status NOT IN ('succeeded', 'failed', 'interrupted', 'closed_unknown');
CREATE TABLE inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX inputs_run ON inputs(run_id);
CREATE TABLE views (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL REFERENCES sessions(id),
    run_id TEXT REFERENCES runs(id), executor TEXT NOT NULL, type TEXT NOT NULL,
    timestamp TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX events_session_sequence ON events(session_id, sequence);
"""


_COLLAB_DDL = """CREATE TABLE collaborations (
    id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id),
    child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), request_id TEXT NOT NULL,
    payload TEXT NOT NULL, UNIQUE(parent_session_id, request_id))"""


class DevelopmentStore:
    def __init__(self, path: Path):
        self.on_change: Callable[[], None] | None = None
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection(write=True) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, SCHEMA_VERSION):
                raise DevelopmentError("unsupported_schema", "开发数据版本不兼容，原数据已保留。请使用对应版本的 Mona。")
            if version == 0:
                if db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone():
                    raise DevelopmentError("unsupported_schema", "发现没有版本号的现有数据库，未覆盖。")
                for sql in _DDL.split(";"):
                    if sql.strip():
                        db.execute(sql)
            if version in (0, 1):
                db.execute(_COLLAB_DDL)
            present = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not set(_TABLES.values()).union({"events"}).issubset(present):
                raise DevelopmentError("unsupported_schema", "开发数据结构不兼容，原数据未覆盖。")
            if version < 3:
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='runs_one_active_session'").fetchone():
                    raise DevelopmentError("unsupported_schema", "开发数据结构不兼容，原数据未覆盖。")
                db.execute("DROP INDEX runs_one_active_session")
                db.execute("CREATE UNIQUE INDEX runs_one_active_session ON runs(session_id) "
                           "WHERE status NOT IN ('succeeded','failed','interrupted','closed_unknown')")
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")

    @contextmanager
    def _connection(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            with db:
                yield db
            if write and db.total_changes and self.on_change:
                self.on_change()
        finally:
            db.close()

    @staticmethod
    def _get(db: sqlite3.Connection, model: type[T], identifier: str) -> T:
        row = db.execute(f"SELECT payload FROM {_TABLES[model]} WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise NotFoundError()
        return model.model_validate_json(row["payload"])

    @staticmethod
    def _save(db: sqlite3.Connection, value: Contract) -> None:
        table = _TABLES[type(value)]
        if isinstance(value, Run):
            db.execute("UPDATE runs SET payload=?, status=? WHERE id=?", (value.model_dump_json(), value.status.value, value.id))
        elif isinstance(value, RunInput):
            db.execute("UPDATE inputs SET payload=?, state=?, run_id=? WHERE id=?",
                       (value.model_dump_json(), value.state.value, value.run_id, value.id))
        else:
            db.execute(f"UPDATE {table} SET payload=? WHERE id=?", (value.model_dump_json(), value.id))

    @staticmethod
    def _event(db: sqlite3.Connection, session: DevelopmentSession, kind: str,
               payload: dict, run: Run | None = None) -> None:
        db.execute(
            "INSERT INTO events(id,project_id,session_id,run_id,executor,type,timestamp,payload) VALUES(?,?,?,?,?,?,?,?)",
            (new_id("event"), session.project_id, session.id, run.id if run else None,
             (run.executor if run else session.executor).value, kind, now().isoformat(),
             json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
        )

    @staticmethod
    def _revision(actual: int, expected: int) -> None:
        if actual != expected:
            raise ConflictError()

    def open_project(self, root: Path, name: str | None = None) -> Project:
        try:
            root = Path(root).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise DevelopmentError("project_unavailable", "项目目录不可访问，请重新选择实际目录。") from exc
        if not root.is_dir():
            raise DevelopmentError("invalid_project", "项目必须是一个目录。")
        key = os.path.normcase(str(root))
        with self._connection(write=True) as db:
            existing = db.execute("SELECT payload FROM projects WHERE root_key=?", (key,)).fetchone()
            if existing:
                project = Project.model_validate_json(existing["payload"])
                project.last_opened_at = now()
                if project.removed or (name is not None and name != project.display_name):
                    project.removed = False
                    project.revision += 1
                if name is not None:
                    project.display_name = name
                self._save(db, project)
            else:
                project = Project(root_path=str(root), display_name=name or root.name or str(root))
                db.execute("INSERT INTO projects VALUES(?,?,?)", (project.id, key, project.model_dump_json()))
            return project

    def get_project(self, project_id: str) -> Project:
        with self._connection() as db:
            return self._get(db, Project, project_id)

    def update_project(self, project_id: str, revision: int, *, display_name: str | None = None,
                       pinned: bool | None = None, removed: bool | None = None) -> Project:
        if display_name is not None:
            display_name = display_name.strip()
            if not display_name or len(display_name) > 200:
                raise DevelopmentError("invalid_project_name", "项目名称需要 1 至 200 个字符。")
        with self._connection(write=True) as db:
            project = self._get(db, Project, project_id)
            self._revision(project.revision, revision)
            if removed and db.execute("SELECT 1 FROM runs JOIN sessions ON sessions.id=runs.session_id "
                    "WHERE sessions.project_id=? AND runs.status NOT IN ('succeeded','failed','interrupted','closed_unknown') LIMIT 1",
                    (project_id,)).fetchone():
                raise ConflictError("项目仍有运行中或状态待核对的任务，请处理后再移除；任务未停止。")
            changed = False
            for key, value in (("display_name", display_name), ("pinned", pinned), ("removed", removed)):
                if value is not None and value != getattr(project, key):
                    setattr(project, key, value)
                    changed = True
            if changed:
                project.revision += 1
                self._save(db, project)
            return project

    def archive_project_sessions(self, project_id: str, revisions: dict[str, int]) -> list[DevelopmentSession]:
        # The confirmation names exact sessions; later conversations are never swept in.
        with self._connection(write=True) as db:
            self._get(db, Project, project_id)
            sessions = [self._get(db, DevelopmentSession, identifier) for identifier in revisions]
            for session in sessions:
                if session.project_id != project_id or session.parent_session_id:
                    raise ConflictError("归档范围不属于该项目的主会话，未更改任何会话。")
                if session.archived:
                    continue
                self._revision(session.revision, revisions[session.id])
                if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown') LIMIT 1",
                              (session.id,)).fetchone():
                    raise ConflictError("选中的会话正在运行或状态待核对，请刷新后再归档；任务未停止。")
            for session in sessions:
                if not session.archived:
                    session.archived = True
                    session.revision += 1
                    session.updated_at = now()
                    self._save(db, session)
                    self._event(db, session, "session.updated", {"revision": session.revision})
            return sessions

    def save_subagents(self, project_id: str, revision: int, presets: list) -> Project:
        from mona.config.schema import (
            BUILTIN_DEVELOPMENT_SUBAGENT_IDS,
            BUILTIN_DEVELOPMENT_SUBAGENT_PROMPTS,
            DevelopmentSubagentConfig,
        )
        values = [DevelopmentSubagentConfig.model_validate(p) for p in presets]
        if sum(p.id not in BUILTIN_DEVELOPMENT_SUBAGENT_IDS for p in values) > 32 or len({p.id for p in values}) != len(values):
            raise DevelopmentError("invalid_subagents", "子智能体数量超过上限或存在重复标识。")
        for preset in values:
            prompt = BUILTIN_DEVELOPMENT_SUBAGENT_PROMPTS.get(preset.id)
            if prompt is not None and (preset.description != prompt or preset.instructions != prompt):
                raise DevelopmentError("builtin_subagent_readonly", "内置子智能体的描述和执行指令不能修改。")
        with self._connection(write=True) as db:
            project = self._get(db, Project, project_id)
            self._revision(project.subagents_revision, revision)
            submitted = {p.id for p in values}
            values.extend(p for p in project.subagents if p.id in BUILTIN_DEVELOPMENT_SUBAGENT_IDS and p.id not in submitted)
            project.subagents = values
            project.subagents_revision += 1
            self._save(db, project)
            return project

    def latest_plan(self, session_id: str) -> dict | None:
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            row = db.execute("SELECT run_id,payload FROM events WHERE session_id=? AND type='run.plan' ORDER BY sequence DESC LIMIT 1", (session_id,)).fetchone()
            if not row:
                return None
            from mona.development.plan import normalize_plan
            return {"runId": row["run_id"], **normalize_plan(json.loads(row["payload"]))}

    def list_projects(self) -> list[Project]:
        with self._connection() as db:
            values = [Project.model_validate_json(r[0]) for r in db.execute("SELECT payload FROM projects")]
            return sorted((p for p in values if not p.removed), key=lambda p: (p.pinned, p.last_opened_at), reverse=True)

    def create_session(self, project_id: str, executor: ExecutorId = ExecutorId.MONA,
                       title: str = "新开发任务", model: str | None = None, *,
                       readonly: bool = False, parent_session_id: str | None = None,
                       model_provider: str | None = None, model_reasoning_effort: str | None = None,
                       permission_mode: PermissionMode = PermissionMode.ASK) -> DevelopmentSession:
        session = DevelopmentSession(project_id=project_id, executor=executor, title=title, model=model,
                                     title_source="default" if title == "新开发任务" else "manual",
                                     readonly=readonly, parent_session_id=parent_session_id,
                                     model_provider=model_provider, model_reasoning_effort=model_reasoning_effort,
                                     permission_mode=permission_mode)
        with self._connection(write=True) as db:
            self._get(db, Project, project_id)
            if parent_session_id:
                parent = self._get(db, DevelopmentSession, parent_session_id)
                if parent.project_id != project_id:
                    raise ConflictError("侧边会话必须属于同一项目。")
                session.permission_mode = parent.permission_mode
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (session.id, project_id, session.model_dump_json()))
            self._event(db, session, "session.created", {"sessionId": session.id})
        return session

    def get_session(self, session_id: str) -> DevelopmentSession:
        with self._connection() as db:
            return self._get(db, DevelopmentSession, session_id)

    def set_message_title(self, session_id: str, title: str) -> DevelopmentSession:
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            if session.title_source != "default" or session.title != "新开发任务" or session.parent_session_id or session.readonly:
                return session
            session.title = title
            session.title_source = "message"
            session.revision += 1
            self._save(db, session)
            self._event(db, session, "session.updated", {"revision": session.revision, "title": title})
            return session

    def publish_fork(self, child: DevelopmentSession, source_revision: int) -> DevelopmentSession:
        if child.fork_source is None:
            raise ValueError("Missing fork source")
        with self._connection(write=True) as db:
            source = self._get(db, DevelopmentSession, child.fork_source.source_session_id)
            self._revision(source.revision, source_revision)
            if source.readonly or source.parent_session_id:
                raise ConflictError("只读讨论和子任务不能在这里分叉。")
            if child.project_id != source.project_id or child.parent_session_id:
                raise ConflictError("分叉任务必须属于原项目。")
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (child.id, child.project_id, child.model_dump_json()))
            self._event(db, child, "session.created", {"sessionId": child.id})
            self._event(db, child, "session.forked", child.fork_source.model_dump(mode="json", by_alias=True))
        return child

    def fork_history(self, session_id: str, run_ids: set[str]) -> dict:
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            runs = [Run.model_validate_json(row[0]).model_dump(mode="json", by_alias=True)
                    for row in db.execute("SELECT payload FROM runs WHERE session_id=? ORDER BY rowid DESC", (session_id,))]
            rows = db.execute("SELECT * FROM events WHERE session_id=? AND run_id IS NOT NULL ORDER BY sequence", (session_id,)).fetchall()
            events = [Event(**{**dict(row), "payload": json.loads(row["payload"])}).model_dump(mode="json", by_alias=True)
                      for row in rows if row["run_id"] in run_ids and not row["type"].startswith("decision.")]
        return {"runs": [run for run in runs if run["id"] in run_ids], "events": events}

    def list_sessions(self, project_id: str) -> list[DevelopmentSession]:
        with self._connection() as db:
            self._get(db, Project, project_id)
            values = [DevelopmentSession.model_validate_json(r[0]) for r in db.execute(
                "SELECT payload FROM sessions WHERE project_id=?", (project_id,))]
            return sorted(values, key=lambda s: (s.pinned, s.updated_at), reverse=True)

    def update_session(self, session_id: str, expected_revision: int, *, title: str | None = None,
                       pinned: bool | None = None, archived: bool | None = None) -> DevelopmentSession:
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            self._revision(session.revision, expected_revision)
            for key, value in (("title", title), ("pinned", pinned), ("archived", archived)):
                if value is not None:
                    setattr(session, key, value)
            if title is not None:
                session.title_source = "manual"
            session.revision += 1
            session.updated_at = now()
            self._save(db, session)
            self._event(db, session, "session.updated", {"revision": session.revision})
            return session

    def set_permission_mode(self, session_id: str, expected_revision: int, mode: PermissionMode) -> DevelopmentSession:
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            self._revision(session.revision, expected_revision)
            if session.readonly or session.parent_session_id:
                raise ConflictError("子任务和只读会话使用已有授权范围，不能在这里修改权限。")
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown')", (session_id,)).fetchone():
                raise ConflictError("当前任务尚未结束，请处理待办或停止任务后再切换权限。")
            if db.execute("SELECT 1 FROM inputs WHERE session_id=? AND state IN ('pending','reserved','unknown')", (session_id,)).fetchone():
                raise ConflictError("仍有排队或待核对消息，请先处理这些消息再切换权限。")
            if session.permission_mode == mode:
                return session
            previous = session.permission_mode
            session.permission_mode = mode
            session.revision += 1
            session.updated_at = now()
            self._save(db, session)
            self._event(db, session, "permissions.changed", {"from": previous.value, "mode": mode.value})
            return session

    def delete_session(self, session_id: str, expected_revision: int) -> list[DevelopmentSession]:
        """Permanently remove one development conversation and its child conversations."""
        with self._connection(write=True) as db:
            try:
                root = self._get(db, DevelopmentSession, session_id)
            except NotFoundError:
                return []
            # Deletion targets an immutable session ID, even if its status or title changed.
            project_sessions = [DevelopmentSession.model_validate_json(row["payload"]) for row in db.execute(
                "SELECT payload FROM sessions WHERE project_id=?", (root.project_id,))]
            targets = {root.id}
            while True:
                children = {session.id for session in project_sessions if session.parent_session_id in targets}
                added = children - targets
                if not added:
                    break
                targets.update(added)
            values = [session for session in project_sessions if session.id in targets]
            placeholders = ",".join("?" for _ in targets)
            params = tuple(targets)
            run_ids = [row["id"] for row in db.execute(
                f"SELECT id FROM runs WHERE session_id IN ({placeholders})", params)]
            if run_ids:
                run_placeholders = ",".join("?" for _ in run_ids)
                db.execute(f"DELETE FROM inputs WHERE run_id IN ({run_placeholders})", tuple(run_ids))
            db.execute(f"DELETE FROM inputs WHERE session_id IN ({placeholders})", params)
            db.execute(
                f"DELETE FROM collaborations WHERE parent_session_id IN ({placeholders}) "
                f"OR child_session_id IN ({placeholders})", params + params,
            )
            db.execute(f"DELETE FROM events WHERE session_id IN ({placeholders})", params)
            db.execute(f"DELETE FROM bindings WHERE session_id IN ({placeholders})", params)
            db.execute(f"DELETE FROM runs WHERE session_id IN ({placeholders})", params)
            for row in db.execute("SELECT payload FROM views WHERE project_id=?", (root.project_id,)).fetchall():
                view = DevelopmentView.model_validate_json(row["payload"])
                changed = False
                for pane in view.panes:
                    if pane.session_id in targets:
                        pane.session_id = None
                        changed = True
                if changed:
                    view.revision += 1
                    self._save(db, view)
            db.execute(f"DELETE FROM sessions WHERE id IN ({placeholders})", params)
            return values

    def activate_binding(self, binding: Binding, expected_session_revision: int, *,
                         handoff: PendingHandoff | None = None,
                         replaces_binding_id: str | None = None,
                         replacement_reason: str | None = None,
                         update_model: bool = False, model: str | None = None,
                         reasoning_effort: str | None = None) -> Binding:
        binding = Binding.model_validate(binding.model_dump())
        if handoff is not None:
            handoff = PendingHandoff.model_validate(handoff.model_dump())
            if handoff.state != "pending" or handoff.input_id is not None:
                raise ConflictError("新的交接必须尚未派发。")
        if bool(replaces_binding_id) != bool(replacement_reason) or replacement_reason not in {None, "history_missing", "user_requested", "collaboration_updated", "design_resources_updated"}:
            raise ConflictError("续接来源或原因无效。")
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, binding.session_id)
            self._revision(session.revision, expected_session_revision)
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown')", (session.id,)).fetchone():
                raise ConflictError("当前轮次尚未结束，不能在派发过程中切换执行者。")
            project = self._get(db, Project, session.project_id)
            if Path(binding.working_directory).resolve() != Path(project.root_path).resolve():
                raise DevelopmentError("invalid_project_context", "原生会话工作目录必须属于当前项目。")
            existing = db.execute("SELECT payload FROM bindings WHERE id=?", (binding.id,)).fetchone()
            if replaces_binding_id:
                previous = self._get(db, Binding, replaces_binding_id)
                if (existing or previous.state == "stale" or previous.id == binding.id
                        or previous.native_session_id == binding.native_session_id
                        or (previous.session_id, previous.executor, previous.readonly) != (session.id, binding.executor, binding.readonly)):
                    raise ConflictError("只能在原任务中续接同一执行者，不能替换其他会话或已失效的绑定。")
                if previous.handoff and previous.handoff.state in {"reserved", "unknown"}:
                    raise ConflictError("原交接派发尚未确认，不能创建替代执行会话。")
                if handoff is None or handoff.mode != "full":
                    raise ConflictError("替代执行会话需要完整交接，不能只携带增量。")
                binding.replaces_binding_id = previous.id
                binding.replacement_reason = replacement_reason
                binding.transcript_cursor = 0
            elif not existing and (binding.replaces_binding_id or binding.replacement_reason):
                raise ConflictError("原生适配器不能自行声明替代绑定。")
            if existing:
                old = Binding.model_validate_json(existing[0])
                if (old.session_id, old.executor, old.native_session_id, old.readonly, old.model_provider) != (binding.session_id, binding.executor, binding.native_session_id, binding.readonly, binding.model_provider):
                    raise ConflictError("原生绑定身份不能被替换。")
                # Adapter snapshots cannot overwrite the host-owned handoff journal.
                binding.handoff = old.handoff
                binding.transcript_cursor = old.transcript_cursor
                binding.replaces_binding_id = old.replaces_binding_id
                binding.replacement_reason = old.replacement_reason
            if handoff is not None:
                if binding.handoff and binding.handoff.state in {"reserved", "unknown"}:
                    raise ConflictError("原交接尚未确认，不能覆盖。")
                binding.handoff = handoff
            duplicate = db.execute("SELECT id FROM bindings WHERE executor=? AND native_id=?",
                                   (binding.executor.value, binding.native_session_id)).fetchone()
            if duplicate and duplicate[0] != binding.id:
                raise ConflictError("原生会话已绑定，请恢复已有绑定。")
            for row in db.execute("SELECT payload FROM bindings WHERE session_id=?", (session.id,)).fetchall():
                old = Binding.model_validate_json(row[0])
                if old.id == replaces_binding_id:
                    old.state = "stale"
                    self._save(db, old)
                elif old.state == "active":
                    old.state = "parked"
                    self._save(db, old)
            active = binding.model_copy(update={"state": "active", "last_used_at": now()})
            if existing:
                self._save(db, active)
            else:
                db.execute("INSERT INTO bindings VALUES(?,?,?,?,?)", (active.id, session.id, active.executor.value, active.native_session_id, active.model_dump_json()))
            session.executor = active.executor
            session.model_provider = active.model_provider
            if update_model:
                session.model = model
                session.model_reasoning_effort = reasoning_effort
            session.revision += 1
            session.updated_at = now()
            self._save(db, session)
            self._event(db, session, "executor.changed", {"bindingId": active.id, "executor": active.executor.value})
            if handoff is not None:
                self._event(db, session, "handoff.prepared", {"bindingId": active.id, "handoffId": handoff.id, "mode": handoff.mode})
            if replaces_binding_id:
                self._event(db, session, "executor.reconnected", {"bindingId": active.id,
                    "previousBindingId": replaces_binding_id, "reason": replacement_reason,
                    "historyPreserved": True, "requestDispatched": False})
            return active

    def prepare_collaboration(self, parent_id: str, request_id: str, fingerprint: str,
                              child: DevelopmentSession, *, goal: str, expected_output: str,
                              source_diff_sha: str | None = None,
                              review_source: ReviewSource | None = None, parent_run_id: str | None = None,
                              required: bool = False, max_active: int | None = None) -> tuple[Collaboration, bool]:
        with self._connection(write=True) as db:
            parent = self._get(db, DevelopmentSession, parent_id)
            row = db.execute("SELECT payload FROM collaborations WHERE parent_session_id=? AND request_id=?", (parent_id, request_id)).fetchone()
            if row:
                existing = Collaboration.model_validate_json(row[0])
                if existing.request_fingerprint != fingerprint:
                    raise ConflictError("相同协作请求携带了不同任务，未重复派发。")
                return existing, False
            if parent.readonly or parent.parent_session_id or parent.archived:
                raise ConflictError("只读、协作子任务或已归档会话不能继续派发协作者。")
            if child.project_id != parent.project_id or child.parent_session_id != parent.id:
                raise ConflictError("协作任务不属于当前项目。")
            if parent_run_id is not None:
                owner = self._get(db, Run, parent_run_id)
                if owner.session_id != parent_id or owner.status not in {RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.WAITING_USER}:
                    raise ConflictError("主任务已结束或正在停止，未派发新的子任务。")
            elif required:
                raise ConflictError("必要子任务必须绑定当前主任务。")
            if max_active is not None:
                if not 1 <= max_active <= 16:
                    raise ValueError("Invalid subagent concurrency bound")
                active = db.execute("SELECT COUNT(*) FROM collaborations c JOIN sessions s ON s.id=c.child_session_id "
                    "WHERE s.project_id=? AND (EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id "
                    "AND r.status NOT IN ('succeeded','failed','interrupted','closed_unknown')) OR "
                    "(NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id) "
                    "AND json_extract(c.payload,'$.state') IN ('prepared','unknown')))", (parent.project_id,)).fetchone()[0]
                if active >= max_active:
                    raise DevelopmentError("subagent_capacity", "当前项目的子任务已达到并行上限。请等待已有子任务结束，不要重复派发。")
            record = Collaboration(parent_session_id=parent.id, child_session_id=child.id,
                request_id=request_id, request_fingerprint=fingerprint, goal=goal, expected_output=expected_output,
                readonly=child.readonly, source_diff_sha=source_diff_sha, review_source=review_source,
                parent_run_id=parent_run_id, required=required)
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (child.id, child.project_id, child.model_dump_json()))
            db.execute("INSERT INTO collaborations VALUES(?,?,?,?,?)", (record.id, parent.id, child.id, request_id, record.model_dump_json()))
            self._event(db, parent, "collaboration.created", {"collaborationId": record.id, "childSessionId": child.id})
            return record, True

    def get_collaboration(self, identifier: str) -> Collaboration:
        with self._connection() as db:
            return self._get(db, Collaboration, identifier)

    def find_collaboration_request(self, parent_id: str, request_id: str) -> Collaboration | None:
        with self._connection() as db:
            self._get(db, DevelopmentSession, parent_id)
            row = db.execute("SELECT payload FROM collaborations WHERE parent_session_id=? AND request_id=?",
                             (parent_id, request_id)).fetchone()
            return Collaboration.model_validate_json(row[0]) if row else None

    def list_collaborations(self, parent_id: str) -> list[Collaboration]:
        with self._connection() as db:
            self._get(db, DevelopmentSession, parent_id)
            return [Collaboration.model_validate_json(row[0]) for row in db.execute(
                "SELECT payload FROM collaborations WHERE parent_session_id=? ORDER BY rowid", (parent_id,))]

    def set_collaboration_state(self, identifier: str, state: str) -> None:
        with self._connection(write=True) as db:
            value = self._get(db, Collaboration, identifier)
            value.state = state
            self._save(db, value)

    def mark_collaboration_returned(self, identifier: str, message_id: str) -> None:
        with self._connection(write=True) as db:
            value = self._get(db, Collaboration, identifier)
            if value.return_message_id and value.return_message_id != message_id:
                raise ConflictError("协作结果已经回传，未覆盖原记录。")
            if not value.return_message_id:
                value.return_message_id = message_id
                self._save(db, value)
                parent = self._get(db, DevelopmentSession, value.parent_session_id)
                self._event(db, parent, "collaboration.returned", {"collaborationId": value.id, "messageId": message_id})

    @staticmethod
    def _required_results(db: sqlite3.Connection, run: Run) -> list[Collaboration]:
        rows = db.execute("SELECT payload FROM collaborations WHERE parent_session_id=? "
            "AND json_extract(payload,'$.parent_run_id')=? AND json_extract(payload,'$.required')=1 "
            "AND COALESCE(json_extract(payload,'$.result_received_by_run_id'),'') != ?",
            (run.session_id, run.id, run.id))
        return [Collaboration.model_validate_json(row[0]) for row in rows]

    def required_results(self, run_id: str) -> list[Collaboration]:
        with self._connection() as db:
            return self._required_results(db, self._get(db, Run, run_id))

    def pending_result_runs(self) -> list[Run]:
        with self._connection() as db:
            return [Run.model_validate_json(row[0]) for row in db.execute(
                "SELECT r.payload FROM runs r WHERE r.status='waiting_children' OR "
                "(r.status='succeeded' AND EXISTS (SELECT 1 FROM inputs i "
                "WHERE i.id=json_extract(r.payload,'$.continuation_input_id') AND i.state='pending'))")]

    def _completion_status(self, db: sqlite3.Connection, run: Run, status: RunStatus | None):
        if status == RunStatus.SUCCEEDED and run.status != RunStatus.INTERRUPTING and self._required_results(db, run):
            return RunStatus.WAITING_CHILDREN
        return status

    def prepare_result_continuation(self, run_id: str, request_id: str, message_id: str) -> RunInput:
        # The transcript body is already fsynced. Release the parent run and
        # persist its next input atomically; a restart never replays its writes.
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            session = self._get(db, DevelopmentSession, run.session_id)
            if run.continuation_input_id:
                if run.continuation_input_id != request_id:
                    raise ConflictError("子任务结果已经有对应处理请求。")
                return self._get(db, RunInput, request_id)
            if run.status != RunStatus.WAITING_CHILDREN or session.archived:
                raise ConflictError("主任务当前不接续处理子任务结果。")
            for record in self._required_results(db, run):
                child = db.execute("SELECT payload FROM runs WHERE session_id=? AND request_id=?",
                    (record.child_session_id, record.request_id)).fetchone()
                finished = Run.model_validate_json(child[0]).status in TERMINAL_RUN_STATUSES if child else record.state == "failed"
                if not finished or not record.return_message_id:
                    raise ConflictError("必要子任务还没有可处理的最终记录。")
            value = RunInput(id=request_id, session_id=session.id, run_id=run.id, message_id=message_id)
            db.execute("INSERT INTO inputs VALUES(?,?,?,?,?)", (value.id, value.session_id, value.run_id, value.state.value, value.model_dump_json()))
            run.status, run.continuation_input_id = RunStatus.SUCCEEDED, request_id
            run.revision += 1
            run.finished_at = now()
            self._save(db, run)
            self._event(db, session, "collaboration.continuing", {"inputId": request_id}, run)
            return value

    def record_collaboration_result_read(self, identifier: str, parent_run_id: str, *, preview_received: bool = False) -> None:
        with self._connection(write=True) as db:
            record = self._get(db, Collaboration, identifier)
            run = self._get(db, Run, parent_run_id)
            if (run.session_id != record.parent_session_id or run.status not in
                    {RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.WAITING_USER}):
                raise ConflictError("结果接收方不是当前主任务。")
            if not record.return_message_id:
                raise ConflictError("子任务结果尚未保存，不能标记为已返回主任务。")
            if (record.result_received_by_run_id != run.id
                    or preview_received and record.result_preview_received_by_run_id != run.id):
                record.result_received_by_run_id = run.id
                if preview_received:
                    record.result_preview_received_by_run_id = run.id
                self._save(db, record)
                session = self._get(db, DevelopmentSession, run.session_id)
                self._event(db, session, "collaboration.result_read", {"collaborationId": record.id}, run)

    def select_mona(self, session_id: str, expected_revision: int, model: str | None = None, *,
                    provider: str | None = None, effort: str | None = None) -> DevelopmentSession:
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            self._revision(session.revision, expected_revision)
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown')", (session_id,)).fetchone():
                raise ConflictError("当前轮次尚未确认结束，不能切换执行者。")
            for row in db.execute("SELECT payload FROM bindings WHERE session_id=?", (session_id,)):
                binding = Binding.model_validate_json(row[0])
                if binding.state == "active":
                    binding.state = "parked"
                    self._save(db, binding)
            session.executor, session.model = ExecutorId.MONA, model
            session.model_provider, session.model_reasoning_effort = provider, effort
            session.revision += 1
            self._save(db, session)
            self._event(db, session, "executor.changed", {"executor": "mona"})
            return session

    def update_binding_cursor(self, binding_id: str, cursor: int) -> None:
        if cursor < 0:
            raise ValueError("Invalid transcript cursor")
        with self._connection(write=True) as db:
            binding = self._get(db, Binding, binding_id)
            binding.transcript_cursor = max(cursor, binding.transcript_cursor)
            self._save(db, binding)

    def refresh_binding(self, binding: Binding) -> Binding:
        """Restore the SAME native identity while its interrupted run remains unknown."""
        with self._connection(write=True) as db:
            current = self._get(db, Binding, binding.id)
            if (current.session_id, current.executor, current.native_session_id, current.working_directory, current.readonly, current.model_provider) != (
                    binding.session_id, binding.executor, binding.native_session_id, binding.working_directory, binding.readonly, binding.model_provider):
                raise ConflictError("恢复不能替换原生会话身份。")
            session = self._get(db, DevelopmentSession, binding.session_id)
            if current.state != "active" or session.executor != current.executor or session.model_provider != current.model_provider:
                raise ConflictError("恢复目标不是当前执行者。")
            current.capabilities, current.protocol_version = binding.capabilities, binding.protocol_version
            current.context_fingerprint = binding.context_fingerprint
            self._save(db, current)
            return current

    def get_binding(self, binding_id: str) -> Binding:
        with self._connection() as db:
            return self._get(db, Binding, binding_id)

    def prepare_handoff(self, binding_id: str, expected_session_revision: int,
                        packet: PendingHandoff) -> Binding:
        packet = PendingHandoff.model_validate(packet.model_dump())
        if packet.state != "pending" or packet.input_id is not None:
            raise ConflictError("新的交接记录必须尚未派发。")
        with self._connection(write=True) as db:
            binding = self._get(db, Binding, binding_id)
            session = self._get(db, DevelopmentSession, binding.session_id)
            self._revision(session.revision, expected_session_revision)
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown')", (session.id,)).fetchone():
                raise ConflictError("当前轮次仍在执行或结果未知，不能替换交接上下文。")
            if binding.handoff and binding.handoff.state in {"reserved", "unknown"}:
                raise ConflictError("原交接派发尚未确认，不能覆盖或重新发送。")
            binding.handoff = packet
            self._save(db, binding)
            self._event(db, session, "handoff.prepared", {"bindingId": binding.id, "handoffId": packet.id, "mode": packet.mode})
            return binding

    def reserve_handoff(self, binding_id: str, run_id: str) -> PendingHandoff | None:
        with self._connection(write=True) as db:
            binding = self._get(db, Binding, binding_id)
            run = self._get(db, Run, run_id)
            if run.binding_id != binding.id or run.session_id != binding.session_id or run.status != RunStatus.PREPARING:
                raise ConflictError("交接必须属于当前待派发轮次。")
            packet = binding.handoff
            if packet is None or packet.state == "accepted":
                return None
            if packet.state != "pending":
                raise ConflictError("交接已进入派发边界或结果未知，不能重复发送。")
            packet.state = "reserved"
            packet.input_id = run.request_id
            self._save(db, binding)
            return packet.model_copy(deep=True)

    def resolve_handoff(self, binding_id: str, handoff_id: str, input_id: str,
                        outcome: str) -> None:
        if outcome not in {"accepted", "rejected", "unknown"}:
            raise ValueError("Invalid handoff dispatch outcome")
        with self._connection(write=True) as db:
            binding = self._get(db, Binding, binding_id)
            packet = binding.handoff
            if packet is None or packet.id != handoff_id or packet.input_id != input_id:
                raise ConflictError("派发回执属于另一份交接，未修改当前记录。")
            if packet.state == "accepted":
                return
            if packet.state not in {"reserved", "unknown"}:
                raise ConflictError("交接尚未进入派发边界。")
            if outcome == "rejected" and packet.state == "unknown":
                raise ConflictError("不确定的交接需核对原生执行记录，不能直接重新发送。")
            packet.state = "pending" if outcome == "rejected" else outcome
            if outcome == "rejected":
                packet.input_id = None
            self._save(db, binding)
            session = self._get(db, DevelopmentSession, binding.session_id)
            self._event(db, session, f"handoff.{outcome}", {"handoffId": packet.id, "bindingId": binding.id})

    def list_bindings(self, session_id: str) -> list[Binding]:
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            return [Binding.model_validate_json(r[0]) for r in db.execute("SELECT payload FROM bindings WHERE session_id=?", (session_id,))]

    def close_unknown(self, session_id: str, run_id: str, revision: int, binding_id: str | None) -> Run:
        """Close only tracking after explicit external verification, never certify the outcome."""
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            run = self._get(db, Run, run_id)
            binding = self._get(db, Binding, binding_id) if binding_id else None
            if (run.session_id != session_id or run.binding_id != binding_id
                    or binding and binding.session_id != session_id
                    or binding is None and run.executor != ExecutorId.MONA):
                raise ConflictError("原任务不属于当前会话，未处理。")
            if run.status == RunStatus.CLOSED_UNKNOWN:
                return run
            self._revision(run.revision, revision)
            if run.status != RunStatus.UNKNOWN or session.archived or binding and binding.state != "active":
                raise ConflictError("原任务状态已变化，请重新核对。")
            run.status = RunStatus.CLOSED_UNKNOWN
            run.revision += 1
            run.finished_at = now()
            if binding:
                binding.state = "stale"
            session.revision += 1
            session.updated_at = now()
            self._save(db, run)
            if binding:
                self._save(db, binding)
            self._save(db, session)
            self._event(db, session, "run.closed_unknown", {"status": run.status.value, "revision": run.revision,
                "bindingId": binding_id, "outcomeVerified": False, "requestReplayed": False}, run)
            self._cancel_unapplied_steering(db, session, run)
            return run

    def create_run(self, session_id: str, request_id: str, message_id: str,
                   binding_id: str | None = None) -> tuple[Run, bool]:
        """Returns (run, created); a repeated request must never dispatch twice."""
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            row = db.execute("SELECT payload FROM runs WHERE session_id=? AND request_id=?", (session_id, request_id)).fetchone()
            if row:
                run = Run.model_validate_json(row[0])
                if (run.request_message_id, run.binding_id) != (message_id, binding_id):
                    raise ConflictError("相同请求标识携带了不同内容引用，未重复执行。")
                return run, False
            if session.archived:
                raise ConflictError("请先恢复已归档会话再执行。")
            pending_result = db.execute("SELECT i.id FROM inputs i JOIN runs owner ON "
                "json_extract(owner.payload,'$.continuation_input_id')=i.id WHERE i.session_id=? "
                "AND i.state IN ('pending','reserved') AND NOT EXISTS "
                "(SELECT 1 FROM runs accepted WHERE accepted.session_id=i.session_id AND accepted.request_id=i.id)",
                (session_id,)).fetchone()
            if pending_result and pending_result[0] != request_id:
                raise ConflictError("当前任务正在接续处理必要子任务结果，请稍后发送。")
            if binding_id:
                binding = self._get(db, Binding, binding_id)
                if binding.session_id != session_id or binding.state != "active" or binding.executor != session.executor:
                    raise ConflictError("原生绑定不属于当前活动执行者。")
            run = Run(session_id=session_id, request_id=request_id, request_message_id=message_id,
                      executor=session.executor, binding_id=binding_id, permission_mode=session.permission_mode)
            try:
                db.execute("INSERT INTO runs VALUES(?,?,?,?,?)", (run.id, session_id, request_id, run.status.value, run.model_dump_json()))
            except sqlite3.IntegrityError as exc:
                raise ConflictError("本会话仍有未结束轮次，请追加输入或另建会话；同项目的其他会话不受限制。") from exc
            self._event(db, session, "run.queued", {"revision": 0}, run)
            return run, True

    def get_run(self, run_id: str) -> Run:
        with self._connection() as db:
            return self._get(db, Run, run_id)

    def active_run(self, session_id: str) -> Run | None:
        """Query the execution guard independently of any paginated UI history."""
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            row = db.execute("SELECT payload FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown')", (session_id,)).fetchone()
            return Run.model_validate_json(row[0]) if row else None

    def list_runs(self, session_id: str, limit: int = 100) -> list[Run]:
        if not 1 <= limit <= 500:
            raise ValueError("Run page must be 1..500")
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            return [Run.model_validate_json(row[0]) for row in db.execute(
                "SELECT payload FROM runs WHERE session_id=? ORDER BY rowid DESC LIMIT ?", (session_id, limit))]

    def binding_has_runs(self, binding_id: str) -> bool:
        """An attempted/uncertain dispatch is not an empty native conversation."""
        with self._connection() as db:
            binding = self._get(db, Binding, binding_id)
            return db.execute(
                "SELECT 1 FROM runs WHERE session_id=? AND json_extract(payload,'$.binding_id')=? LIMIT 1",
                (binding.session_id, binding.id)).fetchone() is not None

    def bind_native_turn(self, run_id: str, binding_id: str, native_turn_id: str) -> Run:
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            binding = self._get(db, Binding, binding_id)
            if run.binding_id != binding.id or run.session_id != binding.session_id or run.executor != binding.executor:
                raise ConflictError("原生轮次绑定属于另一开发会话。")
            if run.native_turn_id is not None:
                if run.native_turn_id != native_turn_id:
                    raise ConflictError("同一执行轮次收到不一致的原生标识。")
                return run
            if run.status not in {RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.WAITING_USER,
                                  RunStatus.INTERRUPTING, RunStatus.UNKNOWN, RunStatus.RECOVERING}:
                raise ConflictError("已结束的执行轮次不能重新绑定原生任务。")
            duplicate = db.execute(
                "SELECT id FROM runs WHERE json_extract(payload,'$.binding_id')=? AND json_extract(payload,'$.native_turn_id')=?",
                (binding_id, native_turn_id)).fetchone()
            if duplicate and duplicate[0] != run.id:
                raise ConflictError("原生轮次已经绑定到另一请求。")
            run.native_turn_id = native_turn_id
            run.revision += 1
            self._save(db, run)
            return run

    def record_native_dispatch(self, run_id: str, binding_id: str, outcome: str) -> Run:
        if outcome not in {"accepted", "rejected", "unknown"}:
            raise ValueError("Invalid native dispatch outcome")
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            binding = self._get(db, Binding, binding_id)
            if (run.binding_id, run.session_id, run.executor) != (binding.id, binding.session_id, binding.executor):
                raise ConflictError("派发证据不属于当前原生会话。")
            if outcome == "accepted" and run.native_turn_id is None:
                raise ConflictError("接受回执缺少对应执行轮次。")
            # A subsequent transport failure does not undo proven acceptance.
            if run.native_dispatch != "accepted" and run.native_dispatch != outcome:
                run.native_dispatch = outcome
                run.revision += 1
                self._save(db, run)
            return run

    def record_native_event(self, run_id: str, binding_id: str, event_id: str, kind: str,
                            payload: dict, *, status: RunStatus | None = None) -> bool:
        """Commit an event and its state together. Callers supply scoped stable IDs."""
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(raw.encode("utf-8")) > 2_097_152:
            raise DevelopmentError("event_too_large", "原生事件过大，需要先保存内容再记录引用。")
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            binding = self._get(db, Binding, binding_id)
            if run.binding_id != binding.id or run.session_id != binding.session_id or run.executor != binding.executor:
                raise ConflictError("原生事件不属于当前开发会话。")
            session = self._get(db, DevelopmentSession, run.session_id)
            existing = db.execute("SELECT run_id,type,payload FROM events WHERE id=?", (event_id,)).fetchone()
            if existing:
                if (existing["run_id"], existing["type"], existing["payload"]) != (run_id, kind, raw):
                    raise ConflictError("原生事件标识重复但内容不同。")
                return False
            if run.status in TERMINAL_RUN_STATUSES:
                return False
            if kind == "run.started" and run.native_dispatch != "accepted":
                run.native_dispatch = "accepted"
                run.revision += 1
                self._save(db, run)
            status = self._completion_status(db, run, status)
            if status is not None and status != run.status:
                if status not in RUN_TRANSITIONS[run.status]:
                    raise ConflictError("原生事件与当前执行状态不一致。")
                run.status = status
                run.revision += 1
                run.error_code = payload.get("errorCode") if isinstance(payload.get("errorCode"), str) else None
                if status == RunStatus.RUNNING and run.started_at is None:
                    run.started_at = now()
                if status in TERMINAL_RUN_STATUSES:
                    run.finished_at = now()
                if status in TERMINAL_RUN_STATUSES or status == RunStatus.WAITING_CHILDREN:
                    if payload.get("resultMessageId") is not None:
                        run.result_message_id = payload["resultMessageId"]
                if status == RunStatus.WAITING_CHILDREN:
                    self._event(db, session, "run.waiting_children", {"status": status.value}, run)
                self._save(db, run)
            db.execute("INSERT INTO events(id,project_id,session_id,run_id,executor,type,timestamp,payload) VALUES(?,?,?,?,?,?,?,?)",
                       (event_id, session.project_id, session.id, run.id, run.executor.value, kind, now().isoformat(), raw))
            session.updated_at = now()
            self._save(db, session)
            if run.status in TERMINAL_RUN_STATUSES:
                self._cancel_unapplied_steering(db, session, run)
            return True

    def _cancel_unapplied_steering(self, db, session, run) -> None:
        for row in db.execute("SELECT payload FROM inputs WHERE run_id=? AND state='pending'", (run.id,)).fetchall():
            value = RunInput.model_validate_json(row[0])
            if value.intent != "steering":
                continue
            if value.follow_up_allowed:
                # ZCode fallbackPendingGuidesToQueue：保留原输入；仅成功轮次允许自动续接。
                value.requested_intent = value.requested_intent or value.intent
                value.intent = "follow_up"
                value.revision += 1
                self._save(db, value)
                self._event(db, session, "input.deferred", {"inputId": value.id,
                    "reason": "guide.turnInterrupted" if run.status == RunStatus.INTERRUPTED else "turn_finished_before_steering",
                    "admittedDelivery": "queue"}, run)
                continue
            value.state = InputState.CANCELLED
            value.revision += 1
            self._save(db, value)
            self._event(db, session, "input.cancelled", {"inputId": value.id, "revision": value.revision,
                "reason": "turn_finished_before_steering", "message": "子任务已结束，纠偏未送入原轮次；没有启动后续任务。"}, run)

    def transition_run(self, run_id: str, expected_revision: int, status: RunStatus,
                       *, error_code: str | None = None) -> Run:
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            self._revision(run.revision, expected_revision)
            status = self._completion_status(db, run, RunStatus(status))
            if status not in RUN_TRANSITIONS[run.status]:
                raise ConflictError(f"不能从 {run.status.value} 转为 {status.value}；请检查真实执行状态。")
            run.status = status
            run.revision += 1
            run.error_code = error_code
            if status == RunStatus.RUNNING and run.started_at is None:
                run.started_at = now()
            if status in TERMINAL_RUN_STATUSES:
                run.finished_at = now()
            self._save(db, run)
            session = self._get(db, DevelopmentSession, run.session_id)
            self._event(db, session, "run.completed" if status == RunStatus.SUCCEEDED else f"run.{status.value}",
                        {"status": status.value, "revision": run.revision, "errorCode": error_code}, run)
            if status in TERMINAL_RUN_STATUSES:
                self._cancel_unapplied_steering(db, session, run)
            return run

    def enqueue_input(self, value: RunInput) -> RunInput:
        value = RunInput.model_validate(value.model_dump())
        if value.state != InputState.PENDING or value.revision != 0:
            raise ConflictError("新输入必须处于待发送状态。")
        with self._connection(write=True) as db:
            run = self._get(db, Run, value.run_id)
            if run.session_id != value.session_id:
                raise NotFoundError()
            row = db.execute("SELECT payload FROM inputs WHERE id=?", (value.id,)).fetchone()
            if row:
                previous = RunInput.model_validate_json(row[0])
                if (previous.session_id, previous.run_id, previous.message_id, previous.intent, previous.follow_up_allowed) != (value.session_id, value.run_id, value.message_id, value.intent, value.follow_up_allowed):
                    raise ConflictError("输入标识已经被其他内容使用。")
                return previous
            if run.status in TERMINAL_RUN_STATUSES:
                raise ConflictError("本轮已结束，请在原会话发起下一轮，不要重新执行旧请求。")
            db.execute("INSERT INTO inputs VALUES(?,?,?,?,?)", (value.id, value.session_id, value.run_id, value.state.value, value.model_dump_json()))
            session = self._get(db, DevelopmentSession, value.session_id)
            self._event(db, session, "input.queued", {"inputId": value.id}, run)
            return value

    def guide_input(self, session_id: str, input_id: str, expected_revision: int, target_run_id: str) -> RunInput:
        with self._connection(write=True) as db:
            value = self._get(db, RunInput, input_id)
            run = self._get(db, Run, target_run_id)
            if value.session_id != session_id or run.session_id != session_id:
                raise ConflictError("消息不属于当前会话。")
            self._revision(value.revision, expected_revision)
            if value.state != InputState.PENDING or not value.follow_up_allowed:
                raise ConflictError("消息已开始派发或状态待核对，原输入已保留。")
            if run.status not in {RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.WAITING_USER}:
                raise ConflictError("目标轮次已结束或变化，消息仍保留在队列。")
            value.requested_intent = value.requested_intent or value.intent
            value.intent = "steering"
            value.run_id = run.id
            value.revision += 1
            self._save(db, value)
            session = self._get(db, DevelopmentSession, session_id)
            self._event(db, session, "input.guided", {"inputId": value.id, "revision": value.revision}, run)
            return value

    def transition_input(self, input_id: str, expected_revision: int, state: InputState) -> RunInput:
        with self._connection(write=True) as db:
            value = self._get(db, RunInput, input_id)
            self._revision(value.revision, expected_revision)
            state = InputState(state)
            if state not in INPUT_TRANSITIONS[value.state]:
                raise ConflictError("消息已经派发或状态未知，不能伪装成已撤回；请先检查执行者状态。")
            run = self._get(db, Run, value.run_id)
            if state == InputState.RESERVED and run.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER}:
                raise ConflictError("当前轮次不能接收新派发，请保留输入并检查执行者状态。")
            value.state = state
            value.revision += 1
            self._save(db, value)
            session = self._get(db, DevelopmentSession, value.session_id)
            run = self._get(db, Run, value.run_id)
            self._event(db, session, f"input.{state.value}", {"inputId": value.id, "revision": value.revision}, run)
            return value

    def list_inputs(self, run_id: str) -> list[RunInput]:
        with self._connection() as db:
            self._get(db, Run, run_id)
            return [RunInput.model_validate_json(row[0]) for row in db.execute(
                "SELECT payload FROM inputs WHERE run_id=? ORDER BY rowid", (run_id,))]

    def replace_pending_input(self, input_id: str, expected_revision: int,
                              message_id: str) -> RunInput:
        """The conversation layer stores the edited body; metadata only changes its reference."""
        with self._connection(write=True) as db:
            value = self._get(db, RunInput, input_id)
            self._revision(value.revision, expected_revision)
            if value.state != InputState.PENDING:
                raise ConflictError("消息已进入派发边界，不能修改原输入。")
            value.message_id = message_id
            value.revision += 1
            self._save(db, value)
            session = self._get(db, DevelopmentSession, value.session_id)
            run = self._get(db, Run, value.run_id)
            self._event(db, session, "input.updated", {"inputId": value.id, "revision": value.revision}, run)
            return value

    def save_view(self, view: DevelopmentView, expected_revision: int | None) -> DevelopmentView:
        view = DevelopmentView.model_validate(view.model_dump())
        with self._connection(write=True) as db:
            self._get(db, Project, view.project_id)
            for pane in view.panes:
                if pane.session_id and self._get(db, DevelopmentSession, pane.session_id).project_id != view.project_id:
                    raise ConflictError("分屏会话不属于当前项目。")
            row = db.execute("SELECT payload FROM views WHERE id=?", (view.id,)).fetchone()
            if row:
                previous = DevelopmentView.model_validate_json(row[0])
                if previous.project_id != view.project_id or previous.revision != expected_revision:
                    raise ConflictError()
                saved = view.model_copy(update={"revision": previous.revision + 1})
                self._save(db, saved)
            else:
                if expected_revision is not None:
                    raise ConflictError("视图不存在，请重新打开项目。")
                saved = view.model_copy(update={"revision": 0})
                db.execute("INSERT INTO views VALUES(?,?,?)", (saved.id, saved.project_id, saved.model_dump_json()))
            return saved

    def get_view(self, view_id: str) -> DevelopmentView:
        with self._connection() as db:
            return self._get(db, DevelopmentView, view_id)

    def native_event_recorded(self, event_id: str, run_id: str, kind: str, source_sha: str) -> bool:
        with self._connection() as db:
            row = db.execute("SELECT run_id,type,payload FROM events WHERE id=?", (event_id,)).fetchone()
            if row is None:
                return False
            if (row["run_id"], row["type"]) != (run_id, kind) or json.loads(row["payload"]).get("sourceSha256") not in {None, source_sha}:
                raise ConflictError("原生事件标识相同但内容不一致。")
            return True

    def events_after(self, session_id: str, after: int = 0, limit: int = 100) -> list[Event]:
        if not 1 <= limit <= 500 or after < 0:
            raise ValueError("事件页大小需要为 1–500，游标必须非负。")
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            rows = db.execute("SELECT * FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?", (session_id, after, limit)).fetchall()
            return [Event(**{**dict(row), "payload": json.loads(row["payload"])}) for row in rows]

    def list_unmaterialized_images(self, session_id: str) -> list[Event]:
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            rows = db.execute("SELECT e.* FROM events e WHERE e.session_id=? AND e.type='tool.completed' "
                "AND json_extract(e.payload,'$.kind')='imageGeneration' AND json_extract(e.payload,'$.status')='completed' "
                "AND json_extract(e.payload,'$.messageId') IS NULL AND NOT EXISTS (SELECT 1 FROM events r "
                "WHERE r.session_id=e.session_id AND r.run_id=e.run_id AND r.type='tool.completed' "
                "AND json_extract(r.payload,'$.nativeItemId')=json_extract(e.payload,'$.itemId') "
                "AND json_extract(r.payload,'$.messageId') IS NOT NULL) ORDER BY e.sequence", (session_id,)).fetchall()
            return [Event(**{**dict(row), "payload": json.loads(row["payload"])}) for row in rows]

    def file_activity(self, project_id: str, relative: str) -> dict:
        # Advisory recent tool intent from still-active tasks, not an exclusive
        # file lock, completed edit claim, or an assertion that no other writer exists.
        with self._connection() as db:
            project = self._get(db, Project, project_id)
            root = Path(project.root_path)
            target = (root / relative).resolve()
            if not target.is_relative_to(root):
                raise DevelopmentError("outside_project", "文件不属于当前项目。")
            rows = db.execute("SELECT e.type,s.payload AS session, "
                "json_extract(e.payload,'$.name') AS tool_name, json_extract(e.payload,'$.inputStreaming') AS streaming, "
                "COALESCE(json_extract(e.payload,'$.arguments.file_path'),json_extract(e.payload,'$.arguments.path'),"
                "json_extract(e.payload,'$.arguments.notebook_path')) AS tool_path, "
                "(SELECT json_group_array(json_extract(value,'$.path')) FROM json_each(e.payload,'$.changes') WHERE type='object') AS changes, "
                "(SELECT json_group_array(json_extract(value,'$.path')) FROM json_each(e.payload,'$.tools') WHERE type='object' "
                "AND json_extract(value,'$.name') IN ('write_file','edit_file')) AS tool_paths FROM events e "
                "JOIN runs r ON r.id=e.run_id JOIN sessions s ON s.id=r.session_id "
                "WHERE s.project_id=? AND r.status NOT IN ('succeeded','failed','interrupted','closed_unknown') "
                "AND e.type IN ('tools.started','tool.started','file.change_proposed','file.changed') "
                "ORDER BY e.sequence DESC LIMIT 128", (project_id,)).fetchall()
        tasks = {}
        for row in rows:
            session = DevelopmentSession.model_validate_json(row["session"])
            if session.readonly or session.id in tasks:
                continue
            if row["type"] in {"file.change_proposed", "file.changed"}:
                paths = json.loads(row["changes"])
            elif row["type"] == "tools.started":
                paths = json.loads(row["tool_paths"])
            else:
                if row["streaming"] or row["tool_name"] not in {"Write", "Edit", "MultiEdit", "NotebookEdit"}:
                    continue
                paths = [row["tool_path"]]
            for path in paths:
                if not isinstance(path, str) or not path or len(path) > 4096 or "\x00" in path:
                    continue
                try:
                    if (root / path).resolve() == target:
                        tasks[session.id] = {"sessionId": session.id, "title": session.title}
                        break
                except (OSError, ValueError, RuntimeError):
                    continue
        return {"available": True, "tasks": list(tasks.values())[:8], "checkedAt": now().isoformat(),
                "partial": len(rows) == 128 or len(tasks) > 8}

    def handoff_evidence(self, session_id: str) -> list[Event]:
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            rows = db.execute("SELECT * FROM events WHERE session_id=? "
                "AND type IN ('command.completed','file.changed') ORDER BY sequence DESC LIMIT 32", (session_id,)).fetchall()
            return [Event(**{**dict(row), "payload": json.loads(row["payload"])}) for row in reversed(rows)]

    def find_run_request(self, session_id: str, request_id: str) -> Run | None:
        with self._connection() as db:
            row = db.execute("SELECT payload FROM runs WHERE session_id=? AND request_id=?", (session_id, request_id)).fetchone()
            return Run.model_validate_json(row[0]) if row else None

    def get_input(self, input_id: str) -> RunInput:
        with self._connection() as db:
            return self._get(db, RunInput, input_id)

    def reserve_follow_up(self, input_id: str, expected_revision: int) -> RunInput:
        with self._connection(write=True) as db:
            value = self._get(db, RunInput, input_id)
            self._revision(value.revision, expected_revision)
            run = self._get(db, Run, value.run_id)
            if value.state != InputState.PENDING or run.status != RunStatus.SUCCEEDED or not value.follow_up_allowed:
                raise ConflictError("仅自动派发成功轮次之后尚未发送的后续消息。")
            if value.intent == "steering":
                session = self._get(db, DevelopmentSession, value.session_id)
                self._event(db, session, "input.deferred", {"inputId": value.id, "reason": "turn_finished_before_steering"}, run)
            value.state = InputState.RESERVED
            value.revision += 1
            self._save(db, value)
            return value

    def move_pending_inputs(self, source_run_id: str, target_run_id: str) -> None:
        with self._connection(write=True) as db:
            source = self._get(db, Run, source_run_id)
            target = self._get(db, Run, target_run_id)
            if source.session_id != target.session_id or source.status != RunStatus.SUCCEEDED:
                raise ConflictError("排队消息不能跨会话转移。")
            for row in db.execute("SELECT payload FROM inputs WHERE run_id=? AND state='pending'", (source.id,)).fetchall():
                value = RunInput.model_validate_json(row[0])
                if not value.follow_up_allowed:
                    continue
                value.run_id = target.id
                value.revision += 1
                db.execute("UPDATE inputs SET run_id=?, payload=? WHERE id=?", (target.id, value.model_dump_json(), value.id))

    def append_run_event(self, run_id: str, kind: str, payload: dict) -> bool:
        """Internal Coding events share the same durable, session-scoped cursor."""
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf-8")) > 2_097_152:
            raise DevelopmentError("event_too_large", "执行结果需要归档后再记录引用。")
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            if run.status in TERMINAL_RUN_STATUSES:
                return False
            session = self._get(db, DevelopmentSession, run.session_id)
            self._event(db, session, kind, payload, run)
            session.updated_at = now()
            self._save(db, session)
            return True

    def update_model(self, session_id: str, expected_revision: int, model: str | None) -> DevelopmentSession:
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, session_id)
            self._revision(session.revision, expected_revision)
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted','closed_unknown')", (session_id,)).fetchone():
                raise ConflictError("请在当前轮次结束后切换模型。")
            session.model = model
            session.revision += 1
            session.model_provider = session.model_reasoning_effort = None
            self._save(db, session)
            self._event(db, session, "session.updated", {"revision": session.revision})
            return session

    def latest_runs_for_project(self, project_id: str) -> dict[str, Run]:
        with self._connection() as db:
            self._get(db, Project, project_id)
            rows = db.execute("SELECT r.payload FROM runs r JOIN sessions s ON s.id=r.session_id "
                              "WHERE s.project_id=? AND r.rowid=(SELECT MAX(r2.rowid) FROM runs r2 WHERE r2.session_id=r.session_id)", (project_id,))
            values = [Run.model_validate_json(row[0]) for row in rows]
            return {run.session_id: run for run in values}

    def reconcile_after_restart(self) -> int:
        """Call once after the Gateway obtains ownership; never replay or guess stopped."""
        with self._connection(write=True) as db:
            rows = db.execute("SELECT payload FROM runs WHERE status IN ('preparing','running','waiting_user','interrupting','recovering')").fetchall()
            for row in rows:
                run = Run.model_validate_json(row[0])
                run.status = RunStatus.UNKNOWN
                run.revision += 1
                run.error_code = "host_restarted"
                self._save(db, run)
                session = self._get(db, DevelopmentSession, run.session_id)
                self._event(db, session, "run.unknown", {"revision": run.revision, "reason": "host_restarted"}, run)
            for row in db.execute("SELECT payload FROM inputs WHERE state IN ('reserved','accepted')").fetchall():
                value = RunInput.model_validate_json(row[0])
                run = self._get(db, Run, value.run_id)
                # All model dispatches persist a Run first. A reserved result
                # outbox with no such Run is provably not sent, unlike an
                # uncertain native receipt, so only that safe preparation resumes.
                if value.intent == "steering" and value.state == InputState.ACCEPTED and run.executor != ExecutorId.MONA and run.status in TERMINAL_RUN_STATUSES:
                    continue  # The completed native turn already owns this accepted input.
                unstarted_result = (value.state == InputState.RESERVED and run.continuation_input_id == value.id
                    and not db.execute("SELECT 1 FROM runs WHERE session_id=? AND request_id=?",
                        (value.session_id, value.id)).fetchone())
                value.state = InputState.PENDING if unstarted_result else InputState.UNKNOWN
                value.revision += 1
                self._save(db, value)
                session = self._get(db, DevelopmentSession, value.session_id)
                self._event(db, session, "input.restored" if unstarted_result else "input.unknown",
                    {"inputId": value.id, "reason": "dispatch_not_started" if unstarted_result else "host_restarted"}, run)
            for row in db.execute("SELECT payload FROM bindings").fetchall():
                binding = Binding.model_validate_json(row[0])
                if binding.handoff and binding.handoff.state == "reserved":
                    binding.handoff.state = "unknown"
                    self._save(db, binding)
            for row in db.execute("SELECT c.payload FROM collaborations c WHERE "
                    "json_extract(c.payload,'$.state')='prepared' AND NOT EXISTS "
                    "(SELECT 1 FROM runs r WHERE r.session_id=c.child_session_id AND r.request_id=c.request_id)").fetchall():
                record = Collaboration.model_validate_json(row[0])
                record.state = "failed"  # Every model dispatch journals its Run first.
                self._save(db, record)
            return len(rows)
