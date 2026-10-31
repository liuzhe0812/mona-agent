"""One search/read interface over the executing Agent's authorized local sources."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import unicodedata
import uuid
from importlib.resources import files as pkg_files
from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

_DEFAULT_SOURCES = ("notes", "knowledge", "conversations", "memory")
_SOURCES = (*_DEFAULT_SOURCES, "events")
_SOURCE_TOOLS = {
    "notes": {"notes_search": {"query": "check"}, "notes_read": {"note_id": "check"}},
    "knowledge": {"knowledge_search": {"query": "check"}, "knowledge_read": {"ref": "check"}},
    "conversations": {
        "conversation_search": {"query": "check"}, "conversation_read": {"ref": "check"},
    },
    "memory": {"memory_read": {"file": "memory"}},
    "events": {"memory_search": {"query": "check"}},
}
_MAX_REFERENCES = 1024
_MAX_RELAXED_TERMS = 4
_RANK_OFFSET = 60


def _normalize_query(query: str) -> str:
    query = unicodedata.normalize("NFKC", query)
    query = re.sub(r"[,;、]+", " ", query)
    return " ".join(query.strip(" \t\r\n\"'“”‘’《》「」『』?!。 ").split())


def _query_variants(query: str, alternatives: list[str]) -> list[str]:
    variants = []
    seen = {query.casefold()}
    for candidate in [_normalize_query(query), *(_normalize_query(item) for item in alternatives)]:
        if candidate and candidate.casefold() not in seen:
            seen.add(candidate.casefold())
            variants.append(candidate)
    return variants


def _result_order(row: dict[str, Any]) -> tuple:
    original = row["kind"] == "document" or (
        row["kind"] == "conversation" and row.get("role") == "user" and row.get("completed") is not False
    )
    evidence = 3 if original else 2 if row["kind"] == "note" else 1 if row["kind"] == "summary" else 0
    return (-row["rank_score"], bool(row.get("stale")), -evidence)


class _MemoryTool(Tool):
    _scopes = {"core", "subagent"}
    system_managed = True
    read_only = True

    def __init__(self, ctx: Any) -> None:
        self._registry = ctx.registry
        self._workspace = Path(ctx.workspace)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(ctx)

    @property
    def concurrency_safe(self) -> bool:
        # Conversation and Knowledge searches may refresh their derived indexes.
        return False

    def _source_tool(self, name: str, params: dict[str, Any]) -> tuple[Tool, dict[str, Any]]:
        if not self._registry.has(name):
            raise LookupError(f"{name} is unavailable in this execution context.")
        if not self._registry.is_permitted(name):
            raise PermissionError(f"{name} is not permitted for this Agent.")
        params = {key: value for key, value in params.items() if value is not None}
        tool, params, error = self._registry.prepare_call(name, params, memory_source=True)
        if error:
            raise ValueError(error)
        assert tool is not None
        return tool, params

    def _authorize(self, source: str) -> None:
        for name, params in _SOURCE_TOOLS[source].items():
            self._source_tool(name, params)

    def _workspace_key(self) -> str:
        return str(get_current_workspace(self._workspace).resolve())


@tool_parameters(tool_parameters_schema(
    query=StringSchema("Short literal query in the user's language; the original query is preserved. Not regex.", min_length=1, max_length=500),
    alternatives=ArraySchema(StringSchema("An alternative short phrase, synonym, or translation.", min_length=1, max_length=500), description="Optional alternative phrasings; keep translations separate rather than requiring them together. No extra model request is made.", max_items=3),
    sources=ArraySchema(StringSchema(enum=list(_SOURCES)), description="Optional source filter. Events are private archived summaries/logs, searched only when explicitly selected."),
    limit=IntegerSchema(5, description="Maximum results across all sources (default 5, maximum 20).", minimum=1, maximum=20),
    cursor=StringSchema("Search continuation returned for conversations; use sources=['conversations']."),
    session_key=StringSchema("Optional conversation session filter."),
    date_from=StringSchema("Optional inclusive conversation date or timestamp."),
    date_to=StringSchema("Optional inclusive conversation date or timestamp."),
    required=["query"],
))
class SearchMemoryTool(_MemoryTool):
    name = "search_memory"
    description = (
        "Search authorized local notes, uploaded knowledge, previous conversations, and private "
        "long-term memory. Results identify original sources versus AI summaries. Read promising "
        "refs with read_memory before answering factual or historical questions. Source failures "
        "and partial coverage are reported separately. Private event logs require sources=['events']; "
        "they are summaries, not original conversation evidence. Ranking scores order candidates, "
        "not answer confidence. A match alone does not establish the answer."
    )

    def __init__(self, ctx: Any) -> None:
        super().__init__(ctx)
        self._references: dict[str, tuple[str, str, str]] = {}

    def _reference(self, source: str, native_ref: str) -> str:
        record = (source, native_ref, self._workspace_key())
        for ref, existing in self._references.items():
            if existing == record:
                self._references.pop(ref)
                self._references[ref] = record
                return ref
        ref = "memory:" + uuid.uuid4().hex
        self._references[ref] = record
        if len(self._references) > _MAX_REFERENCES:
            self._references.pop(next(iter(self._references)))
        return ref

    def resolve_reference(self, ref: str) -> tuple[str, str]:
        record = self._references.get(ref)
        if record is None or record[2] != self._workspace_key():
            raise ValueError("Reference expired or belongs to another workspace; run search_memory again.")
        return record[0], record[1]

    async def _search_source(
        self, source: str, query: str, limit: int, filters: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        self._authorize(source)
        status: dict[str, Any] = {"status": "ok"}
        if source in {"notes", "knowledge"}:
            tool, _ = self._source_tool(source + "_search", {"query": query, "limit": limit})
            items = await tool.search_results(query, limit)
        elif source == "events":
            tool, _ = self._source_tool("memory_search", {"query": query, "limit": limit})
            items = await tool.search_results(query, limit, fixed_strings=True)
        elif source == "conversations":
            tool, params = self._source_tool("conversation_search", {"query": query, "limit": limit, **filters})
            response = json.loads(await tool.execute(**params))
            status = {key: value for key, value in response.items() if key != "results"}
            if response.get("status") not in {"ok", "partial"}:
                return [], status
            items = response["results"]
        else:
            items = []
            for file, title in (("memory", "Long-term memory"), ("soul", "Persona")):
                tool, params = self._source_tool("memory_read", {"file": file})
                content = (await tool.read_result(file))["content"]
                if not content.strip():
                    continue
                if file == "memory" and content.strip() == (pkg_files("mona") / "templates" / "memory" / "MEMORY.md").read_text(encoding="utf-8").strip():
                    continue
                position = content.casefold().find(query.casefold())
                if position >= 0:
                    start = max(0, position - 150)
                    items.append({"ref": file, "title": title, "preview": content[start:start + 500]})

        results = []
        for item in items[:limit]:
            native_ref = item.get("noteId") if source == "notes" else item.get("ref")
            if not isinstance(native_ref, str) or not native_ref:
                raise ValueError(f"{source} returned a result without a readable reference")
            kind = {
                "notes": "note", "conversations": "conversation", "memory": "summary", "events": "event_summary",
            }.get(source, "summary" if item.get("kind") == "material_wiki" else "document")
            if source == "memory" and native_ref == "soul":
                kind = "persona"
            row = {
                "source": source, "kind": kind,
                "ref": self._reference(source, native_ref),
                "title": item.get("title") or item.get("timestamp", "Archived event" if source == "events" else ""),
                "preview": item.get("preview", item.get("snippet", "")),
            }
            for key in ("role", "created_at", "completed", "stale", "locationLabel", "notebookName"):
                if key in item:
                    row[key] = item[key]
            results.append(row)
        return results, {**status, "count": len(results)}

    async def _search_queries(
        self, source: str, query: str, alternatives: list[str], limit: int,
        filters: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        matches: dict[str, dict[str, Any]] = {}
        partial = False
        status: dict[str, Any] = {}
        queried: list[str] = []
        terms = list(dict.fromkeys(_normalize_query(query).split()))
        modes: set[str] = set()
        variants = [] if filters.get("cursor") else _query_variants(query, alternatives)
        stages = [("all_terms", [query]), ("all_terms", variants)]
        if not filters.get("cursor") and 2 <= len(terms) <= _MAX_RELAXED_TERMS:
            stages.append(("any_term", [term for term in terms if term.casefold() not in {query.casefold(), *(item.casefold() for item in variants)}]))
        for stage_index, (mode, candidates) in enumerate(stages):
            if matches and (mode == "any_term" or (stage_index == 1 and not alternatives)):
                break
            for candidate in candidates:
                queried.append(candidate)
                try:
                    hits, info = await self._search_source(source, candidate, limit, filters)
                    if info["status"] not in {"ok", "partial"}:
                        raise RuntimeError(f"{source} query failed: {info.get('error', info['status'])}")
                except PermissionError:
                    raise
                except Exception as exc:
                    if not matches:
                        raise
                    return sorted(matches.values(), key=_result_order), {**status, "status": "partial", "count": len(matches), "queries": queried, "error": str(exc)}
                if not status:
                    status = dict(info)
                partial |= info["status"] == "partial"
                modes.add(mode)
                if info.get("next_cursor") and candidate != query:
                    status.setdefault("continuations", []).append({"query": candidate, "cursor": info["next_cursor"]})
                for rank, hit in enumerate(hits, 1):
                    row = matches.setdefault(hit["ref"], {
                        **hit, "matched_terms": [], "matched_queries": [],
                        "match_mode": mode, "rank_score": 0.0,
                    })
                    row["rank_score"] += 1.0 / (_RANK_OFFSET + rank)
                    row["matched_queries"].append(candidate)
                    if mode == "any_term":
                        row["matched_terms"].append(candidate)
        results = sorted(matches.values(), key=_result_order)
        return results, {**status, "status": "partial" if partial else "ok", "count": len(results), "queries": queried, "match_mode": "any_term" if "any_term" in modes else "all_terms"}

    async def execute(
        self, query: str, sources: list[str] | None = None, limit: int = 5,
        cursor: str | None = None, session_key: str | None = None,
        date_from: str | None = None, date_to: str | None = None,
        alternatives: list[str] | None = None,
        **_: Any,
    ) -> str:
        query = query.strip()
        alternatives = alternatives or []
        if len(alternatives) > 3:
            return "Error: provide at most three alternative queries."
        selected = list(dict.fromkeys(sources if sources is not None else _DEFAULT_SOURCES))
        if sources is None:
            authorized = []
            for source in selected:
                try:
                    self._authorize(source)
                except (PermissionError, LookupError):
                    continue
                authorized.append(source)
            selected = authorized
        if not query or not selected or any(source not in _SOURCES for source in selected):
            return "Error: provide a query and valid local memory sources."
        if cursor and selected != ["conversations"]:
            return "Error: search cursors require sources=['conversations']."
        filters = {key: value for key, value in {
            "cursor": cursor, "session_key": session_key, "date_from": date_from, "date_to": date_to,
        }.items() if value is not None}
        limit = max(1, min(int(limit), 20))
        results: list[dict[str, Any]] = []
        statuses: dict[str, Any] = {}
        responses = await asyncio.gather(*(
            self._search_queries(source, query, alternatives, limit, filters)
            for source in selected
        ), return_exceptions=True)
        for source, response in zip(selected, responses):
            if isinstance(response, BaseException):
                logger.warning("Local memory source {} failed: {}", source, response)
                statuses[source] = {
                    "status": "not_authorized" if isinstance(response, PermissionError) else "unavailable",
                    "error": str(response),
                }
            else:
                hits, statuses[source] = response
                results.extend(hits)
        results = sorted(results, key=_result_order)[:limit]
        for source, info in statuses.items():
            info["returned_count"] = sum(row["source"] == source for row in results)
            if info.get("count", 0) > info["returned_count"]:
                info["limited"] = True
                info["refine"] = "Repeat the query with this source filter to inspect omitted matches."
                info.pop("next_cursor", None)
                info.pop("continuations", None)
        modes = {row["match_mode"] for row in results}
        match_mode = next(iter(modes)) if len(modes) == 1 else "mixed" if modes else "any_term" if any(info.get("match_mode") == "any_term" for info in statuses.values()) else "all_terms"
        complete = all(item["status"] == "ok" for item in statuses.values())
        available = any(item["status"] in {"ok", "partial"} for item in statuses.values())
        return json.dumps({
            "status": "ok" if complete else "partial" if available else "unavailable", "query": query,
            "results": results, "sources": statuses, "match_mode": match_mode,
        }, ensure_ascii=False)


@tool_parameters(tool_parameters_schema(
    ref=StringSchema("Reference returned by search_memory.", min_length=1),
    max_chars=IntegerSchema(8000, description="Page or Knowledge chunk size; source limits may apply.", minimum=1000, maximum=50000),
    cursor=StringSchema("Read continuation returned for this reference."),
    before=IntegerSchema(2, description="Earlier conversation messages (0-5).", minimum=0, maximum=5),
    after=IntegerSchema(2, description="Later conversation messages (0-5).", minimum=0, maximum=5),
    required=["ref"],
))
class ReadMemoryTool(_MemoryTool):
    name = "read_memory"
    description = (
        "Read a search_memory reference with its original context and evidence. Rechecks source "
        "permissions; preserve returned citations and distinguish user statements from assistant "
        "suggestions or AI summaries. Follow returned references or next_cursor when present."
    )

    async def execute(
        self, ref: str, max_chars: int = 8000, cursor: str | None = None,
        before: int = 2, after: int = 2, **_: Any,
    ) -> str:
        search = self._registry.get("search_memory")
        if not isinstance(search, SearchMemoryTool):
            return "Error: search_memory is unavailable."
        try:
            source, native_ref = search.resolve_reference(ref)
            self._authorize(source)
            max_chars = max(1000, min(int(max_chars), 50000))
            if source == "conversations":
                if cursor:
                    if not cursor.startswith("conversation:"):
                        raise ValueError("Invalid conversation read cursor.")
                    page = json.loads(base64.urlsafe_b64decode(cursor[13:]))
                    if not isinstance(page, dict) or (page.get("ref"), page.get("before"), page.get("after")) != (ref, before, after):
                        raise ValueError("Read cursor belongs to another reference or conversation window.")
                    cursor = page["cursor"]
                tool, params = self._source_tool("conversation_read", {
                    "ref": native_ref, "max_chars": min(max_chars, 16000), "cursor": cursor,
                    "before": before, "after": after,
                })
                result = json.loads(await tool.execute(**params))
                if result.get("next_cursor"):
                    page = {"ref": ref, "before": before, "after": after, "cursor": result["next_cursor"]}
                    result["next_cursor"] = "conversation:" + base64.urlsafe_b64encode(json.dumps(page).encode("utf-8")).decode("ascii")
                result.update(source=source, ref=ref)
                return json.dumps(result, ensure_ascii=False)
            name, params = {
                "notes": ("notes_read", {"note_id": native_ref}),
                "knowledge": ("knowledge_read", {"ref": native_ref, "max_chars": max_chars}),
                "memory": ("memory_read", {"file": native_ref}),
                "events": ("memory_search", {"query": "check"}),
            }[source]
            tool, params = self._source_tool(name, params)
            metadata: dict[str, Any] = {}
            if source == "notes":
                note = await tool.read_result(native_ref)
                content = note["contentMarkdown"]
                metadata = {key: note[key] for key in ("title", "notebookName", "updatedAt", "contextLevel") if key in note}
                metadata["kind"] = "note_preview" if note.get("contextLevel") == "summary" else "note"
            elif source == "events":
                event = await tool.read_result(native_ref)
                raw_content = event.get("content", "")
                content = raw_content if isinstance(raw_content, str) else json.dumps(raw_content, ensure_ascii=False)
                metadata = {key: event[key] for key in ("timestamp", "role") if key in event}
                if "cursor" in event:
                    metadata["event_cursor"] = event["cursor"]
                metadata["kind"] = "event_summary"
            elif source == "memory":
                memory = await tool.read_result(native_ref)
                content = memory["content"]
                metadata = {"title": memory["filename"], "updatedAt": memory.get("updatedAt")}
                metadata["kind"] = "summary" if native_ref == "memory" else "persona"
            else:
                knowledge = await tool.read_result(**params)
                if not isinstance(knowledge, dict):
                    raise RuntimeError(knowledge)
                content = knowledge["content"]
                metadata.update({key: knowledge[key] for key in ("kind", "citation") if key in knowledge})
                metadata["references"] = [
                    {**item, "ref": search._reference("knowledge", item["ref"])}
                    for item in knowledge["references"]
                ]
            if not isinstance(content, str):
                raise RuntimeError(content)
            if source == "knowledge":
                if cursor:
                    raise ValueError("Knowledge uses located chunks; search_memory can find another location.")
                result = {"status": "ok", "content": content}
            else:
                offset = 0
                version = hashlib.sha256(content.encode("utf-8")).hexdigest()
                if cursor:
                    parts = cursor.split(":")
                    if len(parts) != 3 or parts[0] != "offset" or not parts[1].isdigit():
                        raise ValueError("Invalid read cursor.")
                    offset = int(parts[1])
                    if parts[2] != version or offset > len(content):
                        raise ValueError("Read cursor is stale; read the reference again without a cursor.")
                end = min(len(content), offset + max_chars)
                result = {
                    "status": "ok", "content": content[offset:end], "truncated": end < len(content),
                    "next_cursor": f"offset:{end}:{version}" if end < len(content) else None,
                }
            result.update(source=source, ref=ref, **metadata)
            return json.dumps(result, ensure_ascii=False)
        except (ValueError, PermissionError, RuntimeError, LookupError, OSError) as exc:
            return json.dumps({"status": "unavailable", "ref": ref, "error": str(exc)}, ensure_ascii=False)
