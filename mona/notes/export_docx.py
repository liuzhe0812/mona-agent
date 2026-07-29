"""Markdown → .docx converter for note export.

A focused, dependency-light tokenizer that walks the markdown source
directly and emits python-docx elements. Handles the common subset
needed for personal notes:

- ATX headings (# .. ######)
- Horizontal rules (--- / *** / ___)
- Blockquotes (> ...)
- Fenced code blocks (``` and ~~~), with monospace + light shading
- GFM tables (| a | b | / | --- | --- |)
- Unordered / ordered / task lists (flat + indented sublists)
- Images: ![alt](path) — resolved against the vault root, or `data:` URLs
- Inline: **bold**, *italic*, `code`, ~~strike~~, [text](url)

Mermaid diagrams are NOT rendered here — the frontend rasterizes them
to PNG and passes them via ``mermaid_images`` (keyed by the source
text). Each mermaid code block is replaced by its PNG image in the
output document.

YAML frontmatter (``---`` … ``---``) is stripped before parsing.
"""

from __future__ import annotations

import base64
import binascii
import io
import re
from pathlib import Path
from typing import Any, Iterable

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from loguru import logger

# python-docx is a core dependency; Pillow rides in via python-pptx.

__all__ = ("markdown_to_docx_bytes",)


# --- Page geometry --------------------------------------------------------

# A4 portrait with 2.5cm margins → content width ≈ 16cm.
_PAGE_CONTENT_WIDTH_CM = 16.0
_DEFAULT_FONT = "Microsoft YaHei"
_MONO_FONT = "Consolas"


# --- Block-level regexes --------------------------------------------------

_RE_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_RE_HR = re.compile(r"^(?:[-*_])(?:\s*[-*_]){2,}\s*$")
_RE_FENCE = re.compile(r"^(`{3,}|~{3,})\s*([\w+-]*)\s*$")
_RE_QUOTE = re.compile(r"^>\s?(.*)$")
_RE_TASK = re.compile(r"^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$")
_RE_UL = re.compile(r"^(\s*)([-*+])\s+(.*)$")
_RE_OL = re.compile(r"^(\s*)(\d+)\.(?:\s|\t)+(.*)$")
_RE_TABLE_ROW = re.compile(r"^\|(.*)\|\s*$")
_RE_TABLE_SEP = re.compile(
    r"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$"
)
_RE_FRONTMATTER = re.compile(r"^---\s*\n(.*?\n)---\s*\n", re.DOTALL)


# --- Inline regexes -------------------------------------------------------

# Code spans are extracted first to protect their content from other
# inline matchers. Placeholders look like ``\x00CODE0\x00``.
_RE_CODE_SPAN = re.compile(r"`([^`]+?)`")
_RE_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)")
_RE_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)")
_RE_BOLD = re.compile(r"\*\*([^*]+?)\*\*|__([^_]+?)__")
_RE_ITALIC = re.compile(r"(?<![*_])\*([^*]+?)\*(?!\*)|(?<![_])_([^_]+?)_(?!_)")
_RE_STRIKE = re.compile(r"~~([^~]+?)~~")


# --- Public API -----------------------------------------------------------


def markdown_to_docx_bytes(
    markdown: str,
    vault_path: str | None = None,
    mermaid_images: dict[str, str] | None = None,
) -> bytes:
    """Convert ``markdown`` text to a .docx file's bytes.

    Args:
        markdown: Source markdown text. YAML frontmatter is stripped.
        vault_path: Absolute path to the notes vault, used to resolve
            relative image references like ``assets/foo.png``.
        mermaid_images: Map of mermaid source text → base64 data URL
            (``data:image/png;base64,...``). Used to embed flowcharts as
            images. Mermaid code blocks whose source is not in this map
            are emitted as plain code blocks instead.
    """
    doc = _new_document()
    vault = Path(vault_path).resolve() if vault_path else None
    mermaid = mermaid_images or {}

    body = _strip_frontmatter(markdown)
    lines = body.splitlines()
    renderer = _Renderer(doc, vault, mermaid)
    renderer.render(lines)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# --- Document setup -------------------------------------------------------


def _new_document() -> Document:
    doc = Document()

    # Page setup: A4 + 2.5cm margins on every side.
    section = doc.sections[0]
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.5)
    section.top_margin = Cm(2.5)
    section.bottom_margin = Cm(2.5)

    # Default font — pick a Chinese-friendly family so notes with CJK
    # text render correctly even on machines without Inter installed.
    normal = doc.styles["Normal"]
    normal.font.name = _DEFAULT_FONT
    normal.font.size = Pt(10.5)
    # Also set the East-Asian font hint so Word picks _DEFAULT_FONT for CJK.
    _set_east_asian_font(normal, _DEFAULT_FONT)

    # Tighten paragraph spacing — Word's defaults are too airy for note
    # content that originated from markdown.
    pf = normal.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(4)
    pf.line_spacing = 1.25

    return doc


def _set_east_asian_font(style: Any, font_name: str) -> None:
    """Force the East-Asian font hint on a paragraph style.

    python-docx doesn't expose ``w:eastAsia`` directly, so we drop into
    oxml. Without this, Word may substitute a default CJK font that
    clashes with the body face.
    """
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), font_name)
    rfonts.set(qn("w:ascii"), font_name)
    rfonts.set(qn("w:hAnsi"), font_name)


# --- Frontmatter ----------------------------------------------------------


def _strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    return _RE_FRONTMATTER.sub("", text, count=1)


# --- Renderer -------------------------------------------------------------


class _Renderer:
    """Drives the line scanner and emits docx blocks."""

    def __init__(
        self,
        doc: Document,
        vault: Path | None,
        mermaid: dict[str, str],
    ) -> None:
        self.doc = doc
        self.vault = vault
        self.mermaid = mermaid

    def render(self, lines: list[str]) -> None:
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]

            # Blank line — collapse, no block emitted.
            if not line.strip():
                i += 1
                continue

            # HTML comment — skip silently.
            if line.lstrip().startswith("<!--"):
                i = _skip_html_comment(lines, i)
                continue

            # Fenced code block (also catches ```mermaid).
            m_fence = _RE_FENCE.match(line)
            if m_fence:
                fence_marker, lang = m_fence.group(1), m_fence.group(2) or ""
                i = self._emit_fenced_code(lines, i, fence_marker, lang)
                continue

            # ATX heading
            m_h = _RE_HEADING.match(line)
            if m_h:
                level = len(m_h.group(1))
                self._emit_heading(level, m_h.group(2))
                i += 1
                continue

            # Horizontal rule
            if _RE_HR.match(line):
                self._emit_horizontal_rule()
                i += 1
                continue

            # Blockquote — gather consecutive > lines.
            if _RE_QUOTE.match(line):
                i = self._emit_blockquote(lines, i)
                continue

            # GFM table — needs the next line to be a separator.
            if _RE_TABLE_ROW.match(line) and i + 1 < n and _RE_TABLE_SEP.match(lines[i + 1]):
                i = self._emit_table(lines, i)
                continue

            # Task / unordered / ordered list — gather consecutive items.
            if _RE_TASK.match(line) or _RE_UL.match(line) or _RE_OL.match(line):
                i = self._emit_list(lines, i)
                continue

            # Default: paragraph. Gather consecutive non-blank lines
            # that don't start a new block.
            i = self._emit_paragraph(lines, i)

    # -- block emitters ----------------------------------------------------

    def _emit_fenced_code(
        self,
        lines: list[str],
        start: int,
        fence_marker: str,
        lang: str,
    ) -> int:
        # Collect lines until the matching closing fence.
        body: list[str] = []
        i = start + 1
        n = len(lines)
        close_re = re.compile(rf"^{re.escape(fence_marker[0])}{{3,}}\s*$")
        while i < n:
            if close_re.match(lines[i]):
                i += 1
                break
            body.append(lines[i])
            i += 1

        # Mermaid → image, if a pre-rasterized PNG was provided.
        if lang.lower() == "mermaid":
            code = "\n".join(body)
            data_url = self.mermaid.get(code) or self.mermaid.get(code.strip())
            if data_url:
                self._emit_image_data_url(data_url, alt="mermaid")
                return i
            # Fallback: emit as a code block so the source is at least
            # visible to the user.

        self._emit_code_block("\n".join(body), lang)
        return i

    def _emit_code_block(self, code: str, lang: str) -> None:
        # One paragraph per line keeps line breaks intact without relying
        # on raw line breaks (which Word sometimes eats). A shaded
        # background + monospace font visually marks the block.
        for line in code.split("\n"):
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.space_before = Pt(0)
            pf.space_after = Pt(0)
            pf.line_spacing = 1.15
            pf.left_indent = Cm(0.4)
            run = p.add_run(line if line else " ")
            run.font.name = _MONO_FONT
            run.font.size = Pt(9.5)
            _set_run_shading(run, "F3F4F6")  # tailwind gray-100
            _set_run_east_asian_font(run, _MONO_FONT)
        # Tighten spacing after the whole block.
        if p := self.doc.paragraphs[-1]:
            p.paragraph_format.space_after = Pt(6)

    def _emit_heading(self, level: int, text: str) -> None:
        # Word's built-in Heading 1..4 styles are well-supported; map
        # anything deeper than 4 to Heading 4 to keep visual hierarchy
        # meaningful.
        style_name = f"Heading {min(level, 4)}"
        p = self.doc.add_paragraph(style=style_name)
        # Heading styles bring their own spacing, but make sure the
        # east-asian font hint is set so CJK headings don't fall back.
        for run in p.runs:
            _set_run_east_asian_font(run, _DEFAULT_FONT)
        # add_paragraph(style=...) creates an empty paragraph; add the
        # text as a single run with inline formatting.
        p.clear()
        self._emit_inline(p, text)
        for run in p.runs:
            _set_run_east_asian_font(run, _DEFAULT_FONT)

    def _emit_horizontal_rule(self) -> None:
        # Word doesn't have a true <hr>; emulate with a bottom border
        # on an empty paragraph.
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_before = Pt(4)
        pf.space_after = Pt(4)
        _add_bottom_border(p, "BFBFBF", size=6)

    def _emit_blockquote(self, lines: list[str], start: int) -> int:
        gathered: list[str] = []
        i = start
        n = len(lines)
        while i < n:
            m = _RE_QUOTE.match(lines[i])
            if not m:
                # Allow blank lines within a multi-paragraph quote.
                if lines[i].strip() == "" and i + 1 < n and _RE_QUOTE.match(lines[i + 1]):
                    gathered.append("")
                    i += 1
                    continue
                break
            gathered.append(m.group(1))
            i += 1

        # Each contiguous run of non-blank lines becomes one indented
        # paragraph with a left border.
        chunks = _split_on_blank(gathered)
        for chunk in chunks:
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(0.6)
            pf.space_after = Pt(4)
            _add_left_border(p, "CCCCCC", size=12)
            self._emit_inline(p, " ".join(line.strip() for line in chunk))
            for run in p.runs:
                run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
        return i

    def _emit_table(self, lines: list[str], start: int) -> int:
        # Header row.
        header = _split_table_row(lines[start])
        aligns = _parse_table_aligns(lines[start + 1])
        i = start + 2
        n = len(lines)
        rows: list[list[str]] = []
        while i < n and _RE_TABLE_ROW.match(lines[i]):
            rows.append(_split_table_row(lines[i]))
            i += 1

        n_cols = max(len(header), max((len(r) for r in rows), default=0))
        if n_cols == 0:
            return i

        table = self.doc.add_table(rows=1 + len(rows), cols=n_cols)
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        table.autofit = True
        _set_table_borders(table, "D0D7DE")

        # Header
        for ci, cell_text in enumerate(header):
            cell = table.rows[0].cells[ci]
            _fill_cell(cell, cell_text, bold=True, shading="F6F8FA")
            _set_cell_vertical_alignment(cell, WD_ALIGN_VERTICAL.CENTER)

        # Body
        for ri, row in enumerate(rows, start=1):
            for ci, cell_text in enumerate(row):
                if ci >= n_cols:
                    break
                cell = table.rows[ri].cells[ci]
                align = aligns[ci] if ci < len(aligns) else "left"
                _fill_cell(cell, cell_text, align=align)

        # Add a tiny spacer paragraph after the table — Word renders
        # adjacent tables/list items poorly without it.
        spacer = self.doc.add_paragraph()
        spacer.paragraph_format.space_after = Pt(2)
        return i

    def _emit_list(self, lines: list[str], start: int) -> int:
        # Collect all consecutive list-looking lines (including blank
        # lines that separate items at the same level).
        gathered: list[str] = []
        i = start
        n = len(lines)
        while i < n:
            line = lines[i]
            if (
                _RE_TASK.match(line)
                or _RE_UL.match(line)
                or _RE_OL.match(line)
            ):
                gathered.append(line)
                i += 1
                continue
            if line.strip() == "":
                # Lookahead: keep gathering if the next non-blank line
                # is still a list item.
                j = i + 1
                while j < n and lines[j].strip() == "":
                    j += 1
                if j < n and (
                    _RE_TASK.match(lines[j])
                    or _RE_UL.match(lines[j])
                    or _RE_OL.match(lines[j])
                ):
                    gathered.append("")
                    i += 1
                    continue
                break
            # Continuation line (indented, not a new item) belongs to
            # the previous item.
            if line[:1] in (" ", "\t") and gathered:
                gathered.append(line)
                i += 1
                continue
            break

        self._emit_list_block(gathered)
        return i

    def _emit_list_block(self, lines: list[str]) -> None:
        # Track an ordered-list counter per indent level.
        counters: dict[int, int] = {}
        # Pending list of (indent_level, item_text, is_task, task_done,
        # marker_kind) — flat order.
        items = _parse_list_items(lines)
        for item in items:
            indent = item["indent"]
            kind = item["kind"]
            text = item["text"]
            is_task = item["is_task"]
            task_done = item["done"]

            if kind == "ol":
                counters[indent] = counters.get(indent, 0) + 1
                marker = f"{counters[indent]}."
            else:
                marker = "•"
                counters[indent] = 0  # reset deeper-level counters

            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(0.6 + 0.6 * indent)
            pf.first_line_indent = Cm(-0.6)
            pf.space_after = Pt(2)
            pf.line_spacing = 1.2

            if is_task:
                checkbox = "☑ " if task_done else "☐ "
                mrun = p.add_run(checkbox)
                mrun.font.name = _DEFAULT_FONT
                mrun.font.size = Pt(10.5)
                _set_run_east_asian_font(mrun, _DEFAULT_FONT)
            else:
                mrun = p.add_run(f"{marker}  ")
                mrun.font.name = _DEFAULT_FONT
                mrun.font.size = Pt(10.5)
                _set_run_east_asian_font(mrun, _DEFAULT_FONT)

            self._emit_inline(p, text)
            if is_task and task_done:
                for run in p.runs[1:]:
                    run.font.strike = True
                    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    def _emit_paragraph(self, lines: list[str], start: int) -> int:
        gathered: list[str] = []
        i = start
        n = len(lines)
        while i < n:
            line = lines[i]
            if not line.strip():
                break
            # Stop if the next line clearly starts a new block.
            if (
                _RE_HEADING.match(line)
                or _RE_HR.match(line)
                or _RE_FENCE.match(line)
                or _RE_QUOTE.match(line)
                or _RE_TASK.match(line)
                or _RE_UL.match(line)
                or _RE_OL.match(line)
            ):
                break
            if _RE_TABLE_ROW.match(line) and i + 1 < n and _RE_TABLE_SEP.match(lines[i + 1]):
                break
            gathered.append(line)
            i += 1

        if not gathered:
            return i

        text = " ".join(line.strip() for line in gathered)
        p = self.doc.add_paragraph()
        self._emit_inline(p, text)
        return i

    # -- inline emitter ----------------------------------------------------

    def _emit_inline(self, p: Any, text: str) -> None:
        for seg in _parse_inline(text):
            kind = seg["kind"]
            if kind == "image":
                self._add_image_run(p, seg["alt"], seg["src"])
            elif kind == "text":
                self._add_formatted_run(p, seg["text"], seg)
            # link → render text with underline + blue, url dropped
            elif kind == "link":
                self._add_formatted_run(p, seg["text"], seg)
                for run in p.runs[-1:]:
                    run.font.underline = True
                    run.font.color.rgb = RGBColor(0x09, 0x69, 0xDA)

    def _add_formatted_run(self, p: Any, text: str, seg: dict[str, Any]) -> None:
        run = p.add_run(text)
        run.font.name = _DEFAULT_FONT
        run.font.size = Pt(10.5)
        _set_run_east_asian_font(run, _DEFAULT_FONT)
        if seg.get("bold"):
            run.bold = True
        if seg.get("italic"):
            run.italic = True
        if seg.get("strike"):
            run.font.strike = True
        if seg.get("code"):
            run.font.name = _MONO_FONT
            run.font.size = Pt(9.5)
            _set_run_east_asian_font(run, _MONO_FONT)
            _set_run_shading(run, "F3F4F6")

    # -- image handling ----------------------------------------------------

    def _add_image_run(self, p: Any, alt: str, src: str) -> None:
        # Inline image — emit on its own paragraph for layout sanity.
        # First close the current paragraph by adding the image to a
        # fresh one. Caller already added ``p``; if it's empty, reuse
        # it, otherwise append a new paragraph.
        target = p if not p.runs else self.doc.add_paragraph()
        ok = self._emit_image_into(target, src, alt)
        if not ok:
            # Fallback: render the image reference as text so the user
            # at least sees that there was an image.
            run = target.add_run(f"[图片: {alt or src}]")
            run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
            run.italic = True

    def _emit_image_data_url(self, data_url: str, alt: str = "") -> None:
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if not self._emit_image_into(p, data_url, alt):
            run = p.add_run(f"[图片: {alt or 'mermaid'}]")
            run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
            run.italic = True

    def _emit_image_into(self, p: Any, src: str, alt: str) -> bool:
        """Try to embed ``src`` into paragraph ``p``. Return False on failure."""
        try:
            data = _read_image_bytes(src, self.vault)
            if data is None:
                return False
            stream = io.BytesIO(data)
            run = p.add_run()
            run.add_picture(stream, width=Cm(_PAGE_CONTENT_WIDTH_CM))
            return True
        except Exception as exc:  # noqa: BLE001 — image embed is best-effort
            logger.warning("docx image embed failed for {!r}: {}", src, exc)
            return False


# --- Helpers --------------------------------------------------------------


def _skip_html_comment(lines: list[str], start: int) -> int:
    # Single-line ``<!-- ... -->`` and multi-line comments both end at
    # the first ``-->``. Scan forward until found.
    i = start
    n = len(lines)
    while i < n:
        if "-->" in lines[i]:
            return i + 1
        i += 1
    return n


def _split_on_blank(lines: Iterable[str]) -> list[list[str]]:
    chunks: list[list[str]] = []
    cur: list[str] = []
    for line in lines:
        if line.strip() == "":
            if cur:
                chunks.append(cur)
                cur = []
            continue
        cur.append(line)
    if cur:
        chunks.append(cur)
    return chunks


def _split_table_row(line: str) -> list[str]:
    # Strip the leading and trailing pipe, then split on ``|``. Empty
    # cells become empty strings.
    m = _RE_TABLE_ROW.match(line)
    if not m:
        return []
    inner = m.group(1)
    return [cell.strip() for cell in inner.split("|")]


def _parse_table_aligns(sep_line: str) -> list[str]:
    # Cells like ``:---:``, ``:---``, ``---:`` → center / left / right.
    inner = sep_line.strip()
    if inner.startswith("|"):
        inner = inner[1:]
    if inner.endswith("|"):
        inner = inner[:-1]
    aligns: list[str] = []
    for cell in inner.split("|"):
        cell = cell.strip()
        left = cell.startswith(":")
        right = cell.endswith(":")
        if left and right:
            aligns.append("center")
        elif right:
            aligns.append("right")
        else:
            aligns.append("left")
    return aligns


def _fill_cell(
    cell: Any,
    text: str,
    *,
    bold: bool = False,
    align: str = "left",
    shading: str | None = None,
) -> None:
    cell.text = ""  # clear default empty paragraph
    p = cell.paragraphs[0]
    pf = p.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.line_spacing = 1.15
    if align == "center":
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif align == "right":
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT

    # Inline formatting inside table cells — reuse the same parser but
    # render with the cell's paragraph directly.
    for seg in _parse_inline(text):
        run = p.add_run(seg.get("text", ""))
        run.font.name = _DEFAULT_FONT
        run.font.size = Pt(10)
        _set_run_east_asian_font(run, _DEFAULT_FONT)
        if bold:
            run.bold = True
        if seg.get("bold"):
            run.bold = True
        if seg.get("italic"):
            run.italic = True
        if seg.get("strike"):
            run.font.strike = True
        if seg.get("code"):
            run.font.name = _MONO_FONT
            _set_run_east_asian_font(run, _MONO_FONT)
            _set_run_shading(run, "F3F4F6")

    if shading:
        _set_cell_shading(cell, shading)


def _set_cell_vertical_alignment(cell: Any, alignment: Any) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    v_align = OxmlElement("w:vAlign")
    v_align.set(qn("w:val"), "center")
    tc_pr.append(v_align)


def _set_cell_shading(cell: Any, hex_color: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tc_pr.append(shd)


def _set_table_borders(table: Any, hex_color: str) -> None:
    tbl = table._tbl
    tbl_pr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), hex_color)
        borders.append(el)
    tbl_pr.append(borders)


def _add_bottom_border(p: Any, hex_color: str, *, size: int = 6) -> None:
    p_pr = p._p.get_or_add_pPr()
    pbdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(size))
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), hex_color)
    pbdr.append(bottom)
    p_pr.append(pbdr)


def _add_left_border(p: Any, hex_color: str, *, size: int = 12) -> None:
    p_pr = p._p.get_or_add_pPr()
    pbdr = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), str(size))
    left.set(qn("w:space"), "8")
    left.set(qn("w:color"), hex_color)
    pbdr.append(left)
    p_pr.append(pbdr)


def _set_run_shading(run: Any, hex_color: str) -> None:
    r_pr = run._r.get_or_add_rPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    r_pr.append(shd)


def _set_run_east_asian_font(run: Any, font_name: str) -> None:
    r_pr = run._r.get_or_add_rPr()
    rfonts = r_pr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        r_pr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), font_name)


# --- List parsing ---------------------------------------------------------


def _parse_list_items(lines: list[str]) -> list[dict[str, Any]]:
    """Flatten raw list lines into a list of item dicts.

    Continuation lines (indented non-list lines) are appended to the
    previous item's text.
    """
    items: list[dict[str, Any]] = []
    for raw in lines:
        if not raw.strip():
            continue
        m_task = _RE_TASK.match(raw)
        m_ul = _RE_UL.match(raw)
        m_ol = _RE_OL.match(raw)

        if m_task:
            items.append({
                "indent": _leading_indent(m_task.group(1)) // 2,
                "kind": "ul",
                "is_task": True,
                "done": m_task.group(3).lower() == "x",
                "text": m_task.group(4).strip(),
            })
        elif m_ul:
            items.append({
                "indent": _leading_indent(m_ul.group(1)) // 2,
                "kind": "ul",
                "is_task": False,
                "done": False,
                "text": m_ul.group(3).strip(),
            })
        elif m_ol:
            items.append({
                "indent": _leading_indent(m_ol.group(1)) // 2,
                "kind": "ol",
                "is_task": False,
                "done": False,
                "text": m_ol.group(3).strip(),
            })
        else:
            # Continuation line — append to previous item.
            if items:
                items[-1]["text"] += " " + raw.strip()
            # else: orphan line, ignore.
    return items


def _leading_indent(s: str) -> int:
    # Count leading spaces (tabs count as 4).
    n = 0
    for ch in s:
        if ch == " ":
            n += 1
        elif ch == "\t":
            n += 4
        else:
            break
    return n


# --- Inline parsing -------------------------------------------------------


def _parse_inline(text: str) -> list[dict[str, Any]]:
    """Tokenize ``text`` into a flat list of segment dicts.

    Each segment is one of:
      - ``{kind: "text", text, bold, italic, strike, code}``
      - ``{kind: "link", text, url, bold, italic, strike, code}``
      - ``{kind: "image", alt, src}``

    Code spans are extracted first to protect their contents. Then
    images, links, bold, italic, strike are matched in a single
    recursive pass — sufficient for personal notes; pathological
    nesting falls back to plain text.
    """
    if not text:
        return []

    # 1) Pull out code spans into placeholders so later regexes don't
    #    misinterpret their contents (e.g. ``a * b`` inside code).
    code_store: list[str] = []

    def _stash_code(m: re.Match[str]) -> str:
        code_store.append(m.group(1))
        return f"\x00CODE{len(code_store) - 1}\x00"

    text = _RE_CODE_SPAN.sub(_stash_code, text)

    # 2) Walk the string char by char, attempting matches at each
    #    position. Greedy but ordered: image, link, bold, italic, strike.
    segments: list[dict[str, Any]] = []
    buf: list[str] = []
    i = 0
    n = len(text)

    def flush_buf() -> None:
        if not buf:
            return
        segments.append({"kind": "text", "text": "".join(buf), "bold": False,
                         "italic": False, "strike": False, "code": False})
        buf.clear()

    while i < n:
        ch = text[i]

        # Image: ![alt](src)
        if ch == "!" and i + 1 < n and text[i + 1] == "[":
            m = _RE_IMAGE.match(text, i)
            if m:
                flush_buf()
                segments.append({
                    "kind": "image",
                    "alt": m.group(1),
                    "src": m.group(2),
                })
                i = m.end()
                continue

        # Link: [text](url)
        if ch == "[":
            m = _RE_LINK.match(text, i)
            if m:
                flush_buf()
                segments.append({
                    "kind": "link",
                    "text": m.group(1),
                    "url": m.group(2),
                    "bold": False, "italic": False, "strike": False, "code": False,
                })
                i = m.end()
                continue

        # Bold: **...** or __...__
        if ch in ("*", "_") and i + 1 < n and text[i + 1] == ch:
            m = _RE_BOLD.match(text, i)
            if m:
                flush_buf()
                inner = m.group(1) if m.group(1) is not None else m.group(2)
                for sub in _parse_inline(inner):
                    sub["bold"] = True
                    segments.append(sub)
                i = m.end()
                continue

        # Italic: *...* or _..._
        if ch in ("*", "_"):
            m = _RE_ITALIC.match(text, i)
            if m:
                flush_buf()
                inner = m.group(1) if m.group(1) is not None else m.group(2)
                for sub in _parse_inline(inner):
                    sub["italic"] = True
                    segments.append(sub)
                i = m.end()
                continue

        # Strikethrough: ~~...~~
        if ch == "~" and i + 1 < n and text[i + 1] == "~":
            m = _RE_STRIKE.match(text, i)
            if m:
                flush_buf()
                for sub in _parse_inline(m.group(1)):
                    sub["strike"] = True
                    segments.append(sub)
                i = m.end()
                continue

        buf.append(ch)
        i += 1

    flush_buf()

    # 3) Restore code spans — every text segment may contain placeholders.
    restored: list[dict[str, Any]] = []
    for seg in segments:
        if seg["kind"] == "text":
            parts = re.split(r"\x00CODE(\d+)\x00", seg["text"])
            for idx, part in enumerate(parts):
                if idx % 2 == 0:
                    if part:
                        restored.append({
                            "kind": "text",
                            "text": part,
                            "bold": seg["bold"],
                            "italic": seg["italic"],
                            "strike": seg["strike"],
                            "code": seg["code"],
                        })
                else:
                    code_idx = int(part)
                    restored.append({
                        "kind": "text",
                        "text": code_store[code_idx],
                        "bold": seg["bold"],
                        "italic": seg["italic"],
                        "strike": seg["strike"],
                        "code": True,
                    })
        elif seg["kind"] == "link":
            # Links can also contain code placeholders in their text.
            seg["text"] = _restore_code_placeholders(seg["text"], code_store)
            restored.append(seg)
        else:
            restored.append(seg)
    return restored


def _restore_code_placeholders(text: str, store: list[str]) -> str:
    def _sub(m: re.Match[str]) -> str:
        return store[int(m.group(1))]
    return re.sub(r"\x00CODE(\d+)\x00", _sub, text)


# --- Image I/O ------------------------------------------------------------


def _read_image_bytes(src: str, vault: Path | None) -> bytes | None:
    """Resolve ``src`` to raw image bytes.

    Supported forms:
      - ``data:image/...;base64,...`` — decoded in-process
      - ``http://`` / ``https://`` — skipped (no network fetch on export)
      - ``assets/foo.png`` or any relative path — resolved against
        ``vault`` if provided
      - Absolute path — read directly
    """
    if not src:
        return None

    if src.startswith("data:"):
        return _decode_data_url(src)

    if src.startswith(("http://", "https://")):
        # Network images are intentionally not fetched during export
        # (no SSRF surface, no async HTTP in this sync helper).
        return None

    # File path.
    path: Path | None = None
    p = Path(src)
    if p.is_absolute():
        path = p
    elif vault is not None:
        # Try as-is relative to vault, then under assets/ (a common
        # shortcut in notes).
        cand = vault / src
        if cand.exists():
            path = cand
        else:
            cand2 = vault / "assets" / src
            if cand2.exists():
                path = cand2

    if path is None or not path.exists():
        return None

    try:
        return path.read_bytes()
    except OSError as exc:
        logger.warning("failed to read image {!r}: {}", path, exc)
        return None


def _decode_data_url(data_url: str) -> bytes | None:
    if "," not in data_url:
        return None
    head, _, payload = data_url.partition(",")
    if "base64" not in head.lower():
        # UTF-8 encoded data URLs are rare for images; still try.
        try:
            from urllib.parse import unquote_to_bytes
            return unquote_to_bytes(payload)
        except Exception:  # noqa: BLE001
            return None
    try:
        return base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        logger.warning("docx export: invalid base64 image: {}", exc)
        return None
