import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/CodeBlock";

import { DbIcon } from "./DbIcon";
import { DbToolButton } from "./DbToolButton";
import { useDbStore } from "./store/dbStore";
import { hasStructureChanges, isStructureColumnReadOnly } from "./structure-edit";
import type {
  ColumnDefinition,
  IndexDefinition,
  QueryTab,
  StructureAdvancedKey,
  StructureAdvancedOption,
  StructureColumn,
  StructureDraft,
  StructureForeignKey,
  StructureIndex,
  StructureListItem,
  StructureListSection,
  StructureTrigger,
} from "./types";

type StructureSection = StructureDraft["section"];
type EditingCell = { section: StructureSection; index: number; field: string } | null;
type Clipboard = { section: StructureListSection; item: StructureListItem };

const SECTION_DEFINITIONS: Array<{ id: StructureSection; label: string }> = [
  { id: "columns", label: "字段" },
  { id: "indexes", label: "索引" },
  { id: "foreign_keys", label: "外键" },
  { id: "triggers", label: "触发器" },
  { id: "advanced", label: "高级" },
];

const ACTION_OPTIONS = [
  { value: "RESTRICT", label: "RESTRICT" },
  { value: "CASCADE", label: "CASCADE" },
  { value: "SET NULL", label: "SET NULL" },
  { value: "NO ACTION", label: "NO ACTION" },
];

const INDEX_TYPE_OPTIONS = [{ value: "BTREE", label: "BTREE" }];
const ADVANCED_KEYS: StructureAdvancedKey[] = ["engine", "charset", "collation", "comment", "row_format", "auto_increment"];
const ADVANCED_LABELS: Record<StructureAdvancedKey, string> = {
  engine: "引擎",
  charset: "字符集",
  collation: "排序规则",
  comment: "注释",
  row_format: "行格式",
  auto_increment: "自增起点",
};
const COMMON_CHARSETS = ["utf8mb4", "utf8", "latin1"];
const COMMON_COLLATIONS = ["utf8mb4_unicode_ci", "utf8mb4_general_ci", "utf8mb4_0900_ai_ci", "utf8_general_ci"];
const ENGINE_OPTIONS = ["InnoDB", "MyISAM", "MEMORY", "Aria"];
const ROW_FORMAT_OPTIONS = ["Default", "Dynamic", "Compact", "Compressed", "Redundant", "Fixed"];

function optionsWithCurrent(current: string, values: string[]) {
  return Array.from(new Set([current, ...values].filter(Boolean))).map((value) => ({ value, label: value }));
}

function isTextType(dataType: string): boolean {
  return /^(?:char|varchar|tinytext|text|mediumtext|longtext)\b/i.test(dataType.trim());
}

function quoteSqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "操作失败";
}

function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || String(value).trim() === "") return "—";
  return String(value);
}

function formatConnection(connectionName: string | undefined, database: string | null, table: string | undefined): string {
  return `${connectionName ?? "未连接"} / ${database ?? "—"} / ${table ?? "—"}`;
}

function baselineFor(column: StructureColumn, originalColumns: ColumnDefinition[]): ColumnDefinition | undefined {
  return column.original_name === null
    ? undefined
    : originalColumns.find((original) => original.name === column.original_name);
}

function splitList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseDataType(value: string): { type: string; length: string; decimals: string } {
  const match = value.trim().match(/^([^\s(]+(?:\s+[^\s(]+)*?)(?:\s*\(([^)]*)\))?/);
  const type = match?.[1]?.trim() ?? value.trim();
  const parts = match?.[2]?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  return { type, length: parts[0] ?? "—", decimals: parts[1] ?? "—" };
}

function cloneItem<T extends StructureListItem>(item: T): T {
  return structuredClone(item);
}

function sectionItems(structure: StructureDraft, section: StructureSection): StructureListItem[] {
  switch (section) {
    case "columns": return structure.columns;
    case "indexes": return structure.indexes;
    case "foreign_keys": return structure.foreignKeys;
    case "triggers": return structure.triggers;
    case "advanced": return structure.advanced;
  }
}

function primaryIndexItem(index: IndexDefinition): StructureIndex {
  return {
    original_name: index.name,
    name: index.name,
    columns: index.columns,
    is_unique: index.is_unique,
    index_type: "BTREE",
    editable: false,
  };
}

function columnFieldEditable(
  column: StructureColumn,
  originalColumns: ColumnDefinition[],
  sqlite: boolean,
  busy: boolean,
  field: "name" | "data_type" | "nullable" | "is_primary_key" | "is_auto_increment" | "comment" | "default",
): boolean {
  if (busy) return false;
  const baseline = baselineFor(column, originalColumns);
  if (baseline && isStructureColumnReadOnly(baseline)) return false;
  if (sqlite && baseline) return field === "name";
  if (sqlite && !baseline) return field === "name" || field === "data_type" || field === "nullable" || field === "default";
  return true;
}

function isFormControlTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, button, [contenteditable=\"true\"]"));
}

function InlineValue({
  value,
  ariaLabel,
  editable,
  editing,
  onStart,
  onChange,
  onFinish,
  className,
  title,
  display,
}: {
  value: string;
  ariaLabel: string;
  editable: boolean;
  editing: boolean;
  onStart: () => void;
  onChange: (value: string) => void;
  onFinish: () => void;
  className?: string;
  title?: string;
  display?: string;
}) {
  if (editing && editable) {
    return (
      <Input
        autoFocus
        aria-label={ariaLabel}
        className={cn("h-6 min-w-0 rounded-sm px-1.5 text-caption", className)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onFinish}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onFinish();
          }
        }}
      />
    );
  }
  return (
    <span className={cn("block min-h-6 truncate py-0", editable && "cursor-text", className)} title={title ?? value} onDoubleClick={() => editable && onStart()}>
      {displayValue(display ?? value)}
    </span>
  );
}

function ToolbarStatus({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" | "success" }) {
  return <span className={cn("shrink-0 px-1 text-caption", tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-muted-foreground")}>{children}</span>;
}

function EmptySection({ label, onAdd, disabled, message }: { label: string; onAdd: () => void; disabled: boolean; message?: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 text-caption text-muted-foreground">
      <span>{message ?? `当前表没有${label}`}</span>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onAdd}><DbIcon name="add" />新增{label}</Button>
    </div>
  );
}

function EditableHeader({ children, className, onResizeStart }: { children: ReactNode; className?: string; onResizeStart?: (event: React.MouseEvent<HTMLSpanElement>) => void }) {
  return <th className={cn("relative h-8 border-b border-r border-border/40 px-2 text-left font-medium text-muted-foreground", className)}>{children}{onResizeStart && <span aria-hidden="true" data-testid={`structure-resize-${children}`} className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none" onMouseDown={onResizeStart} />}</th>;
}

function MoveHandleIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5v13M1.5 8h13M5.75 3.75 8 1.5l2.25 2.25M5.75 12.25 8 14.5l2.25-2.25M3.75 5.75 1.5 8l2.25 2.25M12.25 5.75 14.5 8l-2.25 2.25" /></svg>;
}

function Shortcut({ children }: { children: ReactNode }) {
  return <span className="ml-auto pl-4 text-micro text-muted-foreground">{children}</span>;
}

function RowContextMenu({
  section,
  rowIndex,
  item,
  clipboard,
  canEdit,
  canDelete,
  canAdd,
  onCopy,
  onClone,
  onPaste,
  onPasteInsert,
  onInsert,
  onDelete,
  children,
}: {
  section: StructureListSection;
  rowIndex: number | null;
  item: StructureListItem;
  clipboard: Clipboard | null;
  canEdit: boolean;
  canDelete: boolean;
  canAdd: boolean;
  onCopy: (section: StructureListSection, item: StructureListItem) => void;
  onClone: (section: StructureListSection, index: number) => void;
  onPaste: (section: StructureListSection, index: number) => void;
  onPasteInsert: (section: StructureListSection, index: number | null) => void;
  onInsert: (section: StructureListSection, index?: number) => void;
  onDelete: (section: StructureListSection, index: number) => void;
  children: ReactNode;
}) {
  const sameSection = clipboard?.section === section;
  const canReplace = sameSection && rowIndex !== null && canEdit;
  const canInsertClipboard = sameSection && canAdd && canEdit;
  const canClone = rowIndex !== null && section !== "advanced" && canAdd && canEdit;
  const canRemove = rowIndex !== null && canDelete;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel>操作</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canClone} onSelect={() => rowIndex !== null && onClone(section, rowIndex)}><DbIcon name="copy" />克隆<Shortcut>Ctrl+Shift+C</Shortcut></ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopy(section, item)}><DbIcon name="copy" />复制<Shortcut>Ctrl+C</Shortcut></ContextMenuItem>
        <ContextMenuItem disabled={!canReplace} onSelect={() => rowIndex !== null && onPaste(section, rowIndex)}><DbIcon name="copy" />粘贴<Shortcut>Ctrl+V</Shortcut></ContextMenuItem>
        <ContextMenuItem disabled={!canInsertClipboard} onSelect={() => onPasteInsert(section, rowIndex)}><DbIcon name="copy" />粘贴并插入</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canAdd}><DbIcon name="add" />插入</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-40">
            <ContextMenuItem disabled={!canAdd} onSelect={() => onInsert(section, rowIndex ?? undefined)}>上方</ContextMenuItem>
            <ContextMenuItem disabled={!canAdd} onSelect={() => onInsert(section, rowIndex === null ? undefined : rowIndex + 1)}>下方</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled={!canAdd} onSelect={() => onInsert(section)}><DbIcon name="add" />添加<Shortcut>Ctrl+Insert</Shortcut></ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canRemove} className="text-destructive focus:text-destructive" onSelect={() => rowIndex !== null && onDelete(section, rowIndex)}><DbIcon name="remove" />删除<Shortcut>Backspace</Shortcut></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface ListViewActions {
  tabId: string;
  sqlite: boolean;
  busy: boolean;
  selectedIndex: number | null;
  editingCell: EditingCell;
  clipboard: Clipboard | null;
  onSelect: (index: number) => void;
  onStartEdit: (section: StructureSection, index: number, field: string) => void;
  onFinishEdit: () => void;
  onUpdate: (section: StructureListSection, index: number, patch: Partial<StructureListItem>) => void;
  onCopy: (section: StructureListSection, item: StructureListItem) => void;
  onClone: (section: StructureListSection, index: number) => void;
  onPaste: (section: StructureListSection, index: number) => void;
  onPasteInsert: (section: StructureListSection, index: number | null) => void;
  onInsert: (section: StructureListSection, index?: number) => void;
  onDelete: (section: StructureListSection, index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>, section: StructureListSection, index: number, item: StructureListItem, canEdit: boolean, canDelete: boolean) => void;
}

function isEditing(editingCell: EditingCell, section: StructureSection, index: number, field: string): boolean {
  return editingCell?.section === section && editingCell.index === index && editingCell.field === field;
}

function rowClass(selected: boolean, readonly = false): string {
  return cn("group h-8 border-b border-border/60 even:bg-muted/35 outline-none hover:bg-accent/50 focus-visible:bg-accent/50", selected && "bg-accent/40", readonly && "text-muted-foreground");
}

function StructureColumnsView({
  columns,
  originalColumns,
  sqlite,
  busy,
  actions,
  onMove,
}: {
  columns: StructureColumn[];
  originalColumns: ColumnDefinition[];
  sqlite: boolean;
  busy: boolean;
  actions: ListViewActions;
  onMove: (from: number, to: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [columnWidths, setColumnWidths] = useState({ order: 64, name: 144, type: 120, length: 72, decimals: 72, nullable: 72, generated: 96, primary: 72, comment: 200 });
  const resizeRef = useRef<{ key: keyof typeof columnWidths; startX: number; startWidth: number } | null>(null);
  const startColumnResize = (key: keyof typeof columnWidths, event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { key, startX: event.clientX, startWidth: columnWidths[key] };
    const onMove = (moveEvent: MouseEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      setColumnWidths((widths) => ({ ...widths, [resize.key]: Math.max(56, resize.startWidth + moveEvent.clientX - resize.startX) }));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  if (!columns.length) return <EmptySection label="字段" disabled={busy} onAdd={() => actions.onInsert("columns")} />;
  return (
    <div className="min-w-0">
      <table className="min-w-[52rem] w-full table-fixed border-collapse text-caption [&_td]:border-r [&_td]:border-border/35" data-testid="structure-section-columns">
        <colgroup><col style={{ width: columnWidths.order }} /><col style={{ width: columnWidths.name }} /><col style={{ width: columnWidths.type }} /><col style={{ width: columnWidths.length }} /><col style={{ width: columnWidths.decimals }} /><col style={{ width: columnWidths.nullable }} /><col style={{ width: columnWidths.generated }} /><col style={{ width: columnWidths.primary }} /><col style={{ width: columnWidths.comment }} /></colgroup>
        <thead><tr><EditableHeader onResizeStart={(event) => startColumnResize("order", event)}>排序</EditableHeader><EditableHeader onResizeStart={(event) => startColumnResize("name", event)}>字段</EditableHeader><EditableHeader onResizeStart={(event) => startColumnResize("type", event)}>类型</EditableHeader><EditableHeader onResizeStart={(event) => startColumnResize("length", event)}>长度</EditableHeader><EditableHeader onResizeStart={(event) => startColumnResize("decimals", event)}>小数位</EditableHeader><EditableHeader className="text-center" onResizeStart={(event) => startColumnResize("nullable", event)}>允许空</EditableHeader><EditableHeader className="text-center" onResizeStart={(event) => startColumnResize("generated", event)}>自动生成</EditableHeader><EditableHeader className="text-center" onResizeStart={(event) => startColumnResize("primary", event)}>主键</EditableHeader><EditableHeader onResizeStart={(event) => startColumnResize("comment", event)}>注释</EditableHeader></tr></thead>
        <tbody>
          {columns.map((column, index) => {
            const baseline = baselineFor(column, originalColumns);
            const readOnly = Boolean(baseline && isStructureColumnReadOnly(baseline));
            const rowSelected = actions.selectedIndex === index;
            const canName = columnFieldEditable(column, originalColumns, sqlite, busy, "name");
            const canType = columnFieldEditable(column, originalColumns, sqlite, busy, "data_type");
            const canComment = columnFieldEditable(column, originalColumns, sqlite, busy, "comment");
            const canNullable = columnFieldEditable(column, originalColumns, sqlite, busy, "nullable");
            const canAuto = columnFieldEditable(column, originalColumns, sqlite, busy, "is_auto_increment");
            const canPrimary = columnFieldEditable(column, originalColumns, sqlite, busy, "is_primary_key");
            const parsed = parseDataType(column.data_type);
            const moveEnabled = !sqlite && !busy && !readOnly;
            return (
              <RowContextMenu key={`${column.original_name ?? "new"}-${index}`} section="columns" rowIndex={index} item={column} clipboard={actions.clipboard} canEdit={canName || canType || canComment} canDelete={!readOnly && !busy} canAdd={!busy} onCopy={actions.onCopy} onClone={actions.onClone} onPaste={actions.onPaste} onPasteInsert={actions.onPasteInsert} onInsert={actions.onInsert} onDelete={actions.onDelete}>
                <tr
                  tabIndex={0}
                  draggable={moveEnabled}
                  aria-selected={rowSelected}
                  aria-disabled={readOnly}
                  data-testid={`structure-row-columns-${index}`}
                  className={rowClass(rowSelected, readOnly)}
                  onClick={() => actions.onSelect(index)}
                  onContextMenu={() => actions.onSelect(index)}
                  onKeyDown={(event) => actions.onKeyDown(event, "columns", index, column, canName || canType || canComment, !readOnly && !busy)}
                onDragStart={(event) => {
                    if (!moveEnabled) { event.preventDefault(); return; }
                    dragIndexRef.current = index;
                    setDragIndex(index);
                    event.dataTransfer?.setData("text/plain", String(index));
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (dragIndex !== null && !sqlite) {
                      event.preventDefault();
                      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const transferIndex = typeof event.dataTransfer?.getData === "function" ? Number(event.dataTransfer.getData("text/plain")) : null;
                    const from = dragIndexRef.current ?? dragIndex ?? (transferIndex !== null && Number.isFinite(transferIndex) ? transferIndex : null);
                    if (from !== null && from !== index && !sqlite && !busy) onMove(from, index);
                    dragIndexRef.current = null;
                    setDragIndex(null);
                  }}
                  onDragEnd={() => { dragIndexRef.current = null; setDragIndex(null); }}
                >
                  <td className={cn("border-l-2 px-2 py-1 tabular-nums text-muted-foreground", rowSelected ? "border-info" : "border-transparent")}><span draggable={moveEnabled} onDragStart={(event) => { if (!moveEnabled) { event.preventDefault(); return; } dragIndexRef.current = index; setDragIndex(index); event.dataTransfer?.setData("text/plain", String(index)); }} className={cn("mr-1 inline-flex select-none align-middle text-muted-foreground", moveEnabled ? "cursor-grab" : "cursor-not-allowed")} title={sqlite ? "SQLite 不支持调整字段顺序" : "拖动调整字段顺序"} aria-label="拖动排序"><MoveHandleIcon /></span>{index + 1}</td>
                  <td className="px-2 py-1"><InlineValue ariaLabel={`字段名，第 ${index + 1} 行`} value={column.name} editable={canName} editing={isEditing(actions.editingCell, "columns", index, "name")} onStart={() => actions.onStartEdit("columns", index, "name")} onChange={(value) => actions.onUpdate("columns", index, { name: value })} onFinish={actions.onFinishEdit} /></td>
                  <td className="px-2 py-1"><InlineValue ariaLabel={`类型，第 ${index + 1} 行`} value={column.data_type} display={parsed.type} title={column.data_type} className="font-mono" editable={canType} editing={isEditing(actions.editingCell, "columns", index, "data_type")} onStart={() => actions.onStartEdit("columns", index, "data_type")} onChange={(value) => actions.onUpdate("columns", index, { data_type: value })} onFinish={actions.onFinishEdit} /></td>
                  <td className="px-2 py-1 text-muted-foreground">{parsed.length}</td><td className="px-2 py-1 text-muted-foreground">{parsed.decimals}</td>
                  <td className="px-2 py-1 text-center"><Checkbox aria-label={`允许空，第 ${index + 1} 行`} checked={column.nullable} disabled={!canNullable} onCheckedChange={(checked) => actions.onUpdate("columns", index, { nullable: checked === true })} /></td>
                  <td className="px-2 py-1 text-center"><Checkbox aria-label={`自动生成，第 ${index + 1} 行`} checked={column.is_auto_increment} disabled={!canAuto} onCheckedChange={(checked) => actions.onUpdate("columns", index, { is_auto_increment: checked === true })} /></td>
                  <td className="px-2 py-1 text-center"><Checkbox aria-label={`主键，第 ${index + 1} 行`} checked={column.is_primary_key} disabled={!canPrimary} onCheckedChange={(checked) => actions.onUpdate("columns", index, { is_primary_key: checked === true })} /></td>
                  <td className="px-2 py-1"><InlineValue ariaLabel={`注释，第 ${index + 1} 行`} value={column.comment} editable={canComment} editing={isEditing(actions.editingCell, "columns", index, "comment")} onStart={() => actions.onStartEdit("columns", index, "comment")} onChange={(value) => actions.onUpdate("columns", index, { comment: value })} onFinish={actions.onFinishEdit} /></td>
                </tr>
              </RowContextMenu>
            );
          })}
        </tbody>
      </table>
      {sqlite && <p className="px-3 py-2 text-caption text-muted-foreground">SQLite 现有字段仅支持改名或删除；SQLite 不支持调整字段顺序。新字段可填写名称、类型、可空和默认值。</p>}
    </div>
  );
}

function IndexesView({ indexes, originalIndexes, ...actions }: { indexes: StructureIndex[]; originalIndexes: IndexDefinition[] } & ListViewActions) {
  const primaryIndexes = originalIndexes.filter((index) => index.is_primary);
  if (!indexes.length && !primaryIndexes.length) return <EmptySection label="索引" disabled={actions.busy} onAdd={() => actions.onInsert("indexes")} />;
  return (
    <div className="min-w-0">
      <table className="min-w-[48rem] w-full table-fixed border-collapse text-caption [&_td]:border-r [&_td]:border-border/35" data-testid="structure-section-indexes">
        <colgroup><col className="w-48" /><col className="w-64" /><col className="w-32" /><col className="w-20" /><col /></colgroup>
        <thead><tr><EditableHeader>名称</EditableHeader><EditableHeader>字段</EditableHeader><EditableHeader>索引类型</EditableHeader><EditableHeader className="text-center">唯一</EditableHeader><EditableHeader>注释</EditableHeader></tr></thead>
        <tbody>
          {primaryIndexes.map((index) => { const item = primaryIndexItem(index); return <RowContextMenu key={`primary-${index.name}`} section="indexes" rowIndex={null} item={item} clipboard={actions.clipboard} canEdit={false} canDelete={false} canAdd={!actions.busy} onCopy={actions.onCopy} onClone={actions.onClone} onPaste={actions.onPaste} onPasteInsert={actions.onPasteInsert} onInsert={actions.onInsert} onDelete={actions.onDelete}><tr className={rowClass(false, true)} data-testid={`structure-row-indexes-primary-${index.name}`}><td className="px-2 py-1">{index.name}</td><td className="px-2 py-1">{index.columns.join(", ") || "—"}</td><td className="px-2 py-1">PRIMARY</td><td className="px-2 py-1 text-center">{index.is_unique ? "是" : "否"}</td><td className="px-2 py-1">—</td></tr></RowContextMenu>; })}
          {indexes.map((index, rowIndex) => {
            const canEdit = !actions.busy && index.editable;
            const rowSelected = actions.selectedIndex === rowIndex;
            return <RowContextMenu key={`${index.original_name ?? "new"}-${rowIndex}`} section="indexes" rowIndex={rowIndex} item={index} clipboard={actions.clipboard} canEdit={canEdit} canDelete={canEdit} canAdd={!actions.busy} onCopy={actions.onCopy} onClone={actions.onClone} onPaste={actions.onPaste} onPasteInsert={actions.onPasteInsert} onInsert={actions.onInsert} onDelete={actions.onDelete}><tr tabIndex={0} aria-selected={rowSelected} aria-disabled={!canEdit} data-testid={`structure-row-indexes-${rowIndex}`} className={rowClass(rowSelected, !canEdit)} onClick={() => actions.onSelect(rowIndex)} onContextMenu={() => actions.onSelect(rowIndex)} onKeyDown={(event) => actions.onKeyDown(event, "indexes", rowIndex, index, canEdit, canEdit)}><td className={cn("border-l-2 px-2 py-1", rowSelected ? "border-info" : "border-transparent")}><InlineValue ariaLabel={`索引名称，第 ${rowIndex + 1} 行`} value={index.name} editable={canEdit} editing={isEditing(actions.editingCell, "indexes", rowIndex, "name")} onStart={() => actions.onStartEdit("indexes", rowIndex, "name")} onChange={(value) => actions.onUpdate("indexes", rowIndex, { name: value })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><InlineValue ariaLabel={`字段，第 ${rowIndex + 1} 行`} value={index.columns.join(", ")} editable={canEdit} editing={isEditing(actions.editingCell, "indexes", rowIndex, "columns")} onStart={() => actions.onStartEdit("indexes", rowIndex, "columns")} onChange={(value) => actions.onUpdate("indexes", rowIndex, { columns: splitList(value) })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><Select aria-label={`索引类型，第 ${rowIndex + 1} 行`} className="h-7 text-caption" value={index.index_type} options={INDEX_TYPE_OPTIONS} disabled={!canEdit} onValueChange={(value) => actions.onUpdate("indexes", rowIndex, { index_type: value as "BTREE" })} /></td><td className="px-2 py-1 text-center"><Checkbox aria-label={`唯一，第 ${rowIndex + 1} 行`} checked={index.is_unique} disabled={!canEdit} onCheckedChange={(checked) => actions.onUpdate("indexes", rowIndex, { is_unique: checked === true })} /></td><td className="px-2 py-1 text-muted-foreground">—</td></tr></RowContextMenu>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function ForeignKeysView({ foreignKeys, ...actions }: { foreignKeys: StructureForeignKey[] } & ListViewActions) {
  if (!foreignKeys.length) return <EmptySection label="外键" disabled={actions.busy || actions.sqlite} onAdd={() => actions.onInsert("foreign_keys")} />;
  return (
    <div className="min-w-0"><table className="min-w-[64rem] w-full table-fixed border-collapse text-caption [&_td]:border-r [&_td]:border-border/35" data-testid="structure-section-foreign_keys"><colgroup><col className="w-40" /><col className="w-40" /><col className="w-40" /><col className="w-40" /><col className="w-32" /><col className="w-32" /></colgroup><thead><tr><EditableHeader>名称</EditableHeader><EditableHeader>本地字段</EditableHeader><EditableHeader>引用表</EditableHeader><EditableHeader>引用字段</EditableHeader><EditableHeader>删除规则</EditableHeader><EditableHeader>更新规则</EditableHeader></tr></thead><tbody>
      {foreignKeys.map((foreignKey, index) => { const canEdit = !actions.busy && !actions.sqlite && foreignKey.editable; const rowSelected = actions.selectedIndex === index; return <RowContextMenu key={`${foreignKey.original_name ?? "new"}-${index}`} section="foreign_keys" rowIndex={index} item={foreignKey} clipboard={actions.clipboard} canEdit={canEdit} canDelete={canEdit} canAdd={!actions.busy && !actions.sqlite} onCopy={actions.onCopy} onClone={actions.onClone} onPaste={actions.onPaste} onPasteInsert={actions.onPasteInsert} onInsert={actions.onInsert} onDelete={actions.onDelete}><tr tabIndex={0} aria-selected={rowSelected} aria-disabled={!canEdit} data-testid={`structure-row-foreign_keys-${index}`} className={rowClass(rowSelected, !canEdit)} onClick={() => actions.onSelect(index)} onContextMenu={() => actions.onSelect(index)} onKeyDown={(event) => actions.onKeyDown(event, "foreign_keys", index, foreignKey, canEdit, canEdit)}><td className={cn("border-l-2 px-2 py-1", rowSelected ? "border-info" : "border-transparent")}><InlineValue ariaLabel={`名称，第 ${index + 1} 行`} value={foreignKey.name} editable={canEdit} editing={isEditing(actions.editingCell, "foreign_keys", index, "name")} onStart={() => actions.onStartEdit("foreign_keys", index, "name")} onChange={(value) => actions.onUpdate("foreign_keys", index, { name: value })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><InlineValue ariaLabel={`本地字段，第 ${index + 1} 行`} value={foreignKey.columns.join(", ")} editable={canEdit} editing={isEditing(actions.editingCell, "foreign_keys", index, "columns")} onStart={() => actions.onStartEdit("foreign_keys", index, "columns")} onChange={(value) => actions.onUpdate("foreign_keys", index, { columns: splitList(value) })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><InlineValue ariaLabel={`引用表，第 ${index + 1} 行`} value={foreignKey.ref_table} editable={canEdit} editing={isEditing(actions.editingCell, "foreign_keys", index, "ref_table")} onStart={() => actions.onStartEdit("foreign_keys", index, "ref_table")} onChange={(value) => actions.onUpdate("foreign_keys", index, { ref_table: value })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><InlineValue ariaLabel={`引用字段，第 ${index + 1} 行`} value={foreignKey.ref_columns.join(", ")} editable={canEdit} editing={isEditing(actions.editingCell, "foreign_keys", index, "ref_columns")} onStart={() => actions.onStartEdit("foreign_keys", index, "ref_columns")} onChange={(value) => actions.onUpdate("foreign_keys", index, { ref_columns: splitList(value) })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><Select aria-label={`删除规则，第 ${index + 1} 行`} className="h-7 text-caption" value={foreignKey.on_delete} options={ACTION_OPTIONS} disabled={!canEdit} onValueChange={(value) => actions.onUpdate("foreign_keys", index, { on_delete: value as StructureForeignKey["on_delete"] })} /></td><td className="px-2 py-1"><Select aria-label={`更新规则，第 ${index + 1} 行`} className="h-7 text-caption" value={foreignKey.on_update} options={ACTION_OPTIONS} disabled={!canEdit} onValueChange={(value) => actions.onUpdate("foreign_keys", index, { on_update: value as StructureForeignKey["on_update"] })} /></td></tr></RowContextMenu>; })}
    </tbody></table>{actions.sqlite && <p className="px-3 py-2 text-caption text-muted-foreground">SQLite 外键结构为只读。</p>}</div>
  );
}

function TriggersView({ triggers, ...actions }: { triggers: StructureTrigger[] } & ListViewActions) {
  if (!triggers.length) return <EmptySection label="触发器" disabled={actions.busy} onAdd={() => actions.onInsert("triggers")} />;
  return <div className="min-w-0"><table className="min-w-[56rem] w-full table-fixed border-collapse text-caption [&_td]:border-r [&_td]:border-border/35" data-testid="structure-section-triggers"><colgroup><col className="w-44" /><col className="w-32" /><col className="w-32" /><col /></colgroup><thead><tr><EditableHeader>名称</EditableHeader><EditableHeader>时机</EditableHeader><EditableHeader>事件</EditableHeader><EditableHeader>语句</EditableHeader></tr></thead><tbody>
    {triggers.map((trigger, index) => { const canEdit = !actions.busy && trigger.editable; const rowSelected = actions.selectedIndex === index; return <RowContextMenu key={`${trigger.original_name ?? "new"}-${index}`} section="triggers" rowIndex={index} item={trigger} clipboard={actions.clipboard} canEdit={canEdit} canDelete={!actions.busy} canAdd={!actions.busy} onCopy={actions.onCopy} onClone={actions.onClone} onPaste={actions.onPaste} onPasteInsert={actions.onPasteInsert} onInsert={actions.onInsert} onDelete={actions.onDelete}><tr tabIndex={0} aria-selected={rowSelected} aria-disabled={!canEdit} data-testid={`structure-row-triggers-${index}`} className={rowClass(rowSelected, !canEdit)} onClick={() => actions.onSelect(index)} onContextMenu={() => actions.onSelect(index)} onKeyDown={(event) => actions.onKeyDown(event, "triggers", index, trigger, canEdit, !actions.busy)}><td className={cn("border-l-2 px-2 py-1", rowSelected ? "border-info" : "border-transparent")}><InlineValue ariaLabel={`名称，第 ${index + 1} 行`} value={trigger.name} editable={canEdit} editing={isEditing(actions.editingCell, "triggers", index, "name")} onStart={() => actions.onStartEdit("triggers", index, "name")} onChange={(value) => actions.onUpdate("triggers", index, { name: value })} onFinish={actions.onFinishEdit} /></td><td className="px-2 py-1"><Select aria-label={`时机，第 ${index + 1} 行`} className="h-7 text-caption" value={trigger.timing} options={[{ value: "BEFORE", label: "BEFORE" }, { value: "AFTER", label: "AFTER" }]} disabled={!canEdit} onValueChange={(value) => actions.onUpdate("triggers", index, { timing: value as StructureTrigger["timing"] })} /></td><td className="px-2 py-1"><Select aria-label={`事件，第 ${index + 1} 行`} className="h-7 text-caption" value={trigger.event} options={[{ value: "INSERT", label: "INSERT" }, { value: "UPDATE", label: "UPDATE" }, { value: "DELETE", label: "DELETE" }]} disabled={!canEdit} onValueChange={(value) => actions.onUpdate("triggers", index, { event: value as StructureTrigger["event"] })} /></td><td className="px-2 py-1"><InlineValue ariaLabel={`语句，第 ${index + 1} 行`} value={trigger.statement} editable={canEdit} editing={isEditing(actions.editingCell, "triggers", index, "statement")} onStart={() => actions.onStartEdit("triggers", index, "statement")} onChange={(value) => actions.onUpdate("triggers", index, { statement: value })} onFinish={actions.onFinishEdit} /></td></tr></RowContextMenu>; })}
  </tbody></table></div>;
}

function AdvancedView({ advanced, originalAdvanced, tableName, sqlite, busy, onChange }: { advanced: StructureAdvancedOption[]; originalAdvanced: StructureDraft["originalAdvanced"]; tableName: string; sqlite: boolean; busy: boolean; onChange: (key: StructureAdvancedKey, value: string) => void }) {
  const value = (key: StructureAdvancedKey) => advanced.find((option) => option.key === key)?.value ?? String(originalAdvanced[key] ?? "");
  const clauses = ADVANCED_KEYS.flatMap((key) => {
    const option = advanced.find((item) => item.key === key);
    if (!option) return [];
    if (key === "engine") return [`ENGINE=${option.value}`];
    if (key === "charset") return [`DEFAULT CHARACTER SET ${option.value}`];
    if (key === "collation") return [`COLLATE ${option.value}`];
    if (key === "comment") return [`COMMENT=${quoteSqlLiteral(option.value)}`];
    if (key === "row_format") return [`ROW_FORMAT=${option.value.toUpperCase()}`];
    return [`AUTO_INCREMENT=${option.value}`];
  });
  const sql = clauses.length ? `ALTER TABLE ${quoteSqlIdentifier(tableName)}\n  ${clauses.join(",\n  ")};` : "";
  const disabled = busy || sqlite;
  return <div className="grid h-full min-w-[52rem] grid-cols-[minmax(0,1fr)_20rem] text-caption" data-testid="structure-section-advanced">
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border"><div className="flex h-9 shrink-0 items-center justify-center border-b border-border text-muted-foreground">SQL总览</div><div className="min-h-0 flex-1 p-4"><div className="h-full min-h-80 overflow-auto rounded-md bg-muted/45" data-testid="advanced-sql-overview">{sql && <CodeBlock language="sql" code={sql} showHeader={false} constrainHeight={false} className="rounded-md" />}</div></div></section>
    <aside className="min-w-0"><div className="flex h-9 items-center border-b border-border px-3 text-muted-foreground">编辑项</div><div className="space-y-3 overflow-auto p-3">
      <div className="space-y-1"><label htmlFor="advanced-table-name">表名</label><Input id="advanced-table-name" aria-label="表名" className="h-9 bg-muted px-2 font-mono text-caption" value={tableName} disabled /></div>
      <div className="space-y-1"><label htmlFor="advanced-comment">注释</label><textarea id="advanced-comment" aria-label="表注释" className="min-h-14 w-full resize-y rounded-md border border-input bg-muted/60 px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" value={value("comment")} disabled={disabled} onChange={(event) => onChange("comment", event.target.value)} /></div>
      <div className="space-y-1"><label>字符集</label><Select aria-label="表字符集" className="h-9 bg-muted/60 font-mono text-caption" value={value("charset")} options={optionsWithCurrent(value("charset"), COMMON_CHARSETS)} disabled={disabled} onValueChange={(next) => onChange("charset", next)} /></div>
      <div className="space-y-1"><label>排序规则</label><Select aria-label="表排序规则" className="h-9 bg-muted/60 font-mono text-caption" value={value("collation")} options={optionsWithCurrent(value("collation"), COMMON_COLLATIONS)} disabled={disabled} onValueChange={(next) => onChange("collation", next)} /></div>
      <div className="space-y-1"><label>引擎</label><Select aria-label="表引擎" className="h-9 bg-muted/60 font-mono text-caption" value={value("engine")} options={optionsWithCurrent(value("engine"), ENGINE_OPTIONS)} disabled={disabled} onValueChange={(next) => onChange("engine", next)} /></div>
      <div className="space-y-1"><label>行格式</label><Select aria-label="表行格式" className="h-9 bg-muted/60 font-mono text-caption" value={value("row_format")} options={optionsWithCurrent(value("row_format"), ROW_FORMAT_OPTIONS)} disabled={disabled} onValueChange={(next) => onChange("row_format", next)} /></div>
      <div className="space-y-1"><label htmlFor="advanced-auto-increment">自动递增</label><Input id="advanced-auto-increment" aria-label="自动递增" type="number" min={1} className="h-9 bg-muted/60 px-2 font-mono text-caption" value={value("auto_increment")} disabled={disabled} onChange={(event) => onChange("auto_increment", event.target.value)} /></div>
      {sqlite && <p className="text-muted-foreground">SQLite 不支持修改高级表选项。</p>}
    </div></aside>
  </div>;
}

function StructureDetail({ column, baseline, tableDefaults, sqlite, originalColumns, busy, onChange }: { column: StructureColumn | undefined; baseline: ColumnDefinition | undefined; tableDefaults: StructureDraft["originalAdvanced"]; sqlite: boolean; originalColumns: ColumnDefinition[]; busy: boolean; onChange: (patch: Partial<StructureColumn>) => void }) {
  if (!column) return <aside className="flex w-80 min-w-64 shrink-0 items-center justify-center border-l border-border px-4 text-center text-caption text-muted-foreground">选择字段查看详情</aside>;
  const canEdit = (field: "name" | "data_type" | "comment" | "default" | "is_auto_increment") => columnFieldEditable(column, originalColumns, sqlite, busy, field);
  const textType = isTextType(column.data_type);
  const charset = column.charset ?? baseline?.charset ?? tableDefaults.charset ?? "";
  const collation = column.collation ?? baseline?.collation ?? tableDefaults.collation ?? "";
  const defaultIsNull = column.default_mode === "null" || (column.default_mode === "keep" && column.nullable && baseline?.default_value == null);
  const defaultValue = column.default_mode === "keep" ? baseline?.default_value ?? "" : column.default_value ?? "";
  const setCustomDefault = (next: string) => onChange({ default_mode: !next ? "none" : /^CURRENT_TIMESTAMP(?:\(\)|\([0-6]\))?$/i.test(next) ? "expression" : "literal", default_value: next || null });
  return <aside className="flex w-80 min-w-64 shrink-0 flex-col overflow-hidden border-l border-border text-caption"><ScrollArea data-testid="structure-detail-scroll-area" className="min-h-0 flex-1"><div className="space-y-2 p-2"><h2 className="mb-2 text-body font-medium">字段</h2>
    <Input aria-label="详情字段名" className="h-9 bg-muted/60 px-2 font-mono text-caption" value={column.name} disabled={!canEdit("name")} onChange={(event) => onChange({ name: event.target.value })} />
    <div className="space-y-1"><label htmlFor="structure-detail-comment">注释</label><textarea id="structure-detail-comment" aria-label="详情注释" className="min-h-14 w-full resize-y rounded-md border border-input bg-muted/60 px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" value={column.comment} disabled={!canEdit("comment")} onChange={(event) => onChange({ comment: event.target.value })} /></div>
    <div className="space-y-1"><label>字符集</label><Select aria-label="字段字符集" className="h-9 bg-muted/60 font-mono text-caption" value={charset} options={optionsWithCurrent(charset, COMMON_CHARSETS)} disabled={!textType || !canEdit("data_type")} onValueChange={(value) => onChange({ charset: value })} /></div>
    <div className="space-y-1"><label>排序规则</label><Select aria-label="字段排序规则" className="h-9 bg-muted/60 font-mono text-caption" value={collation} options={optionsWithCurrent(collation, COMMON_COLLATIONS)} disabled={!textType || !canEdit("data_type")} onValueChange={(value) => onChange({ collation: value })} /></div>
    <fieldset className="space-y-2"><legend>默认值</legend><div className="flex items-center gap-4"><label className="flex items-center gap-1.5"><input type="radio" name={`field-default-${column.original_name ?? "new"}`} aria-label="默认值 NULL" checked={defaultIsNull} disabled={!column.nullable || !canEdit("default")} onChange={() => onChange({ default_mode: "null", default_value: null })} />NULL</label><label className="flex items-center gap-1.5"><input type="radio" name={`field-default-${column.original_name ?? "new"}`} aria-label="默认值自定义" checked={!defaultIsNull} disabled={!canEdit("default")} onChange={() => setCustomDefault(defaultValue)} />自定义值</label></div><Input aria-label="默认值" className="h-9 bg-muted/60 px-2 font-mono text-caption" value={defaultIsNull ? "" : defaultValue} disabled={defaultIsNull || !canEdit("default")} placeholder="无默认值" onChange={(event) => setCustomDefault(event.target.value)} /></fieldset>
    <label className="flex items-center gap-2"><Checkbox aria-label="自动生成" checked={column.is_auto_increment} disabled={!canEdit("is_auto_increment")} onCheckedChange={(checked) => onChange({ is_auto_increment: checked === true })} />自动生成</label>
    {!canEdit("name") && <p className="text-muted-foreground">此字段的部分属性由数据库结构限制，当前不可编辑。</p>}
  </div></ScrollArea></aside>;
}

function initialFieldFor(section: StructureSection): string {
  return section === "advanced" ? "value" : "name";
}

export function TableStructureEditor({ tab }: { tab: QueryTab }) {
  const activeConnections = useDbStore((state) => state.activeConnections);
  const patchTab = useDbStore((state) => state.patchTab);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(() => tab.structure?.section === "columns" && tab.structure.columns.length ? 0 : null);
  const [editingCell, setEditingCell] = useState<EditingCell>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const [previewSql, setPreviewSql] = useState<string[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const structure = tab.structure;
  const section = structure?.section ?? "columns";
  const columns = structure?.columns ?? [];
  const originalColumns = structure?.originalColumns ?? [];
  const connection = activeConnections.find((item) => item.id === tab.connectionId);
  const sqlite = connection?.config.db_type === "sqlite";
  const busy = Boolean(tab.isSaving || tab.isLoadingMetadata || previewLoading);
  const modified = hasStructureChanges(tab);
  const selectedColumn = section === "columns" && selectedIndex !== null ? columns[selectedIndex] : undefined;
  const selectedBaseline = selectedColumn ? baselineFor(selectedColumn, originalColumns) : undefined;

  const risks = useMemo(() => {
    if (!structure) return [];
    const draftColumns = new Set(structure.columns.filter((column) => column.original_name !== null).map((column) => column.original_name));
    const draftIndexes = new Set(structure.indexes.filter((index) => index.original_name !== null).map((index) => index.original_name));
    const draftForeignKeys = new Set(structure.foreignKeys.filter((foreignKey) => foreignKey.original_name !== null).map((foreignKey) => foreignKey.original_name));
    const draftTriggers = new Set(structure.triggers.filter((trigger) => trigger.original_name !== null).map((trigger) => trigger.original_name));
    const changedTypes = structure.originalColumns.flatMap((column) => { const draft = structure.columns.find((item) => item.original_name === column.name); return draft && draft.data_type !== column.data_type ? [{ name: column.name, before: column.data_type, after: draft.data_type }] : []; });
    const advancedRisks = structure.advanced.flatMap((option) => { const current = structure.originalAdvanced[option.key]; return String(current ?? "") !== option.value ? [`修改高级选项：${ADVANCED_LABELS[option.key]}（${displayValue(current)} → ${displayValue(option.value)}）`] : []; });
    return [
      ...structure.originalColumns.filter((column) => !draftColumns.has(column.name)).map((column) => `删除字段：${column.name}`),
      ...changedTypes.map((change) => `类型变更：${change.name}（${change.before} → ${change.after}）`),
      ...structure.originalIndexes.filter((index) => !index.is_primary && !draftIndexes.has(index.name)).map((index) => `删除索引：${index.name}`),
      ...structure.originalForeignKeys.filter((foreignKey) => !draftForeignKeys.has(foreignKey.name)).map((foreignKey) => `删除外键：${foreignKey.name}`),
      ...structure.originalTriggers.filter((trigger) => !draftTriggers.has(trigger.name)).map((trigger) => `删除触发器：${trigger.name}`),
      ...advancedRisks,
    ];
  }, [structure]);

  const currentItems = structure ? sectionItems(structure, section) : [];
  const canAddCurrent = Boolean(structure && !busy && section !== "advanced" && (section !== "foreign_keys" || !sqlite));

  useEffect(() => {
    if (section === "columns" && selectedIndex === null && currentItems.length) setSelectedIndex(0);
    else if (selectedIndex !== null && selectedIndex >= currentItems.length) setSelectedIndex(currentItems.length ? currentItems.length - 1 : null);
  }, [currentItems.length, section, selectedIndex]);

  useEffect(() => {
    setSelectedIndex(section === "columns" ? 0 : null);
    setEditingCell(null);
    setPreviewSql(null);
  }, [tab.id, section]);

  function actions() { return useDbStore.getState(); }

  function updateColumn(index: number, patch: Partial<StructureColumn>) { actions().updateStructureColumn(tab.id, index, patch); }

  function updateItem(itemSection: StructureListSection, index: number, patch: Partial<StructureListItem>) {
    if (itemSection === "columns") updateColumn(index, patch as Partial<StructureColumn>);
    else actions().updateStructureItem(tab.id, itemSection, index, patch);
  }

  function updateAdvanced(key: StructureAdvancedKey, value: string) {
    if (!structure || sqlite || busy) return;
    const index = structure.advanced.findIndex((option) => option.key === key);
    const original = String(structure.originalAdvanced[key] ?? "");
    if (value === original) {
      if (index >= 0) actions().removeStructureItem(tab.id, "advanced", index);
      return;
    }
    if (index >= 0) actions().updateStructureItem(tab.id, "advanced", index, { value });
    else actions().insertStructureItem(tab.id, "advanced", undefined, { key, value });
  }

  function startEdit(itemSection: StructureSection, index: number, field: string) {
    if (!structure || itemSection === "advanced") return;
    if (itemSection === "columns") {
      const column = structure.columns[index];
      if (column && columnFieldEditable(column, originalColumns, sqlite, busy, field as Parameters<typeof columnFieldEditable>[4])) setEditingCell({ section: itemSection, index, field });
      return;
    }
    const item = sectionItems(structure, itemSection)[index] as StructureIndex | StructureForeignKey | StructureTrigger | undefined;
    if (item && !busy && item.editable && !(itemSection === "foreign_keys" && sqlite)) setEditingCell({ section: itemSection, index, field });
  }

  function selectSection(nextSection: StructureSection) {
    if (!structure || section === nextSection) return;
    patchTab(tab.id, { structure: { ...structure, section: nextSection } });
    setSelectedIndex(null);
    setEditingCell(null);
  }

  function addCurrent(index?: number) {
    if (!structure || !canAddCurrent) return;
    if (index === undefined) actions().insertStructureItem(tab.id, section);
    else actions().insertStructureItem(tab.id, section, index);
    setSelectedIndex(index ?? currentItems.length);
  }

  function removeAt(itemSection: StructureListSection, index: number) {
    if (!structure || busy) return;
    if (itemSection === "columns") {
      const column = structure.columns[index];
      const baseline = column && baselineFor(column, originalColumns);
      if (!column || (baseline && isStructureColumnReadOnly(baseline))) return;
    }
    if (itemSection === "indexes" && !structure.indexes[index]?.editable) return;
    if (itemSection === "foreign_keys" && (sqlite || !structure.foreignKeys[index]?.editable)) return;
    actions().removeStructureItem(tab.id, itemSection, index);
    setSelectedIndex((current) => current === null ? null : current === index ? null : current > index ? current - 1 : current);
  }

  function copyItem(itemSection: StructureListSection, item: StructureListItem) { setClipboard({ section: itemSection, item: cloneItem(item) }); }

  function sourceForInsert(itemSection: StructureListSection, source: StructureListItem): StructureListItem {
    if (itemSection !== "advanced" || !structure) return cloneItem(source);
    const used = new Set(structure.advanced.map((option) => option.key));
    const key = ADVANCED_KEYS.find((candidate) => !used.has(candidate));
    return key ? { ...(cloneItem(source) as StructureAdvancedOption), key } : cloneItem(source);
  }

  function cloneAt(itemSection: StructureListSection, index: number) {
    if (!structure || busy || itemSection === "advanced") return;
    const item = sectionItems(structure, itemSection)[index];
    if (!item || "editable" in item && !item.editable) return;
    if (itemSection === "columns") { const baseline = baselineFor(item as StructureColumn, originalColumns); if (baseline && isStructureColumnReadOnly(baseline)) return; }
    actions().insertStructureItem(tab.id, itemSection, index + 1, sourceForInsert(itemSection, item));
    setSelectedIndex(index + 1);
  }

  function pasteAt(itemSection: StructureListSection, index: number) {
    if (!structure || busy || !clipboard || clipboard.section !== itemSection) return;
    const target = sectionItems(structure, itemSection)[index];
    if (!target) return;
    if (itemSection === "columns") {
      const baseline = baselineFor(target as StructureColumn, originalColumns);
      if (baseline && isStructureColumnReadOnly(baseline)) return;
      updateColumn(index, { ...(cloneItem(clipboard.item) as StructureColumn), original_name: (target as StructureColumn).original_name });
    } else if (itemSection === "advanced") updateItem(itemSection, index, cloneItem(clipboard.item) as StructureAdvancedOption);
    else {
      if ("editable" in target && !target.editable) return;
      const targetWithIdentity = target as Exclude<StructureListItem, StructureAdvancedOption>;
      const targetIdentity = "editable" in targetWithIdentity ? { original_name: targetWithIdentity.original_name, editable: targetWithIdentity.editable } : { original_name: targetWithIdentity.original_name };
      updateItem(itemSection, index, { ...(cloneItem(clipboard.item) as unknown as Record<string, unknown>), ...targetIdentity } as Partial<StructureListItem>);
    }
    setSelectedIndex(index);
  }

  function pasteAndInsert(itemSection: StructureListSection, index: number | null) {
    if (!structure || busy || !clipboard || clipboard.section !== itemSection || !canAddCurrent) return;
    const insertionIndex = index === null ? currentItems.length : index + 1;
    actions().insertStructureItem(tab.id, itemSection, insertionIndex, sourceForInsert(itemSection, clipboard.item));
    setSelectedIndex(insertionIndex);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, itemSection: StructureListSection, index: number, item: StructureListItem, canEdit: boolean, canDelete: boolean) {
    if (event.target !== event.currentTarget || isFormControlTarget(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === "Enter") { event.preventDefault(); startEdit(itemSection, index, initialFieldFor(itemSection)); }
    else if (modifier && event.shiftKey && event.key.toLowerCase() === "c" && canEdit && itemSection !== "advanced") { event.preventDefault(); cloneAt(itemSection, index); }
    else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); copyItem(itemSection, item); }
    else if (modifier && event.key.toLowerCase() === "v" && clipboard?.section === itemSection && canEdit) { event.preventDefault(); pasteAt(itemSection, index); }
    else if (modifier && event.key === "Insert" && canAddCurrent) { event.preventDefault(); addCurrent(); }
    else if (event.key === "Backspace" && canDelete) { event.preventDefault(); removeAt(itemSection, index); }
  }

  function moveColumn(from: number, to: number) {
    if (!structure || sqlite || busy || from === to) return;
    actions().moveStructureItem(tab.id, "columns", from, to);
    setSelectedIndex(to);
  }

  function refreshNow() { setSelectedIndex(null); setEditingCell(null); void actions().refreshStructure(tab.id); }
  function refresh() { if (busy) return; if (modified) setRefreshConfirmOpen(true); else refreshNow(); }

  async function preview() {
    if (!structure || !modified || busy) return;
    setPreviewLoading(true);
    try { setPreviewSql(await actions().previewStructure(tab.id)); }
    catch (error) { patchTab(tab.id, { error: errorMessage(error) }); }
    finally { setPreviewLoading(false); }
  }

  function apply() {
    if (!previewSql) return;
    void (async () => { try { await actions().applyStructure(tab.id); } catch (error) { patchTab(tab.id, { error: errorMessage(error) }); } finally { setPreviewSql(null); } })();
  }

  const listActions: ListViewActions = { tabId: tab.id, sqlite, busy, selectedIndex, editingCell, clipboard, onSelect: setSelectedIndex, onStartEdit: startEdit, onFinishEdit: () => setEditingCell(null), onUpdate: updateItem, onCopy: copyItem, onClone: cloneAt, onPaste: pasteAt, onPasteInsert: pasteAndInsert, onInsert: (_itemSection, index) => addCurrent(index), onDelete: removeAt, onKeyDown: handleRowKeyDown };
  const connectionPath = formatConnection(connection?.config.name, tab.database, tab.tableName ?? tab.title);
  const showError = [tab.metadataError, tab.error].filter(Boolean).join("\n");
  const selectedReadOnly = Boolean(selectedBaseline && isStructureColumnReadOnly(selectedBaseline));
  const currentSectionLabel = SECTION_DEFINITIONS.find((item) => item.id === section)?.label ?? "字段";

  return <TooltipProvider delayDuration={250}><div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground" data-testid="table-structure-editor" aria-busy={busy}>
    <div role="toolbar" aria-label="表结构操作" className="relative flex h-8 shrink-0 min-w-0 items-center gap-1 border-b border-border px-2">
      <div className="flex shrink-0 items-center gap-1">
        <DbToolButton icon="save" label="应用结构" disabled={!structure || !modified || busy} onClick={() => { void preview(); }} />
        <DbToolButton icon="add" label={`新增${currentSectionLabel}`} disabled={!structure || !canAddCurrent} onClick={() => addCurrent()} />
        <DbToolButton icon="remove" label={`删除选中${currentSectionLabel}`} disabled={!structure || busy || section === "advanced" || selectedIndex === null || section === "columns" && selectedReadOnly || section === "indexes" && !structure?.indexes[selectedIndex ?? -1]?.editable || section === "foreign_keys" && (sqlite || !structure?.foreignKeys[selectedIndex ?? -1]?.editable)} onClick={() => selectedIndex !== null && removeAt(section, selectedIndex)} />
        <DbToolButton icon="refresh" label="刷新表结构" disabled={busy || !tab.connectionId || !tab.database || !tab.tableName} onClick={refresh} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
        <div role="tablist" aria-label="表结构分段" className="pointer-events-auto flex max-w-[calc(100%-16rem)] items-center gap-0 rounded-sm bg-muted p-px">
          {SECTION_DEFINITIONS.map((item) => <Button key={item.id} type="button" role="tab" aria-selected={section === item.id} aria-controls={`structure-panel-${item.id}`} data-testid={`structure-tab-${item.id}`} variant="ghost" size="xs" className={cn("h-6 shrink-0 rounded-sm px-3 text-caption font-normal", section === item.id && "bg-background text-foreground shadow-sm")} disabled={!structure} onClick={() => selectSection(item.id)}>{item.label}</Button>)}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">{previewLoading && <ToolbarStatus>正在生成 SQL…</ToolbarStatus>}{modified && !previewLoading && <ToolbarStatus tone="warning">已修改</ToolbarStatus>}{tab.isSaving && <ToolbarStatus>正在应用…</ToolbarStatus>}{tab.isLoadingMetadata && <ToolbarStatus>正在读取…</ToolbarStatus>}</div>
    </div>
    {showError && <div role="alert" className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words border-b border-border px-3 py-2 text-caption text-destructive">{showError}</div>}
    {!structure ? <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-caption text-muted-foreground">{tab.isLoadingMetadata ? "正在读取表结构…" : "尚未读取表结构，请刷新后重试。"}</div> : <div id={`structure-panel-${section}`} role="tabpanel" aria-label={currentSectionLabel} className="flex min-h-0 min-w-0 flex-1"><ScrollArea horizontal data-testid="structure-scroll-area" className="min-h-0 min-w-0 flex-1">{section === "columns" && <StructureColumnsView columns={columns} originalColumns={originalColumns} sqlite={sqlite} busy={busy} actions={listActions} onMove={moveColumn} />}{section === "indexes" && <IndexesView indexes={structure.indexes} originalIndexes={structure.originalIndexes} {...listActions} />}{section === "foreign_keys" && <ForeignKeysView foreignKeys={structure.foreignKeys} {...listActions} />}{section === "triggers" && <TriggersView triggers={structure.triggers} {...listActions} />}{section === "advanced" && <AdvancedView advanced={structure.advanced} originalAdvanced={structure.originalAdvanced} tableName={tab.tableName ?? tab.title} sqlite={sqlite} busy={busy} onChange={updateAdvanced} />}</ScrollArea>{section === "columns" && <StructureDetail column={selectedColumn} baseline={selectedBaseline} tableDefaults={structure.originalAdvanced} sqlite={sqlite} originalColumns={originalColumns} busy={busy} onChange={(patch) => selectedIndex !== null && updateColumn(selectedIndex, patch)} />}</div>}
    <div className="flex h-8 shrink-0 items-center gap-2 overflow-hidden border-t border-border px-3 text-caption text-muted-foreground"><span className={connection ? "text-success" : "text-destructive"} aria-label={connection ? "已连接" : "已断开"}>●</span><span className="truncate" title={connectionPath}>{connectionPath}</span><span className="ml-auto shrink-0">{structure ? section === "advanced" ? "高级设置" : `${currentItems.length} 个${currentSectionLabel}` : "—"}</span></div>
  </div><AlertDialog open={refreshConfirmOpen} onOpenChange={setRefreshConfirmOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未保存的结构修改？</AlertDialogTitle><AlertDialogDescription>刷新会重新读取 {connectionPath}，当前结构修改将被丢弃。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { setRefreshConfirmOpen(false); actions().resetStructureEdits(tab.id); refreshNow(); }}>放弃修改并刷新</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><AlertDialog open={previewSql !== null} onOpenChange={(open) => !open && setPreviewSql(null)}><AlertDialogContent className="max-w-3xl"><AlertDialogHeader><AlertDialogTitle>确认应用表结构？</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-3 text-caption"><p>{connectionPath}</p>{risks.length ? <div className="space-y-1 text-warning"><p className="font-medium">请确认以下风险：</p>{risks.map((risk) => <p key={risk}>· {risk}</p>)}</div> : <p className="text-muted-foreground">请检查将要执行的结构变更。</p>}<div className="space-y-1"><p className="font-medium text-foreground">将执行 SQL</p><pre data-testid="structure-preview-sql" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/30 p-3 font-mono text-caption select-text">{previewSql?.join("\n\n") || "（预览没有生成 SQL）"}</pre></div></div></AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回编辑</AlertDialogCancel><AlertDialogAction disabled={tab.isSaving} onClick={apply}>应用结构</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></TooltipProvider>;
}
