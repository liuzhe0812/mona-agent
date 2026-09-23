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
from typing import Iterator, TypeVar

from mona.development.contracts import (
    INPUT_TRANSITIONS,
    RUN_TRANSITIONS,
    SCHEMA_VERSION,
    TERMINAL_RUN_STATUSES,
    Binding,
    Contract,
    DevelopmentSession,
    DevelopmentView,
    Event,
    ExecutorId,
    InputState,
    PendingHandoff,
    Project,
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
           Run: "runs", RunInput: "inputs", DevelopmentView: "views"}
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
    WHERE status NOT IN ('succeeded', 'failed', 'interrupted');
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


class DevelopmentStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection(write=True) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise DevelopmentError("unsupported_schema", "开发数据版本不兼容，原数据已保留。请使用对应版本的 Mona。")
            if version == 0:
                if db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone():
                    raise DevelopmentError("unsupported_schema", "发现没有版本号的现有数据库，未覆盖。")
                for sql in _DDL.split(";"):
                    if sql.strip():
                        db.execute(sql)
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
            db.execute("UPDATE inputs SET payload=?, state=? WHERE id=?", (value.model_dump_json(), value.state.value, value.id))
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

    def list_projects(self) -> list[Project]:
        with self._connection() as db:
            values = [Project.model_validate_json(r[0]) for r in db.execute("SELECT payload FROM projects")]
            return sorted(values, key=lambda p: p.last_opened_at, reverse=True)

    def create_session(self, project_id: str, executor: ExecutorId = ExecutorId.MONA,
                       title: str = "新开发任务", model: str | None = None) -> DevelopmentSession:
        session = DevelopmentSession(project_id=project_id, executor=executor, title=title, model=model)
        with self._connection(write=True) as db:
            self._get(db, Project, project_id)
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (session.id, project_id, session.model_dump_json()))
            self._event(db, session, "session.created", {"sessionId": session.id})
        return session

    def get_session(self, session_id: str) -> DevelopmentSession:
        with self._connection() as db:
            return self._get(db, DevelopmentSession, session_id)

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
            session.revision += 1
            session.updated_at = now()
            self._save(db, session)
            self._event(db, session, "session.updated", {"revision": session.revision})
            return session

    def activate_binding(self, binding: Binding, expected_session_revision: int) -> Binding:
        binding = Binding.model_validate(binding.model_dump())
        with self._connection(write=True) as db:
            session = self._get(db, DevelopmentSession, binding.session_id)
            self._revision(session.revision, expected_session_revision)
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted')", (session.id,)).fetchone():
                raise ConflictError("当前轮次尚未结束，不能在派发过程中切换执行者。")
            project = self._get(db, Project, session.project_id)
            if Path(binding.working_directory).resolve() != Path(project.root_path).resolve():
                raise DevelopmentError("invalid_project_context", "原生会话工作目录必须属于当前项目。")
            existing = db.execute("SELECT payload FROM bindings WHERE id=?", (binding.id,)).fetchone()
            if existing:
                old = Binding.model_validate_json(existing[0])
                if (old.session_id, old.executor, old.native_session_id, old.readonly) != (binding.session_id, binding.executor, binding.native_session_id, binding.readonly):
                    raise ConflictError("原生绑定身份不能被替换。")
                # Adapter snapshots cannot overwrite the host-owned handoff journal.
                binding.handoff = old.handoff
            duplicate = db.execute("SELECT id FROM bindings WHERE executor=? AND native_id=?",
                                   (binding.executor.value, binding.native_session_id)).fetchone()
            if duplicate and duplicate[0] != binding.id:
                raise ConflictError("原生会话已绑定，请恢复已有绑定。")
            for row in db.execute("SELECT payload FROM bindings WHERE session_id=?", (session.id,)).fetchall():
                old = Binding.model_validate_json(row[0])
                if old.state == "active":
                    old.state = "parked"
                    self._save(db, old)
            active = binding.model_copy(update={"state": "active", "last_used_at": now()})
            if existing:
                self._save(db, active)
            else:
                db.execute("INSERT INTO bindings VALUES(?,?,?,?,?)", (active.id, session.id, active.executor.value, active.native_session_id, active.model_dump_json()))
            session.executor = active.executor
            session.revision += 1
            session.updated_at = now()
            self._save(db, session)
            self._event(db, session, "executor.changed", {"bindingId": active.id, "executor": active.executor.value})
            return active

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
            if db.execute("SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','interrupted')", (session.id,)).fetchone():
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
            if binding_id:
                binding = self._get(db, Binding, binding_id)
                if binding.session_id != session_id or binding.state != "active" or binding.executor != session.executor:
                    raise ConflictError("原生绑定不属于当前活动执行者。")
            run = Run(session_id=session_id, request_id=request_id, request_message_id=message_id,
                      executor=session.executor, binding_id=binding_id)
            try:
                db.execute("INSERT INTO runs VALUES(?,?,?,?,?)", (run.id, session_id, request_id, run.status.value, run.model_dump_json()))
            except sqlite3.IntegrityError as exc:
                raise ConflictError("本会话仍有未结束轮次，请追加输入或另建会话；同项目的其他会话不受限制。") from exc
            self._event(db, session, "run.queued", {"revision": 0}, run)
            return run, True

    def get_run(self, run_id: str) -> Run:
        with self._connection() as db:
            return self._get(db, Run, run_id)

    def list_runs(self, session_id: str, limit: int = 100) -> list[Run]:
        if not 1 <= limit <= 500:
            raise ValueError("Run page must be 1..500")
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            return [Run.model_validate_json(row[0]) for row in db.execute(
                "SELECT payload FROM runs WHERE session_id=? ORDER BY rowid DESC LIMIT ?", (session_id, limit))]

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
            if status is not None and status != run.status:
                if status not in RUN_TRANSITIONS[run.status]:
                    raise ConflictError("原生事件与当前执行状态不一致。")
                run.status = status
                run.revision += 1
                if status == RunStatus.RUNNING and run.started_at is None:
                    run.started_at = now()
                if status in TERMINAL_RUN_STATUSES:
                    run.finished_at = now()
                    if payload.get("resultMessageId") is not None:
                        run.result_message_id = payload["resultMessageId"]
                self._save(db, run)
            db.execute("INSERT INTO events(id,project_id,session_id,run_id,executor,type,timestamp,payload) VALUES(?,?,?,?,?,?,?,?)",
                       (event_id, session.project_id, session.id, run.id, run.executor.value, kind, now().isoformat(), raw))
            session.updated_at = now()
            self._save(db, session)
            return True

    def transition_run(self, run_id: str, expected_revision: int, status: RunStatus,
                       *, error_code: str | None = None) -> Run:
        with self._connection(write=True) as db:
            run = self._get(db, Run, run_id)
            self._revision(run.revision, expected_revision)
            status = RunStatus(status)
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
                if (previous.session_id, previous.run_id, previous.message_id, previous.intent) != (value.session_id, value.run_id, value.message_id, value.intent):
                    raise ConflictError("输入标识已经被其他内容使用。")
                return previous
            if run.status in TERMINAL_RUN_STATUSES:
                raise ConflictError("本轮已结束，请在原会话发起下一轮，不要重新执行旧请求。")
            db.execute("INSERT INTO inputs VALUES(?,?,?,?,?)", (value.id, value.session_id, value.run_id, value.state.value, value.model_dump_json()))
            session = self._get(db, DevelopmentSession, value.session_id)
            self._event(db, session, "input.queued", {"inputId": value.id}, run)
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

    def events_after(self, session_id: str, after: int = 0, limit: int = 100) -> list[Event]:
        if not 1 <= limit <= 500 or after < 0:
            raise ValueError("事件页大小需要为 1–500，游标必须非负。")
        with self._connection() as db:
            self._get(db, DevelopmentSession, session_id)
            rows = db.execute("SELECT * FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?", (session_id, after, limit)).fetchall()
            return [Event(**{**dict(row), "payload": json.loads(row["payload"])}) for row in rows]

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
                value.state = InputState.UNKNOWN
                value.revision += 1
                self._save(db, value)
                run = self._get(db, Run, value.run_id)
                session = self._get(db, DevelopmentSession, value.session_id)
                self._event(db, session, "input.unknown", {"inputId": value.id, "reason": "host_restarted"}, run)
            for row in db.execute("SELECT payload FROM bindings").fetchall():
                binding = Binding.model_validate_json(row[0])
                if binding.handoff and binding.handoff.state == "reserved":
                    binding.handoff.state = "unknown"
                    self._save(db, binding)
            return len(rows)
