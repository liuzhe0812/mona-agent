"""Built-in PDF operations using the Gateway's bundled Python libraries."""

from __future__ import annotations

import asyncio
import io
import json
from contextlib import ExitStack
from pathlib import Path
from threading import Lock
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    NumberSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)

_ACTIONS = [
    "read", "tables", "render", "merge", "extract", "rotate",
    "forms", "fill", "create", "annotate",
]
_MAX_PAGES = 20
_MAX_CREATE_PAGES = 100
_MAX_CHARS = 100_000
_PDF_LOCK = Lock()
_ANNOTATION_SCHEMA = ObjectSchema(
    {
        "page": IntegerSchema(description="1-based page number", minimum=1),
        "rect": ArraySchema(
            NumberSchema(description="PDF point coordinate", minimum=0),
            description="Text box [x0, y0, x1, y1] in PDF points, from the top-left",
            min_items=4,
            max_items=4,
        ),
        "text": StringSchema("Text to place in the box", min_length=1),
    },
    required=["page", "rect", "text"],
    additional_properties=False,
)


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema("PDF operation", enum=_ACTIONS),
        path=StringSchema("Workspace PDF path; used by all actions except merge and create", nullable=True),
        paths=ArraySchema(
            StringSchema("Workspace PDF path"),
            description="Input PDFs for merge, in order",
            min_items=2,
            max_items=20,
            nullable=True,
        ),
        output=StringSchema(
            "New workspace output path. For rendering multiple pages, use a new directory path.",
            nullable=True,
        ),
        pages=ArraySchema(
            IntegerSchema(description="1-based page number", minimum=1),
            description="Page numbers (1-based), up to 20 per call. Omit to use the first 20 pages.",
            min_items=1,
            max_items=_MAX_PAGES,
            nullable=True,
        ),
        degrees=IntegerSchema(
            description="Clockwise rotation angle", enum=[90, 180, 270], nullable=True
        ),
        values=ObjectSchema(
            description="Interactive form field names mapped to replacement string values",
            additional_properties={"type": "string"},
            nullable=True,
        ),
        texts=ArraySchema(
            StringSchema("Text for one generated page"),
            description="One item per page for create, up to 100 pages",
            min_items=1,
            max_items=_MAX_CREATE_PAGES,
            nullable=True,
        ),
        annotations=ArraySchema(
            _ANNOTATION_SCHEMA,
            description="Positioned text overlays for annotate, up to 100 items",
            min_items=1,
            max_items=100,
            nullable=True,
        ),
        max_chars=IntegerSchema(
            description="Output character limit for read/tables (default 30000, maximum 100000)",
            minimum=1000,
            maximum=_MAX_CHARS,
            nullable=True,
        ),
        offset=IntegerSchema(
            description="Character offset for continuing read of one page; use returned next_offset",
            minimum=0,
            nullable=True,
        ),
        required=["action"],
    )
)
class PdfTool(Tool):
    """Read and modify workspace PDFs with Mona's bundled PDF libraries."""

    _scopes = {"core", "subagent"}
    config_key = "pdf"
    name = "pdf"
    description = (
        "Read PDF text and tables, render pages, merge or extract pages, rotate pages, "
        "inspect/fill interactive forms, create PDFs, and place positioned text. "
        "All paths must be inside the current workspace. Every output must be new."
    )

    @classmethod
    def create(cls, ctx: Any) -> PdfTool:
        return cls(workspace=ctx.workspace)

    def __init__(self, *, workspace: str | Path | None = None) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()

    def _active_workspace(self) -> Path:
        ws = get_current_workspace(self._workspace)
        return Path(ws or self._workspace).expanduser().resolve()

    @property
    def read_only(self) -> bool:
        return False

    def _resolve_path(self, value: str, *, pdf: bool = True) -> Path:
        workspace = self._active_workspace()
        try:
            path = resolve_workspace_path(value, workspace, workspace)
        except (OSError, PermissionError, ValueError) as exc:
            raise ValueError(f"path is outside the current workspace and media directory: {exc}") from exc
        if pdf and path.suffix.lower() != ".pdf":
            raise ValueError(f"expected a .pdf file: {value}")
        if not path.is_file() and pdf:
            raise ValueError(f"PDF file not found: {value}")
        return path

    def _output_path(self, value: str, *, extension: str | None = ".pdf") -> Path:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("output is required")
        workspace = self._active_workspace()
        try:
            path = resolve_workspace_path(value, workspace, workspace)
            path.relative_to(workspace)
        except (OSError, PermissionError, ValueError) as exc:
            raise ValueError(f"output must resolve inside the current workspace: {exc}") from exc
        if extension and path.suffix.lower() != extension:
            raise ValueError(f"output must use the {extension} extension")
        if path.exists() or path.is_symlink():
            raise FileExistsError(f"output already exists: {path}")
        if not path.parent.is_dir():
            raise ValueError(f"output directory does not exist: {path.parent}")
        return path

    @staticmethod
    def _save_new_file(path: Path, data: bytes) -> None:
        created = False
        try:
            with path.open("xb") as stream:
                created = True
                stream.write(data)
        except Exception:
            if created:
                path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _json(payload: dict[str, Any]) -> str:
        return json.dumps(payload, ensure_ascii=False, indent=2)

    @staticmethod
    def _select_pages(page_count: int, pages: list[int] | None) -> tuple[list[int], list[int]]:
        if pages is None:
            selected = list(range(1, min(page_count, _MAX_PAGES) + 1))
            return selected, list(range(len(selected) + 1, page_count + 1))
        if not pages:
            raise ValueError("pages must contain at least one page")
        if len(pages) > _MAX_PAGES:
            raise ValueError(f"pages may contain at most {_MAX_PAGES} pages per call")
        if len(set(pages)) != len(pages):
            raise ValueError("pages must not contain duplicates")
        invalid = [page for page in pages if page < 1 or page > page_count]
        if invalid:
            raise ValueError(f"page number out of range: {invalid}; PDF has {page_count} pages")
        return pages, []

    @staticmethod
    def _require(value: Any, name: str) -> Any:
        if value is None or value == "":
            raise ValueError(f"'{name}' is required for this action")
        return value

    async def execute(
        self,
        action: str,
        path: str | None = None,
        paths: list[str] | None = None,
        output: str | None = None,
        pages: list[int] | None = None,
        degrees: int | None = None,
        values: dict[str, str] | None = None,
        texts: list[str] | None = None,
        annotations: list[dict[str, Any]] | None = None,
        max_chars: int | None = None,
        offset: int = 0,
        **kwargs: Any,
    ) -> str:
        return await asyncio.to_thread(
            self._run_locked,
            action,
            path,
            paths,
            output,
            pages,
            degrees,
            values,
            texts,
            annotations,
            max_chars,
            offset or 0,
        )

    def _run_locked(self, *args: Any) -> str:
        # MuPDF operations must not run concurrently on worker threads.
        with _PDF_LOCK:
            return self._execute(*args)

    def _execute(
        self,
        action: str,
        path: str | None,
        paths: list[str] | None,
        output: str | None,
        pages: list[int] | None,
        degrees: int | None,
        values: dict[str, str] | None,
        texts: list[str] | None,
        annotations: list[dict[str, Any]] | None,
        max_chars: int | None,
        offset: int,
    ) -> str:
        try:
            if action not in _ACTIONS:
                raise ValueError(f"unsupported action: {action}")
            if action == "merge":
                return self._merge(paths, output)
            if action == "create":
                return self._create(texts, output)
            source = self._resolve_path(self._require(path, "path"))
            if action == "read":
                return self._read(source, pages, max_chars or 30_000, offset)
            if action == "tables":
                return self._tables(source, pages, max_chars or 30_000)
            if action == "render":
                return self._render(source, pages, output)
            if action == "extract":
                if pages is None:
                    raise ValueError("pages is required for extract")
                return self._extract(source, pages, output)
            if action == "rotate":
                return self._rotate(source, pages, degrees, output)
            if action == "forms":
                return self._forms(source)
            if action == "fill":
                return self._fill(source, values, output)
            if action == "annotate":
                return self._annotate(source, annotations, output)
            raise ValueError(f"unsupported action: {action}")
        except Exception as exc:
            return f"Error: {type(exc).__name__}: {exc}"

    def _read(self, source: Path, pages: list[int] | None, limit: int, offset: int) -> str:
        import pymupdf

        with pymupdf.open(source) as doc:
            selected, remaining = self._select_pages(doc.page_count, pages)
            if offset and (pages is None or len(selected) != 1):
                raise ValueError("offset is only valid when pages selects exactly one page")
            result: list[dict[str, Any]] = []
            used = 0
            next_offset: int | None = None
            for index, page_number in enumerate(selected):
                text = doc[page_number - 1].get_text("text")
                start = offset if index == 0 else 0
                if start > len(text):
                    raise ValueError(f"offset {start} exceeds page {page_number} text length {len(text)}")
                available = limit - used
                if len(text) - start > available:
                    if available <= 0:
                        remaining.extend(selected[index:])
                        break
                    page = doc[page_number - 1]
                    result.append({
                        "page": page_number,
                        "text": text[start : start + available],
                        "width": round(page.rect.width, 2),
                        "height": round(page.rect.height, 2),
                        "rotation": page.rotation,
                    })
                    next_offset = start + available
                    remaining.extend(selected[index + 1 :])
                    break
                result.append({"page": page_number, "text": text[start:]})
                used += len(text) - start
                page = doc[page_number - 1]
                result[-1].update({
                    "width": round(page.rect.width, 2),
                    "height": round(page.rect.height, 2),
                    "rotation": page.rotation,
                })
            return self._json({
                "ok": True,
                "action": "read",
                "page_count": doc.page_count,
                "pages": result,
                "truncated": bool(remaining or next_offset is not None),
                "remaining_pages": remaining,
                "next_offset": next_offset,
            })

    def _tables(self, source: Path, pages: list[int] | None, limit: int) -> str:
        import pdfplumber

        with pdfplumber.open(source) as pdf:
            selected, remaining = self._select_pages(len(pdf.pages), pages)
            result: list[dict[str, Any]] = []
            used = 0
            for index, page_number in enumerate(selected):
                tables = pdf.pages[page_number - 1].extract_tables()
                item = {"page": page_number, "tables": tables}
                size = len(json.dumps(item, ensure_ascii=False))
                if used + size > limit:
                    if not result:
                        raise ValueError(
                            f"table data on page {page_number} exceeds max_chars={limit}; "
                            "select fewer pages or raise max_chars"
                        )
                    remaining.extend(selected[index:])
                    break
                result.append(item)
                used += size
            return self._json({
                "ok": True,
                "action": "tables",
                "page_count": len(pdf.pages),
                "pages": result,
                "truncated": bool(remaining),
                "remaining_pages": remaining,
            })

    def _render(self, source: Path, pages: list[int] | None, output: str | None) -> str:
        import pymupdf

        with pymupdf.open(source) as doc:
            selected, remaining = self._select_pages(doc.page_count, pages)
            page_info = [
                {
                    "page": page_number,
                    "width": round(doc[page_number - 1].rect.width, 2),
                    "height": round(doc[page_number - 1].rect.height, 2),
                    "rotation": doc[page_number - 1].rotation,
                }
                for page_number in selected
            ]
            if len(selected) == 1:
                destination = self._output_path(self._require(output, "output"), extension=".png")
                if destination == source:
                    raise ValueError("output must not be an input file")
                page = doc[selected[0] - 1]
                scale = min(2, 2000 / max(page.rect.width, page.rect.height))
                data = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png")
                self._save_new_file(destination, data)
                files = [str(destination)]
            else:
                directory = self._output_path(self._require(output, "output"), extension=None)
                if directory == source:
                    raise ValueError("output must not be an input file")
                directory.mkdir()
                files = []
                try:
                    for page_number in selected:
                        page = doc[page_number - 1]
                        scale = min(2, 2000 / max(page.rect.width, page.rect.height))
                        data = page.get_pixmap(
                            matrix=pymupdf.Matrix(scale, scale), alpha=False
                        ).tobytes("png")
                        image_path = directory / f"page-{page_number:04}.png"
                        self._save_new_file(image_path, data)
                        files.append(str(image_path))
                except Exception:
                    for image_path in directory.iterdir():
                        image_path.unlink(missing_ok=True)
                    directory.rmdir()
                    raise
            return self._json({
                "ok": True,
                "action": "render",
                "files": files,
                "pages": page_info,
                "truncated": bool(remaining),
                "remaining_pages": remaining,
            })

    def _merge(self, paths: list[str] | None, output: str | None) -> str:
        from pypdf import PdfReader, PdfWriter

        paths = self._require(paths, "paths")
        if len(paths) < 2 or len(paths) > _MAX_PAGES:
            raise ValueError(f"merge requires 2 to {_MAX_PAGES} input PDFs")
        sources = [self._resolve_path(value) for value in paths]
        destination = self._output_path(self._require(output, "output"))
        if destination in sources:
            raise ValueError("output must not be an input file")
        writer = PdfWriter()
        with ExitStack() as stack:
            for source in sources:
                reader = PdfReader(stack.enter_context(source.open("rb")))
                for page in reader.pages:
                    writer.add_page(page)
            stream = io.BytesIO()
            writer.write(stream)
        self._save_new_file(destination, stream.getvalue())
        return self._json({"ok": True, "action": "merge", "output": str(destination)})

    def _extract(self, source: Path, pages: list[int] | None, output: str | None) -> str:
        from pypdf import PdfReader, PdfWriter

        destination = self._output_path(self._require(output, "output"))
        if destination == source:
            raise ValueError("output must not be an input file")
        with source.open("rb") as file:
            reader = PdfReader(file)
            selected, _ = self._select_pages(len(reader.pages), pages)
            writer = PdfWriter()
            for page_number in selected:
                writer.add_page(reader.pages[page_number - 1])
            stream = io.BytesIO()
            writer.write(stream)
        self._save_new_file(destination, stream.getvalue())
        return self._json({
            "ok": True, "action": "extract", "pages": selected, "output": str(destination)
        })

    def _rotate(
        self, source: Path, pages: list[int] | None, degrees: int | None, output: str | None
    ) -> str:
        from pypdf import PdfReader, PdfWriter

        if degrees not in (90, 180, 270):
            raise ValueError("degrees must be 90, 180, or 270 clockwise")
        destination = self._output_path(self._require(output, "output"))
        if destination == source:
            raise ValueError("output must not be an input file")
        with source.open("rb") as file:
            reader = PdfReader(file)
            selected, remaining = self._select_pages(len(reader.pages), pages)
            writer = PdfWriter()
            writer.clone_document_from_reader(reader)
            for page_number in selected:
                writer.pages[page_number - 1].rotate(degrees)
            stream = io.BytesIO()
            writer.write(stream)
        self._save_new_file(destination, stream.getvalue())
        return self._json({
            "ok": True,
            "action": "rotate",
            "pages": selected,
            "remaining_pages": remaining,
            "output": str(destination),
        })

    def _forms(self, source: Path) -> str:
        import pymupdf
        from pypdf import PdfReader

        with source.open("rb") as file:
            fields = PdfReader(file).get_fields() or {}
        widgets: list[dict[str, Any]] = []
        with pymupdf.open(source) as doc:
            for page_index, page in enumerate(doc):
                for widget in page.widgets() or []:
                    rect = widget.rect
                    try:
                        states = widget.button_states()
                    except (AttributeError, RuntimeError):
                        states = {}
                    widgets.append({
                        "name": widget.field_name,
                        "page": page_index + 1,
                        "rect": [round(value, 2) for value in (rect.x0, rect.y0, rect.x1, rect.y1)],
                        "page_width": round(page.rect.width, 2),
                        "page_height": round(page.rect.height, 2),
                        "button_states": states,
                    })
        return self._json({
            "ok": True,
            "action": "forms",
            "fields": [
                {
                    "name": name,
                    "type": str(field.get("/FT", "")),
                    "value": str(field.get("/V", "")),
                    "options": [self._plain(option) for option in field.get("/Opt", [])],
                }
                for name, field in fields.items()
            ],
            "widgets": widgets,
        })

    @classmethod
    def _plain(cls, value: Any) -> Any:
        if isinstance(value, (list, tuple)):
            return [cls._plain(item) for item in value]
        if isinstance(value, dict):
            return {str(key): cls._plain(item) for key, item in value.items()}
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        return str(value)

    def _fill(self, source: Path, values: dict[str, str] | None, output: str | None) -> str:
        import pymupdf
        from pypdf import PdfReader

        values = self._require(values, "values")
        if not values:
            raise ValueError("values must contain at least one field")
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in values.items()):
            raise ValueError("values must map field names to strings")
        destination = self._output_path(self._require(output, "output"))
        if destination == source:
            raise ValueError("output must not be an input file")
        with source.open("rb") as file:
            fields = PdfReader(file).get_fields() or {}
        if not fields:
            raise ValueError("PDF has no interactive form fields; use annotate with text positions")
        unknown = sorted(set(values) - set(fields))
        if unknown:
            raise ValueError(f"unknown form field(s): {unknown}")
        with pymupdf.open(source) as doc:
            widgets_by_name: dict[str, list[Any]] = {}
            retained_pages = list(doc)
            for page in retained_pages:
                for widget in page.widgets() or []:
                    widgets_by_name.setdefault(widget.field_name, []).append(widget)
            missing_widgets = sorted(set(values) - set(widgets_by_name))
            if missing_widgets:
                raise ValueError(f"form field(s) have no editable widget: {missing_widgets}")
            for name, value in values.items():
                field = fields[name]
                field_type = str(field.get("/FT", ""))
                widgets = widgets_by_name[name]
                if field_type == "/Ch":
                    options = field.get("/Opt", [])
                    allowed = {
                        str(option[0]) if isinstance(option, (list, tuple)) else str(option)
                        for option in options
                    }
                    if allowed and value not in allowed:
                        raise ValueError(
                            f"invalid choice for field '{name}'; allowed values: {sorted(allowed)}"
                        )
                elif field_type == "/Btn":
                    allowed = {"Off"}
                    for widget in widgets:
                        try:
                            allowed.update(widget.button_states().get("normal") or [])
                        except (AttributeError, RuntimeError):
                            pass
                    if value not in allowed:
                        raise ValueError(
                            f"invalid button value for field '{name}'; allowed values: {sorted(allowed)}"
                        )
                for widget in widgets:
                    widget.field_value = value
                    widget.update()
            data = doc.tobytes()
        self._save_new_file(destination, data)
        return self._json({
            "ok": True, "action": "fill", "fields": sorted(values), "output": str(destination)
        })

    def _create(self, texts: list[str] | None, output: str | None) -> str:
        import pymupdf

        texts = self._require(texts, "texts")
        if not 1 <= len(texts) <= _MAX_CREATE_PAGES:
            raise ValueError(f"create requires 1 to {_MAX_CREATE_PAGES} page texts")
        destination = self._output_path(self._require(output, "output"))
        doc = pymupdf.open()
        try:
            for page_number, text in enumerate(texts, 1):
                if not isinstance(text, str):
                    raise ValueError(f"texts[{page_number - 1}] must be a string")
                page = doc.new_page(width=595, height=842)
                box = pymupdf.Rect(50, 50, 545, 792)
                spare = page.insert_textbox(box, text, fontname="china-s", fontsize=11)
                if spare < 0:
                    raise ValueError(
                        f"text overflows page {page_number} by {-spare:.1f} points; shorten the text"
                    )
            data = doc.tobytes()
        finally:
            doc.close()
        self._save_new_file(destination, data)
        return self._json({
            "ok": True, "action": "create", "page_count": len(texts), "output": str(destination)
        })

    def _annotate(
        self,
        source: Path,
        annotations: list[dict[str, Any]] | None,
        output: str | None,
    ) -> str:
        import pymupdf

        annotations = self._require(annotations, "annotations")
        if not 1 <= len(annotations) <= 100:
            raise ValueError("annotate requires 1 to 100 annotations")
        destination = self._output_path(self._require(output, "output"))
        if destination == source:
            raise ValueError("output must not be an input file")
        with pymupdf.open(source) as doc:
            for index, item in enumerate(annotations):
                try:
                    page_number = item["page"]
                    coordinates = item["rect"]
                    text = item["text"]
                    if not isinstance(page_number, int) or not isinstance(text, str) or not text:
                        raise ValueError("page must be an integer and text must be non-empty")
                    if page_number < 1 or page_number > doc.page_count:
                        raise ValueError(f"page {page_number} is outside 1..{doc.page_count}")
                    if len(coordinates) != 4:
                        raise ValueError("rect must contain [x0, y0, x1, y1]")
                    page = doc[page_number - 1]
                    rect = pymupdf.Rect(*coordinates)
                    if rect.is_empty or rect.is_infinite or not page.rect.contains(rect):
                        raise ValueError("rect must be a positive box inside the page")
                    spare = page.insert_textbox(rect, text, fontname="china-s", fontsize=11)
                    if spare < 0:
                        raise ValueError(f"text overflows its box by {-spare:.1f} points")
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError(f"annotation {index + 1}: {exc}") from exc
            data = doc.tobytes()
        self._save_new_file(destination, data)
        return self._json({
            "ok": True,
            "action": "annotate",
            "annotation_count": len(annotations),
            "output": str(destination),
        })
