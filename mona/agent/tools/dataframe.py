"""Dataframe query tool: run SQL against local tabular files.

Loads CSV/TSV/JSON/Excel/Parquet files into an in-memory SQLite database and
runs SQL queries against them. Uses only stdlib (sqlite3, csv, json) plus
openpyxl for Excel — no new dependencies.

Each file is registered as a table named after its stem (sanitized). The agent
can then run any read-only SELECT query joining across multiple files.
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import ArraySchema, IntegerSchema, StringSchema, tool_parameters_schema
from mona.config.schema import Base

_MAX_ROWS_RETURN = 500
_MAX_CELL_CHARS = 500

_READ_ONLY_PREFIXES = ("SELECT", "WITH", "EXPLAIN", "PRAGMA")


class DataframeToolConfig(Base):
    """Dataframe query tool configuration."""

    enable: bool = True
    max_rows: int = Field(default=_MAX_ROWS_RETURN, ge=1, le=10000)
    restrict_to_workspace: bool = False


def _sanitize_table_name(stem: str) -> str:
    """Convert a filename stem into a valid SQLite table identifier."""
    name = re.sub(r"[^A-Za-z0-9_]", "_", stem)
    if not name:
        name = "data"
    if name[0].isdigit():
        name = "t_" + name
    return name.lower()


def _infer_sqlite_type(value: Any) -> str:
    """Infer a SQLite column affinity from a sample value."""
    if value is None or value == "":
        return "TEXT"
    if isinstance(value, bool):
        return "INTEGER"
    if isinstance(value, int):
        return "INTEGER"
    if isinstance(value, float):
        return "REAL"
    return "TEXT"


def _coerce_value(value: str, col_type: str) -> Any:
    """Coerce a string cell into the column's affinity type."""
    if value == "" or value is None:
        return None
    if col_type == "INTEGER":
        try:
            return int(value)
        except ValueError:
            # Maybe it's a float-looking int
            try:
                return float(value)
            except ValueError:
                return value
    if col_type == "REAL":
        try:
            return float(value)
        except ValueError:
            return value
    return value


def _load_csv(path: Path, conn: sqlite3.Connection, table: str, delimiter: str = ",") -> int:
    """Load a CSV/TSV file into a SQLite table. Returns row count."""
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        try:
            header = next(reader)
        except StopIteration:
            return 0
        header = [h.strip() or f"col_{i}" for i, h in enumerate(header)]

        # Sample first row to infer types
        sample_rows: list[list[str]] = []
        for _ in range(20):
            try:
                sample_rows.append(next(reader))
            except StopIteration:
                break

        col_types: list[str] = []
        for i, _col_name in enumerate(header):
            sample_values = [row[i] for row in sample_rows if i < len(row) and row[i] != ""]
            # Infer: start optimistic (INTEGER), downgrade as we see non-int values.
            # Empty sample → TEXT.
            if not sample_values:
                col_types.append("TEXT")
                continue
            inferred = "INTEGER"
            for v in sample_values:
                try:
                    int(v)
                    continue  # still INTEGER
                except ValueError:
                    try:
                        float(v)
                        if inferred == "INTEGER":
                            inferred = "REAL"
                    except ValueError:
                        inferred = "TEXT"
                        break
            col_types.append(inferred)

        # Create table
        cols_sql = ", ".join(
            f'"{name}" {ctype}' for name, ctype in zip(header, col_types)
        )
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        conn.execute(f'CREATE TABLE "{table}" ({cols_sql})')

        # Insert sample rows + remaining rows
        placeholders = ", ".join("?" for _ in header)
        insert_sql = f'INSERT INTO "{table}" VALUES ({placeholders})'
        row_count = 0
        for row in sample_rows:
            row = row + [""] * (len(header) - len(row))
            row = row[: len(header)]
            values = [_coerce_value(v, ct) for v, ct in zip(row, col_types)]
            conn.execute(insert_sql, values)
            row_count += 1
        for row in reader:
            row = row + [""] * (len(header) - len(row))
            row = row[: len(header)]
            values = [_coerce_value(v, ct) for v, ct in zip(row, col_types)]
            conn.execute(insert_sql, values)
            row_count += 1
        conn.commit()
        return row_count


def _load_tsv(path: Path, conn: sqlite3.Connection, table: str) -> int:
    return _load_csv(path, conn, table, delimiter="\t")


def _load_json(path: Path, conn: sqlite3.Connection, table: str) -> int:
    """Load a JSON file (array of objects, or single object) into a SQLite table."""
    data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        conn.execute(f'CREATE TABLE "{table}" (id INTEGER)')
        return 0

    # Collect all keys (union across objects)
    all_keys: list[str] = []
    seen: set[str] = set()
    for obj in data:
        if not isinstance(obj, dict):
            continue
        for k in obj.keys():
            if k not in seen:
                seen.add(k)
                all_keys.append(k)

    if not all_keys:
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        conn.execute(f'CREATE TABLE "{table}" (id INTEGER)')
        return 0

    # Infer types from first non-null value per column
    col_types: list[str] = []
    for k in all_keys:
        inferred = "TEXT"
        for obj in data:
            v = obj.get(k)
            if v is not None and v != "":
                inferred = _infer_sqlite_type(v)
                break
        col_types.append(inferred)

    cols_sql = ", ".join(f'"{k}" {t}' for k, t in zip(all_keys, col_types))
    conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    conn.execute(f'CREATE TABLE "{table}" ({cols_sql})')

    placeholders = ", ".join("?" for _ in all_keys)
    insert_sql = f'INSERT INTO "{table}" VALUES ({placeholders})'
    row_count = 0
    for obj in data:
        if not isinstance(obj, dict):
            continue
        values = [obj.get(k) for k in all_keys]
        conn.execute(insert_sql, values)
        row_count += 1
    conn.commit()
    return row_count


def _load_excel(path: Path, conn: sqlite3.Connection, table: str) -> int:
    """Load the first sheet of an Excel file into a SQLite table."""
    try:
        from openpyxl import load_workbook
    except ImportError:
        raise RuntimeError("openpyxl not installed")

    wb = load_workbook(str(path), read_only=True, data_only=True)
    sheet = wb.worksheets[0]
    rows_iter = sheet.iter_rows(values_only=True)
    try:
        header = next(rows_iter)
    except StopIteration:
        wb.close()
        return 0
    header = [str(h) if h is not None else f"col_{i}" for i, h in enumerate(header)]

    sample_rows: list[tuple] = []
    for _ in range(20):
        try:
            sample_rows.append(next(rows_iter))
        except StopIteration:
            break

    col_types: list[str] = []
    for i in range(len(header)):
        inferred = "TEXT"
        for row in sample_rows:
            if i < len(row) and row[i] is not None:
                inferred = _infer_sqlite_type(row[i])
                break
        col_types.append(inferred)

    cols_sql = ", ".join(f'"{h}" {t}' for h, t in zip(header, col_types))
    conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    conn.execute(f'CREATE TABLE "{table}" ({cols_sql})')
    placeholders = ", ".join("?" for _ in header)
    insert_sql = f'INSERT INTO "{table}" VALUES ({placeholders})'
    row_count = 0
    for row in sample_rows:
        row = row + (None,) * (len(header) - len(row))
        row = row[: len(header)]
        conn.execute(insert_sql, row)
        row_count += 1
    for row in rows_iter:
        row = row + (None,) * (len(header) - len(row))
        row = row[: len(header)]
        conn.execute(insert_sql, row)
        row_count += 1
    conn.commit()
    wb.close()
    return row_count


_LOADERS: dict[str, Any] = {
    ".csv": _load_csv,
    ".tsv": _load_tsv,
    ".json": _load_json,
    ".jsonl": _load_json,  # Will be handled below
    ".xlsx": _load_excel,
    ".xls": _load_excel,
}


def _load_jsonl(path: Path, conn: sqlite3.Connection, table: str) -> int:
    """Load a JSONL file (one JSON object per line) into a SQLite table."""
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    records.append(obj)
            except ValueError:
                continue
    if not records:
        conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        conn.execute(f'CREATE TABLE "{table}" (id INTEGER)')
        return 0

    all_keys: list[str] = []
    seen: set[str] = set()
    for obj in records:
        for k in obj.keys():
            if k not in seen:
                seen.add(k)
                all_keys.append(k)

    col_types: list[str] = []
    for k in all_keys:
        inferred = "TEXT"
        for obj in records:
            v = obj.get(k)
            if v is not None and v != "":
                inferred = _infer_sqlite_type(v)
                break
        col_types.append(inferred)

    cols_sql = ", ".join(f'"{k}" {t}' for k, t in zip(all_keys, col_types))
    conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    conn.execute(f'CREATE TABLE "{table}" ({cols_sql})')
    placeholders = ", ".join("?" for _ in all_keys)
    insert_sql = f'INSERT INTO "{table}" VALUES ({placeholders})'
    for obj in records:
        values = [obj.get(k) for k in all_keys]
        conn.execute(insert_sql, values)
    conn.commit()
    return len(records)


def _is_read_only(sql: str) -> bool:
    stripped = sql.lstrip().upper()
    return any(stripped.startswith(p) for p in _READ_ONLY_PREFIXES)


def _format_rows(rows: list[tuple], columns: list[str], max_rows: int) -> tuple[str, int, bool]:
    """Format query result rows as a markdown table. Returns (text, shown, truncated)."""
    if not rows:
        return "(no rows)", 0, False

    truncated = len(rows) > max_rows
    shown_rows = rows[:max_rows]

    # Truncate overly long cell values
    def _cell(v: Any) -> str:
        if v is None:
            return "NULL"
        s = str(v)
        if len(s) > _MAX_CELL_CHARS:
            s = s[:_MAX_CELL_CHARS] + "…"
        return s.replace("|", "\\|").replace("\n", " ")

    lines = ["| " + " | ".join(_cell(c) for c in columns) + " |"]
    lines.append("| " + " | ".join("---" for _ in columns) + " |")
    for row in shown_rows:
        lines.append("| " + " | ".join(_cell(v) for v in row) + " |")
    if truncated:
        lines.append(f"\n... ({len(rows)} rows total, showing first {max_rows})")
    return "\n".join(lines), len(shown_rows), truncated


@tool_parameters(
    tool_parameters_schema(
        sql=StringSchema(
            "Read-only SQL query (SELECT/WITH/EXPLAIN/PRAGMA only). "
            "Tables are named after file stems (e.g. sales.csv → table 'sales').",
            min_length=1,
        ),
        files=ArraySchema(
            StringSchema("Absolute or workspace-relative path to a CSV/TSV/JSON/JSONL/Excel file to load"),
            description="Files to load as tables before running the query. Each file becomes a table named after its stem.",
            min_items=1,
        ),
        max_rows=IntegerSchema(
            500,
            description="Maximum rows to return (default 500).",
            minimum=1,
            maximum=10000,
        ),
        required=["sql", "files"],
    )
)
class DataframeTool(Tool):
    """Run SQL queries against local tabular files (CSV/JSON/Excel)."""

    _scopes = {"core", "subagent"}
    agent_allowlist = frozenset({"com.mona.academic-researcher"})
    config_key = "dataframe"

    name = "dataframe_query"
    description = (
        "Load local tabular files (CSV/TSV/JSON/JSONL/XLSX) into an in-memory SQLite database "
        "and run a read-only SQL query against them. Each file becomes a table named after its "
        "stem (e.g. 'sales.csv' → table 'sales'). Supports JOINs across files. "
        "Only SELECT/WITH/EXPLAIN/PRAGMA statements are allowed."
    )

    @classmethod
    def config_cls(cls):
        return DataframeToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.dataframe.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.dataframe,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
        )

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        config: DataframeToolConfig | None = None,
        restrict_to_workspace: bool = False,
    ) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()
        self.config = config or DataframeToolConfig()
        self._restrict = restrict_to_workspace or self.config.restrict_to_workspace

    def _active_workspace(self) -> Path:
        """Return the active session workspace (contextvar) or configured fallback."""
        ws = get_current_workspace(self._workspace)
        return ws if ws is not None else self._workspace

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        sql: str,
        files: list[str],
        max_rows: int | None = None,
        **kwargs: Any,
    ) -> str:
        if not _is_read_only(sql):
            return "Error: only SELECT/WITH/EXPLAIN/PRAGMA statements are allowed"

        if not files:
            return "Error: at least one file path is required"

        limit = max_rows or self.config.max_rows

        # Resolve all input files against the active session workspace.
        active_ws = self._active_workspace()
        resolved_files: list[tuple[str, Path]] = []
        for raw_path in files:
            if self._restrict:
                try:
                    resolved = resolve_workspace_path(raw_path, active_ws, active_ws)
                except (OSError, PermissionError, ValueError) as e:
                    return f"Error: path not allowed: {e}"
            else:
                p = Path(raw_path).expanduser()
                resolved = p if p.is_absolute() else active_ws / p
            if not resolved.is_file():
                return f"Error: file not found: {raw_path}"
            table_name = _sanitize_table_name(resolved.stem)
            resolved_files.append((table_name, resolved))

        # Build in-memory SQLite DB and load files
        conn = sqlite3.connect(":memory:")
        try:
            loaded_tables: list[str] = []
            for table_name, path in resolved_files:
                ext = path.suffix.lower()
                try:
                    if ext == ".jsonl":
                        count = _load_jsonl(path, conn, table_name)
                    elif ext in _LOADERS:
                        count = _LOADERS[ext](path, conn, table_name)
                    else:
                        return f"Error: unsupported file type '{ext}' for {path.name}. Supported: CSV/TSV/JSON/JSONL/XLSX"
                    loaded_tables.append(f"{table_name} ({count} rows, from {path.name})")
                except Exception as e:
                    logger.exception("Failed to load {}", path)
                    return f"Error loading {path.name}: {type(e).__name__}: {e}"

            # Execute the query
            try:
                cursor = conn.execute(sql)
            except sqlite3.Error as e:
                return f"SQL error: {e}\n\nLoaded tables:\n" + "\n".join(loaded_tables)

            columns = [desc[0] for desc in cursor.description] if cursor.description else []
            rows = cursor.fetchall()

            if not columns:
                return "Query executed (no result set).\n\nLoaded tables:\n" + "\n".join(loaded_tables)

            table_text, shown, truncated = _format_rows(rows, columns, limit)
            header = f"<!-- Loaded tables: {'; '.join(loaded_tables)} -->\n\n"
            footer = f"\n\n({shown} rows shown" + (f" of {len(rows)}" if truncated else "") + ")"
            return header + table_text + footer
        finally:
            conn.close()
