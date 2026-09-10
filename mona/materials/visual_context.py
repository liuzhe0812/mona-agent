"""Map OOXML media files to nearby source text.

The returned strings are document data only.  They are passed to the visual
reader as context and must never be interpreted as instructions.
"""

from __future__ import annotations

import posixpath
import re
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote

import defusedxml.ElementTree
from loguru import logger

_MAX_CONTEXT_CHARS = 3000

_OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_IMAGE_REL_SUFFIX = "/image"

_MEDIA_PREFIXES = {
    ".docx": "word/media/",
    ".pptx": "ppt/media/",
    ".xlsx": "xl/media/",
}


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _attribute(element: defusedxml.ElementTree.Element, name: str) -> str | None:
    """Read an attribute by local name, including malformed unqualified XML."""

    for key, value in element.attrib.items():
        if key == name or key == f"r:{name}" or _local_name(key) == name:
            return value
    return None


def _relationship_id(element: defusedxml.ElementTree.Element) -> str | None:
    return element.get(f"{{{_OFFICE_REL_NS}}}id") or element.get("r:id") or _attribute(element, "id")


def _parse_xml(data: bytes, part: str = "<unknown>") -> defusedxml.ElementTree.Element | None:
    try:
        return defusedxml.ElementTree.fromstring(data)
    except Exception as exc:
        logger.warning("无法解析 Office XML 部件 {}：{}", part, exc)
        return None


def _clean_text(value: str) -> str:
    lines = []
    for line in value.replace("\r", "\n").split("\n"):
        line = re.sub(r"[ \t\f\v]+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _clip_context(value: str) -> str:
    value = _clean_text(value)
    if len(value) <= _MAX_CONTEXT_CHARS:
        return value
    suffix = f"\n...（内容已截断 / truncated；原始上下文共 {len(value)} 字符）"
    return value[: max(0, _MAX_CONTEXT_CHARS - len(suffix))] + suffix


class _ContextCollector:
    def __init__(self, media_paths: Iterable[str] = ()) -> None:
        self._parts: dict[str, list[str]] = defaultdict(list)
        for media_path in media_paths:
            self._parts[media_path]

    def add(self, media_path: str | None, *parts: str) -> None:
        if not media_path:
            return
        target = self._parts[media_path]
        for part in parts:
            cleaned = _clean_text(part)
            if cleaned and cleaned not in target:
                target.append(cleaned)

    def result(self) -> dict[str, str]:
        return {
            media_path: _clip_context("\n".join(parts))
            for media_path, parts in self._parts.items()
        }


def _package_path(value: str) -> str | None:
    """Normalize a package member without allowing an escaped package path."""

    value = unquote(value).replace("\\", "/")
    if not value or "\x00" in value or value.startswith("/"):
        return None
    normalized = posixpath.normpath(value)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        return None
    return normalized


def _resolve_target(
    source_part: str, target: str, package_prefix: str | None = None,
) -> str | None:
    """Resolve an OOXML relationship target inside the package."""

    target = unquote(target).replace("\\", "/")
    if (
        not target
        or "\x00" in target
        or target.startswith("//")
        or re.match(r"^[A-Za-z]:", target)
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target)
    ):
        return None
    if target.startswith("/"):
        candidate = target[1:]
    else:
        candidate = posixpath.join(posixpath.dirname(source_part), target)
    normalized = _package_path(candidate)
    if normalized is None or (package_prefix and not normalized.startswith(package_prefix)):
        return None
    return normalized


def _rels_path(source_part: str) -> str:
    directory, filename = posixpath.split(source_part)
    return posixpath.join(directory, "_rels", f"{filename}.rels")


def _image_relationships(
    archive: zipfile.ZipFile, source_part: str, media_prefix: str,
) -> dict[str, str]:
    rels_part = _rels_path(source_part)
    try:
        root = _parse_xml(archive.read(rels_part), rels_part)
    except KeyError:
        return {}
    if root is None:
        return {}
    relationships: dict[str, str] = {}
    for relationship in root.iter():
        if _local_name(relationship.tag) != "Relationship":
            continue
        rel_type = _attribute(relationship, "Type") or ""
        rel_id = _attribute(relationship, "Id")
        target = _attribute(relationship, "Target")
        target_mode = (_attribute(relationship, "TargetMode") or "").lower()
        if (
            not rel_id
            or not target
            or target_mode == "external"
            or not rel_type.endswith(_IMAGE_REL_SUFFIX)
        ):
            continue
        media_path = _resolve_target(source_part, target, media_prefix)
        if media_path:
            relationships[rel_id] = media_path
    return relationships


def _media_paths(archive: zipfile.ZipFile, media_prefix: str) -> list[str]:
    paths: list[str] = []
    for raw_name in archive.namelist():
        name = _package_path(raw_name)
        if name and name.startswith(media_prefix) and name != media_prefix:
            if not name.endswith("/") and name not in paths:
                paths.append(name)
    return paths


def _element_text(element: defusedxml.ElementTree.Element) -> str:
    """Extract visible Word text while preserving tabs and line breaks."""

    pieces: list[str] = []
    for child in element.iter():
        name = _local_name(child.tag)
        if name in {"t", "delText", "instrText"} and child.text:
            pieces.append(child.text)
        elif name == "tab":
            pieces.append("\t")
        elif name in {"br", "cr"}:
            pieces.append("\n")
    return "".join(pieces)


def _word_paragraph_text(paragraph: defusedxml.ElementTree.Element) -> str:
    return _clean_text(_element_text(paragraph))


def _word_row_text(row: defusedxml.ElementTree.Element) -> str:
    cells: list[str] = []
    for cell in row.iter():
        if _local_name(cell.tag) != "tc":
            continue
        paragraphs = [
            _word_paragraph_text(paragraph)
            for paragraph in cell.iter()
            if _local_name(paragraph.tag) == "p"
        ]
        cell_text = "\n".join(text for text in paragraphs if text)
        if cell_text:
            cells.append(cell_text)
    return " | ".join(cells)


def _ancestor(
    element: defusedxml.ElementTree.Element,
    parents: dict[defusedxml.ElementTree.Element, defusedxml.ElementTree.Element],
    name: str,
) -> defusedxml.ElementTree.Element | None:
    current = parents.get(element)
    while current is not None:
        if _local_name(current.tag) == name:
            return current
        current = parents.get(current)
    return None


def _docx_contexts(archive: zipfile.ZipFile, media_prefix: str) -> _ContextCollector:
    collector = _ContextCollector(_media_paths(archive, media_prefix))
    names = [
        name for raw_name in archive.namelist()
        if (name := _package_path(raw_name))
        and name.startswith("word/")
        and name.endswith(".xml")
        and not name.endswith(".rels")
    ]
    for part in names:
        try:
            root = _parse_xml(archive.read(part), part)
        except KeyError:
            continue
        if root is None:
            continue
        relationships = _image_relationships(archive, part, media_prefix)
        if not relationships:
            continue
        parents = {child: parent for parent in root.iter() for child in parent}
        paragraphs = [element for element in root.iter() if _local_name(element.tag) == "p"]
        paragraph_texts = [_word_paragraph_text(paragraph) for paragraph in paragraphs]
        for image in root.iter():
            relation_id = None
            image_name = _local_name(image.tag)
            if image_name == "blip":
                relation_id = _attribute(image, "embed")
            elif image_name == "imagedata":
                relation_id = _attribute(image, "id")
            media_path = relationships.get(relation_id or "")
            if not media_path:
                continue

            row = _ancestor(image, parents, "tr")
            if row is not None:
                row_text = _word_row_text(row)
                if row_text:
                    collector.add(media_path, f"表格行（{part}）：{row_text}")
                continue

            paragraph = _ancestor(image, parents, "p")
            if paragraph is None:
                collector.add(media_path, f"文档部件：{part}")
                continue
            try:
                index = paragraphs.index(paragraph)
            except ValueError:
                index = -1
            nearby: list[str] = []
            if index >= 0:
                for offset, label in ((-1, "前一段"), (0, "所在段"), (1, "后一段")):
                    position = index + offset
                    if 0 <= position < len(paragraph_texts) and paragraph_texts[position]:
                        nearby.append(f"{label}：{paragraph_texts[position]}")
            if nearby:
                collector.add(media_path, f"正文（{part}）：" + "\n".join(nearby))
            else:
                collector.add(media_path, f"正文（{part}）")
    return collector


def _drawing_text(root: defusedxml.ElementTree.Element) -> str:
    return _clean_text(" ".join(child.text or "" for child in root.iter() if _local_name(child.tag) == "t"))


def _ppt_relationship_target(
    archive: zipfile.ZipFile, source_part: str, package_prefix: str | None,
    relationship_type_suffix: str,
) -> dict[str, str]:
    rels_part = _rels_path(source_part)
    try:
        root = _parse_xml(archive.read(rels_part), rels_part)
    except KeyError:
        return {}
    if root is None:
        return {}
    result: dict[str, str] = {}
    for relationship in root.iter():
        if _local_name(relationship.tag) != "Relationship":
            continue
        rel_id = _attribute(relationship, "Id")
        target = _attribute(relationship, "Target")
        rel_type = _attribute(relationship, "Type") or ""
        if (
            not rel_id
            or not target
            or (_attribute(relationship, "TargetMode") or "").lower() == "external"
        ):
            continue
        if not rel_type.endswith(relationship_type_suffix):
            continue
        resolved = _resolve_target(source_part, target, package_prefix)
        if resolved:
            result[rel_id] = resolved
    return result


def _ppt_slide_parts(archive: zipfile.ZipFile) -> list[str]:
    """Return slides in the user-visible order from presentation.xml."""

    presentation_part = "ppt/presentation.xml"
    ordered: list[str] = []
    try:
        root = _parse_xml(archive.read(presentation_part), presentation_part)
    except KeyError:
        root = None
    if root is not None:
        relationships = _ppt_relationship_target(archive, presentation_part, None, "/slide")
        for element in root.iter():
            if _local_name(element.tag) != "sldId":
                continue
            slide_part = relationships.get(_relationship_id(element) or "")
            if slide_part and slide_part.startswith("ppt/slides/") and slide_part.endswith(".xml"):
                ordered.append(slide_part)

    discovered = sorted(
        {
            name
            for raw_name in archive.namelist()
            if (name := _package_path(raw_name))
            and name.startswith("ppt/slides/slide")
            and name.endswith(".xml")
        },
    )
    return ordered + [name for name in discovered if name not in ordered]


def _ppt_contexts(archive: zipfile.ZipFile, media_prefix: str) -> _ContextCollector:
    collector = _ContextCollector(_media_paths(archive, media_prefix))
    for slide_number, slide_part in enumerate(_ppt_slide_parts(archive), 1):
        try:
            root = _parse_xml(archive.read(slide_part), slide_part)
        except KeyError:
            continue
        if root is None:
            continue
        label = f"第 {slide_number} 张幻灯片"
        slide_text = _drawing_text(root)
        context = f"{label}（{slide_part}）"
        if slide_text:
            context += f"\n幻灯片文字：{slide_text}"
        relationships = _image_relationships(archive, slide_part, media_prefix)
        for image in root.iter():
            if _local_name(image.tag) != "blip":
                continue
            media_path = relationships.get(_attribute(image, "embed") or "")
            collector.add(media_path, context)

        # A picture can live on a layout or master and therefore be visible on
        # every slide that uses that part.  Include the slide's text as the
        # useful source context for those inherited pictures.
        layout_rels = _ppt_relationship_target(
            archive, slide_part, None, "/slideLayout",
        )
        for layout_part in layout_rels.values():
            try:
                layout_root = _parse_xml(archive.read(layout_part), layout_part)
            except KeyError:
                continue
            if layout_root is None:
                continue
            layout_images = _image_relationships(archive, layout_part, media_prefix)
            layout_context = f"{context}\n幻灯片布局：{layout_part}"
            for image in layout_root.iter():
                if _local_name(image.tag) == "blip":
                    collector.add(
                        layout_images.get(_attribute(image, "embed") or ""),
                        layout_context,
                    )
            master_rels = _ppt_relationship_target(
                archive, layout_part, None, "/slideMaster",
            )
            for master_part in master_rels.values():
                try:
                    master_root = _parse_xml(archive.read(master_part), master_part)
                except KeyError:
                    continue
                if master_root is None:
                    continue
                master_images = _image_relationships(archive, master_part, media_prefix)
                master_context = f"{context}\n幻灯片母版：{master_part}"
                for image in master_root.iter():
                    if _local_name(image.tag) == "blip":
                        collector.add(
                            master_images.get(_attribute(image, "embed") or ""),
                            master_context,
                        )
    return collector


def _xlsx_drawing_parts(archive: zipfile.ZipFile, sheet_part: str) -> list[str]:
    relationships = _ppt_relationship_target(
        archive, sheet_part, "xl/drawings/", "/drawing",
    )
    return list(relationships.values())


def _xlsx_sheet_parts(
    archive: zipfile.ZipFile, workbook: Any,
) -> dict[str, Any]:
    """Resolve workbook sheet names through workbook.xml relationships."""

    workbook_part = "xl/workbook.xml"
    try:
        root = _parse_xml(archive.read(workbook_part), workbook_part)
    except KeyError:
        return {}
    if root is None:
        return {}
    relationships = _ppt_relationship_target(archive, workbook_part, None, "/worksheet")
    result: dict[str, Any] = {}
    for sheet in root.iter():
        if _local_name(sheet.tag) != "sheet":
            continue
        name = _attribute(sheet, "name")
        part = relationships.get(_relationship_id(sheet) or "")
        if name and part:
            try:
                result[part] = workbook[name]
            except KeyError:
                continue
    return result


def _xlsx_drawing_candidates(
    archive: zipfile.ZipFile, drawing_part: str,
) -> list[tuple[str, tuple[int, int] | None]]:
    try:
        root = _parse_xml(archive.read(drawing_part), drawing_part)
    except KeyError:
        return []
    if root is None:
        return []
    relationships = _image_relationships(archive, drawing_part, "xl/media/")
    candidates: list[tuple[str, tuple[int, int] | None]] = []
    for anchor in root.iter():
        if _local_name(anchor.tag) not in {"oneCellAnchor", "twoCellAnchor", "absoluteAnchor"}:
            continue
        marker = next(
            (child for child in anchor.iter() if _local_name(child.tag) == "from"), None,
        )
        position: tuple[int, int] | None = None
        if marker is not None:
            row = next((child for child in marker if _local_name(child.tag) == "row"), None)
            col = next((child for child in marker if _local_name(child.tag) == "col"), None)
            try:
                position = (int(row.text), int(col.text)) if row is not None and col is not None else None
            except (TypeError, ValueError):
                position = None
        for image in anchor.iter():
            if _local_name(image.tag) != "blip":
                continue
            media_path = relationships.get(_attribute(image, "embed") or "")
            if media_path:
                candidates.append((media_path, position))
    return candidates


def _nearby_cells(worksheet: Any, row: int, column: int) -> str:
    values: list[str] = []
    for row_index in range(max(1, row - 1), row + 2):
        for column_index in range(max(1, column - 1), column + 2):
            cell = worksheet.cell(row=row_index, column=column_index)
            if cell.value is not None and str(cell.value).strip():
                values.append(f"{cell.coordinate}={cell.value}")
    return "; ".join(values)


def _xlsx_contexts(path: Path, archive: zipfile.ZipFile, media_prefix: str) -> _ContextCollector:
    collector = _ContextCollector(_media_paths(archive, media_prefix))
    try:
        from openpyxl import load_workbook
    except ImportError:
        logger.warning("openpyxl 不可用，无法解析 XLSX 图片上下文：{}", path)
        return collector
    try:
        workbook = load_workbook(path, read_only=False, data_only=True)
    except Exception as exc:
        logger.warning("无法读取 XLSX 图片上下文 {}：{}", path, exc)
        return collector
    try:
        sheet_parts = _xlsx_sheet_parts(archive, workbook)
        for sheet_part, worksheet in sheet_parts.items():
            candidates: list[tuple[str, tuple[int, int] | None]] = []
            for drawing_part in _xlsx_drawing_parts(archive, sheet_part):
                candidates.extend(_xlsx_drawing_candidates(archive, drawing_part))
            for media_path, position in candidates:
                if position is None:
                    collector.add(media_path, f"工作表：{worksheet.title}")
                    continue
                row, column = position
                coordinate = f"{worksheet.cell(row=row + 1, column=column + 1).coordinate}"
                context = f"工作表：{worksheet.title}\n图片锚点：{coordinate}"
                nearby = _nearby_cells(worksheet, row + 1, column + 1)
                if nearby:
                    context += f"\n附近单元格：{nearby}"
                collector.add(media_path, context)
    finally:
        workbook.close()
    return collector


def office_image_contexts(path: Path) -> dict[str, str]:
    """Return ``OOXML media path -> nearby source context`` for an Office file."""

    if not isinstance(path, Path):
        path = Path(path)
    media_prefix = _MEDIA_PREFIXES.get(path.suffix.lower())
    if media_prefix is None or not path.is_file():
        return {}
    try:
        with zipfile.ZipFile(path) as archive:
            if path.suffix.lower() == ".docx":
                collector = _docx_contexts(archive, media_prefix)
            elif path.suffix.lower() == ".pptx":
                collector = _ppt_contexts(archive, media_prefix)
            else:
                collector = _xlsx_contexts(path, archive, media_prefix)
            return collector.result()
    except (OSError, zipfile.BadZipFile):
        return {}


__all__ = ["office_image_contexts"]
