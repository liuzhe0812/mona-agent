"""Shared read_file document formatting for desktop and isolated Work."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path


def parse_page_range(pages: str, total: int) -> tuple[int, int]:
    """Parse a one-based PDF range into zero-based inclusive indices."""
    parts = pages.strip().split("-")
    if len(parts) == 1:
        page = int(parts[0])
        return max(0, page - 1), min(page - 1, total - 1)
    return max(0, int(parts[0]) - 1), min(int(parts[1]) - 1, total - 1)


def read_pdf(path: Path, pages: str | None, *, max_pages: int, max_chars: int, data: bytes | None = None) -> str:
    try:
        import fitz
    except ImportError:
        return "Error: PDF reading requires pymupdf. Install with: pip install pymupdf"
    try:
        doc = fitz.open(str(path)) if data is None else fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        return f"Error reading PDF: {exc}"

    total_pages = len(doc)
    if pages:
        try:
            start, end = parse_page_range(pages, total_pages)
        except (ValueError, IndexError):
            doc.close()
            return f"Error: Invalid page range '{pages}'. Use format like '1-5'."
        if start > end or start >= total_pages:
            doc.close()
            return f"Error: Page range '{pages}' is out of bounds (document has {total_pages} pages)."
    else:
        start, end = 0, min(total_pages - 1, max_pages - 1)
    if end - start + 1 > max_pages:
        end = start + max_pages - 1
    parts = []
    for index in range(start, end + 1):
        text = doc[index].get_text().strip()
        if text:
            parts.append(f"--- Page {index + 1} ---\n{text}")
    doc.close()
    if not parts:
        return f"(PDF has no extractable text: {path})"
    result = "\n\n".join(parts)
    if end < total_pages - 1:
        result += f"\n\n(Showing pages {start + 1}-{end + 1} of {total_pages}. Use pages='{end + 2}-{min(end + 1 + max_pages, total_pages)}' to continue.)"
    if len(result) > max_chars:
        result = result[:max_chars] + "\n\n(PDF text truncated at ~128K chars)"
    return result


def read_office(path: Path, *, max_chars: int, data: bytes | None = None) -> str:
    from mona.utils.document import _extract_docx, _extract_pptx, _extract_xlsx, extract_text

    if data is None:
        result = extract_text(path)
    else:
        parser = {".docx": _extract_docx, ".xlsx": _extract_xlsx, ".pptx": _extract_pptx}.get(path.suffix.lower())
        result = parser(BytesIO(data)) if parser else None
    if result is None:
        return f"Error: Unsupported file format: {path.suffix}"
    if result.startswith("[error:"):
        return f"Error reading {path.suffix.upper()} file: {result}"
    if not result:
        return f"({path.suffix.upper().lstrip('.')} has no extractable text: {path})"
    if len(result) > max_chars:
        result = result[:max_chars] + "\n\n(Document text truncated at ~128K chars)"
    return result
