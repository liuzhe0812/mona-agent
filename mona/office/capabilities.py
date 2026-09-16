"""Structured capability descriptions for the Python-owned Office editors."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

DOCS_CAPABILITIES: list[dict[str, Any]] = [
    {
        "op": "replace_block_text",
        "description": "Replace the text of an existing paragraph, heading, list item, or table block.",
        "elementTypes": ["paragraph", "heading", "list_item", "table"],
        "payload": {"blockId": "string", "text": "string"},
    },
    {
        "op": "delete_block",
        "description": "Delete an existing document block by stable block ID.",
        "elementTypes": ["paragraph", "heading", "list_item", "table", "image"],
        "payload": {"blockId": "string"},
    },
    {
        "op": "insert_paragraph",
        "description": "Insert a paragraph after a block; null appends it to the document.",
        "elementTypes": ["paragraph"],
        "payload": {"afterBlockId": "string|null", "text": "string"},
    },
    {
        "op": "insert_title",
        "description": "Insert the document title with the professional default Title style.",
        "elementTypes": ["paragraph"],
        "payload": {"afterBlockId": "string|null", "text": "string"},
    },
    {
        "op": "insert_heading",
        "description": "Insert a level 1-6 heading after a block.",
        "elementTypes": ["heading"],
        "payload": {"afterBlockId": "string|null", "text": "string", "level": "integer 1-6"},
    },
    {
        "op": "insert_list",
        "description": "Insert a bullet or numbered list after a block.",
        "elementTypes": ["list_item"],
        "payload": {"afterBlockId": "string|null", "kind": "bullet|number", "items": "string[]"},
    },
    {
        "op": "insert_table",
        "description": "Insert a table from a non-empty two-dimensional string array.",
        "elementTypes": ["table"],
        "payload": {"afterBlockId": "string|null", "rows": "string[][]"},
    },
    {
        "op": "set_table_cell",
        "description": "Set one table cell using zero-based rowIndex and columnIndex.",
        "elementTypes": ["table"],
        "payload": {
            "blockId": "string",
            "rowIndex": "integer",
            "columnIndex": "integer",
            "text": "string",
        },
    },
    {
        "op": "insert_image",
        "description": "Insert an image block after a block from an editor-supported data URL.",
        "elementTypes": ["image"],
        "payload": {"afterBlockId": "string|null", "dataUrl": "image data URL"},
    },
    {
        "op": "set_block_style",
        "description": "Set block style fields: bold, italic, underline, strike, color, highlight, font, fontSize, headingLevel, align, lineSpacing, indentLeft, indentRight, indentFirstLine, spaceBefore, spaceAfter, pageBreakBefore, shadingFill, and borders.",
        "elementTypes": ["paragraph", "heading", "list_item", "table", "image"],
        "payload": {"blockId": "string", "style": "object"},
    },
    {
        "op": "set_table_style",
        "description": "Set table column widths, header/body fills, border color, header rows, text alignment, row splitting, and cell padding.",
        "elementTypes": ["table"],
        "payload": {
            "blockId": "string",
            "columnWidths": "number[]",
            "headerRows": "integer",
            "headerFill": "string|null",
            "bodyFill": "string|null",
            "borderColor": "string|null",
            "cellPadding": "number",
            "headerBold": "boolean",
            "headerAlign": "left|center|right",
            "verticalAlign": "top|center|bottom",
            "allowRowBreakAcrossPages": "boolean",
        },
    },
    {
        "op": "set_page_style",
        "description": "Set section page size and margins in millimetres.",
        "elementTypes": ["document"],
        "payload": {
            "sectionIndex": "integer",
            "widthMm": "number",
            "heightMm": "number",
            "marginTopMm": "number",
            "marginBottomMm": "number",
            "marginLeftMm": "number",
            "marginRightMm": "number",
        },
    },
    {
        "op": "set_header_footer",
        "description": "Set kind header|footer, optional view default|first|even, text, and optional pageNumber; omitted pageNumber preserves its current state.",
        "elementTypes": ["document"],
        "payload": {
            "kind": "header|footer",
            "view": "default|first|even",
            "text": "string",
            "pageNumber": "boolean",
        },
    },
]

SHEETS_CAPABILITIES: list[dict[str, Any]] = [
    {
        "op": "set_cell",
        "description": "Set one cell value.",
        "elementTypes": ["cell"],
        "payload": {"sheet": "string", "cell": "string", "value": "cell value"},
    },
    {
        "op": "set_range",
        "description": "Set a rectangular range from a non-empty two-dimensional value array.",
        "elementTypes": ["range"],
        "payload": {"sheet": "string", "range": "string", "values": "cell value[][]"},
    },
    {
        "op": "set_formula",
        "description": "Set one cell formula; read the range afterward to verify the result.",
        "elementTypes": ["cell"],
        "payload": {"sheet": "string", "cell": "string", "formula": "string"},
    },
    {
        "op": "clear_range",
        "description": "Clear values and formulas in a rectangular range.",
        "elementTypes": ["range"],
        "payload": {"sheet": "string", "range": "string"},
    },
    {
        "op": "set_style",
        "description": "Set cell style fields: fontFamily, fontSize, bold, italic, underline, strikethrough, color, backgroundColor, numberFormat, horizontalAlign, verticalAlign, wrapText, and borderTop/borderBottom/borderLeft/borderRight {style,color}.",
        "elementTypes": ["cell", "range"],
        "payload": {"sheet": "string", "range": "string", "style": "object"},
    },
    {
        "op": "insert_rows",
        "description": "Insert rows at a one-based index.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "index": "integer", "count": "integer"},
    },
    {
        "op": "delete_rows",
        "description": "Delete rows at a one-based index.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "index": "integer", "count": "integer"},
    },
    {
        "op": "insert_columns",
        "description": "Insert columns at a one-based index.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "index": "integer", "count": "integer"},
    },
    {
        "op": "delete_columns",
        "description": "Delete columns at a one-based index.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "index": "integer", "count": "integer"},
    },
    {
        "op": "merge_cells",
        "description": "Merge a rectangular cell range.",
        "elementTypes": ["range"],
        "payload": {"sheet": "string", "range": "string"},
    },
    {
        "op": "unmerge_cells",
        "description": "Unmerge a rectangular cell range.",
        "elementTypes": ["range"],
        "payload": {"sheet": "string", "range": "string"},
    },
    {
        "op": "add_sheet",
        "description": "Add a worksheet by name.",
        "elementTypes": ["sheet"],
        "payload": {"name": "string"},
    },
    {
        "op": "delete_sheet",
        "description": "Delete a worksheet by name.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string"},
    },
    {
        "op": "rename_sheet",
        "description": "Rename a worksheet.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "newName": "string"},
    },
    {
        "op": "move_sheet",
        "description": "Move a worksheet to a zero-based position.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "position": "integer"},
    },
    {
        "op": "set_column_width",
        "description": "Set column width in character units with payload {sheet,index,count,size}; index is 1-based.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "index": "integer", "count": "integer", "size": "number"},
    },
    {
        "op": "set_row_height",
        "description": "Set row height in points with payload {sheet,index,count,size}; index is 1-based.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "index": "integer", "count": "integer", "size": "number"},
    },
    {
        "op": "set_auto_filter",
        "description": "Set or clear a worksheet auto-filter range.",
        "elementTypes": ["sheet", "range"],
        "payload": {"sheet": "string", "range": "string|null"},
    },
    {
        "op": "set_freeze_panes",
        "description": "Set frozen row and column counts.",
        "elementTypes": ["sheet"],
        "payload": {"sheet": "string", "rows": "integer", "columns": "integer"},
    },
    {
        "op": "set_conditional_format",
        "description": "Set a supported number, text, blank, duplicate, top10, formula, or colorScale rule on a range.",
        "elementTypes": ["range"],
        "payload": {"sheet": "string", "range": "string", "rule": "object"},
    },
]

DOCS_OPERATIONS = DOCS_CAPABILITIES
SHEETS_OPERATIONS = SHEETS_CAPABILITIES


def _field_schema(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return deepcopy(value)
    description = str(value)
    if description == "string":
        return {"type": "string"}
    if description == "string|null":
        return {"type": ["string", "null"]}
    if description == "boolean":
        return {"type": "boolean"}
    if description == "integer":
        return {"type": "integer"}
    if description == "integer 1-6":
        return {"type": "integer", "minimum": 1, "maximum": 6}
    if description == "number":
        return {"type": "number"}
    if description == "number[]":
        return {"type": "array", "items": {"type": "number"}}
    if description == "string[]":
        return {"type": "array", "items": {"type": "string"}}
    if description == "string[][]":
        return {
            "type": "array",
            "items": {"type": "array", "items": {"type": "string"}},
        }
    if description == "cell value":
        return {"type": ["string", "number", "boolean", "null"]}
    if description == "cell value[][]":
        return {
            "type": "array",
            "items": {
                "type": "array",
                "items": {"type": ["string", "number", "boolean", "null"]},
            },
        }
    if description == "object":
        return {"type": "object"}
    return {"type": "string", "description": description}


def _payload_schema(payload: dict[str, object]) -> dict[str, object]:
    return {
        "type": "object",
        "properties": {
            name: _field_schema(value) for name, value in payload.items()
        },
    }


def get_capabilities(
    document_type: str,
    element_type: str | None = None,
    operations: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return Python-owned capabilities, optionally filtered by element and operation."""

    if document_type == "docs":
        capabilities = DOCS_CAPABILITIES
    elif document_type == "sheets":
        capabilities = SHEETS_CAPABILITIES
    else:
        return []

    if operations:
        known_operations = {str(capability["op"]) for capability in capabilities}
        unknown_operations = [operation for operation in operations if operation not in known_operations]
        if unknown_operations:
            names = ", ".join(repr(operation) for operation in unknown_operations)
            raise ValueError(f"unknown operation(s) for {document_type}: {names}")
        capabilities = [
            capability for capability in capabilities if capability["op"] in operations
        ]

    if element_type is not None:
        wanted = element_type.strip().lower()
        capabilities = [
            capability
            for capability in capabilities
            if wanted
            in {str(item).lower() for item in capability.get("elementTypes", [])}
        ]
    return [
        {
            "op": capability["op"],
            "payloadSchema": _payload_schema(capability["payload"]),
            "description": capability["description"],
        }
        for capability in capabilities
    ]


__all__ = (
    "DOCS_CAPABILITIES",
    "DOCS_OPERATIONS",
    "SHEETS_CAPABILITIES",
    "SHEETS_OPERATIONS",
    "get_capabilities",
)
