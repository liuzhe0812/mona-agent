/**
 * 流程图图形库面板（左侧可折叠）。
 *
 * 分类展示 8 种标准节点形状，支持：
 * 1. 点击形状 → 添加到画布中心；
 * 2. 拖拽形状 → 放置到画布指定位置（onDropShape 回调）；
 * 3. 折叠/展开切换；
 * 4. 顶部搜索过滤。
 *
 * 设计依据：draw.io / WPS 流程图左侧形状面板的交互模式。
 */

import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Play,
  CircleEllipsis,
  ArrowDownToLine,
  Square,
  FileText,
  Database,
  MessageSquareText,
  Blocks,
  Search,
  ArrowLeftRight,
} from "lucide-react";

import type { FlowchartNodeKind } from "./flowchart-document";

interface ShapeMeta {
  kind: FlowchartNodeKind;
  label: string;
  icon: typeof Play;
  /** 分类：basic / extended */
  group: "basic" | "extended";
}

const SHAPES: ShapeMeta[] = [
  { kind: "start", label: "开始/结束", icon: Play, group: "basic" },
  { kind: "process", label: "处理", icon: CircleEllipsis, group: "basic" },
  { kind: "decision", label: "判断", icon: ArrowDownToLine, group: "basic" },
  { kind: "end", label: "结束", icon: Square, group: "basic" },
  { kind: "input-output", label: "输入/输出", icon: ArrowLeftRight, group: "basic" },
  { kind: "document", label: "文档", icon: FileText, group: "extended" },
  { kind: "database", label: "数据库", icon: Database, group: "extended" },
  { kind: "annotation", label: "注释", icon: MessageSquareText, group: "extended" },
  { kind: "subprocess", label: "子流程", icon: Blocks, group: "extended" },
];

export interface FlowchartShapePanelProps {
  /** 点击形状时触发，添加到画布中心 */
  onAddShape: (kind: FlowchartNodeKind) => void;
  /** 拖拽形状到画布时触发（可选） */
  onDropShape?: (kind: FlowchartNodeKind, x: number, y: number) => void;
  /** 只读模式禁用 */
  readOnly?: boolean;
}

export function FlowchartShapePanel({
  onAddShape,
  onDropShape,
  readOnly = false,
}: FlowchartShapePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [draggingKind, setDraggingKind] = useState<FlowchartNodeKind | null>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return SHAPES;
    const q = query.trim().toLowerCase();
    return SHAPES.filter((s) => s.label.toLowerCase().includes(q) || s.kind.includes(q));
  }, [query]);

  const basicShapes = filtered.filter((s) => s.group === "basic");
  const extendedShapes = filtered.filter((s) => s.group === "extended");

  if (collapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center border-r border-border/60 bg-background py-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="展开图形库"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="mt-2 flex flex-col items-center gap-1">
          {SHAPES.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.kind}
                type="button"
                disabled={readOnly}
                onClick={() => onAddShape(s.kind)}
                title={s.label}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-[200px] shrink-0 flex-col border-r border-border/60 bg-background">
      {/* 顶部标题 + 折叠按钮 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-2.5">
        <span className="text-[12px] font-medium text-foreground">图形库</span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="折叠图形库"
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 搜索框 */}
      <div className="shrink-0 border-b border-border/60 p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索形状"
            className="w-full bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* 形状列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {basicShapes.length > 0 && (
          <ShapeGroup
            title="基本形状"
            shapes={basicShapes}
            readOnly={readOnly}
            onAddShape={onAddShape}
            draggingKind={draggingKind}
            setDraggingKind={setDraggingKind}
            onDropShape={onDropShape}
          />
        )}
        {extendedShapes.length > 0 && (
          <ShapeGroup
            title="扩展形状"
            shapes={extendedShapes}
            readOnly={readOnly}
            onAddShape={onAddShape}
            draggingKind={draggingKind}
            setDraggingKind={setDraggingKind}
            onDropShape={onDropShape}
          />
        )}
        {filtered.length === 0 && (
          <div className="py-6 text-center text-[11px] text-muted-foreground">
            未找到匹配的形状
          </div>
        )}
      </div>
    </div>
  );
}

function ShapeGroup({
  title,
  shapes,
  readOnly,
  onAddShape,
  draggingKind,
  setDraggingKind,
  onDropShape,
}: {
  title: string;
  shapes: ShapeMeta[];
  readOnly: boolean;
  onAddShape: (kind: FlowchartNodeKind) => void;
  draggingKind: FlowchartNodeKind | null;
  setDraggingKind: (kind: FlowchartNodeKind | null) => void;
  onDropShape?: (kind: FlowchartNodeKind, x: number, y: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {shapes.map((s) => {
          const Icon = s.icon;
          const isDragging = draggingKind === s.kind;
          return (
            <button
              key={s.kind}
              type="button"
              disabled={readOnly}
              draggable={!readOnly && !!onDropShape}
              onDragStart={(e) => {
                setDraggingKind(s.kind);
                e.dataTransfer.setData("application/x-flowchart-kind", s.kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={() => setDraggingKind(null)}
              onClick={() => onAddShape(s.kind)}
              title={`添加${s.label}（点击或拖拽到画布）`}
              className={`flex flex-col items-center gap-1 rounded-md border border-border/60 bg-background px-1.5 py-2 text-center transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40 ${
                isDragging ? "opacity-50" : ""
              }`}
            >
              <Icon className="h-5 w-5 text-foreground/80" />
              <span className="text-[10.5px] leading-tight text-foreground/80">{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
