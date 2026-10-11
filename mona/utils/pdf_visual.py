"""Bounded PDF page previews shared by attachments and the PDF tool."""

from __future__ import annotations

from pathlib import Path
from threading import RLock
from typing import Any

from mona.config.paths import get_media_dir
from mona.utils.media_store import store_media_bytes

# MuPDF calls from attachment processing and tools share the same lock.
PDF_LOCK = RLock()
MAX_VISUAL_PAGES = 4


def render_pdf_previews(
    source: Path,
    pages: list[int] | None = None,
    *,
    limit: int = MAX_VISUAL_PAGES,
) -> dict[str, Any]:
    import pymupdf

    with PDF_LOCK, pymupdf.open(source) as doc:
        selected = pages if pages is not None else list(range(1, min(doc.page_count, limit) + 1))
        if not selected or len(selected) > MAX_VISUAL_PAGES:
            raise ValueError(f"select between 1 and {MAX_VISUAL_PAGES} pages for visual inspection")
        if len(set(selected)) != len(selected):
            raise ValueError("pages must not contain duplicates")
        if any(page < 1 or page > doc.page_count for page in selected):
            raise ValueError(f"page number out of range; PDF has {doc.page_count} pages")
        previews = []
        for number in selected:
            page = doc[number - 1]
            scale = min(2, 2000 / max(page.rect.width, page.rect.height))
            raw = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png")
            image = store_media_bytes(raw, get_media_dir(), ".png")
            previews.append({"page": number, "image_path": str(image)})
        return {
            "page_count": doc.page_count,
            "visual_pages": previews,
            "remaining_pages": list(range(len(selected) + 1, doc.page_count + 1)) if pages is None else [],
        }
