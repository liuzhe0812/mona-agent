"""Wire contracts for the Mona Office editor integration."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from mona.office.errors import OfficeErrorCode

OfficeDocumentType: TypeAlias = Literal["docs", "sheets", "slides"]
OfficeSaveState: TypeAlias = Literal["clean", "dirty", "saving", "error"]
CellValue: TypeAlias = str | int | float | bool | None
OFFICE_OWNER_HEADER = "X-Mona-Session-Key"


class OfficeWireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class DocumentVersion(OfficeWireModel):
    editor_epoch: str = Field(min_length=1)
    model_revision: int = Field(ge=0)


class OfficeErrorPayload(OfficeWireModel):
    code: OfficeErrorCode
    message: str = Field(min_length=1)
    retryable: bool = False


class OfficeSessionState(OfficeWireModel):
    session_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    type: OfficeDocumentType
    version: DocumentVersion
    checkpoint_version: DocumentVersion | None = None
    saved_version: DocumentVersion | None = None
    dirty: bool = False
    editor_connected: bool = False
    save_state: OfficeSaveState = "clean"
    last_error: OfficeErrorPayload | None = None
    pending_visual_slide_ids: list[str] = Field(default_factory=list)


class OfficeSessionCreateRequest(OfficeWireModel):
    owner_session_key: str = Field(min_length=1)
    type: OfficeDocumentType | None = None
    path: str | None = None
    display_name: str | None = None


class OfficeSocketTicketRequest(OfficeWireModel):
    renew_editor: bool = False


class OfficeSocketTicketResponse(OfficeWireModel):
    ticket: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    editor_epoch: str = Field(min_length=1)
    expires_in_seconds: int = Field(gt=0)


class OfficeSaveRequest(OfficeWireModel):
    overwrite_source: bool = False
    version: DocumentVersion | None = None


class OfficeExportRequest(OfficeWireModel):
    output: str = Field(min_length=1)
    version: DocumentVersion | None = None


class SheetCellArea(OfficeWireModel):
    start_row: int = Field(ge=0, le=1_048_575)
    end_row: int = Field(ge=0, le=1_048_575)
    start_column: int = Field(ge=0, le=16_383)
    end_column: int = Field(ge=0, le=16_383)

    @model_validator(mode="after")
    def validate_area(self) -> SheetCellArea:
        if self.start_row > self.end_row or self.start_column > self.end_column:
            raise ValueError("range boundaries are reversed")
        if (self.end_row - self.start_row + 1) * (
            self.end_column - self.start_column + 1
        ) > 20_000:
            raise ValueError("range exceeds 20000 cells")
        return self


class OfficeEngineRangeRequest(OfficeWireModel):
    sheet_id: str = Field(min_length=1)
    range: SheetCellArea


class SheetSummaryQuery(OfficeWireModel):
    mode: Literal["summary"]


class SheetRangeQuery(OfficeWireModel):
    mode: Literal["range"]
    sheet: str = Field(min_length=1)
    range: str = Field(min_length=1)
    include_formula: bool = True
    include_style: bool = False


class ChangedSinceQuery(OfficeWireModel):
    mode: Literal["changed_since"]
    version: DocumentVersion


class OutlineQuery(OfficeWireModel):
    mode: Literal["outline"]
    limit: int = Field(default=100, ge=1, le=200)


class SearchQuery(OfficeWireModel):
    mode: Literal["search"]
    text: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=20, ge=1, le=100)


class BlocksQuery(OfficeWireModel):
    mode: Literal["blocks"]
    block_ids: list[str] = Field(min_length=1, max_length=50)


class SlidesQuery(OfficeWireModel):
    mode: Literal["slides"]
    slide_ids: list[str] = Field(default_factory=list, max_length=50)
    element_ids: list[str] = Field(default_factory=list, max_length=50)
    include_data: bool = True
    limit: int = Field(default=20, ge=1, le=100)


class CapabilitiesQuery(OfficeWireModel):
    mode: Literal["capabilities"]
    document_type: OfficeDocumentType | None = None
    element_type: str | None = Field(default=None, min_length=1)
    operations: list[str] = Field(default_factory=list, max_length=20)


class VisualRegion(OfficeWireModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class VisualQuery(OfficeWireModel):
    mode: Literal["visual"]
    page_index: int | None = Field(default=None, ge=0)
    slide_id: str | None = None
    element_ids: list[str] = Field(default_factory=list, max_length=50)
    region: VisualRegion | None = None
    padding: float = Field(default=16, ge=0, le=100)


class ReviewQuery(OfficeWireModel):
    mode: Literal["review"]


class SelectionQuery(OfficeWireModel):
    mode: Literal["selection"]


OfficeInspectQuery: TypeAlias = Annotated[
    SheetSummaryQuery
    | SheetRangeQuery
    | ChangedSinceQuery
    | OutlineQuery
    | SearchQuery
    | BlocksQuery
    | SlidesQuery
    | CapabilitiesQuery
    | VisualQuery
    | ReviewQuery
    | SelectionQuery,
    Field(discriminator="mode"),
]


class OfficeInspectRequest(OfficeWireModel):
    session_id: str = Field(min_length=1)
    query: OfficeInspectQuery


class OfficeInspectCommand(OfficeInspectRequest):
    request_id: str = Field(min_length=1)


class SheetFreeze(OfficeWireModel):
    frozen_rows: int = Field(default=0, ge=0, le=100)
    frozen_columns: int = Field(default=0, ge=0, le=100)


class SheetInfo(OfficeWireModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    row_count: int = Field(ge=0)
    column_count: int = Field(ge=0)
    auto_filter: SheetCellArea | None = None
    conditional_format_count: int = Field(default=0, ge=0)
    freeze: SheetFreeze = Field(default_factory=SheetFreeze)


class SheetBorder(OfficeWireModel):
    style: Literal[
        "thin", "medium", "thick", "double", "hair", "dashed", "dotted",
        "dashDot", "dashDotDot", "mediumDashed", "mediumDashDot", "mediumDashDotDot", "slantDashDot",
    ] = "thin"
    color: str | None = None


class SheetStyle(OfficeWireModel):
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = None
    background_color: str | None = None
    number_format: str | None = None
    horizontal_align: Literal["left", "center", "right"] | None = None
    font_family: str | None = Field(default=None, max_length=200)
    font_size: float | None = Field(default=None, gt=0, le=409)
    underline: bool | None = None
    strikethrough: bool | None = None
    vertical_align: Literal["top", "center", "bottom"] | None = None
    wrap_text: bool | None = None
    border_top: SheetBorder | None = None
    border_bottom: SheetBorder | None = None
    border_left: SheetBorder | None = None
    border_right: SheetBorder | None = None


class SheetCell(OfficeWireModel):
    value: CellValue = None
    formula: str | None = None
    style: SheetStyle | None = None


class OfficeSummaryResult(OfficeWireModel):
    mode: Literal["summary"]
    document_type: OfficeDocumentType
    sheet_count: int | None = Field(default=None, ge=0)
    sheets: list[SheetInfo] = Field(default_factory=list)
    block_count: int | None = Field(default=None, ge=0)
    character_count: int | None = Field(default=None, ge=0)
    heading_count: int | None = Field(default=None, ge=0)
    table_count: int | None = Field(default=None, ge=0)
    image_count: int | None = Field(default=None, ge=0)
    slide_count: int | None = Field(default=None, ge=0)
    element_count: int | None = Field(default=None, ge=0)
    page_settings: list[dict[str, object]] = Field(default_factory=list)
    header_footer: dict[str, object] | None = None
    slide_width_emu: int | None = Field(default=None, gt=0)
    slide_height_emu: int | None = Field(default=None, gt=0)


class SheetRangeResult(OfficeWireModel):
    mode: Literal["range"]
    sheet: str = Field(min_length=1)
    range: str = Field(min_length=1)
    rows: list[list[SheetCell]]
    column_widths: list[float] = Field(default_factory=list)
    row_heights: list[float] = Field(default_factory=list)
    auto_filter: SheetCellArea | None = None
    conditional_format_count: int = Field(default=0, ge=0)
    freeze: SheetFreeze = Field(default_factory=SheetFreeze)


class RevisionChange(OfficeWireModel):
    revision: int = Field(ge=1)
    actor: Literal["user", "agent"]
    target: str = Field(min_length=1)
    kind: Literal["cell", "block", "slide", "document"]


class ChangedSinceResult(OfficeWireModel):
    mode: Literal["changed_since"]
    changes: list[RevisionChange]


class DocBlock(OfficeWireModel):
    id: str = Field(min_length=1)
    type: Literal["paragraph", "heading", "list_item", "table", "image"]
    text: str = ""
    level: int | None = Field(default=None, ge=1, le=6)
    rows: list[list[str]] | None = None
    style: dict[str, object] = Field(default_factory=dict)


class DocBlocksResult(OfficeWireModel):
    mode: Literal["blocks"]
    blocks: list[DocBlock]


class SlideElementInfo(OfficeWireModel):
    id: str = Field(min_length=1)
    slide_id: str | None = None
    type: str = Field(min_length=1)
    text: str = ""
    x: float
    y: float
    width: float = Field(ge=0)
    height: float = Field(ge=0)
    table_rows: list[list[str]] | None = None
    chart: dict[str, object] | None = None
    link: dict[str, object] | None = None
    style: dict[str, object] = Field(default_factory=dict)


class SlideInfo(OfficeWireModel):
    id: str = Field(min_length=1)
    index: int = Field(ge=0)
    title: str = ""
    width: float = Field(default=0, ge=0)
    height: float = Field(default=0, ge=0)
    elements: list[SlideElementInfo] = Field(default_factory=list)
    notes: str = ""
    transition: str = "none"
    animations: int = Field(default=0, ge=0)
    comments: int = Field(default=0, ge=0)


class OutlineResult(OfficeWireModel):
    mode: Literal["outline"]
    items: list[DocBlock | SlideInfo]


class SearchResult(OfficeWireModel):
    mode: Literal["search"]
    matches: list[DocBlock | SlideElementInfo]


class SlidesResult(OfficeWireModel):
    mode: Literal["slides"]
    slides: list[SlideInfo]


class CapabilitiesResult(OfficeWireModel):
    mode: Literal["capabilities"]
    document_type: OfficeDocumentType
    operations: list[dict[str, object]]


class SelectionResult(OfficeWireModel):
    mode: Literal["selection"]
    document_type: OfficeDocumentType
    block_ids: list[str] = Field(default_factory=list)
    text: str = ""
    sheet: str | None = None
    range: str | None = None
    slide_id: str | None = None
    element_ids: list[str] = Field(default_factory=list)
    elements: list[SlideElementInfo] = Field(default_factory=list)
    slide_width: float | None = Field(default=None, ge=0)
    slide_height: float | None = Field(default=None, ge=0)


class VisualResult(OfficeWireModel):
    mode: Literal["visual"]
    data_url: str = Field(max_length=16_000_000, pattern=r"^data:image/png;base64,[A-Za-z0-9+/=]+$")
    width: int = Field(gt=0, le=4096)
    height: int = Field(gt=0, le=8192)
    target: str
    warnings: list[str] = Field(default_factory=list)
    pending_visual_slide_ids: list[str] | None = None


class ReviewResult(OfficeWireModel):
    mode: Literal["review"]
    document_type: Literal["slides"]
    pending_slide_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


OfficeInspectPayload: TypeAlias = Annotated[
    OfficeSummaryResult
    | SheetRangeResult
    | ChangedSinceResult
    | OutlineResult
    | SearchResult
    | DocBlocksResult
    | SlidesResult
    | CapabilitiesResult
    | SelectionResult
    | VisualResult
    | ReviewResult,
    Field(discriminator="mode"),
]


class OfficeInspectResult(OfficeWireModel):
    session_id: str = Field(min_length=1)
    version: DocumentVersion
    result: OfficeInspectPayload


class OfficeInspectSuccess(OfficeInspectResult):
    ok: Literal[True]
    request_id: str = Field(min_length=1)


class OfficeInspectFailure(OfficeWireModel):
    ok: Literal[False]
    request_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    current_version: DocumentVersion
    error: OfficeErrorPayload


OfficeInspectResponse: TypeAlias = Annotated[
    OfficeInspectSuccess | OfficeInspectFailure,
    Field(discriminator="ok"),
]


class SetCellPayload(OfficeWireModel):
    sheet: str = Field(min_length=1)
    cell: str = Field(min_length=1)
    value: CellValue


class SetRangePayload(OfficeWireModel):
    sheet: str = Field(min_length=1)
    range: str = Field(min_length=1)
    values: list[list[CellValue]] = Field(min_length=1)


class SetFormulaPayload(OfficeWireModel):
    sheet: str = Field(min_length=1)
    cell: str = Field(min_length=1)
    formula: str = Field(min_length=1)


class ClearRangePayload(OfficeWireModel):
    sheet: str = Field(min_length=1)
    range: str = Field(min_length=1)


class SetStylePayload(OfficeWireModel):
    sheet: str = Field(min_length=1)
    range: str = Field(min_length=1)
    style: SheetStyle


class SetCellOperation(OfficeWireModel):
    op: Literal["set_cell"]
    payload: SetCellPayload


class SetRangeOperation(OfficeWireModel):
    op: Literal["set_range"]
    payload: SetRangePayload


class SetFormulaOperation(OfficeWireModel):
    op: Literal["set_formula"]
    payload: SetFormulaPayload


class ClearRangeOperation(OfficeWireModel):
    op: Literal["clear_range"]
    payload: ClearRangePayload


class SetStyleOperation(OfficeWireModel):
    op: Literal["set_style"]
    payload: SetStylePayload


class SheetStructureOperation(OfficeWireModel):
    op: Literal[
        "insert_rows",
        "delete_rows",
        "insert_columns",
        "delete_columns",
        "merge_cells",
        "unmerge_cells",
        "add_sheet",
        "delete_sheet",
        "rename_sheet",
        "move_sheet",
        "set_column_width",
        "set_row_height",
        "set_auto_filter",
        "set_freeze_panes",
        "set_conditional_format",
    ]
    payload: dict[str, object]


class DocsOperation(OfficeWireModel):
    op: Literal[
        "replace_block_text",
        "delete_block",
        "insert_paragraph",
        "insert_heading",
        "insert_list",
        "insert_table",
        "set_table_cell",
        "insert_image",
        "set_block_style",
        "set_table_style",
        "set_page_style",
        "set_header_footer",
    ]
    payload: dict[str, object]


class SlidesOperation(OfficeWireModel):
    op: Literal[
        "slide_set_text",
        "slide_set_font",
        "slide_set_chart_style",
        "slide_set_geometry",
        "slide_set_fill",
        "slide_set_stroke",
        "slide_add_text",
        "slide_add_shape",
        "slide_add_image",
        "slide_add_svg",
        "slide_compose",
        "slide_delete_element",
        "slide_add",
        "slide_duplicate",
        "slide_delete",
        "slide_move",
        "slide_apply_txn",
    ]
    payload: dict[str, object]


OfficeOperation: TypeAlias = Annotated[
    SetCellOperation
    | SetRangeOperation
    | SetFormulaOperation
    | ClearRangeOperation
    | SetStyleOperation
    | SheetStructureOperation
    | DocsOperation
    | SlidesOperation,
    Field(discriminator="op"),
]


class OfficeApplyCommand(OfficeWireModel):
    session_id: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)
    expected_version: DocumentVersion
    operations: list[OfficeOperation] = Field(min_length=1, max_length=50)


class OfficeCommandSuccess(OfficeWireModel):
    ok: Literal[True]
    session_id: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)
    version: DocumentVersion
    changed_targets: list[str]
    summary: str = ""
    unchanged: bool = False
    created_elements: list[SlideElementInfo] | None = None
    created_slides: list[SlideInfo] | None = None
    updated_elements: list[SlideElementInfo] | None = None
    warnings: list[str] | None = None
    pending_visual_slide_ids: list[str] | None = None


class OfficeCommandFailure(OfficeWireModel):
    ok: Literal[False]
    session_id: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)
    current_version: DocumentVersion
    changed_targets: list[str]
    error: OfficeErrorPayload


OfficeCommandResult: TypeAlias = Annotated[
    OfficeCommandSuccess | OfficeCommandFailure,
    Field(discriminator="ok"),
]


class OfficeCheckpointMetadata(OfficeWireModel):
    session_id: str = Field(min_length=1)
    version: DocumentVersion
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class OfficeCheckpointStartRequest(OfficeWireModel):
    version: DocumentVersion
    size: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class OfficeCheckpointReceipt(OfficeCheckpointMetadata):
    working_file_name: str = Field(min_length=1)


class OfficeSessionOpenMessage(OfficeWireModel):
    event: Literal["office_session_open"]
    session: OfficeSessionState


class OfficeSessionStateMessage(OfficeWireModel):
    event: Literal["office_session_state"]
    session: OfficeSessionState


class OfficeCommandMessage(OfficeWireModel):
    event: Literal["office_command"]
    command: OfficeApplyCommand


class OfficeInspectCommandMessage(OfficeWireModel):
    event: Literal["office_inspect_command"]
    command: OfficeInspectCommand


class OfficeCheckpointRequestMessage(OfficeWireModel):
    event: Literal["office_checkpoint_request"]
    session_id: str = Field(min_length=1)
    version: DocumentVersion


class OfficeEditorReadyMessage(OfficeWireModel):
    event: Literal["office_editor_ready"]
    session_id: str = Field(min_length=1)
    version: DocumentVersion


class OfficeUserChangeMessage(OfficeWireModel):
    event: Literal["office_user_change"]
    session_id: str = Field(min_length=1)
    version: DocumentVersion
    changed_targets: list[str]
    pending_visual_slide_ids: list[str] | None = None


class OfficeCommandResultMessage(OfficeWireModel):
    event: Literal["office_command_result"]
    result: OfficeCommandResult


class OfficeInspectResultMessage(OfficeWireModel):
    event: Literal["office_inspect_result"]
    result: OfficeInspectResponse


class OfficeSessionClosedMessage(OfficeWireModel):
    event: Literal["office_session_closed"]
    session_id: str = Field(min_length=1)


OfficeSocketMessage: TypeAlias = Annotated[
    OfficeSessionOpenMessage
    | OfficeSessionStateMessage
    | OfficeCommandMessage
    | OfficeInspectCommandMessage
    | OfficeCheckpointRequestMessage
    | OfficeEditorReadyMessage
    | OfficeUserChangeMessage
    | OfficeCommandResultMessage
    | OfficeInspectResultMessage
    | OfficeSessionClosedMessage,
    Field(discriminator="event"),
]
