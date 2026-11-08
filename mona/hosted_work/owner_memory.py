"""Desktop memory search over only the executing hosted account's memory."""
from __future__ import annotations

import hashlib
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from mona.agent.tools.memory_tools import MemoryReadTool, MemorySearchTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.unified_memory import ReadMemoryTool, SearchMemoryTool
from mona.config.loader import get_config_path
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.frontend import _is_link

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_FILES = {"memory": "MEMORY.md", "soul": "SOUL.md"}


class _OwnerScope:
    def __init__(self, ctx):
        self.ctx, self.memory = ctx, ctx.memory
        self.owner, self.session_id = ctx.owner, identifier(ctx.session_id)
        if not isinstance(self.owner, str) or not _OWNER.fullmatch(self.owner):
            raise WorkError("runtime_scope", "会话记忆不属于当前账户。", 403)
        root, self.runtime = Path(ctx.config.state_dir), Path(ctx._runtime)
        if not root.is_absolute() or self.runtime != root / "users" / self.owner / "runtime":
            raise WorkError("runtime_scope", "会话记忆不属于当前账户。", 403)
        self.directory = self.runtime / "agents" / "mona" / "memory"
        self.history = self.directory / "history.jsonl"
        self.check()

    def check(self, *files: Path) -> None:
        """Recheck the account boundary without creating or consulting any other store."""
        try:
            if (self.ctx.owner != self.owner or self.ctx.session_id != self.session_id
                    or self.ctx.memory is not self.memory or Path(self.ctx._runtime) != self.runtime
                    or Path(self.ctx.config.state_dir) / "users" / self.owner / "runtime" != self.runtime
                    or get_config_path().absolute() != self.runtime / "config.json"
                    or self.memory.agent_id != "mona" or Path(self.memory.memory_dir) != self.directory
                    or Path(self.memory.memory_file) != self.directory / "MEMORY.md"
                    or Path(self.memory.soul_file) != self.directory / "SOUL.md"
                    or Path(self.memory.agents_file) != self.directory / "AGENTS.md"
                    or Path(self.memory.history_file) != self.history):
                raise WorkError("runtime_scope", "会话记忆不属于当前账户。", 403)
            for directory in (*reversed(self.directory.parents), self.directory):
                if _is_link(directory):
                    raise WorkError("runtime_scope", "会话记忆目录未通过安全检查。", 503)
            if not self.directory.is_dir() or not self.directory.resolve(strict=True).is_relative_to(self.runtime):
                raise WorkError("runtime_scope", "会话记忆目录未通过安全检查。", 503)
            for path in files:
                if path.parent != self.directory or _is_link(path):
                    raise WorkError("runtime_scope", "会话记忆文件未通过安全检查。", 503)
                try:
                    info = path.stat()
                except FileNotFoundError:
                    continue
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or not path.resolve(strict=True).is_relative_to(self.directory)):
                    raise WorkError("runtime_scope", "会话记忆文件未通过安全检查。", 503)
        except OSError:
            raise WorkError("runtime_scope", "会话记忆暂不可用。", 503) from None


class _OwnerMemoryRead(MemoryReadTool):
    def __init__(self, scope: _OwnerScope):
        super().__init__("mona")
        self.scope = scope

    async def read_result(self, file: str) -> dict:
        if file not in _FILES:
            raise ValueError("Invalid memory file.")
        path = self.scope.directory / _FILES[file]
        previous = self.scope.directory / (path.name + ".previous")
        sources = [path, self.scope.directory / "AGENTS.md"] if file == "soul" else [path]
        try:
            self.scope.check(*sources, previous)
            content = self.scope.memory.read_soul() if file == "soul" else self.scope.memory.read_memory()
            updated = max((source.stat().st_mtime for source in sources if source.exists()), default=None)
            return {"key": file, "filename": path.name, "content": content,
                    "contentHash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                    "hasPrevious": previous.exists(),
                    "updatedAt": datetime.fromtimestamp(updated, tz=timezone.utc).isoformat() if updated is not None else None}
        except Exception:
            raise RuntimeError("Account memory is unavailable.") from None

    async def execute(self, **_kwargs):
        return "Error: use search_memory, then read_memory."


class _OwnerEvents(MemorySearchTool):
    def __init__(self, scope: _OwnerScope):
        super().__init__("mona", history_path=scope.history)
        self.scope = scope

    def _history_entries(self):
        try:
            self.scope.check(self.scope.history)
        except WorkError:
            raise RuntimeError("Account event memory is unavailable.") from None
        yield from super()._history_entries()

    async def execute(self, **_kwargs):
        return "Error: use search_memory, then read_memory."


class _OwnerSearch(SearchMemoryTool):
    description = (SearchMemoryTool.description +
                   " In this context account memory, events, and authorized conversation history may be connected; "
                   "other sources are unavailable.")

    def __init__(self, ctx, scope: _OwnerScope):
        super().__init__(ctx)
        self.scope = scope

    def _workspace_key(self):
        # Refs live only in this source registry; never inspect the host
        # workspace or a process-global desktop workspace for their identity.
        return f"hosted:{self.scope.owner}:{self.scope.session_id}"

    async def _search_queries(self, source, query, alternatives, limit, filters):
        if source != "conversations":
            return await super()._search_queries(source, query, alternatives, limit, filters)
        from mona.hosted_work.conversation_memory import conversation_query_budget

        # Alternate/relaxed queries are part of the same user request and may
        # not each claim a separate full transcript scan allowance.
        with conversation_query_budget(self.scope.ctx.config):
            return await super()._search_queries(source, query, alternatives, limit, filters)


def build_memory_tools(ctx, *, include_conversations: bool = False) -> tuple:
    """Create fresh shared facades and an account-only source registry.

    Ownerless in-process callers are deliberately given no private sources.
    """
    if ctx.owner is None and ctx._runtime is None:
        return ()
    if ctx.owner is None or ctx._runtime is None:
        raise WorkError("runtime_scope", "会话记忆不属于当前账户。", 403)
    scope = _OwnerScope(ctx)
    registry = ToolRegistry()
    registry.register(_OwnerMemoryRead(scope))
    registry.register(_OwnerEvents(scope))
    if include_conversations:
        from mona.hosted_work.conversation_memory import conversation_tools

        for tool in conversation_tools(ctx, scope):
            registry.register(tool)
    context = SimpleNamespace(registry=registry, workspace="/workspace")
    search, read = _OwnerSearch(context, scope), ReadMemoryTool(context)
    registry.register(search)
    registry.register(read)
    return search, read
