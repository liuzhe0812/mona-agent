from __future__ import annotations

import re
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import RequestContext
from mona.agent.tools.schema import StringSchema, tool_parameters_schema
from mona.agent.tools.terminal import _tauri_invoke

_READ_ONLY_PREFIXES = ("SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH")
_MAX_ROWS = 100


@tool_parameters(
    tool_parameters_schema(
        sql=StringSchema(
            "SQL query to execute (only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH allowed)",
        ),
        database=StringSchema(
            "Target database name (optional, defaults to current database)",
            nullable=True,
        ),
        required=["sql"],
    )
)
class DbQueryTool(Tool):
    config_key = "db_query"
    _scopes = {"core"}
    _request_ctx: RequestContext | None = None
    _connection_id: str | None = None
    _database: str | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx
        meta = ctx.metadata or {}
        self._connection_id = meta.get("connection_id")
        self._database = meta.get("database")

    @property
    def name(self) -> str:
        return "db_query"

    @property
    def description(self) -> str:
        return (
            "Execute a read-only SQL query on the user's currently connected database. "
            "Only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH (CTE) statements are allowed. "
            "Results are limited to 100 rows. "
            "Common patterns:\n"
            "- Table structure: SHOW CREATE TABLE `db`.`table` / DESCRIBE `table`\n"
            "- Index info: SHOW INDEX FROM `table`\n"
            "- Server status: SHOW STATUS / SHOW VARIABLES / SHOW PROCESSLIST\n"
            "- Query plan: EXPLAIN SELECT ...\n"
            "- Table stats: SHOW TABLE STATUS\n"
            "- Schema discovery: SHOW DATABASES / SHOW TABLES / SHOW TABLES FROM `db`"
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, sql: str, database: str | None = None, **kwargs: Any) -> str:
        if not self._connection_id:
            return "Error: No database connection available. The user is not currently connected to a database."

        trimmed = sql.strip()
        first_word = trimmed.split()[0].upper() if trimmed.split() else ""
        if first_word not in _READ_ONLY_PREFIXES:
            return (
                f"Error: Only read-only queries are allowed "
                f"(SELECT/SHOW/DESCRIBE/EXPLAIN/WITH). "
                f"Got: {first_word}"
            )

        if not re.search(r"\bLIMIT\s+\d+", trimmed, re.IGNORECASE):
            if trimmed.rstrip().endswith(";"):
                trimmed = trimmed.rstrip()[:-1].rstrip() + f" LIMIT {_MAX_ROWS};"
            else:
                trimmed = trimmed.rstrip() + f" LIMIT {_MAX_ROWS}"

        effective_db = database or self._database

        logger.debug("db_query: sql={!r} db={} conn={}", trimmed, effective_db, self._connection_id)

        result = _tauri_invoke(
            "db_execute_query",
            {
                "connectionId": self._connection_id,
                "sql": trimmed,
                "limit": _MAX_ROWS,
                **({"database": effective_db} if effective_db else {}),
            },
        )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        return _format_query_result(result)


def _format_query_result(result: Any) -> str:
    if not isinstance(result, dict):
        return str(result)

    columns = result.get("columns", [])
    rows = result.get("rows", [])
    total = result.get("total", len(rows))
    truncated = result.get("truncated", False)

    if not columns or not rows:
        meta_parts = []
        if "affectedRows" in result:
            meta_parts.append(f"Affected rows: {result['affectedRows']}")
        if "message" in result:
            meta_parts.append(str(result["message"]))
        if meta_parts:
            return "\n".join(meta_parts)
        return "Query returned no results."

    col_widths = []
    for i, col in enumerate(columns):
        col_name = col if isinstance(col, str) else col.get("name", str(col))
        max_w = len(col_name)
        for row in rows[:20]:
            if i < len(row):
                max_w = max(max_w, len(str(row[i])))
        col_widths.append(min(max_w, 40))

    header_parts = []
    for i, col in enumerate(columns):
        col_name = col if isinstance(col, str) else col.get("name", str(col))
        header_parts.append(col_name.ljust(col_widths[i]))
    header = " | ".join(header_parts)
    separator = "-+-".join("-" * w for w in col_widths)

    lines = [header, separator]
    for row in rows[:50]:
        row_parts = []
        for i, val in enumerate(row):
            s = str(val) if val is not None else "NULL"
            if len(s) > col_widths[i]:
                s = s[: col_widths[i] - 2] + ".."
            row_parts.append(s.ljust(col_widths[i]))
        lines.append(" | ".join(row_parts))

    if len(rows) > 50:
        lines.append(f"... and {len(rows) - 50} more rows")

    footer = f"\n({total} row{'s' if total != 1 else ''}"
    if truncated:
        footer += ", result truncated"
    footer += ")"

    return "\n".join(lines) + footer
