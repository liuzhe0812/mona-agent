#!/usr/bin/env python3
"""Accept supported inline DOCX revisions into a new workspace file."""

from __future__ import annotations

import argparse
import copy
import shutil
import sys
import zipfile
from io import BytesIO

from helpers import MAX_ARCHIVE_BYTES, MAX_XML_BYTES, validate_archive, workspace_path
from lxml import etree

WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{WORD}}}"
WRAPPERS = {"ins", "del", "moveFrom", "moveTo"}
REMOVED = {"del", "moveFrom"}
RANGES = {"moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd"}
PROPERTIES = {
    "rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "tblPrExChange", "tcPrChange", "trPrChange",
}
INLINE_PARENTS = {"p", "hyperlink", "smartTag", "sdtContent", "customXml", *WRAPPERS}
RUN_CONTENT = {"rPr", "t", "delText", "tab", "br", "cr", "noBreakHyphen", "softHyphen", "sym"}
UNSUPPORTED = {
    "cellIns", "cellDel", "cellMerge", "numberingChange", "tblGridChange",
    "customXmlInsRangeStart", "customXmlInsRangeEnd", "customXmlDelRangeStart", "customXmlDelRangeEnd",
    "customXmlMoveFromRangeStart", "customXmlMoveFromRangeEnd", "customXmlMoveToRangeStart", "customXmlMoveToRangeEnd",
    "conflictIns", "conflictDel", "customXmlConflictInsertionRangeStart", "customXmlConflictInsertionRangeEnd",
    "customXmlConflictDeletionRangeStart", "customXmlConflictDeletionRangeEnd",
}


def _unsupported(part: str, reason: str) -> ValueError:
    return ValueError(f"Unsupported tracked change in {part}: {reason}")


def _name(element: etree._Element) -> tuple[str | None, str]:
    qname = etree.QName(element)
    return qname.namespace, qname.localname


def _inside_old_properties(element: etree._Element) -> bool:
    return any(parent.tag in {W + name for name in PROPERTIES} for parent in element.iterancestors())


def _validate_move_ranges(root: etree._Element, part: str) -> None:
    for direction in ("moveFrom", "moveTo"):
        start_tag, end_tag = W + direction + "RangeStart", W + direction + "RangeEnd"
        starts = (node for node in root.iter(start_tag) if not _inside_old_properties(node))
        paired: set[etree._Element] = set()
        for start in starts:
            parent = start.getparent()
            identifier = start.get(W + "id")
            if parent is None or parent.tag != W + "p" or not identifier:
                raise _unsupported(part, f"{direction} range spans document structure")
            siblings = list(parent)
            index = siblings.index(start)
            end = next((node for node in siblings[index + 1:] if node.tag == end_tag and node.get(W + "id") == identifier), None)
            if end is None or end in paired:
                raise _unsupported(part, f"{direction} range is not paired within one paragraph")
            enclosed = siblings[index + 1:siblings.index(end)]
            if not enclosed or any(node.tag != W + direction for node in enclosed):
                raise _unsupported(part, f"{direction} range contains unsupported unwrapped content")
            paired.add(end)
        if any(end not in paired for end in root.iter(end_tag) if not _inside_old_properties(end)):
            raise _unsupported(part, f"{direction} range is missing its start")


def _validate_revisions(root: etree._Element, part: str) -> bool:
    changed = False
    for node in root.iter():
        if not isinstance(node.tag, str) or _inside_old_properties(node):
            continue
        namespace, name = _name(node)
        if name in UNSUPPORTED and namespace and (namespace == WORD or "word" in namespace.lower()):
            raise _unsupported(part, name)
        if namespace != WORD:
            if namespace and "wordprocessingml" in namespace.lower() and (name in WRAPPERS | RANGES | PROPERTIES):
                raise _unsupported(part, "revision namespace is not supported")
            continue
        if name in PROPERTIES or name in RANGES:
            changed = True
            continue
        if name.endswith("Change"):
            raise _unsupported(part, name)
        if name in {"delText", "delInstrText"} and not any(
            ancestor.tag in {W + "del", W + "moveFrom"} for ancestor in node.iterancestors()
        ):
            raise _unsupported(part, f"{name} outside deleted content")
        if name not in WRAPPERS:
            continue
        changed = True
        parent = node.getparent()
        if (parent is None or parent.tag not in {W + value for value in INLINE_PARENTS}
                or not any(ancestor.tag == W + "p" for ancestor in node.iterancestors())):
            raise _unsupported(part, f"{name} is not an inline paragraph revision")
        for child in node:
            if child.tag in {W + value for value in WRAPPERS}:
                continue
            if child.tag != W + "r":
                raise _unsupported(part, f"{name} contains non-text structure")
            if any(item.tag not in {W + value for value in RUN_CONTENT} for item in child):
                raise _unsupported(part, f"{name} contains a field, object, or other unsupported run")
    if changed:
        _validate_move_ranges(root, part)
    return changed


def _remove(node: etree._Element, *, keep_children: bool = False) -> None:
    parent = node.getparent()
    if parent is None:
        return
    index = parent.index(node)
    tail = node.tail or ""
    children = list(node) if keep_children else []
    parent.remove(node)
    for child in children:
        node.remove(child)
        parent.insert(index, child)
        index += 1
    if tail:
        if index:
            previous = parent[index - 1]
            previous.tail = (previous.tail or "") + tail
        else:
            parent.text = (parent.text or "") + tail


def _accept_xml(data: bytes, part: str) -> tuple[bytes, bool]:
    if len(data) > MAX_XML_BYTES:
        raise ValueError(f"DOCX XML part exceeds size limit: {part}")
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, strip_cdata=False)
    document = etree.parse(BytesIO(data), parser)
    if document.docinfo.doctype:
        raise ValueError(f"DOCTYPE is not allowed in DOCX XML: {part}")
    root = document.getroot()
    if not part.startswith("word/") or not _validate_revisions(root, part):
        return data, False
    for node in reversed(list(root.iter())):
        if not isinstance(node.tag, str):
            continue
        namespace, name = _name(node)
        if namespace == WORD and name in WRAPPERS | RANGES | PROPERTIES:
            _remove(node, keep_children=name in WRAPPERS - REMOVED)
    return etree.tostring(document, encoding="UTF-8", xml_declaration=True), True


def accept_changes(input_file: str, output_file: str) -> str:
    input_path = workspace_path(input_file)
    output_path = workspace_path(output_file)
    if not input_path.is_file() or input_path.suffix.lower() != ".docx":
        raise ValueError("Input must be an existing DOCX file in the workspace")
    if output_path.suffix.lower() != ".docx" or output_path == input_path:
        raise ValueError("Output must be a different DOCX file in the workspace")
    if output_path.exists():
        raise ValueError("Output file already exists")
    if input_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("DOCX archive exceeds size limit")

    with zipfile.ZipFile(input_path) as archive:
        validate_archive(archive)
        names = set(archive.namelist())
        if not {"[Content_Types].xml", "word/document.xml"} <= names:
            raise ValueError("DOCX is missing required document parts")
        updated: dict[str, bytes] = {}
        for info in archive.infolist():
            if info.filename.endswith((".xml", ".rels")) and not info.is_dir():
                if info.file_size > MAX_XML_BYTES:
                    raise ValueError(f"DOCX XML part exceeds size limit: {info.filename}")
                data, changed = _accept_xml(archive.read(info), info.filename)
                if changed:
                    updated[info.filename] = data
        if archive.testzip() is not None:
            raise ValueError("DOCX archive is corrupt")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        created = False
        try:
            with output_path.open("xb") as stream:
                created = True
                with zipfile.ZipFile(stream, "w") as result:
                    for info in archive.infolist():
                        target_info = copy.copy(info)
                        if info.filename in updated:
                            result.writestr(target_info, updated[info.filename])
                        elif info.is_dir():
                            result.writestr(target_info, b"")
                        else:
                            with archive.open(info) as source, result.open(target_info, "w") as target:
                                shutil.copyfileobj(source, target, length=1024 * 1024)
        except Exception:
            if created:
                output_path.unlink(missing_ok=True)
            raise
    return f"Accepted supported inline revisions in {len(updated)} document part(s): {output_path}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_file", help="Input DOCX file in the active workspace")
    parser.add_argument("output_file", help="New output DOCX file in the active workspace")
    args = parser.parse_args()
    try:
        print(accept_changes(args.input_file, args.output_file))
    except (OSError, ValueError, zipfile.BadZipFile, etree.XMLSyntaxError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
