export const OFFICE_ERROR_CODES = [
  "SESSION_NOT_FOUND",
  "EDITOR_UNAVAILABLE",
  "VERSION_CONFLICT",
  "RESYNC_REQUIRED",
  "INVALID_OPERATION",
  "CHECKPOINT_FAILED",
  "SAVE_CONFLICT",
  "REVIEW_REQUIRED",
] as const;

export type OfficeErrorCode = (typeof OFFICE_ERROR_CODES)[number];
export type OfficeDocumentType = "docs" | "sheets" | "slides";
export type OfficeSaveState = "clean" | "dirty" | "saving" | "error";
export type CellValue = string | number | boolean | null;

export interface DocumentVersion {
  editorEpoch: string;
  modelRevision: number;
}

export interface OfficeErrorPayload {
  code: OfficeErrorCode;
  message: string;
  retryable: boolean;
}

export interface OfficeSessionState {
  sessionId: string;
  displayName: string;
  type: OfficeDocumentType;
  version: DocumentVersion;
  checkpointVersion: DocumentVersion | null;
  savedVersion: DocumentVersion | null;
  dirty: boolean;
  editorConnected: boolean;
  saveState: OfficeSaveState;
  lastError: OfficeErrorPayload | null;
  pendingVisualSlideIds?: string[];
}

export interface OfficeSessionCreateRequest {
  ownerSessionKey: string;
  type?: OfficeDocumentType | null;
  path?: string | null;
  displayName?: string | null;
}

export interface OfficeSocketTicketRequest {
  renewEditor: boolean;
}

export interface OfficeSocketTicketResponse {
  ticket: string;
  sessionId: string;
  editorEpoch: string;
  expiresInSeconds: number;
}

export interface OfficeSaveRequest {
  overwriteSource: boolean;
  version?: DocumentVersion | null;
}

export interface OfficeExportRequest {
  output: string;
  version?: DocumentVersion | null;
}

export interface SheetCellArea {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface OfficeEngineRangeRequest {
  sheetId: string;
  range: SheetCellArea;
}

export type OfficeInspectQuery =
  | { mode: "summary" }
  | { mode: "selection" }
  | { mode: "review" }
  | { mode: "visual"; pageIndex?: number; slideId?: string; elementIds?: string[]; region?: { x: number; y: number; width: number; height: number }; padding?: number }
  | { mode: "capabilities"; documentType?: OfficeDocumentType; elementType?: string; operations?: string[] }
  | { mode: "changed_since"; version: DocumentVersion }
  | { mode: "outline"; limit?: number }
  | { mode: "search"; text: string; limit?: number }
  | { mode: "blocks"; blockIds: string[] }
  | { mode: "slides"; slideIds?: string[]; elementIds?: string[]; includeData?: boolean; limit?: number }
  | {
      mode: "range";
      sheet: string;
      range: string;
      includeFormula: boolean;
      includeStyle: boolean;
    };

export interface OfficeInspectRequest {
  sessionId: string;
  query: OfficeInspectQuery;
}

export interface OfficeInspectCommand extends OfficeInspectRequest {
  requestId: string;
}

export interface SheetInfo {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  autoFilter?: SheetCellArea | null;
  conditionalFormatCount?: number;
  freeze?: { frozenRows: number; frozenColumns: number };
}

export interface SheetStyle {
  bold?: boolean | null;
  italic?: boolean | null;
  color?: string | null;
  backgroundColor?: string | null;
  numberFormat?: string | null;
  horizontalAlign?: "left" | "center" | "right" | null;
  fontFamily?: string | null;
  fontSize?: number | null;
  underline?: boolean | null;
  strikethrough?: boolean | null;
  verticalAlign?: "top" | "center" | "bottom" | null;
  wrapText?: boolean | null;
  borderTop?: { style: string; color?: string | null } | null;
  borderBottom?: { style: string; color?: string | null } | null;
  borderLeft?: { style: string; color?: string | null } | null;
  borderRight?: { style: string; color?: string | null } | null;
}

export interface SheetCell {
  value: CellValue;
  formula?: string | null;
  style?: SheetStyle | null;
}

export type SheetInspectResult =
  | { mode: "review"; documentType: "slides"; pendingSlideIds: string[]; warnings: string[] }
  | { mode: "capabilities"; documentType: OfficeDocumentType; operations: Array<Record<string, unknown>> }
  | { mode: "visual"; dataUrl: string; width: number; height: number; target: string; warnings: string[]; pendingVisualSlideIds?: string[] }
  | { mode: "selection"; documentType: OfficeDocumentType; blockIds?: string[]; text?: string; sheet?: string | null; range?: string | null; slideId?: string | null; elementIds?: string[]; elements?: Array<Record<string, unknown>>; slideWidth?: number; slideHeight?: number }
  | {
      mode: "summary";
      documentType: OfficeDocumentType;
      sheetCount?: number | null;
      sheets?: SheetInfo[];
      blockCount?: number | null;
      characterCount?: number | null;
      headingCount?: number | null;
      tableCount?: number | null;
      imageCount?: number | null;
      slideCount?: number | null;
      elementCount?: number | null;
    }
  | { mode: "range"; sheet: string; range: string; rows: SheetCell[][]; columnWidths?: number[]; rowHeights?: number[]; autoFilter?: SheetCellArea | null; conditionalFormatCount?: number; freeze?: { frozenRows: number; frozenColumns: number } }
  | {
      mode: "outline";
      items: Array<Record<string, unknown>>;
    }
  | {
      mode: "search";
      matches: Array<Record<string, unknown>>;
    }
  | {
      mode: "blocks";
      blocks: Array<Record<string, unknown>>;
    }
  | {
      mode: "slides";
      slides: Array<Record<string, unknown>>;
    }
  | {
      mode: "changed_since";
      changes: Array<{
        revision: number;
        actor: "user" | "agent";
        target: string;
        kind: "cell" | "block" | "slide" | "document";
      }>;
    };

export interface OfficeInspectResult {
  sessionId: string;
  version: DocumentVersion;
  result: SheetInspectResult;
}

export type OfficeInspectResponse =
  | (OfficeInspectResult & { ok: true; requestId: string })
  | {
      ok: false;
      requestId: string;
      sessionId: string;
      currentVersion: DocumentVersion;
      error: OfficeErrorPayload;
    };

export type SheetOperation =
  | { op: "set_cell"; payload: { sheet: string; cell: string; value: CellValue } }
  | { op: "set_range"; payload: { sheet: string; range: string; values: CellValue[][] } }
  | { op: "set_formula"; payload: { sheet: string; cell: string; formula: string } }
  | { op: "clear_range"; payload: { sheet: string; range: string } }
  | { op: "set_style"; payload: { sheet: string; range: string; style: SheetStyle } }
  | {
      op:
        | "insert_rows"
        | "delete_rows"
        | "insert_columns"
        | "delete_columns"
        | "merge_cells"
        | "unmerge_cells"
        | "add_sheet"
        | "delete_sheet"
        | "rename_sheet"
        | "move_sheet"
        | "set_column_width"
        | "set_row_height"
        | "set_auto_filter"
        | "set_freeze_panes"
        | "set_conditional_format";
      payload: Record<string, unknown>;
    }
  | {
      op:
        | "replace_block_text"
        | "delete_block"
        | "insert_paragraph"
        | "insert_heading"
        | "insert_list"
        | "insert_table"
        | "insert_image"
        | "set_block_style"
        | "set_table_cell"
        | "set_table_style"
        | "set_page_style";
      payload: Record<string, unknown>;
    }
  | {
      op:
        | "slide_set_text"
        | "slide_set_font"
        | "slide_set_chart_style"
        | "slide_set_geometry"
        | "slide_set_fill"
        | "slide_set_stroke"
        | "slide_add_text"
        | "slide_add_shape"
        | "slide_add_image"
        | "slide_add_svg"
        | "slide_compose"
        | "slide_delete_element"
        | "slide_add"
        | "slide_duplicate"
        | "slide_delete"
        | "slide_move"
        | "slide_apply_txn";
      payload: Record<string, unknown>;
    };

export interface OfficeApplyCommand {
  sessionId: string;
  operationId: string;
  expectedVersion: DocumentVersion;
  operations: SheetOperation[];
}

export type OfficeCommandResult =
  | {
      ok: true;
      unchanged?: boolean;
      createdElements?: Array<Record<string, unknown>>;
      createdSlides?: Array<{ id: string; index: number; width: number; height: number }>;
      updatedElements?: Array<Record<string, unknown>>;
      warnings?: string[];
      pendingVisualSlideIds?: string[];
      sessionId: string;
      operationId: string;
      version: DocumentVersion;
      changedTargets: string[];
      summary: string;
    }
  | {
      ok: false;
      sessionId: string;
      operationId: string;
      currentVersion: DocumentVersion;
      changedTargets: string[];
      error: OfficeErrorPayload;
    };

export interface OfficeCheckpointMetadata {
  sessionId: string;
  version: DocumentVersion;
  size: number;
  sha256: string;
}

export interface OfficeCheckpointStartRequest {
  version: DocumentVersion;
  size: number;
  sha256: string;
}

export interface OfficeCheckpointReceipt extends OfficeCheckpointMetadata {
  workingFileName: string;
}

export type OfficeSocketMessage =
  | { event: "office_session_open"; session: OfficeSessionState }
  | { event: "office_session_state"; session: OfficeSessionState }
  | { event: "office_command"; command: OfficeApplyCommand }
  | { event: "office_inspect_command"; command: OfficeInspectCommand }
  | { event: "office_checkpoint_request"; sessionId: string; version: DocumentVersion }
  | { event: "office_editor_ready"; sessionId: string; version: DocumentVersion }
  | {
      event: "office_user_change";
      sessionId: string;
      version: DocumentVersion;
      changedTargets: string[];
    }
  | { event: "office_command_result"; result: OfficeCommandResult }
  | { event: "office_inspect_result"; result: OfficeInspectResponse }
  | { event: "office_session_closed"; sessionId: string };
