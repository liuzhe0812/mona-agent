from __future__ import annotations

from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import RequestContext
from mona.agent.tools.schema import StringSchema, tool_parameters_schema
from mona.agent.tools.terminal import _tauri_invoke_async


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
    subscription_required = True
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
            "Prefer db_inspect for standard database diagnostics (table structure, indexes, EXPLAIN, health)."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, sql: str, database: str | None = None, **kwargs: Any) -> str:
        if not self._connection_id:
            return "Error: No database connection available. The user is not currently connected to a database."

        effective_db = database or self._database

        logger.debug("db_query: sql={!r} db={} conn={}", sql, effective_db, self._connection_id)

        result = await _tauri_invoke_async(
            "db_execute_ai_read",
            {
                "connectionId": self._connection_id,
                "sql": sql.strip(),
                **({"database": effective_db} if effective_db else {}),
            },
        )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        return _format_query_result(result)


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Inspection action: connection | table | indexes | explain | health",
        ),
        database=StringSchema("Target database name", nullable=True),
        table=StringSchema("Target table name (required for 'table' and 'indexes' actions)", nullable=True),
        sql=StringSchema("SQL to explain (required for 'explain' action)", nullable=True),
        required=["action"],
    )
)
class DbInspectTool(Tool):
    config_key = "db_inspect"
    _scopes = {"core"}
    subscription_required = True
    _connection_id: str | None = None
    _database: str | None = None

    def set_context(self, ctx: RequestContext) -> None:
        meta = ctx.metadata or {}
        self._connection_id = meta.get("connection_id")
        self._database = meta.get("database")

    @property
    def name(self) -> str:
        return "db_inspect"

    @property
    def description(self) -> str:
        return (
            "Inspect database structure, indexes, execution plans, and health. "
            "Actions: 'connection' (db type/version), 'table' (table structure), "
            "'indexes' (index info), 'explain' (execution plan for SQL), "
            "'health' (server health check). "
            "Prefer this tool over db_query for standard database diagnostics."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        action: str,
        database: str | None = None,
        table: str | None = None,
        sql: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not self._connection_id:
            return "Error: No database connection available."

        result = await _tauri_invoke_async(
            "db_ai_inspect",
            {
                "connectionId": self._connection_id,
                "action": action,
                **({"database": database or self._database} if database or self._database else {}),
                **({"table": table} if table else {}),
                **({"sql": sql} if sql else {}),
            },
        )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        return str(result) if result else "No result."


@tool_parameters(
    tool_parameters_schema(
        sql=StringSchema("The SQL statement"),
        statement_type=StringSchema("Statement type: SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, etc."),
        operation_class=StringSchema(
            "Operation class: read, transactional_dml, non_transactional_change, blocked"
        ),
        explanation=StringSchema("Brief explanation of what the SQL does"),
        target_objects=StringSchema("Comma-separated list of target table/database names", nullable=True),
        required=["sql", "statement_type", "operation_class", "explanation"],
    )
)
class DbSqlDraftTool(Tool):
    config_key = "db_sql_draft"
    _scopes = {"core"}
    subscription_required = True

    @property
    def name(self) -> str:
        return "db_sql_draft"

    @property
    def description(self) -> str:
        return (
            "Publish a structured SQL draft to the user's SQL editor. "
            "Use this when generating SQL for the user (NL2SQL, optimization suggestions, etc.). "
            "The draft appears as a card in the DB sidebar with copy/insert/replace actions. "
            "operation_class must be one of: read, transactional_dml, non_transactional_change, blocked."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        sql: str,
        statement_type: str,
        operation_class: str,
        explanation: str,
        target_objects: str | None = None,
        **kwargs: Any,
    ) -> str:
        target_list = (
            [s.strip() for s in target_objects.split(",") if s.strip()]
            if target_objects
            else []
        )

        result = await _tauri_invoke_async(
            "db_publish_sql_draft",
            {
                "sql": sql,
                "statementType": statement_type,
                "targetObjects": target_list,
                "operationClass": operation_class,
                "explanation": explanation,
            },
        )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        return f"SQL draft published: {statement_type} ({operation_class})"


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
