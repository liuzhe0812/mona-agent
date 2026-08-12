"""Document-to-note extraction: parse local documents into text.

Office formats (docx/pptx/xlsx/odt/rtf/epub) are converted to Markdown by
the Pandoc binary, which is downloaded on demand (see pandoc_runtime.py).
PDF is handled by the bundled pypdf. Plain text formats are read directly.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from mona.api.pandoc_runtime import PandocRuntime

__all__ = (
    "SUPPORTED_EXTENSIONS",
    "Doc2NoteError",
    "DocumentSource",
    "PandocMissingError",
    "extract_document",
    "needs_pandoc",
)

_MAX_FILE_BYTES = 50 * 1024 * 1024
_EXTRACT_TIMEOUT = 60

_PANDOC_FORMATS = frozenset({".docx", ".pptx", ".xlsx", ".odt", ".rtf", ".epub"})
_TEXT_FORMATS = frozenset({".txt", ".md"})

SUPPORTED_EXTENSIONS = sorted(_PANDOC_FORMATS | _TEXT_FORMATS | {".pdf"})


class Doc2NoteError(RuntimeError):
    """A user-facing document extraction failure."""


class PandocMissingError(Doc2NoteError):
    """Pandoc binary is required for this format but not installed."""


@dataclass(frozen=True)
class DocumentSource:
    title: str
    kind: str
    text: str


def needs_pandoc(suffix: str) -> bool:
    return suffix.lower() in _PANDOC_FORMATS


async def extract_document(file_path: str) -> DocumentSource:
    path = Path(file_path.strip().strip('"'))
    if not path.is_file():
        raise Doc2NoteError(f"文件不存在：{path.name}")
    if path.stat().st_size > _MAX_FILE_BYTES:
        raise Doc2NoteError("文件超过 50MB，暂不支持导入")
    suffix = path.suffix.lower()
    if suffix in _TEXT_FORMATS:
        return _extract_text(path)
    if suffix == ".pdf":
        return await _extract_pdf(path)
    if suffix in _PANDOC_FORMATS:
        return await _extract_with_pandoc(path, suffix)
    supported = "/".join(ext.lstrip(".") for ext in SUPPORTED_EXTENSIONS)
    raise Doc2NoteError(f"不支持的文件格式：{suffix or '未知'}（支持 {supported}）")


def _extract_text(path: Path) -> DocumentSource:
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        raise Doc2NoteError("文件内容为空")
    return DocumentSource(path.stem, path.suffix.lstrip("."), text)


async def _extract_pdf(path: Path) -> DocumentSource:
    def _run() -> str:
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        return "\n\n".join(
            text for page in reader.pages if (text := (page.extract_text() or "").strip())
        )

    try:
        text = (await asyncio.wait_for(asyncio.to_thread(_run), _EXTRACT_TIMEOUT)).strip()
    except TimeoutError as exc:
        raise Doc2NoteError("PDF 解析超时") from exc
    except Exception as exc:
        raise Doc2NoteError(f"PDF 解析失败：{exc}") from exc
    if not text:
        raise Doc2NoteError("PDF 未提取到文本（扫描件暂不支持）")
    return DocumentSource(path.stem, "pdf", text)


async def _extract_with_pandoc(path: Path, suffix: str) -> DocumentSource:
    pandoc = PandocRuntime().get_pandoc_path()
    if not pandoc:
        raise PandocMissingError("Pandoc 组件未安装")
    fmt = suffix.lstrip(".")
    command = PandocRuntime.wrap_cmd(
        [pandoc, "-f", fmt, "-t", "gfm", "--wrap=none", str(path)]
    )
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise PandocMissingError("Pandoc 组件不可用") from exc
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=_EXTRACT_TIMEOUT
        )
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise Doc2NoteError("文档解析超时") from exc
    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip()
        raise Doc2NoteError(f"文档解析失败：{detail[:200] or '未知错误'}")
    text = stdout.decode("utf-8", "replace").strip()
    if not text:
        raise Doc2NoteError("文档中未提取到文本内容")
    return DocumentSource(path.stem, fmt, text)
