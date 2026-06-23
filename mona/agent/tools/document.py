"""Document parsing tool: extract text/markdown from common document formats.

Supported formats (all using core dependencies, no extra installs):
    .pdf   → pypdf
    .docx  → python-docx
    .xlsx  → openpyxl
    .pptx  → python-pptx
    .csv   → stdlib csv
    .json  → stdlib json
    .html/.htm → stdlib html.parser
    .txt/.md/.log/.py/.js/... → plain text

The tool returns markdown text suitable for LLM consumption. Output is capped
at ``max_chars`` to protect the context window.
"""

from __future__ import annotations

import csv
import html
import html.parser
import json
import re
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import resolve_workspace_path
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from mona.config.schema import Base

_MAX_CHARS_DEFAULT = 50_000
_MAX_ROWS_SPREADSHEET = 200
_MAX_SLIDES = 200

_TEXT_EXTS = {".txt", ".md", ".markdown", ".log", ".rst", ".ini", ".cfg", ".conf", ".yaml", ".yml", ".toml"}
_CODE_EXTS = {".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".hpp", ".go", ".rs",
              ".rb", ".php", ".sh", ".bash", ".sql", ".css", ".scss", ".vue", ".svelte"}


class DocumentToolConfig(Base):
    """Document parsing tool configuration."""

    enable: bool = True
    max_chars: int = Field(default=_MAX_CHARS_DEFAULT, ge=1000)
    # Restrict file access to workspace when True (set from ToolsConfig.restrict_to_workspace)
    restrict_to_workspace: bool = False


def _truncate(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True


def _wrap_language(text: str, lang: str) -> str:
    return f"```{lang}\n{text}\n```\n"


def _parse_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        return "Error: pypdf not installed"

    reader = PdfReader(str(path))
    parts: list[str] = [f"# {path.stem}\n"]
    for i, page in enumerate(reader.pages, 1):
        try:
            text = page.extract_text() or ""
        except Exception as e:
            logger.debug("PDF page {} extract failed: {}", i, e)
            text = ""
        text = text.strip()
        if text:
            parts.append(f"<!-- Page {i} -->\n\n{text}\n")
    return "\n".join(parts)


def _parse_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError:
        return "Error: python-docx not installed"

    doc = Document(str(path))
    parts: list[str] = [f"# {path.stem}\n"]
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style else ""
        if "heading 1" in style or style == "title":
            parts.append(f"\n# {text}\n")
        elif "heading 2" in style:
            parts.append(f"\n## {text}\n")
        elif "heading 3" in style:
            parts.append(f"\n### {text}\n")
        elif "list" in style:
            parts.append(f"- {text}")
        else:
            parts.append(text)

    # Tables
    for ti, table in enumerate(doc.tables, 1):
        parts.append(f"\n**Table {ti}**\n")
        rows = list(table.rows)
        if not rows:
            continue
        header = [cell.text.strip() for cell in rows[0].cells]
        parts.append("| " + " | ".join(header) + " |")
        parts.append("| " + " | ".join("---" for _ in header) + " |")
        for row in rows[1:]:
            cells = [cell.text.strip() for cell in row.cells]
            parts.append("| " + " | ".join(cells) + " |")
    return "\n".join(parts)


def _parse_xlsx(path: Path) -> str:
    try:
        from openpyxl import load_workbook
    except ImportError:
        return "Error: openpyxl not installed"

    wb = load_workbook(str(path), read_only=True, data_only=True)
    parts: list[str] = [f"# {path.stem}\n"]
    for sheet in wb.worksheets:
        parts.append(f"\n## Sheet: {sheet.title}\n")
        rows_iter = sheet.iter_rows(values_only=True)
        row_count = 0
        first_row = True
        for row in rows_iter:
            if row_count >= _MAX_ROWS_SPREADSHEET:
                parts.append(f"\n... (truncated at {_MAX_ROWS_SPREADSHEET} rows)\n")
                break
            cells = ["" if v is None else str(v) for v in row]
            if not any(c.strip() for c in cells):
                continue
            if first_row:
                parts.append("| " + " | ".join(cells) + " |")
                parts.append("| " + " | ".join("---" for _ in cells) + " |")
                first_row = False
            else:
                parts.append("| " + " | ".join(cells) + " |")
            row_count += 1
    wb.close()
    return "\n".join(parts)


def _parse_pptx(path: Path) -> str:
    try:
        from pptx import Presentation
    except ImportError:
        return "Error: python-pptx not installed"

    prs = Presentation(str(path))
    parts: list[str] = [f"# {path.stem}\n"]
    for i, slide in enumerate(prs.slides, 1):
        if i > _MAX_SLIDES:
            parts.append(f"\n... (truncated at {_MAX_SLIDES} slides)\n")
            break
        parts.append(f"\n## Slide {i}\n")
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for para in shape.text_frame.paragraphs:
                text = "".join(run.text for run in para.runs).strip()
                if text:
                    parts.append(text)
        # Notes
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append(f"\n*Notes:* {notes}")
    return "\n".join(parts)


def _parse_csv(path: Path) -> str:
    parts: list[str] = [f"# {path.stem}\n"]
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        row_count = 0
        first_row = True
        for row in reader:
            if row_count >= _MAX_ROWS_SPREADSHEET:
                parts.append(f"\n... (truncated at {_MAX_ROWS_SPREADSHEET} rows)\n")
                break
            if not any(c.strip() for c in row):
                continue
            if first_row:
                parts.append("| " + " | ".join(row) + " |")
                parts.append("| " + " | ".join("---" for _ in row) + " |")
                first_row = False
            else:
                parts.append("| " + " | ".join(row) + " |")
            row_count += 1
    return "\n".join(parts)


def _parse_json(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    return _wrap_language(json.dumps(data, indent=2, ensure_ascii=False), "json")


class _HTMLTextExtractor(html.parser.HTMLParser):
    """Minimal HTML → markdown-ish text extractor (stdlib only)."""

    _BLOCK_TAGS = {"p", "div", "section", "article", "header", "footer", "main",
                   "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br", "hr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._out: list[str] = []
        self._skip_depth = 0  # skip script/style
        self._list_depth = 0
        self._in_li = False
        self._in_pre = False
        self._in_table = False
        self._row_cells: list[str] = []
        self._is_header_row = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in ("script", "style", "noscript"):
            self._skip_depth += 1
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag[1])
            self._out.append("\n" + "#" * level + " ")
        elif tag == "p":
            self._out.append("\n\n")
        elif tag in ("div", "section", "article", "header", "footer", "main"):
            self._out.append("\n")
        elif tag == "br":
            self._out.append("\n")
        elif tag == "hr":
            self._out.append("\n---\n")
        elif tag in ("strong", "b"):
            self._out.append("**")
        elif tag in ("em", "i"):
            self._out.append("*")
        elif tag == "code":
            self._out.append("`")
        elif tag == "pre":
            self._in_pre = True
            self._out.append("\n```\n")
        elif tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self._out.append("[")
                    self._out.append(f"]({v}")
                    break
        elif tag in ("ul", "ol"):
            self._list_depth += 1
            self._out.append("\n")
        elif tag == "li":
            self._in_li = True
            self._out.append("  " * (self._list_depth - 1) + "- ")
        elif tag == "table":
            self._in_table = True
            self._out.append("\n")
        elif tag == "tr":
            self._row_cells = []
            self._is_header_row = False
        elif tag == "th":
            self._is_header_row = True
            self._row_cells.append("")
        elif tag == "td":
            self._row_cells.append("")
        elif tag == "img":
            alt = ""
            src = ""
            for k, v in attrs:
                if k == "alt" and v:
                    alt = v
                elif k == "src" and v:
                    src = v
            if src:
                self._out.append(f"![{alt}]({src})")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ("script", "style", "noscript"):
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return
        if self._skip_depth > 0:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._out.append("\n")
        elif tag == "p":
            self._out.append("\n")
        elif tag in ("strong", "b"):
            self._out.append("**")
        elif tag in ("em", "i"):
            self._out.append("*")
        elif tag == "code":
            self._out.append("`")
        elif tag == "pre":
            self._in_pre = False
            self._out.append("\n```\n")
        elif tag == "a":
            # Close the link markdown if we opened one
            if self._out and self._out[-1].endswith("]("):
                self._out[-1] = self._out[-1][:-2]  # nothing matched, drop
            else:
                self._out.append(")")
        elif tag in ("ul", "ol"):
            if self._list_depth > 0:
                self._list_depth -= 1
            self._out.append("\n")
        elif tag == "li":
            self._in_li = False
            self._out.append("\n")
        elif tag == "table":
            self._in_table = False
            self._out.append("\n")
        elif tag == "tr":
            if self._row_cells:
                line = "| " + " | ".join(self._row_cells) + " |"
                self._out.append(line + "\n")
                if self._is_header_row:
                    self._out.append("| " + " | ".join("---" for _ in self._row_cells) + " |\n")
        elif tag in ("td", "th"):
            pass

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_pre:
            self._out.append(data)
            return
        # Collapse whitespace outside pre
        text = re.sub(r"\s+", " ", data)
        if not text:
            return
        if self._row_cells:
            # Append to the last cell
            self._row_cells[-1] += text
            return
        self._out.append(text)

    def get_text(self) -> str:
        text = "".join(self._out)
        # Fix link markdown: [text](url) — re-join split pieces
        text = re.sub(r"\]\(([^)]+)\(", r"](\1", text)
        # Collapse excessive blank lines
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def _parse_html(path: Path) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    parser = _HTMLTextExtractor()
    parser.feed(raw)
    parser.close()
    text = parser.get_text()
    title_match = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
    title = title_match.group(1).strip() if title_match else path.stem
    title = re.sub(r"\s+", " ", html.unescape(title))
    return f"# {title}\n\n{text}"


def _parse_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    ext = path.suffix.lower()
    if ext in _CODE_EXTS:
        lang = ext.lstrip(".")
        return _wrap_language(text, lang)
    return text


_PARSERS: dict[str, Any] = {
    ".pdf": _parse_pdf,
    ".docx": _parse_docx,
    ".xlsx": _parse_xlsx,
    ".pptx": _parse_pptx,
    ".csv": _parse_csv,
    ".json": _parse_json,
    ".html": _parse_html,
    ".htm": _parse_html,
}


@tool_parameters(
    tool_parameters_schema(
        path=StringSchema("Absolute or workspace-relative file path to parse"),
        max_chars=IntegerSchema(
            _MAX_CHARS_DEFAULT,
            description="Maximum characters to return (default 50000)",
            minimum=1000,
        ),
        required=["path"],
    )
)
class DocumentTool(Tool):
    """Parse a document file and return its content as markdown."""

    _scopes = {"core", "subagent"}
    config_key = "document"

    name = "document"
    description = (
        "Parse a local document file (PDF/DOCX/XLSX/PPTX/CSV/JSON/HTML/TXT/code) "
        "and return its content as markdown. Output is capped at max_chars. "
        "Use this when the user asks to read, summarize, or extract content from a file."
    )

    @classmethod
    def config_cls(cls):
        return DocumentToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.document.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.document,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
        )

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        config: DocumentToolConfig | None = None,
        restrict_to_workspace: bool = False,
    ) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()
        self.config = config or DocumentToolConfig()
        self._restrict = restrict_to_workspace or self.config.restrict_to_workspace

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, path: str, max_chars: int | None = None, **kwargs: Any) -> str:
        limit = max_chars or self.config.max_chars

        # Resolve path with workspace boundary enforcement
        if self._restrict:
            try:
                resolved = resolve_workspace_path(path, self._workspace, self._workspace)
            except (OSError, PermissionError, ValueError) as e:
                return f"Error: path not allowed: {e}"
        else:
            p = Path(path).expanduser()
            resolved = p if p.is_absolute() else self._workspace / p

        if not resolved.is_file():
            return f"Error: file not found: {path}"

        ext = resolved.suffix.lower()
        parser = _PARSERS.get(ext)
        if parser is None:
            if ext in _TEXT_EXTS or ext in _CODE_EXTS or not ext:
                parser = _parse_text
            else:
                supported = ", ".join(sorted(_PARSERS.keys() | _TEXT_EXTS | _CODE_EXTS))
                return f"Error: unsupported file type '{ext}'. Supported: {supported}"

        try:
            content = parser(resolved)
        except Exception as e:
            logger.exception("Document parse failed for {}", resolved)
            return f"Error parsing {resolved.name}: {type(e).__name__}: {e}"

        content, truncated = _truncate(content, limit)
        header = f"<!-- Parsed from: {resolved.name} ({ext}) -->\n\n"
        footer = "\n\n[... truncated]" if truncated else ""
        return header + content + footer
