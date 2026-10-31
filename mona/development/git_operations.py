"""Explicit, durable Git actions. UI lifetime never owns a write operation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from mona.development.contracts import now
from mona.development.git_environment import git_command_env, require_git
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError
from mona.development.workspace import project_path


class GitUncertainError(Exception):
    pass


def digest(value) -> str:
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


async def git(root: Path, *args: str, stdin: bytes | None = None, timeout: int = 20, index_file: Path | None = None):
    executable = await require_git()
    env = git_command_env()
    if index_file is not None:
        env["GIT_INDEX_FILE"] = str(index_file)
    try:
        process = await asyncio.create_subprocess_exec(executable, "--no-pager", "--literal-pathspecs",
            "-c", "core.fsmonitor=false", *args, cwd=root, env=env,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=os.name != "nt")
    except OSError as exc:
        raise DevelopmentError("git_unavailable", "Git 无法启动，请重新检测；未执行 Git 操作。") from exc

    async def read(stream):
        data = bytearray()
        while chunk := await stream.read(65536):
            data.extend(chunk)
            if len(data) > 2_097_152:
                raise GitUncertainError("Git 输出超过读取范围，请核对实际结果。")
        return bytes(data)

    async def send():
        if stdin is not None:
            try:
                process.stdin.write(stdin)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass  # The exit code, not an early stdin close, determines the outcome.
            finally:
                process.stdin.close()

    readers = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr)),
               asyncio.create_task(send())]

    async def collect():
        out, err, _ = await asyncio.gather(*readers)
        await process.wait()
        return process.returncode, out, err
    try:
        return await asyncio.wait_for(collect(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError, GitUncertainError) as exc:
        from mona.agent.tools.shell import kill_process_tree

        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        # Drain while terminating: paused pipes can keep wait() pending after Git exits.
        try:
            await asyncio.wait_for(asyncio.gather(kill_process_tree(process), process.communicate()), 10)
        except asyncio.TimeoutError:
            # Helpers can retain inherited pipes; release only this process's owned handles.
            process._transport.close()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise GitUncertainError("等待 Git 结果中断；子进程或远程操作可能仍在运行，请核对后再操作。") from exc


async def read_git(root: Path, *args: str) -> bytes:
    code, out, _ = await git(root, *args)
    if code:
        raise DevelopmentError("git_read_failed", "无法读取仓库状态，请在终端核对 Git 配置。")
    return out


def destination_label(url: str) -> str:
    if "://" in url:
        value = urlsplit(url)
        return urlunsplit((value.scheme, value.netloc.rsplit("@", 1)[-1], value.path, "", ""))
    return url.rsplit("@", 1)[-1] if re.match(r"^[^/@]+@[^/:]+:", url) else url


class GitOperations:
    def __init__(self, store: DevelopmentStore):
        self.store = store
        self.path = store.path.parent / "git-operations.sqlite3"
        self.tasks: dict[str, asyncio.Task] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.closed = False
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, "
                "session_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS operations_session ON operations(session_id)")
            for (raw,) in db.execute("SELECT payload FROM operations WHERE status='running'").fetchall():
                item = json.loads(raw)
                item.update(status="unknown", reason="服务曾中断。原操作可能已完成或仍在运行，没有重新执行。")
                self._write(db, item)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _write(db, item):
        db.execute("INSERT OR REPLACE INTO operations VALUES (?,?,?,?,?)", (item["id"], item["projectId"],
            item["sessionId"], item["status"], json.dumps(item, ensure_ascii=False)))

    def _save(self, item):
        try:
            self.store.get_session(item["sessionId"])
        except NotFoundError:
            return
        with self._db() as db:
            self._write(db, item)

    def delete_sessions(self, session_ids: set[str]) -> set[asyncio.Task]:
        placeholders = ",".join("?" for _ in session_ids)
        tasks = set()
        with self._db() as db:
            for (identifier,) in db.execute(f"SELECT id FROM operations WHERE session_id IN ({placeholders})", tuple(session_ids)):
                task = self.tasks.get(identifier)
                if task:
                    task.cancel()
                    tasks.add(task)
            db.execute(f"DELETE FROM operations WHERE session_id IN ({placeholders})", tuple(session_ids))
        return tasks

    @staticmethod
    def public(item):
        return {key: value for key, value in item.items() if key not in {"signature", "requestDigest"}}

    def _load(self, session_id: str, operation_id: str):
        self.store.get_session(session_id)
        with self._db() as db:
            row = db.execute("SELECT payload FROM operations WHERE id=? AND session_id=?", (operation_id, session_id)).fetchone()
        if row is None:
            raise NotFoundError()
        return json.loads(row[0])

    def get(self, session_id, operation_id):
        return self.public(self._load(session_id, operation_id))

    def recent(self, session_id):
        self.store.get_session(session_id)
        with self._db() as db:
            rows = db.execute("SELECT payload FROM operations WHERE session_id=? AND "
                "json_extract(payload,'$.kind') IN ('stage','commit','push','commit_and_push','commit_and_switch') ORDER BY rowid DESC LIMIT 12", (session_id,)).fetchall()
        return [self.public(json.loads(row[0])) for row in rows]

    async def _root(self, session_id: str, *, writing=False):
        session = self.store.get_session(session_id)
        if writing and (self.closed or session.readonly or session.archived):
            raise DevelopmentError("git_readonly", "当前会话不能修改 Git 仓库。")
        project = self.store.get_project(session.project_id)
        root = project_path(project)
        top = Path((await read_git(root, "rev-parse", "--show-toplevel")).decode().strip()).resolve()
        if root != top:
            raise DevelopmentError("git_repository_scope", "请把 Git 仓库根目录作为开发项目打开后再执行 Git 操作；子目录仍可查看文件与差异。")
        return session, root

    async def _identity(self, root):
        code, head, _ = await git(root, "rev-parse", "--verify", "HEAD")
        _, branch, _ = await git(root, "symbolic-ref", "--quiet", "--short", "HEAD")
        return {"head": None if code else head.decode().strip(), "branch": branch.decode().strip()}

    async def _index(self, root):
        return await read_git(root, "ls-files", "--stage", "-z")

    async def context(self, session_id, *, refresh=False):
        self.store.get_session(session_id)
        await require_git(refresh=refresh)
        session, root = await self._root(session_id)
        identity = await self._identity(root)
        raw = await read_git(root, "-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all")
        rows = [{"status": part[:2].decode(), "path": part[3:].decode("utf-8")} for part in raw.split(b"\0") if part]
        if len(rows) > 2000:
            raise DevelopmentError("git_too_many_files", "变更文件过多，请先在终端缩小范围；没有返回不完整的勾选列表。")
        remotes = (await read_git(root, "remote")).decode().splitlines()
        default = ""
        default_branch = identity["branch"]
        if identity["branch"]:
            _, value, _ = await git(root, "config", "--get", f"branch.{identity['branch']}.remote")
            default = value.decode().strip()
            _, merge, _ = await git(root, "config", "--get", f"branch.{identity['branch']}.merge")
            if merge.decode().strip().startswith("refs/heads/"):
                default_branch = merge.decode().strip().removeprefix("refs/heads/")
        if default not in remotes:
            _, configured, _ = await git(root, "config", "--get", "remote.pushDefault")
            default = configured.decode().strip()
        return {**identity, "files": rows, "remotes": remotes, "defaultBranch": default_branch,
            "defaultRemote": default if default in remotes else ("origin" if "origin" in remotes else remotes[0] if len(remotes) == 1 else ""),
            "writable": not session.readonly and not session.archived}

    async def preview(self, session_id, include_unstaged=True):
        from mona.development.git_views import preview
        return await preview(self, session_id, include_unstaged)

    async def graph(self, session_id, skip=0):
        from mona.development.git_views import graph
        return await graph(self, session_id, skip)

    async def commit_detail(self, session_id, sha, path=None):
        from mona.development.git_views import commit_detail
        return await commit_detail(self, session_id, sha, path)

    async def branches(self, session_id):
        session, root = await self._root(session_id)
        identity = await self._identity(root)
        with self._db() as db:
            row = db.execute("SELECT payload FROM operations WHERE project_id=? AND status IN ('running','unknown') "
                "AND json_extract(payload,'$.kind') IN ('create_branch','switch_branch') ORDER BY rowid DESC LIMIT 1",
                (session.project_id,)).fetchone()
        return {**identity, "branches": await self.branches_for_root(root),
            "pendingAction": self.public(json.loads(row[0])) if row else None}

    async def _remote(self, root, name, branch):
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", name):
            raise DevelopmentError("invalid_remote", "请选择仓库中已配置的远程名称。")
        code, _, _ = await git(root, "check-ref-format", f"refs/heads/{branch}")
        if code or not branch or branch.startswith("-"):
            raise DevelopmentError("invalid_branch", "远程分支名称无效。")
        if name not in (await read_git(root, "remote")).decode().splitlines():
            raise DevelopmentError("invalid_remote", "所选远程已不存在。")
        values = (await read_git(root, "remote", "get-url", "--push", "--all", name)).decode().splitlines()
        _, mirror, _ = await git(root, "config", "--get", f"remote.{name}.mirror")
        if len(values) != 1 or mirror.strip() == b"true":
            raise DevelopmentError("git_remote_scope", "多推送地址或镜像远程不支持单分支确认，请在终端处理。")
        url = values[0]
        if "::" in url or ("://" in url and urlsplit(url).scheme not in {"https", "http", "ssh", "git", "file"}):
            raise DevelopmentError("git_remote_transport", "此远程使用自定义传输，请在终端处理。")
        return {"fingerprint": digest(url), "destination": destination_label(url)}

    async def _normal(self, root):
        for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "index.lock"):
            path = Path((await read_git(root, "rev-parse", "--git-path", marker)).decode().strip())
            if (root / path).exists():
                raise ConflictError("仓库有进行中的 Git 操作或锁，请先在终端处理；没有清理锁或覆盖状态。")

        if await read_git(root, "ls-files", "--unmerged", "-z"):
            raise ConflictError("暂存区存在未解决的冲突，请先在终端处理。")

    def _file(self, root, relative):
        path = Path(relative)
        if path.is_absolute() or path.drive or any(ord(char) < 32 for char in relative) or ".git" in path.parts:
            raise DevelopmentError("invalid_git_path", "所选路径不能用于 Git 操作。")
        target = (root / path).resolve()
        if not target.is_relative_to(root) or target == root or (root / path).is_symlink() or target.is_dir():
            raise DevelopmentError("invalid_git_path", "只支持项目内普通文件；链接、子模块及目录请在终端处理。")
        if not target.exists():
            return None
        with target.open("rb") as stream:
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
        return {"sha256": sha, "mode": target.stat().st_mode}

    async def _signature(self, root, kind, paths, remote, branch, *, include_unstaged=True):
        identity = await self._identity(root)
        if kind in {"create_branch", "switch_branch"}:
            if not branch or branch.startswith("-") or any(ord(char) < 32 for char in branch):
                raise DevelopmentError("invalid_branch", "分支名称无效。")
            code, _, _ = await git(root, "check-ref-format", f"refs/heads/{branch}")
            if code:
                raise DevelopmentError("invalid_branch", "分支名称无效。")
            names = await self.branches_for_root(root)
            if kind == "create_branch" and branch in names:
                raise ConflictError("分支已存在，请换一个名称。")
            if kind == "switch_branch" and branch not in names:
                raise DevelopmentError("branch_not_found", "目标分支不存在，请选择本地分支。")
            if kind == "switch_branch" and branch == identity["branch"]:
                raise ConflictError("当前已在所选分支。")
            if kind == "create_branch" and not identity["head"]:
                raise DevelopmentError("git_unborn", "当前仓库尚无提交，无法从当前版本创建分支。")
            await self._normal(root)
            return {**identity, "target": branch, "index": digest(await self._index(root)),
                "working": digest(await read_git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"))}
        if kind == "push":
            if not identity["branch"]:
                raise DevelopmentError("git_detached", "当前是分离 HEAD，请先切回分支后再推送。")
            if not identity["head"]:
                raise DevelopmentError("git_unborn", "当前分支还没有提交，不能推送。")
            return {**identity, **await self._remote(root, remote, branch)}
        await self._normal(root)
        result = {**identity, "index": digest(await self._index(root)),
            "files": {path: self._file(root, path) if include_unstaged else None for path in paths}}
        if kind == "commit_and_push":
            if not identity["branch"]:
                raise DevelopmentError("git_detached", "当前是分离 HEAD，请先切回分支后再推送。")
            result.update(await self._remote(root, remote, branch) if remote else {"fingerprint": None, "destination": ""})
        if kind == "commit_and_switch":
            if branch not in await self.branches_for_root(root) or branch == identity["branch"]:
                raise DevelopmentError("invalid_branch", "请选择其他本地分支。")
            result["targetHead"] = (await read_git(root, "rev-parse", f"refs/heads/{branch}")).decode().strip()
        return result

    async def branches_for_root(self, root):
        return (await read_git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")).decode().splitlines()

    async def prepare(self, session_id, request_id, kind, paths, message="", remote="", branch="", include_unstaged=True, context_token=None):
        session, root = await self._root(session_id, writing=True)
        key = "git_" + digest([session_id, request_id])[:40]
        request_digest = digest([kind, paths, message, remote, branch, include_unstaged, context_token])
        with self._db() as db:
            prior = db.execute("SELECT payload FROM operations WHERE id=?", (key,)).fetchone()
        if prior:
            item = json.loads(prior[0])
            if item["requestDigest"] != request_digest:
                raise ConflictError("同一请求标识对应不同内容。")
            return self.public(item)
        if kind not in {"stage", "commit", "push", "create_branch", "switch_branch", "commit_and_push", "commit_and_switch"}:
            raise DevelopmentError("invalid_git_action", "不支持的 Git 操作。")
        if kind in {"create_branch", "switch_branch"}:
            if paths or message or remote:
                raise DevelopmentError("invalid_git_action", "分支操作不接受文件、提交说明或远程仓库。")
        elif kind != "push":
            available = {row["path"] for row in (await self.context(session_id))["files"]}
            if not paths or len(paths) > 2000 or len(set(paths)) != len(paths) or not set(paths).issubset(available):
                raise ConflictError("请选择当前列表中实际变更的文件，不接受目录或通配选择。")
        elif paths:
            raise DevelopmentError("invalid_git_action", "推送针对明确的提交和远程分支，不接受文件选择。")
        if kind in {"commit", "commit_and_push", "commit_and_switch"} and (not message.strip() or "\0" in message or len(message) > 4000):
            raise DevelopmentError("invalid_commit_message", "请填写不超过 4000 字的提交说明。")
        if context_token and (await self.preview(session_id, include_unstaged))["contextToken"] != context_token:
            raise ConflictError("更改已发生变化，请重新读取后提交。")
        if not include_unstaged and kind != "push":
            staged = {row["path"] for row in (await self.context(session_id))["files"] if row["status"][0] not in {" ", "?"}}
            if not set(paths).issubset(staged):
                raise ConflictError("所选文件没有可提交的暂存更改。")
        signature = await self._signature(root, kind, paths, remote, branch, include_unstaged=include_unstaged)
        item = {"id": key, "projectId": session.project_id, "sessionId": session_id, "kind": kind,
            "paths": paths, "message": message, "remote": remote, "targetBranch": branch,
            "branch": signature["branch"], "expectedHead": signature["head"],
            "destination": signature.get("destination", ""), "signature": signature, "requestDigest": request_digest,
            "status": "prepared", "phase": "prepared", "steps": [], "reason": "", "commit": None,
            "exitCode": None, "createdAt": now().isoformat()}
        item["includeUnstaged"] = include_unstaged
        with self._db() as db:
            db.execute("INSERT OR IGNORE INTO operations VALUES (?,?,?,?,?)", (key, session.project_id,
                session_id, "prepared", json.dumps(item, ensure_ascii=False)))
            existing = json.loads(db.execute("SELECT payload FROM operations WHERE id=?", (key,)).fetchone()[0])
        if existing["requestDigest"] != request_digest:
            raise ConflictError("同一请求标识对应不同内容。")
        return self.public(existing)

    async def execute(self, session_id, operation_id):
        session, _ = await self._root(session_id, writing=True)
        async with self.locks.setdefault(session.project_id, asyncio.Lock()):
            item = self._load(session_id, operation_id)
            if item["status"] != "prepared":
                return self.public(item)
            with self._db() as db:
                pending = db.execute("SELECT 1 FROM operations WHERE project_id=? AND status IN ('running','unknown') LIMIT 1", (session.project_id,)).fetchone()
            if pending:
                raise ConflictError("仓库还有进行中或结果未知的 Git 操作，请先核对原操作。")
            self._step(item, "checking")
            task = asyncio.create_task(self._execute(item), name=f"development-git:{operation_id}")
            self.tasks[operation_id] = task
            task.add_done_callback(lambda _: self.tasks.pop(operation_id, None))
            return self.public(item)

    def _step(self, item, phase):
        if item["steps"]:
            item["steps"][-1]["status"] = "completed"
        item["steps"].append({"phase": phase, "status": "running", "startedAt": now().isoformat()})
        item.update(status="running", phase=phase)
        self._save(item)

    def _end(self, item, status, reason=""):
        item.update(status=status, reason=reason, finishedAt=now().isoformat())
        if item["steps"]:
            item["steps"][-1]["status"] = "completed" if status == "succeeded" else status
        self._save(item)

    @staticmethod
    def _other_index(raw, selected):
        return digest([part.decode("utf-8") for part in raw.split(b"\0") if part and part.split(b"\t", 1)[1].decode("utf-8") not in selected])

    async def _commit_index(self, root, paths, message):
        selected = set(paths)
        entries = [part for part in (await self._index(root)).split(b"\0") if part and part.split(b"\t", 1)[1].decode() in selected]
        identity = await self._identity(root)
        object_format = (await read_git(root, "rev-parse", "--show-object-format")).strip()
        zero = b"0" * (64 if object_format == b"sha256" else 40)
        removals = [b"0 " + zero + b"\t" + path.encode() for path in paths]
        with tempfile.TemporaryDirectory(prefix="mona-git-index-") as directory:
            index = Path(directory) / "index"
            code, _, _ = await git(root, "read-tree", identity["head"] or "--empty", index_file=index)
            if code:
                raise DevelopmentError("git_index_failed", "无法准备暂存内容，未提交。")
            code, _, _ = await git(root, "update-index", "-z", "--index-info", index_file=index,
                stdin=b"\0".join(removals + entries) + b"\0")
            if code:
                raise DevelopmentError("git_index_failed", "无法准备所选文件，未提交。")
            return await git(root, "commit", "-m", message, index_file=index, timeout=180)

    async def _push(self, root, item, commit):
        self._step(item, "pushing")
        code, out, _ = await git(root, "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
            "--", item["remote"], f"{commit}:refs/heads/{item['targetBranch']}", timeout=180)
        item["exitCode"] = code
        if code:
            rejected = b"[rejected]" in out or b"[remote rejected]" in out
            prefix = "本地提交已完成；" if item["kind"] == "commit_and_push" else ""
            self._end(item, "failed" if rejected else "unknown", prefix + ("远程拒绝推送。" if rejected else "推送结果无法确认，请核对远程状态。"))
            return
        current = await self._identity(root)
        if current["head"] == commit and current["branch"] == item["branch"]:
            code, _, _ = await git(root, "config", "--get", f"branch.{item['branch']}.remote")
            if code:
                for key, value in (("remote", item["remote"]), ("merge", f"refs/heads/{item['targetBranch']}")):
                    code, _, _ = await git(root, "config", f"branch.{item['branch']}.{key}", value)
                    if code:
                        raise GitUncertainError("推送已完成，但分支跟踪配置未保存，请核对远程分支。")
        item["commit"] = commit
        self._end(item, "succeeded", "已提交并推送。" if item["kind"] == "commit_and_push" else "已推送。")

    async def _switch(self, root, item, current):
        self._step(item, "switching")
        create = item["kind"] == "create_branch"
        args = ("switch", "-c", item["targetBranch"]) if create else ("switch", item["targetBranch"])
        code, _, stderr = await git(root, *args, timeout=45)
        item["exitCode"] = code
        final = await self._identity(root)
        if code == 0 and final["branch"] == item["targetBranch"]:
            self._end(item, "succeeded", "已创建并切换分支。" if create else "已切换分支。")
        elif create and item["targetBranch"] in await self.branches_for_root(root):
            self._end(item, "unknown", "分支可能已创建，但未确认切换结果。请核对当前分支。")
        elif final["branch"] == current["branch"]:
            if b"would be overwritten" in stderr:
                item["errorCode"] = "branch_overwrite"
                item["affectedPaths"] = [line.strip().decode("utf-8", errors="replace") for line in stderr.splitlines() if line.startswith(b"\t")]
            self._end(item, "failed", "本地更改会被覆盖，请先提交更改再切换。" if item.get("errorCode") else "Git 未切换分支，请核对分支占用或当前仓库状态。")
        else:
            self._end(item, "unknown", "切换结果无法确认，请核对当前分支。")

    async def _execute(self, item):
        dispatched = False
        try:
            _, root = await self._root(item["sessionId"], writing=True)
            include_unstaged = item.get("includeUnstaged", True)
            current = await self._signature(root, item["kind"], item["paths"], item["remote"], item["targetBranch"], include_unstaged=include_unstaged)
            if current != item["signature"]:
                raise ConflictError("分支、文件、暂存或远程配置已变化，请重新预览并确认；没有执行写操作。")
            if item["kind"] in {"create_branch", "switch_branch", "commit_and_switch"}:
                for session in self.store.list_sessions(item["projectId"]):
                    if self.store.active_run(session.id):
                        raise ConflictError("项目仍有执行中的任务，请在任务结束后切换分支。")
            if item["kind"] in {"create_branch", "switch_branch"}:
                dispatched = True
                await self._switch(root, item, current)
                return
            if item["kind"] == "push":
                dispatched = True
                await self._push(root, item, item["expectedHead"])
                return
            others = self._other_index(await self._index(root), item["paths"])
            paths_input = b"\0".join(path.encode() for path in item["paths"]) + b"\0"
            if include_unstaged or item["kind"] == "stage":
                self._step(item, "staging")
                dispatched = True
                code, _, _ = await git(root, "add", "--pathspec-from-file=-", "--pathspec-file-nul", stdin=paths_input, timeout=120)
                item["exitCode"] = code
                if code:
                    self._end(item, "failed", "暂存未完成；已生效的暂存保留，请核对后重试。")
                    return
            after = await self._signature(root, item["kind"], item["paths"], item["remote"], item["targetBranch"], include_unstaged=include_unstaged)
            if any(after[key] != current[key] for key in ("head", "branch", "files")) or self._other_index(await self._index(root), item["paths"]) != others:
                self._end(item, "failed", "暂存期间仓库内容发生变化，已停止后续提交；现有暂存保留，请重新预览。")
                return
            if item["kind"] == "stage":
                self._end(item, "succeeded", "所选文件已暂存，其他文件未改动。")
                return
            selected_index = {part.split(b"\t", 1)[1]: part.split(b"\t", 1)[0].split()[:2]
                for part in (await self._index(root)).split(b"\0") if part and part.split(b"\t", 1)[1].decode() in item["paths"]}
            self._step(item, "committing")
            dispatched = True
            code, _, _ = await self._commit_index(root, item["paths"], item["message"])
            item["exitCode"] = code
            final = await self._identity(root)
            if final["head"] == current["head"]:
                self._end(item, "failed" if code else "unknown", "未确认生成新提交。请在终端核对提交检查或签名配置；工作区与暂存保留。")
                return
            item["commit"] = final["head"]
            parents = (await read_git(root, "rev-list", "--parents", "-n", "1", final["head"])).decode().split()[1:]
            changed = {part.decode() for part in (await read_git(root, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", final["head"])).split(b"\0") if part}
            tree = await read_git(root, "ls-tree", "-r", "-z", final["head"])
            selected_tree = {part.split(b"\t", 1)[1]: [part.split()[0], part.split()[2]] for part in tree.split(b"\0")
                if part and part.split(b"\t", 1)[1].decode() in item["paths"]}
            expected_parents = [current["head"]] if current["head"] else []
            if final["branch"] != current["branch"] or parents != expected_parents or not changed.issubset(set(item["paths"])) or selected_tree != selected_index or self._other_index(await self._index(root), item["paths"]) != others:
                self._end(item, "unknown", "出现新提交，但结果与确认范围不一致，可能有并发修改或提交钩子改变内容。没有回滚，请核对实际提交。")
            elif item["kind"] == "commit_and_push":
                if not item["remote"]:
                    self._end(item, "failed", "本地提交已完成，但尚未配置可用的推送目标。")
                    return
                if await self._remote(root, item["remote"], item["targetBranch"]) != {key: current[key] for key in ("fingerprint", "destination")}:
                    self._end(item, "failed", "本地提交已完成，但远程配置已变化，未推送。")
                    return
                await self._push(root, item, final["head"])
            elif item["kind"] == "commit_and_switch":
                if (await read_git(root, "rev-parse", f"refs/heads/{item['targetBranch']}")).decode().strip() != current["targetHead"]:
                    self._end(item, "failed", "提交已完成，但目标分支已变化，未切换。")
                    return
                await self._switch(root, item, final)
            else:
                self._end(item, "succeeded", "已提交所选文件，未提交其他暂存文件，也未推送。")
        except asyncio.CancelledError:
            self._end(item, "unknown" if dispatched else "failed", "服务停止等待，不能确认 Git 子进程或远程操作已结束；未重新执行。")
            raise
        except (DevelopmentError, GitUncertainError) as exc:
            uncertain = dispatched and (isinstance(exc, GitUncertainError) or item["phase"] in {"committing", "pushing", "switching"})
            self._end(item, "unknown" if uncertain else "failed", str(exc))
        except Exception:
            self._end(item, "unknown" if dispatched else "failed", "Git 操作结果待核对，请检查本地仓库；未自动重试。")

    def acknowledge(self, session_id, operation_id):
        item = self._load(session_id, operation_id)
        if item["status"] != "unknown":
            raise ConflictError("只有结果未知的操作需要人工核对。")
        item.update(status="acknowledged", reason="用户已确认完成外部核对；此记录不代表 Git 操作成功，也不会重新执行。")
        self._save(item)
        return self.public(item)

    async def close(self):
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
