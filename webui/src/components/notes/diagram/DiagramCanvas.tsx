/**
 * v2 图表画布：基于 React Flow 渲染 DiagramDocument，处理拖动、连线、选区与绘制工具。
 *
 * 规范（见 AI_EDITABLE_DIAGRAM_CANVAS_PRODUCTION_PLAN.md §8.3）：
 * 1. 元素映射为自定义节点（"diagram"），group/container 映射为 "diagram-group"，
 *    自由端点连接器使用不可见 "diagram-anchor" 锚点节点；
 * 2. 连接器映射为 React Flow edge，marker 使用本文件 <DiagramMarkers> 的 SVG 定义；
 * 3. 受控模式：nodes/edges 由父级从文档派生，交互变化通过回调上抛，
 *    父级把变化转为 DiagramCommand 提交（不直接改文档）；
 * 4. 只读模式：禁用拖动、连线、删除和编辑，保留平移缩放；
 * 5. 主题：根容器复用 .flowchart-surface，消费 --flowchart-* token；
 * 6. 导出与画布共用同一渲染树（html-to-image 截取 .react-flow）。
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  BackgroundVariant,
  type Edge,
  type EdgeChange,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeResizer,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type OnNodesChange,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useViewport,
  type Viewport,
} from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";
import * as lucide from "lucide-react";
import {
  Grid3X3,
  Magnet,
  Maximize2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import "@xyflow/react/dist/style.css";

import { getNotesVaultPath, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type {
  DiagramActivationElement,
  DiagramBraceElement,
  DiagramDocument,
  DiagramElement,
  DiagramFreehandElement,
  DiagramIconElement,
  DiagramImageElement,
  DiagramLifelineElement,
  DiagramTableElement,
  DiagramTextElement,
  EndpointMarker,
  ShapeKind,
} from "./diagram-document";
import {
  docToFlowEdges,
  docToFlowNodes,
  renderShapeElement,
  strokeToSvgProps,
  textStyleToCss,
  type DiagramNodeData,
} from "./diagram-flow";
import {
  HIGHLIGHTER_STYLE,
  PEN_STYLE,
  createFreehandGeometry,
  type FreehandPoint,
  type FreehandStyle,
  getFreehandOutline,
  getSvgPathFromStroke,
} from "../flowchart/freehand";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type CanvasTool = "select" | "hand" | "pen" | "highlighter" | "eraser";

export type DiagramContextMenuContext =
  | { kind: "element"; elementId: string; x: number; y: number }
  | { kind: "connector"; connectorId: string; x: number; y: number }
  | { kind: "pane"; x: number; y: number };

export interface DiagramFreehandCompletePayload {
  points: FreehandPoint[];
  position: { x: number; y: number };
  size: { width: number; height: number };
  path: string;
  tool: "pen" | "highlighter";
  color: string;
  opacity: number;
  strokeWidth: number;
}

export interface DiagramExportOptions {
  /** 导出倍率（默认 1） */
  scale?: number;
  /** 背景：theme=画布背景色，transparent=透明 */
  background?: "theme" | "transparent";
}

export interface DiagramCanvasHandle {
  exportToPng: (options?: DiagramExportOptions) => Promise<string>;
  exportToSvg: (options?: DiagramExportOptions) => Promise<string>;
  fitView: (padding?: number) => void;
  selectAll: () => void;
  setZoom: (zoom: number) => void;
  getZoom: () => number;
}

export interface DiagramCanvasProps {
  document: DiagramDocument;
  readOnly?: boolean;
  /** 当前选中元素/连接器 id（受控选中态，React Flow 受控模式下由父级注入） */
  selection?: { elementIds: string[]; connectorIds: string[] };
  initialViewport?: { x: number; y: number; zoom: number } | null;
  /** 当前文档 ID，切换文档时重置视图恢复状态 */
  noteId?: string;
  onNodesChange?: (changes: NodeChange[]) => void;
  onEdgesChange?: (changes: EdgeChange[]) => void;
  onConnect?: (connection: {
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }) => void;
  onReconnect?: (
    edgeId: string,
    next: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
  ) => void;
  onViewportChange?: (vp: { x: number; y: number; zoom: number }) => void;
  onSelectionChange?: (selection: { elementIds: string[]; connectorIds: string[] }) => void;
  onElementLabelEdit?: (elementId: string, text: string) => void;
  onElementTitleEdit?: (elementId: string, title: string) => void;
  onConnectorLabelEdit?: (connectorId: string, text: string) => void;
  onDropShape?: (kind: ShapeKind, x: number, y: number) => void;
  onCreateElementWithConnection?: (
    kind: ShapeKind,
    position: { x: number; y: number },
    connection: { source: string; sourceHandle?: string },
  ) => void;
  onContextMenu?: (ctx: DiagramContextMenuContext) => void;
  activeTool?: CanvasTool;
  penColor?: string;
  penSize?: number;
  highlighterColor?: string;
  highlighterSize?: number;
  onFreehandComplete?: (payload: DiagramFreehandCompletePayload) => void;
  onEraseFreehand?: (elementIds: string[]) => void;
  showGrid?: boolean;
  snapToGrid?: boolean;
}

// ---------------------------------------------------------------------------
// 端口 Handle：四方向 source + target（与 flowchart 同一交互）
// ---------------------------------------------------------------------------

function FourHandles() {
  const handleStyle = { background: "var(--flowchart-handle)" };
  return (
    <>
      <Handle type="target" position={Position.Top} id="top-target" style={handleStyle} isConnectable />
      <Handle type="source" position={Position.Top} id="top-source" style={handleStyle} isConnectable />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={handleStyle} isConnectable />
      <Handle type="source" position={Position.Bottom} id="bottom-source" style={handleStyle} isConnectable />
      <Handle type="target" position={Position.Left} id="left-target" style={handleStyle} isConnectable />
      <Handle type="source" position={Position.Left} id="left-source" style={handleStyle} isConnectable />
      <Handle type="target" position={Position.Right} id="right-target" style={handleStyle} isConnectable />
      <Handle type="source" position={Position.Right} id="right-source" style={handleStyle} isConnectable />
    </>
  );
}

// ---------------------------------------------------------------------------
// 双击编辑 label（与 flowchart EditableLabel 同模式）
// ---------------------------------------------------------------------------

const EditableLabel = memo(function EditableLabel({
  elementId,
  value,
  readOnly,
  onEdit,
  className,
  style,
}: {
  elementId: string;
  value: string;
  readOnly: boolean;
  onEdit?: (elementId: string, text: string) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    editorRef.current?.focus();
    editorRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <div
        className={cn("w-full cursor-text whitespace-pre-wrap break-words text-center", className)}
        style={style}
        onDoubleClick={(event) => {
          if (readOnly) return;
          event.stopPropagation();
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </div>
    );
  }

  const commit = () => {
    onEdit?.(elementId, draft.trim());
    setEditing(false);
  };

  return (
    <textarea
      ref={editorRef}
      className={cn(
        "nodrag nowheel max-h-full w-full resize-none overflow-hidden bg-transparent text-center outline-none",
        className,
      )}
      style={style}
      rows={Math.max(1, draft.split("\n").length)}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setEditing(false);
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          commit();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
});

// ---------------------------------------------------------------------------
// 各元素类型渲染
// ---------------------------------------------------------------------------

function TextElementView({ el, readOnly, onLabelEdit }: { el: DiagramTextElement; readOnly: boolean; onLabelEdit?: (id: string, text: string) => void }) {
  const css = textStyleToCss(el.textStyle);
  const firstText = el.textBlocks.map((b) => b.text).join("\n");
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden">
      <EditableLabel
        elementId={el.id}
        value={firstText}
        readOnly={readOnly}
        onEdit={onLabelEdit}
        style={css}
      />
    </div>
  );
}

function IconElementView({ el }: { el: DiagramIconElement }) {
  const IconComponent = useMemo(() => {
    if (el.iconRef.library !== "lucide") return null;
    const name = el.iconRef.name as keyof typeof lucide;
    const comp = lucide[name];
    return typeof comp === "function" ? (comp as lucide.LucideIcon) : null;
  }, [el.iconRef]);
  return (
    <div className="flex h-full w-full items-center justify-center">
      {IconComponent ? (
        <IconComponent
          style={{
            width: "70%",
            height: "70%",
            color: el.color ?? "currentColor",
            objectFit: el.fit,
          }}
        />
      ) : (
        <lucide.Shapes style={{ width: "70%", height: "70%" }} className="text-muted-foreground" />
      )}
    </div>
  );
}

function ImageElementView({ el, assets }: { el: DiagramImageElement; assets?: DiagramDocument["assets"] }) {
  const [src, setSrc] = useState<string | null>(null);
  const assetPath = useMemo(
    () => assets?.find((a) => a.id === el.assetId)?.path ?? el.assetId,
    [assets, el.assetId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let resolved = assetPath;
      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          const vaultPath = await getNotesVaultPath();
          if (vaultPath) resolved = convertFileSrc(`${vaultPath}/${assetPath}`);
        } catch (e) {
          console.warn("[diagram] convert image path failed", e);
        }
      }
      if (!cancelled) setSrc(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetPath]);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden">
      {src ? (
        <img
          src={src}
          alt={el.alt ?? "图片"}
          draggable={false}
          className="max-h-full max-w-full"
          style={{ objectFit: el.fit }}
        />
      ) : (
        <span className="text-xs text-muted-foreground">缺失图片</span>
      )}
    </div>
  );
}

/** 大括号/方括号/圆括号：按方向绘制一条 brace 路径。 */
function BraceElementView({ el }: { el: DiagramBraceElement }) {
  const stroke = strokeToSvgProps(el.stroke);
  const vertical = el.orientation === "left" || el.orientation === "right";
  const mirror = el.orientation === "left" || el.orientation === "top";
  // 以竖向右括号 } 为基础形状，按需镜像/旋转
  const path = useMemo(() => {
    if (el.braceKind === "square") {
      return "M20 0 H6 V100 H20";
    }
    if (el.braceKind === "round") {
      return "M18 0 C4 20 4 80 18 100";
    }
    // curly
    return "M18 0 C8 0 10 12 10 22 C10 36 4 42 0 46 C4 50 10 56 10 70 C10 88 8 100 18 100";
  }, [el.braceKind]);
  return (
    <svg
      className="h-full w-full overflow-visible"
      viewBox="0 0 20 100"
      preserveAspectRatio="none"
      style={{
        transform: `${vertical ? "" : "rotate(90deg) "}${mirror ? "scaleX(-1)" : ""}`,
      }}
    >
      <path
        d={path}
        fill="none"
        stroke={stroke.stroke}
        strokeWidth={stroke.strokeWidth}
        strokeDasharray={stroke.strokeDasharray}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TableElementView({ el }: { el: DiagramTableElement }) {
  return (
    <div className="h-full w-full overflow-hidden rounded-md border border-border bg-card text-[11px] text-foreground">
      <table className="h-full w-full border-collapse">
        {el.sections.map((section) => {
          const Tag = section.kind === "header" ? "thead" : "tbody";
          return (
            <Tag key={section.id}>
              {section.rows.map((row) => (
                <tr key={row.id}>
                  {row.cells.map((cell, ci) => {
                    const width = el.columnWidths[ci];
                    const CellTag = section.kind === "header" ? "th" : "td";
                    return (
                      <CellTag
                        key={cell.id}
                        className="border border-border/60 px-2 py-1 text-left align-top"
                        style={{
                          width: width ? `${width}%` : undefined,
                          ...textStyleToCss(cell.style),
                        }}
                      >
                        {cell.text}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </Tag>
          );
        })}
      </table>
    </div>
  );
}

function LifelineElementView({ el, readOnly, onTitleEdit }: { el: DiagramLifelineElement; readOnly: boolean; onTitleEdit?: (id: string, title: string) => void }) {
  return (
    <div className="relative flex h-full w-full flex-col items-center">
      <div className="z-10 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-sm">
        <EditableLabel
          elementId={el.id}
          value={el.title}
          readOnly={readOnly}
          onEdit={onTitleEdit}
        />
      </div>
      <div className="w-px flex-1 border-l border-dashed border-muted-foreground/60" />
    </div>
  );
}

function ActivationElementView({ el }: { el: DiagramActivationElement }) {
  void el;
  return <div className="h-full w-full rounded-sm border border-border bg-muted" />;
}

function FreehandElementView({ el, selected, resizable }: { el: DiagramFreehandElement; selected: boolean; resizable: boolean }) {
  const w = Math.max(el.size.width, 4);
  const h = Math.max(el.size.height, 4);
  return (
    <div className="h-full w-full">
      {selected && resizable && (
        <NodeResizer
          minWidth={4}
          minHeight={4}
          isVisible={true}
          lineClassName="!border-[hsl(var(--flowchart-handle))]"
          handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
        />
      )}
      <svg className="size-full overflow-visible" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <path d={el.path ?? ""} fill={el.color} fillOpacity={el.opacity ?? 1} />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 节点视图
// ---------------------------------------------------------------------------

/** 可连接的元素类型（显示 FourHandles）。 */
const CONNECTABLE_TYPES: ReadonlySet<DiagramElement["type"]> = new Set([
  "shape",
  "text",
  "icon",
  "image",
  "table",
  "lifeline",
]);

function DiagramElementNode({ id, data, selected }: NodeProps<Node>) {
  const d = data as DiagramNodeData;
  const el = d.element;
  if (!el) return null;
  const readOnly = d.readOnly;
  const resizable = !readOnly;

  return (
    <div
      className={cn("h-full w-full", selected && "diagram-node-selected")}
      style={{ transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined }}
    >
      {selected && resizable && el.type !== "freehand" && (
        <NodeResizer
          minWidth={16}
          minHeight={16}
          isVisible={true}
          lineClassName="!border-[hsl(var(--flowchart-handle))]"
          handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
        />
      )}
      <ElementBody el={el} doc={dataDocumentRef.current} readOnly={readOnly} selected={selected} resizable={resizable} onLabelEdit={d.onLabelEdit} onTitleEdit={d.onTitleEdit} />
      {CONNECTABLE_TYPES.has(el.type) && !readOnly && <FourHandles />}
      {CONNECTABLE_TYPES.has(el.type) && readOnly && <FourHandles />}
      {id ? null : null}
    </div>
  );
}

// data 里没有 doc 引用（避免每次 doc 变化重建节点），assets 通过模块级 ref 传递。
// DiagramCanvasInner 每次渲染时更新该 ref；元素渲染只在 nodes 数组重建时发生，
// 而 nodes 重建必然发生在 doc 变化后，因此 ref 内容始终是最新的。
const dataDocumentRef: { current: DiagramDocument | undefined } = { current: undefined };

function ElementBody({
  el,
  doc,
  readOnly,
  selected,
  resizable,
  onLabelEdit,
  onTitleEdit,
}: {
  el: DiagramElement;
  doc: DiagramDocument | undefined;
  readOnly: boolean;
  selected: boolean;
  resizable: boolean;
  onLabelEdit?: (id: string, text: string) => void;
  onTitleEdit?: (id: string, title: string) => void;
}) {
  switch (el.type) {
    case "shape":
      return (
        <ShapeWithEditableLabel
          el={el}
          readOnly={readOnly}
          onLabelEdit={onLabelEdit}
        />
      );
    case "text":
      return <TextElementView el={el} readOnly={readOnly} onLabelEdit={onLabelEdit} />;
    case "icon":
      return <IconElementView el={el} />;
    case "image":
      return <ImageElementView el={el} assets={doc?.assets} />;
    case "brace":
      return <BraceElementView el={el} />;
    case "table":
      return <TableElementView el={el} />;
    case "lifeline":
      return <LifelineElementView el={el} readOnly={readOnly} onTitleEdit={onTitleEdit} />;
    case "activation":
      return <ActivationElementView el={el} />;
    case "freehand":
      return <FreehandElementView el={el} selected={selected} resizable={resizable} />;
    default:
      return null;
  }
}

/** shape：SVG 形状 + 双击可编辑文本。 */
function ShapeWithEditableLabel({
  el,
  readOnly,
  onLabelEdit,
}: {
  el: Extract<DiagramElement, { type: "shape" }>;
  readOnly: boolean;
  onLabelEdit?: (id: string, text: string) => void;
}) {
  if (readOnly || !onLabelEdit) {
    return <>{renderShapeElement(el, `shape-${el.id}`)}</>;
  }
  // 可编辑态：形状 SVG 照旧，文本层换成 EditableLabel
  const textCss = textStyleToCss(el.textStyle);
  const firstText = el.textBlocks.map((b) => b.text).join("\n");
  const { renderShapeSvg, buildGradientDefs, strokeToSvgProps } = shapeRenderApi;
  const { defs, fill } = buildGradientDefs(el.fill, `shape-${el.id}`);
  const stroke = strokeToSvgProps(el.stroke);
  return (
    <div className="relative h-full w-full">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 200 100" preserveAspectRatio="none">
        {defs}
        {renderShapeSvg({ kind: el.shapeKind, fill, stroke: stroke.stroke, strokeWidth: stroke.strokeWidth, strokeDasharray: stroke.strokeDasharray })}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center px-2 py-1">
        <EditableLabel
          elementId={el.id}
          value={firstText}
          readOnly={readOnly}
          onEdit={onLabelEdit}
          style={textCss}
        />
      </div>
    </div>
  );
}

// diagram-flow 的命名导出在组件外聚合，避免每次渲染重新解构
import * as diagramFlowApi from "./diagram-flow";
const shapeRenderApi = {
  renderShapeSvg: diagramFlowApi.renderShapeSvg,
  buildGradientDefs: diagramFlowApi.buildGradientDefs,
  strokeToSvgProps: diagramFlowApi.strokeToSvgProps,
};

/** group/container：半透明背景框 + 可编辑标题。 */
function DiagramGroupNode({ data, selected }: NodeProps<Node>) {
  const d = data as DiagramNodeData;
  const el = d.element;
  if (!el || (el.type !== "group" && el.type !== "container")) return null;
  const title = el.type === "group" ? el.title : el.title;
  const background = el.type === "group" ? el.background : el.background;
  const bgCss = background && background.type === "solid" ? { backgroundColor: background.color } : {};
  const isContainer = el.type === "container";
  return (
    <div
      className={cn(
        "h-full w-full rounded-lg border",
        isContainer ? "border-border/80 bg-muted/30" : "border-dashed border-border/60 bg-muted/20",
        selected && "border-[hsl(var(--flowchart-handle))]",
      )}
      style={bgCss}
    >
      {title !== undefined && title !== "" || (!d.readOnly && d.onTitleEdit) ? (
        <div className="absolute left-2 top-1 max-w-[calc(100%-16px)] text-xs font-medium text-muted-foreground">
          <EditableLabel
            elementId={el.id}
            value={title ?? ""}
            readOnly={d.readOnly}
            onEdit={d.onTitleEdit}
            className="text-left"
          />
        </div>
      ) : null}
    </div>
  );
}

/** 自由端点锚点：1px 不可见节点。 */
function DiagramAnchorNode() {
  return (
    <>
      <Handle type="target" position={Position.Top} id="top-target" style={{ opacity: 0 }} isConnectable={false} />
      <Handle type="source" position={Position.Top} id="top-source" style={{ opacity: 0 }} isConnectable={false} />
    </>
  );
}

const nodeTypes = {
  diagram: DiagramElementNode,
  "diagram-group": DiagramGroupNode,
  "diagram-anchor": DiagramAnchorNode,
};

// ---------------------------------------------------------------------------
// 端点 marker SVG 定义
// ---------------------------------------------------------------------------

const MARKER_DEFS: Array<{ marker: Exclude<EndpointMarker, "none">; path: (id: string) => React.ReactNode }> = [
  { marker: "arrow-open", path: () => <path d="M1 1 L9 5 L1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" /> },
  { marker: "arrow-closed", path: () => <path d="M1 1 L9 5 L1 9 Z" fill="context-stroke" stroke="context-stroke" strokeWidth="1" /> },
  { marker: "triangle", path: () => <path d="M1 1 L9 5 L1 9 Z" fill="none" stroke="context-stroke" strokeWidth="1.5" /> },
  { marker: "circle", path: () => <circle cx="5" cy="5" r="3.5" fill="none" stroke="context-stroke" strokeWidth="1.5" /> },
  { marker: "diamond-open", path: () => <path d="M1 5 L5 1 L9 5 L5 9 Z" fill="white" stroke="context-stroke" strokeWidth="1.5" /> },
  { marker: "diamond-filled", path: () => <path d="M1 5 L5 1 L9 5 L5 9 Z" fill="context-stroke" stroke="context-stroke" strokeWidth="1" /> },
  { marker: "bar", path: () => <path d="M5 1 V9" fill="none" stroke="context-stroke" strokeWidth="2" /> },
  { marker: "er-one", path: () => <path d="M5 1 V9 M8 1 V9" fill="none" stroke="context-stroke" strokeWidth="1.5" /> },
  { marker: "er-one-many", path: () => <path d="M5 1 V9 M9 5 L2 1 M9 5 L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" /> },
  { marker: "er-many", path: () => <path d="M9 5 L2 1 M9 5 L2 5 M9 5 L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" /> },
];

/** 全局 marker defs：渲染一次，供所有 edge 引用。 */
function DiagramMarkers() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true">
      <defs>
        {(["start", "end"] as const).flatMap((end) =>
          MARKER_DEFS.map(({ marker, path }) => (
            <marker
              key={`${marker}-${end}`}
              id={`diagram-marker-${marker}-${end}`}
              viewBox="0 0 10 10"
              refX={end === "end" ? 9 : 1}
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient={end === "end" ? "auto" : "auto-start-reverse"}
              markerUnits="strokeWidth"
            >
              {path(`diagram-marker-${marker}-${end}`)}
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 形状选择浮层（连线拖到空白处）
// ---------------------------------------------------------------------------

const CONNECTION_MENU_SHAPES: Array<{ kind: ShapeKind; label: string }> = [
  { kind: "rectangle", label: "矩形" },
  { kind: "rounded-rectangle", label: "圆角矩形" },
  { kind: "diamond", label: "判断" },
  { kind: "pill", label: "开始/结束" },
  { kind: "parallelogram", label: "输入/输出" },
  { kind: "document", label: "文档" },
  { kind: "cylinder", label: "数据库" },
  { kind: "ellipse", label: "椭圆" },
];

// ---------------------------------------------------------------------------
// 画布主体
// ---------------------------------------------------------------------------

const DiagramCanvasInner = forwardRef<DiagramCanvasHandle, DiagramCanvasProps>(function DiagramCanvasInner({
  document: doc,
  readOnly = false,
  selection,
  initialViewport,
  noteId,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onReconnect,
  onViewportChange,
  onSelectionChange,
  onElementLabelEdit,
  onElementTitleEdit,
  onConnectorLabelEdit,
  onDropShape,
  onCreateElementWithConnection,
  onContextMenu,
  activeTool = "select",
  penColor = "#18181b",
  penSize = PEN_STYLE.size,
  highlighterColor = "#facc15",
  highlighterSize = HIGHLIGHTER_STYLE.size,
  onFreehandComplete,
  onEraseFreehand,
  showGrid = true,
  snapToGrid = true,
}, ref) {
  const reactFlowWrapper = useRef<HTMLDivElement | null>(null);
  const {
    screenToFlowPosition,
    setViewport,
    getViewport,
    getNodes,
    getNodesBounds,
    setNodes,
    setEdges,
  } = useReactFlow();
  const viewport = useViewport();

  // 元素渲染所需的 doc 引用（assets 等）
  dataDocumentRef.current = doc;

  const labelCallbacks = useMemo(
    () => ({ onLabelEdit: onElementLabelEdit, onTitleEdit: onElementTitleEdit }),
    [onElementLabelEdit, onElementTitleEdit],
  );
  const connectorCallbacks = useMemo(
    () => ({ onLabelEdit: onConnectorLabelEdit }),
    [onConnectorLabelEdit],
  );

  const flowNodes = useMemo(() => {
    const nodes = docToFlowNodes(doc, readOnly, labelCallbacks);
    if (selection && selection.elementIds.length > 0) {
      const selected = new Set(selection.elementIds);
      return nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    }
    return nodes;
  }, [doc, readOnly, labelCallbacks, selection]);
  const flowEdges = useMemo(() => {
    const edges = docToFlowEdges(doc, readOnly, connectorCallbacks);
    if (selection && selection.connectorIds.length > 0) {
      const selected = new Set(selection.connectorIds);
      return edges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    }
    return edges;
  }, [doc, readOnly, connectorCallbacks, selection]);

  // ── viewport 恢复 / 新建居中（与 flowchart 同一策略）─────────────────────
  const viewportRestoredRef = useRef(false);
  const lastNoteIdRef = useRef(noteId);
  useEffect(() => {
    if (noteId !== lastNoteIdRef.current) {
      lastNoteIdRef.current = noteId;
      viewportRestoredRef.current = false;
    }
    if (viewportRestoredRef.current) return;
    const apply = () => {
      const allNodes = getNodes();
      if (allNodes.length === 0) {
        viewportRestoredRef.current = true;
        return;
      }
      if (
        initialViewport &&
        (initialViewport.x !== 0 || initialViewport.y !== 0 || initialViewport.zoom !== 1)
      ) {
        setViewport(initialViewport, { duration: 0 });
        viewportRestoredRef.current = true;
        return;
      }
      const surfaceEl = reactFlowWrapper.current;
      const rfEl = surfaceEl?.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) {
        viewportRestoredRef.current = true;
        return;
      }
      const bounds = getNodesBounds(allNodes);
      const containerRect = rfEl.getBoundingClientRect();
      setViewport(
        {
          x: containerRect.width / 2 - (bounds.x + bounds.width / 2),
          y: containerRect.height / 2 - (bounds.y + bounds.height / 2),
          zoom: 1,
        },
        { duration: 0 },
      );
      viewportRestoredRef.current = true;
    };
    const timer = setTimeout(apply, 0);
    return () => clearTimeout(timer);
  }, [noteId, initialViewport, setViewport, getNodes, getNodesBounds]);

  // ── 受控变化上抛 ────────────────────────────────────────────────────────
  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      if (readOnly) {
        const safe = changes.filter((c) => c.type === "position" || c.type === "select");
        if (safe.length > 0) onNodesChange?.(safe);
        return;
      }
      onNodesChange?.(changes);
    },
    [readOnly, onNodesChange],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      if (readOnly) {
        const safe = changes.filter((c) => c.type !== "remove");
        if (safe.length > 0) onEdgesChange?.(safe);
        return;
      }
      onEdgesChange?.(changes);
    },
    [readOnly, onEdgesChange],
  );

  const handleConnect = useCallback<OnConnect>(
    (connection) => {
      if (readOnly || !connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      onConnect?.({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? undefined,
        targetHandle: connection.targetHandle ?? undefined,
      });
    },
    [readOnly, onConnect],
  );

  // 拖线到空白处：形状选择浮层
  const [connectionMenu, setConnectionMenu] = useState<{
    x: number;
    y: number;
    source: string;
    sourceHandle?: string;
  } | null>(null);
  const [preferredKind, setPreferredKind] = useState<ShapeKind | null>(null);

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      if (readOnly || !onCreateElementWithConnection) return;
      if (connectionState.isValid) return;
      const fromNode = connectionState.fromNode;
      if (!fromNode) return;
      const clientX = "clientX" in event ? event.clientX : event.changedTouches?.[0]?.clientX;
      const clientY = "clientY" in event ? event.clientY : event.changedTouches?.[0]?.clientY;
      if (clientX === undefined || clientY === undefined) return;
      setConnectionMenu({
        x: clientX,
        y: clientY,
        source: fromNode.id,
        sourceHandle: connectionState.fromHandle?.id ?? undefined,
      });
    },
    [readOnly, onCreateElementWithConnection],
  );

  const handleConnectionMenuSelect = useCallback(
    (kind: ShapeKind) => {
      const menu = connectionMenu;
      setConnectionMenu(null);
      if (!menu) return;
      const flowPosition = screenToFlowPosition({ x: menu.x, y: menu.y });
      setPreferredKind(kind);
      onCreateElementWithConnection?.(kind, flowPosition, {
        source: menu.source,
        sourceHandle: menu.sourceHandle,
      });
    },
    [connectionMenu, screenToFlowPosition, onCreateElementWithConnection],
  );

  useEffect(() => {
    if (!connectionMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".diagram-connection-menu")) setConnectionMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectionMenu(null);
    };
    window.document.addEventListener("mousedown", onDown);
    window.document.addEventListener("keydown", onKey);
    return () => {
      window.document.removeEventListener("mousedown", onDown);
      window.document.removeEventListener("keydown", onKey);
    };
  }, [connectionMenu]);

  // 边重连
  const handleReconnect = useCallback(
    (edge: Edge, newConnection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      if (readOnly) return;
      if (newConnection.source === newConnection.target) return;
      onReconnect?.(edge.id, {
        source: newConnection.source,
        target: newConnection.target,
        sourceHandle: newConnection.sourceHandle ?? undefined,
        targetHandle: newConnection.targetHandle ?? undefined,
      });
    },
    [readOnly, onReconnect],
  );

  // 双击边编辑 label
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [edgeEditValue, setEdgeEditValue] = useState("");
  const [edgeEditPosition, setEdgeEditPosition] = useState<{ x: number; y: number } | null>(null);
  const edgeEditInputRef = useRef<HTMLTextAreaElement | null>(null);

  const handleEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (readOnly || !onConnectorLabelEdit) return;
      event.stopPropagation();
      setEditingEdgeId(edge.id);
      setEdgeEditValue(String(edge.label ?? ""));
      setEdgeEditPosition({ x: event.clientX, y: event.clientY });
      requestAnimationFrame(() => {
        edgeEditInputRef.current?.focus();
        edgeEditInputRef.current?.select();
      });
    },
    [readOnly, onConnectorLabelEdit],
  );

  const commitEdgeEdit = useCallback(() => {
    if (!editingEdgeId) return;
    onConnectorLabelEdit?.(editingEdgeId, edgeEditValue.trim());
    setEditingEdgeId(null);
    setEdgeEditValue("");
    setEdgeEditPosition(null);
  }, [editingEdgeId, edgeEditValue, onConnectorLabelEdit]);

  // 拖放形状
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (readOnly || !onDropShape) return;
      const kind = e.dataTransfer.getData("application/x-diagram-shape") as ShapeKind | "";
      if (!kind) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onDropShape(kind, position.x, position.y);
    },
    [readOnly, onDropShape, screenToFlowPosition],
  );

  // ── 导出（与 flowchart 同一链路：html-to-image 截取 .react-flow）────────
  const exportImage = useCallback(
    async (format: "png" | "svg", options: DiagramExportOptions = {}): Promise<string> => {
      const scale = options.scale ?? 1;
      const background = options.background ?? "theme";
      const surfaceEl = reactFlowWrapper.current;
      if (!surfaceEl) throw new Error("画布未就绪，无法导出");
      const rfEl = surfaceEl.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) throw new Error("React Flow 容器未就绪，无法导出");
      const allNodes = getNodes().filter((n) => n.type !== "diagram-anchor");
      if (allNodes.length === 0) throw new Error("画布上没有元素，无法导出");

      setEditingEdgeId(null);
      surfaceEl.classList.add("flowchart-exporting");

      const prevViewport = getViewport();
      const bounds = getNodesBounds(allNodes);
      const containerRect = rfEl.getBoundingClientRect();
      const padding = 40;
      const availableWidth = Math.max(containerRect.width - padding * 2, 100);
      const availableHeight = Math.max(containerRect.height - padding * 2, 100);
      const zoom = Math.min(
        availableWidth / Math.max(bounds.width, 1),
        availableHeight / Math.max(bounds.height, 1),
        1.5,
      );
      const x = -bounds.x * zoom + (containerRect.width - bounds.width * zoom) / 2;
      const y = -bounds.y * zoom + (containerRect.height - bounds.height * zoom) / 2;
      setViewport({ x, y, zoom }, { duration: 0 });

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      try {
        const backgroundColor =
          background === "transparent"
            ? undefined
            : getComputedStyle(surfaceEl).getPropertyValue("--flowchart-canvas").trim() || "#ffffff";
        const opts = {
          pixelRatio: scale,
          backgroundColor,
          filter: (node: HTMLElement) => {
            if (!node.classList) return true;
            return (
              !node.classList.contains("react-flow__controls") &&
              !node.classList.contains("react-flow__minimap")
            );
          },
        };
        return format === "png" ? await toPng(rfEl, opts) : await toSvg(rfEl, opts);
      } finally {
        setViewport(prevViewport, { duration: 0 });
        surfaceEl.classList.remove("flowchart-exporting");
      }
    },
    [getNodes, getNodesBounds, getViewport, setViewport],
  );

  const exportToPng = useCallback(
    (options?: DiagramExportOptions) => exportImage("png", options),
    [exportImage],
  );
  const exportToSvg = useCallback(
    (options?: DiagramExportOptions) => exportImage("svg", options),
    [exportImage],
  );

  const fitView = useCallback(
    (padding: number = 24) => {
      const allNodes = getNodes().filter((n) => n.type !== "diagram-anchor");
      if (allNodes.length === 0) return;
      const rfEl = reactFlowWrapper.current?.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) return;
      const bounds = getNodesBounds(allNodes);
      const containerRect = rfEl.getBoundingClientRect();
      const pad = padding < 1 ? 24 : padding;
      const zoom = Math.min(
        Math.max(containerRect.width - pad * 2, 100) / Math.max(bounds.width, 1),
        Math.max(containerRect.height - pad * 2, 100) / Math.max(bounds.height, 1),
        2.5,
      );
      setViewport(
        {
          x: -bounds.x * zoom + (containerRect.width - bounds.width * zoom) / 2,
          y: -bounds.y * zoom + (containerRect.height - bounds.height * zoom) / 2,
          zoom,
        },
        { duration: 200 },
      );
    },
    [getNodes, getNodesBounds, setViewport],
  );

  const selectAll = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.type === "diagram-anchor" ? n : { ...n, selected: true })));
    setEdges((eds) => eds.map((e) => ({ ...e, selected: true })));
  }, [setNodes, setEdges]);

  // 右键菜单
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (!onContextMenu || node.type === "diagram-anchor") return;
      event.preventDefault();
      onContextMenu({ kind: "element", elementId: node.id, x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );
  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({ kind: "connector", connectorId: edge.id, x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );
  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({ kind: "pane", x: event.clientX ?? 0, y: event.clientY ?? 0 });
    },
    [onContextMenu],
  );

  // ── freehand 绘制 overlay ───────────────────────────────────────────────
  const isDrawingTool = activeTool === "pen" || activeTool === "highlighter" || activeTool === "eraser";
  const [previewPath, setPreviewPath] = useState<string>("");
  const drawingPointsRef = useRef<FreehandPoint[]>([]);
  const erasingIdsRef = useRef<Set<string>>(new Set());
  const drawingActiveRef = useRef(false);

  const activeBrushStyle: FreehandStyle = useMemo(() => {
    if (activeTool === "highlighter") return { ...HIGHLIGHTER_STYLE, size: highlighterSize };
    return { ...PEN_STYLE, size: penSize };
  }, [activeTool, penSize, highlighterSize]);
  const activeBrushColor = activeTool === "highlighter" ? highlighterColor : penColor;
  const activeBrushOpacity = activeTool === "highlighter" ? 0.28 : 1;

  const eraseAtPoint = useCallback(
    (flowPoint: { x: number; y: number }) => {
      if (!onEraseFreehand) return;
      const hitIds: string[] = [];
      const eraseRadius = 12;
      for (const n of getNodes()) {
        const data = n.data as DiagramNodeData | undefined;
        const el = data?.element;
        if (!el || el.type !== "freehand") continue;
        if (erasingIdsRef.current.has(n.id)) continue;
        const nw = typeof n.width === "number" ? n.width : 0;
        const nh = typeof n.height === "number" ? n.height : 0;
        if (
          flowPoint.x >= n.position.x - eraseRadius &&
          flowPoint.x <= n.position.x + nw + eraseRadius &&
          flowPoint.y >= n.position.y - eraseRadius &&
          flowPoint.y <= n.position.y + nh + eraseRadius
        ) {
          hitIds.push(n.id);
          erasingIdsRef.current.add(n.id);
        }
      }
      if (hitIds.length > 0) onEraseFreehand(hitIds);
    },
    [getNodes, onEraseFreehand],
  );

  const handleDrawingPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDrawingTool || readOnly) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drawingActiveRef.current = true;
      if (activeTool === "eraser") erasingIdsRef.current.clear();
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (activeTool === "eraser") {
        eraseAtPoint(flowPoint);
        return;
      }
      drawingPointsRef.current = [{ ...flowPoint, pressure: event.pressure || 0.5 }];
    },
    [isDrawingTool, readOnly, activeTool, screenToFlowPosition, eraseAtPoint],
  );

  const handleDrawingPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drawingActiveRef.current || !isDrawingTool || readOnly) return;
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (activeTool === "eraser") {
        eraseAtPoint(flowPoint);
        return;
      }
      const next = [...drawingPointsRef.current, { ...flowPoint, pressure: event.pressure || 0.5 }];
      drawingPointsRef.current = next;
      const outline = getFreehandOutline(next, activeBrushStyle);
      if (outline.length > 0) setPreviewPath(getSvgPathFromStroke(outline));
    },
    [isDrawingTool, readOnly, activeTool, screenToFlowPosition, eraseAtPoint, activeBrushStyle],
  );

  const handleDrawingPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drawingActiveRef.current) return;
      drawingActiveRef.current = false;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (activeTool === "eraser") {
        erasingIdsRef.current.clear();
        return;
      }
      const completedPoints = drawingPointsRef.current.map((p) => ({ ...p }));
      if (completedPoints.length > 0 && onFreehandComplete) {
        const geometry = createFreehandGeometry(completedPoints, activeBrushStyle);
        if (geometry) {
          onFreehandComplete({
            points: completedPoints,
            position: { x: geometry.x, y: geometry.y },
            size: { width: geometry.width, height: geometry.height },
            path: geometry.path,
            tool: activeTool === "highlighter" ? "highlighter" : "pen",
            color: activeBrushColor,
            opacity: activeBrushOpacity,
            strokeWidth: activeBrushStyle.size,
          });
        }
      }
      drawingPointsRef.current = [];
      setPreviewPath("");
    },
    [activeTool, activeBrushStyle, activeBrushColor, activeBrushOpacity, onFreehandComplete],
  );

  useEffect(() => {
    if (!isDrawingTool) {
      drawingActiveRef.current = false;
      drawingPointsRef.current = [];
      setPreviewPath("");
      erasingIdsRef.current.clear();
    }
  }, [isDrawingTool]);

  const rfPanOnDrag: boolean | number[] = useMemo(() => {
    if (activeTool === "hand") return true;
    if (isDrawingTool) return [1];
    return [1];
  }, [activeTool, isDrawingTool]);
  const rfSelectionOnDrag = !isDrawingTool && activeTool !== "hand";

  useImperativeHandle(
    ref,
    () => ({
      exportToPng,
      exportToSvg,
      fitView,
      selectAll,
      setZoom: (z: number) => {
        const vp = getViewport();
        setViewport({ x: vp.x, y: vp.y, zoom: z }, { duration: 120 });
      },
      getZoom: () => getViewport().zoom,
    }),
    [exportToPng, exportToSvg, fitView, selectAll, getViewport, setViewport],
  );

  return (
    <div
      ref={reactFlowWrapper}
      className={cn("flowchart-surface h-full w-full", readOnly && "flowchart-readonly")}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <DiagramMarkers />
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onReconnect={handleReconnect}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onSelectionChange={({ nodes: ns, edges: es }) => {
          onSelectionChange?.({
            elementIds: ns.filter((n) => n.type !== "diagram-anchor").map((n) => n.id),
            connectorIds: es.map((e) => e.id),
          });
        }}
        onMoveEnd={(_, vp: Viewport) => onViewportChange?.({ x: vp.x, y: vp.y, zoom: vp.zoom })}
        nodesDraggable={!readOnly && !isDrawingTool}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        edgesFocusable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        fitView={false}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        panOnDrag={rfPanOnDrag}
        selectionOnDrag={rfSelectionOnDrag}
        selectionMode={SelectionMode.Partial}
        connectionRadius={28}
        nodeDragThreshold={1}
        snapToGrid={!readOnly && snapToGrid}
        snapGrid={[8, 8]}
      >
        {showGrid && (
          <Background variant={BackgroundVariant.Lines} gap={doc.canvas.grid.size * 2} color="var(--flowchart-grid)" />
        )}
        <MiniMap
          pannable
          zoomable
          className="!bg-[var(--flowchart-node-bg)] !border-[var(--flowchart-node-border)]"
          maskColor="hsl(var(--muted-foreground) / 0.12)"
          nodeColor={(n) => {
            const el = (n.data as DiagramNodeData | undefined)?.element;
            if (!el) return "transparent";
            if (el.type === "group" || el.type === "container") return "#a1a1aa";
            if (el.type === "shape" && el.semantic?.role === "start") return "#3b82f6";
            if (el.type === "shape" && el.semantic?.role === "end") return "#3b82f6";
            if (el.type === "shape" && el.shapeKind === "diamond") return "#f59e0b";
            return "#64748b";
          }}
          nodeStrokeColor={() => "#94a3b8"}
          nodeBorderRadius={8}
        />
      </ReactFlow>

      {/* 连线拖到空白处的形状选择浮层 */}
      {connectionMenu && (
        <div
          className="diagram-connection-menu absolute z-50 flex w-72 flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg"
          style={{
            left: connectionMenu.x - (reactFlowWrapper.current?.getBoundingClientRect().left ?? 0),
            top: connectionMenu.y - (reactFlowWrapper.current?.getBoundingClientRect().top ?? 0),
          }}
        >
          <div className="flex flex-col gap-0.5 px-4 pb-2 pt-3">
            <div className="text-sm font-medium text-foreground">选择形状创建元素</div>
            <div className="text-xs text-muted-foreground">点击形状将在连线终点创建新元素并自动连线</div>
          </div>
          <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto p-3 scrollbar-thin">
            {[
              ...(preferredKind ? CONNECTION_MENU_SHAPES.filter((s) => s.kind === preferredKind) : []),
              ...CONNECTION_MENU_SHAPES.filter((s) => s.kind !== preferredKind),
            ].map((s) => (
              <button
                key={s.kind}
                type="button"
                onClick={() => handleConnectionMenuSelect(s.kind)}
                className="flex h-14 flex-col items-center justify-center gap-1 rounded-md border border-border/70 text-[11px] text-foreground/80 hover:bg-accent"
              >
                <svg viewBox="0 0 200 100" className="h-6 w-12" preserveAspectRatio="none">
                  {shapeRenderApi.renderShapeSvg({
                    kind: s.kind,
                    fill: "var(--card)",
                    stroke: "var(--border)",
                    strokeWidth: 2,
                  })}
                </svg>
                <span className="max-w-full truncate">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* freehand 绘制 overlay */}
      {isDrawingTool && !readOnly && (
        <div
          className="absolute inset-0 z-20"
          style={{ pointerEvents: "auto", cursor: "crosshair", touchAction: "none" }}
          onPointerDown={handleDrawingPointerDown}
          onPointerMove={handleDrawingPointerMove}
          onPointerUp={handleDrawingPointerUp}
          onPointerCancel={handleDrawingPointerUp}
        >
          {previewPath && (
            <svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
              <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
                <path d={previewPath} fill={activeBrushColor} fillOpacity={activeBrushOpacity} stroke="none" />
              </g>
            </svg>
          )}
        </div>
      )}

      {/* 边 label 编辑浮层 */}
      {editingEdgeId && edgeEditPosition && (
        <div className="fixed inset-0 z-50" onMouseDown={commitEdgeEdit}>
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: Math.min(Math.max(edgeEditPosition.x, 90), window.innerWidth - 90),
              top: Math.min(Math.max(edgeEditPosition.y, 24), window.innerHeight - 24),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <textarea
              ref={edgeEditInputRef}
              value={edgeEditValue}
              onChange={(e) => setEdgeEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitEdgeEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingEdgeId(null);
                  setEdgeEditValue("");
                  setEdgeEditPosition(null);
                }
              }}
              onBlur={commitEdgeEdit}
              className="min-w-[160px] max-w-[280px] rounded-md border-2 border-primary bg-background px-2 py-1 text-xs shadow-lg outline-none"
              rows={1}
              placeholder="回车确认 / Esc 取消"
            />
          </div>
        </div>
      )}
    </div>
  );
});

export const DiagramCanvas = forwardRef<DiagramCanvasHandle, DiagramCanvasProps>(
  function DiagramCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <DiagramCanvasInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  },
);

// ---------------------------------------------------------------------------
// Footer（与 flowchart footer 同一视觉：左侧网格/吸附/自动布局，右侧缩放）
// ---------------------------------------------------------------------------

export interface DiagramFooterProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFitView: () => void;
  showGrid: boolean;
  onShowGridChange: (show: boolean) => void;
  snapToGrid: boolean;
  onSnapToGridChange: (snap: boolean) => void;
  onAutoLayout: () => void;
  readOnly?: boolean;
}

function FooterButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-md transition-colors",
            "text-muted-foreground hover:bg-accent hover:text-foreground",
            active && "bg-accent text-foreground",
            disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function ZoomInput({ zoom, onZoomChange }: { zoom: number; onZoomChange: (z: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(String(Math.round(zoom * 100)));
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, zoom]);

  const commit = () => {
    const num = Number(draft.replace(/[^\d.]/g, ""));
    if (Number.isFinite(num)) {
      onZoomChange(Math.min(2.5, Math.max(0.2, num / 100)));
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-9 cursor-pointer rounded text-right tabular-nums hover:bg-accent"
          >
            {Math.round(zoom * 100)}%
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">点击输入缩放比例</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className="w-9 rounded border border-input bg-background px-0.5 text-right tabular-nums text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function DiagramFooter({
  zoom,
  onZoomChange,
  onFitView,
  showGrid,
  onShowGridChange,
  snapToGrid,
  onSnapToGridChange,
  onAutoLayout,
  readOnly = false,
}: DiagramFooterProps) {
  return (
    <div className="flex h-6 max-h-6 min-h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs text-muted-foreground">
      <div className="flex shrink-0 items-center gap-0.5">
        <FooterButton
          label={showGrid ? "网格：开" : "网格：关"}
          active={showGrid}
          onClick={() => onShowGridChange(!showGrid)}
        >
          <Grid3X3 className="h-3 w-3" />
        </FooterButton>
        <FooterButton
          label={snapToGrid ? "吸附：开" : "吸附：关"}
          active={snapToGrid}
          disabled={readOnly}
          onClick={() => onSnapToGridChange(!snapToGrid)}
        >
          <Magnet className="h-3 w-3" />
        </FooterButton>
        <FooterButton label="自动布局" disabled={readOnly} onClick={onAutoLayout}>
          <WandSparkles className="h-3 w-3" />
        </FooterButton>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <div className="flex items-center gap-1.5 px-1">
          <ZoomOut className="h-3 w-3 cursor-pointer" aria-hidden="true" onClick={() => onZoomChange(Math.max(0.2, zoom - 0.1))} />
          <input
            type="range"
            min={0.2}
            max={2.5}
            step={0.05}
            value={zoom}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            aria-label="缩放"
            className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-muted accent-[hsl(var(--theme))]"
          />
          <ZoomIn className="h-3 w-3 cursor-pointer" aria-hidden="true" onClick={() => onZoomChange(Math.min(2.5, zoom + 0.1))} />
          <ZoomInput zoom={zoom} onZoomChange={onZoomChange} />
        </div>
        <FooterButton label="适应视图" onClick={onFitView}>
          <Maximize2 className="h-3 w-3" />
        </FooterButton>
      </div>
    </div>
  );
}
