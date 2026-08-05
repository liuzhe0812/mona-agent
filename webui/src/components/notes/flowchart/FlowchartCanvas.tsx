/**
 * React Flow 画布组件：渲染流程图节点/边，处理拖动、连线和选区。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §8.4
 *
 * 主题：根容器加 .flowchart-surface 类，节点/边样式只消费 --flowchart-* token。
 * 不在此组件硬编码浅色/深色值。
 *
 * 只读模式：禁用节点拖动、连线、删除和编辑，保留平移缩放。
 *
 * 节点类型：start/end（椭圆）、process（矩形）、decision（菱形）、
 * document（文档波形）、database（圆柱）、annotation（虚线框）、subprocess（双边框）。
 * 每种类型通过 SVG 形状 + 主题 token 实现 WPS 风格。
 *
 * 样式覆盖：节点/边的 style 字段通过 CSS 变量注入到 .flowchart-node-wps 容器，
 * 由 globals.css 中的 var(--node-*) 消费。
 */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type OnNodesChange,
  NodeResizer,
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  SelectionMode,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useViewport,
  type Viewport,
} from "@xyflow/react";
import { getNotesVaultPath, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";
import {
  Grid3X3,
  Magnet,
  WandSparkles,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type {
  FlowchartDirection,
  FlowchartEdge,
  FlowchartEdgeStyle,
  FlowchartNode,
  FlowchartNodeKind,
  FlowchartNodeStyle,
} from "./flowchart-document";
import { SHAPES } from "./FlowchartShapePanel";
import {
  HIGHLIGHTER_STYLE,
  PEN_STYLE,
  createFreehandGeometry,
  type FreehandPoint,
  type FreehandStyle,
  getFreehandOutline,
  getSvgPathFromStroke,
} from "./freehand";

// ---------------------------------------------------------------------------
// 节点组件（WPS 风格）
// ---------------------------------------------------------------------------

interface FlowchartNodeData {
  kind: FlowchartNodeKind;
  label: string;
  style?: FlowchartNodeStyle;
  /** 是否允许缩放（仅非只读模式） */
  resizable?: boolean;
  /** 是否只读（禁用编辑） */
  readOnly?: boolean;
  /** label 编辑回调 */
  onLabelEdit?: (nodeId: string, label: string) => void;
  /** 图片节点：相对于 vault 根目录的图片路径 */
  imagePath?: string;
  /** freehand 节点：原始笔触点（含压感） */
  points?: FreehandPoint[];
  /** freehand 节点：本地化 SVG path */
  path?: string;
  /** freehand 节点：笔触工具 */
  drawingTool?: "pen" | "highlighter";
  /** freehand 节点：笔触颜色 */
  color?: string;
  /** freehand 节点：不透明度 */
  opacity?: number;
  /** freehand 节点：笔触宽度 */
  strokeWidth?: number;
  [key: string]: unknown;
}

/** 把 FlowchartNodeStyle 转为 CSS 变量对象，注入到节点容器。 */
function styleToCssVars(style: FlowchartNodeStyle | undefined): Record<string, string> {
  if (!style) return {};
  const vars: Record<string, string> = {};
  if (style.fill) vars["--node-fill"] = style.fill;
  if (style.color) vars["--node-text"] = style.color;
  if (style.borderColor) vars["--node-border"] = style.borderColor;
  if (typeof style.borderWidth === "number") vars["--node-border-width"] = `${style.borderWidth}px`;
  if (style.borderStyle) vars["--node-border-style"] = style.borderStyle;
  if (typeof style.fontSize === "number") vars["--node-font-size"] = `${style.fontSize}px`;
  if (style.fontFamily) vars["--node-font-family"] = style.fontFamily;
  if (typeof style.bold === "boolean") vars["--node-font-weight"] = style.bold ? "700" : "400";
  if (typeof style.italic === "boolean") vars["--node-font-style"] = style.italic ? "italic" : "normal";
  if (typeof style.underline === "boolean") vars["--node-text-decoration"] = style.underline ? "underline" : "none";
  if (style.textAlign) vars["--node-text-align"] = style.textAlign;
  return vars;
}

/** 把 FlowchartEdgeStyle 转为 React Flow edge 的 style 属性。 */
function edgeStyleToCss(style: FlowchartEdgeStyle | undefined): React.CSSProperties | undefined {
  if (!style) return undefined;
  const css: React.CSSProperties = {};
  if (style.stroke) css.stroke = style.stroke;
  if (typeof style.strokeWidth === "number") css.strokeWidth = style.strokeWidth;
  if (style.strokeDasharray === "dashed") css.strokeDasharray = "6 3";
  else if (style.strokeDasharray === "dotted") css.strokeDasharray = "2 3";
  else css.strokeDasharray = "none";
  return css;
}

/** 四方向 Handle 组件：每个方向同时渲染 source + target 两个 handle（同方向重叠）。
 *  参考 NoteGen 的 ConnectionHandles 配置：任意方向都能拖出连线，也能接受连入。
 *  handle id 使用 `{dir}-source` / `{dir}-target` 格式，与 toFlowEdge 的归一化逻辑一致。 */
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

/** 根据 FlowchartNodeKind 返回 SVG 形状元素。
 *  100% 对齐 NoteGen canvas-nodes.tsx 的 SVG 定义：
 *  - 统一 viewBox="0 0 200 100" + preserveAspectRatio="none" + vectorEffect: non-scaling-stroke
 *  - 形状 className: 'fill-card stroke-border'（由 CSS 变量 --card / --border 控制颜色）
 *  - 用户自定义样式通过 svgShapeStyle 覆盖 fill/stroke/strokeWidth/strokeDasharray
 *  - 默认 strokeWidth=1，dashed='8 6'，dotted='2 5'
 */
function renderShape(
  kind: FlowchartNodeKind,
  selected: boolean,
  cssVars: Record<string, string>,
): React.ReactNode {
  // 100% 对齐 NoteGen 的 svgShapeStyle：用户自定义优先，否则用 CSS 变量
  const userFill = cssVars["--node-fill"];
  const userStroke = cssVars["--node-border"];
  const userBorderWidth = cssVars["--node-border-width"];
  const userBorderStyle = cssVars["--node-border-style"];

  const style: React.CSSProperties = {
    fill: userFill || undefined,
    stroke: userStroke || undefined,
    strokeWidth: userBorderWidth ? parseFloat(userBorderWidth) : 1,
    strokeDasharray:
      userBorderStyle === "dashed" ? "8 6"
      : userBorderStyle === "dotted" ? "2 5"
      : undefined,
    vectorEffect: "non-scaling-stroke",
  };

  // 形状 className：未自定义时用主题 token（fill-card stroke-border 等价）
  const shapeClassName = !userFill && !userStroke ? "fill-card stroke-border" : "";

  // 选中状态：NoteGen 不改 stroke 颜色，仅通过外层 drop-shadow 增强
  // 这里保持 selected 参数用于未来扩展，但形状本身不变色
  void selected;

  const common = { className: shapeClassName, style };

  switch (kind) {
    case "decision":
      return <polygon points="100,1 199,50 100,99 1,50" {...common} />;
    case "start":
    case "end":
    case "terminator":
      return <rect x="1" y="1" width="198" height="98" rx="49" {...common} />;
    case "input-output":
      return <polygon points="24,1 199,1 176,99 1,99" {...common} />;
    case "document":
      return <path d="M1 1H199V80C160 60 132 100 99 81C65 61 35 100 1 82Z" {...common} />;
    case "multi-document":
      return (
        <>
          <path d="M15 1H199V73C163 57 137 90 106 75C76 60 49 90 15 75Z" {...common} />
          <path d="M8 9H192V81C156 65 130 98 99 83C69 68 42 98 8 83Z" {...common} />
          <path d="M1 17H185V89C149 73 123 106 92 91C62 76 35 106 1 91Z" {...common} />
        </>
      );
    case "database":
      return (
        <>
          <path d="M1 17C1 8 45 1 100 1S199 8 199 17V83C199 92 155 99 100 99S1 92 1 83Z" {...common} />
          <ellipse
            className="fill-none stroke-border"
            cx="100"
            cy="17"
            rx="99"
            ry="16"
            style={{
              stroke: style.stroke,
              strokeWidth: style.strokeWidth,
              strokeDasharray: style.strokeDasharray,
              vectorEffect: "non-scaling-stroke",
            }}
          />
        </>
      );
    case "annotation":
      return (
        <>
          <path d="M 1 1 L 1 99" stroke={style.stroke || "var(--border)"} strokeWidth={((style.strokeWidth as number | undefined) ?? 1) * 2} strokeDasharray={style.strokeDasharray} vectorEffect="non-scaling-stroke" fill="none" />
          <rect x="1" y="1" width="198" height="98" rx="4" {...common} fill="none" />
        </>
      );
    case "subprocess":
    case "predefined-process":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" rx="6" {...common} />
          <path className="fill-none stroke-border" d="M24 1V99M176 1V99" style={style} />
        </>
      );
    case "manual-input":
      return <polygon points="1,25 199,1 199,99 1,99" {...common} />;
    case "preparation":
      return <polygon points="28,1 172,1 199,50 172,99 28,99 1,50" {...common} />;
    case "delay":
      return <path d="M1 1H126C167 1 199 23 199 50S167 99 126 99H1Z" {...common} />;
    case "display":
      return <path d="M25 1H132C174 1 199 23 199 50S174 99 132 99H25C43 75 43 25 25 1Z" {...common} />;
    case "connector":
      return <ellipse cx="100" cy="50" rx="49" ry="49" {...common} />;
    case "off-page-connector":
      return <polygon points="1,1 199,1 199,66 100,99 1,66" {...common} />;
    case "internal-storage":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" rx="4" {...common} />
          <path className="fill-none stroke-border" d="M28 1V99M1 24H199" style={style} />
        </>
      );
    case "stored-data":
      return <path d="M24 1H176C207 20 207 80 176 99H24C-7 80-7 20 24 1Z" {...common} />;
    case "text":
      // text 节点：无 SVG 形状，仅渲染文本（对齐 NoteGen TextCanvasNode）
      return null;
    case "process":
    default:
      return <rect x="1" y="1" width="198" height="98" rx="8" {...common} />;
  }
}

/**
 * 原地编辑 label 组件：双击时把 div 替换为 textarea，编辑完失焦或 Esc 退出。
 * 参考 note-gen-dev 的 EditableLabel 实现。
 * - nodog / nowheel：编辑时不被画布拖动/滚轮劫持
 * - 编辑框相对节点定位，随画布缩放平移自动跟随
 */
const EditableLabel = memo(function EditableLabel({
  nodeId,
  value,
  readOnly,
  onLabelEdit,
  className,
  style,
}: {
  nodeId: string;
  value: string;
  readOnly: boolean;
  onLabelEdit?: (nodeId: string, label: string) => void;
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

  // 外部 value 变化时同步 draft（非编辑态）
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
        aria-label="Node label"
      >
        {value}
      </div>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    onLabelEdit?.(nodeId, trimmed || "新节点");
    setEditing(false);
  };

  return (
    <textarea
      ref={editorRef}
      className={cn("nodrag nowheel max-h-full w-full resize-none overflow-hidden bg-transparent text-center outline-none", className)}
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
      aria-label="Node label editor"
    />
  );
});

function FlowchartNodeView({ id, data, selected, width, height }: NodeProps<Node>) {
  const d = data as unknown as FlowchartNodeData;
  const cssVars = useMemo(() => styleToCssVars(d.style), [d.style]);
  const className = `flowchart-node-wps ${d.kind}${selected ? " selected" : ""}`;
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    if (d.kind !== "image" || !d.imagePath) {
      setImageSrc(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      let src = d.imagePath as string;
      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          const vaultPath = await getNotesVaultPath();
          if (vaultPath) {
            src = convertFileSrc(`${vaultPath}/${d.imagePath}`);
          }
        } catch (e) {
          console.warn("[flowchart] convert image path failed", e);
        }
      }
      if (!cancelled) setImageSrc(src);
    })();
    return () => { cancelled = true; };
  }, [d.kind, d.imagePath]);

  // freehand 节点：渲染 SVG path，不可连接、不渲染 FourHandles
  // 参考 NoteGen FreehandNode：用 feMorphology 调整笔触宽度差异，colorInterpolationFilters 保证色彩
  if (d.kind === "freehand") {
    const nodeWidth = typeof width === "number" && width > 0 ? width : 4;
    const nodeHeight = typeof height === "number" && height > 0 ? height : 4;
    const pathStrokeWidth = d.strokeWidth;
    const widthAdjustment =
      typeof pathStrokeWidth === "number" && typeof d.strokeWidth === "number"
        ? (d.strokeWidth - pathStrokeWidth) / 2
        : 0;
    const filterRadius = Math.abs(widthAdjustment);
    const filterId = `freehand-width-${id}`;
    const color = d.color || "currentColor";
    const opacity = d.opacity ?? 1;
    const w = Math.max(nodeWidth, 4);
    const h = Math.max(nodeHeight, 4);

    return (
      <div className={className} style={{ ...cssVars, width: "100%", height: "100%" }}>
        {selected && d.resizable && (
          <NodeResizer
            minWidth={4}
            minHeight={4}
            isVisible={true}
            lineClassName="!border-[hsl(var(--flowchart-handle))]"
            handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
          />
        )}
        <div className="flowchart-node-content" style={{ position: "relative", width: "100%", height: "100%" }}>
          <svg className="size-full overflow-visible" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            {filterRadius > 0 && (
              <defs>
                <filter
                  id={filterId}
                  x={-filterRadius * 2}
                  y={-filterRadius * 2}
                  width={w + filterRadius * 4}
                  height={h + filterRadius * 4}
                  filterUnits="userSpaceOnUse"
                  colorInterpolationFilters="sRGB"
                >
                  <feMorphology
                    in="SourceAlpha"
                    operator={widthAdjustment > 0 ? "dilate" : "erode"}
                    radius={filterRadius}
                    result="adjusted"
                  />
                  <feFlood floodColor={color} floodOpacity={opacity} result="paint" />
                  <feComposite in="paint" in2="adjusted" operator="in" />
                </filter>
              </defs>
            )}
            <path
              d={d.path || ""}
              fill={color}
              fillOpacity={filterRadius > 0 ? 1 : opacity}
              filter={filterRadius > 0 ? `url(#${filterId})` : undefined}
            />
          </svg>
        </div>
      </div>
    );
  }

  // 图片节点：直接渲染图片
  if (d.kind === "image") {
    return (
      <div className={className} style={cssVars}>
        {selected && d.resizable && (
          <NodeResizer
            minWidth={48}
            minHeight={48}
            isVisible={true}
            lineClassName="!border-[hsl(var(--flowchart-handle))]"
            handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
          />
        )}
        <div className="flowchart-node-content" style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={d.label}
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">图片</span>
          )}
        </div>
        <FourHandles />
      </div>
    );
  }

  // label 渲染：使用 EditableLabel 支持原地双击编辑
  const labelEl = (
    <EditableLabel
      nodeId={id}
      value={d.label}
      readOnly={!!d.readOnly}
      onLabelEdit={d.onLabelEdit}
      className="flowchart-node-label"
      style={{
        whiteSpace: "pre-wrap",
        // 消费 --node-text CSS 变量（由 styleToCssVars 从 style.color 注入），
        // 修复修改文字颜色不生效的问题
        color: cssVars["--node-text"] ?? undefined,
        textAlign: (cssVars["--node-text-align"] as "left" | "center" | "right" | undefined) ?? "center",
        textDecoration: cssVars["--node-text-decoration"] ?? "none",
      }}
    />
  );

  const shape = renderShape(d.kind, selected, cssVars);

  // text 节点：对齐 NoteGen TextCanvasNode，无 SVG 形状，仅渲染文本
  if (d.kind === "text") {
    return (
      <div className={className} style={cssVars}>
        {selected && d.resizable && (
          <NodeResizer
            minWidth={48}
            minHeight={28}
            isVisible={true}
            lineClassName="!border-[hsl(var(--flowchart-handle))]"
            handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
          />
        )}
        <div
          className="flowchart-node-content"
          style={{
            position: "relative",
            zIndex: 1,
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "4px 8px",
          }}
        >
          {labelEl}
        </div>
        <FourHandles />
      </div>
    );
  }

  return (
    <div className={className} style={cssVars}>
      {selected && d.resizable && (
        <NodeResizer
          minWidth={d.kind === "connector" ? 48 : 96}
          minHeight={d.kind === "connector" ? 48 : 56}
          keepAspectRatio={d.kind === "connector"}
          isVisible={true}
          lineClassName="!border-[hsl(var(--flowchart-handle))]"
          handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
        />
      )}
      <svg className="flowchart-node-shape" viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        {shape}
      </svg>
      <div className="flowchart-node-content" style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 12px" }}>
        {labelEl}
      </div>
      <FourHandles />
    </div>
  );
}

const nodeTypes = { flowchart: FlowchartNodeView };

/** 连线拖到空白处弹出的形状选择菜单（左侧形状库的子集，图标保持一致） */
const CONNECTION_MENU_KINDS: FlowchartNodeKind[] = [
  "process",
  "decision",
  "terminator",
  "text",
  "input-output",
  "document",
  "database",
  "subprocess",
  "annotation",
];
const CONNECTION_MENU_SHAPES = SHAPES.filter((s) => CONNECTION_MENU_KINDS.includes(s.kind));

// ---------------------------------------------------------------------------
// 工具：节点/边转换
// ---------------------------------------------------------------------------

function toFlowNode(
  n: FlowchartNode,
  direction: FlowchartDirection,
  readOnly: boolean = true,
  onLabelEdit?: (nodeId: string, label: string) => void,
): Node {
  const node: Node = {
    id: n.id,
    type: "flowchart",
    position: n.position,
    data: { kind: n.kind, label: n.label, style: n.style, resizable: !readOnly, readOnly, onLabelEdit, imagePath: n.imagePath },
    sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
    targetPosition: direction === "LR" ? Position.Left : Position.Top,
  };
  if (n.size) {
    node.width = n.size.width;
    node.height = n.size.height;
  }
  // freehand 节点：补充笔触数据，禁止连接
  if (n.kind === "freehand") {
    node.data = {
      ...node.data,
      points: n.points,
      path: n.path,
      drawingTool: n.drawingTool,
      color: n.color,
      opacity: n.opacity,
      strokeWidth: n.strokeWidth,
    };
    node.connectable = false;
    node.draggable = true;
  }
  return node;
}

function toFlowEdge(e: FlowchartEdge): Edge {
  const style = edgeStyleToCss(e.style);
  // route 映射：bezier→default（贝塞尔曲线）、smoothstep→smoothstep（圆角折线）、straight→straight（直线）
  // 默认折线（smoothstep），对齐 NoteGen 流程图常见样式
  const routeMap = { bezier: "default", smoothstep: "smoothstep", straight: "straight" } as const;
  const route = routeMap[e.style?.route ?? "smoothstep"];
  // 兼容旧 handle id：旧格式为 top/bottom/left/right（单类型），
  // 新格式为 {dir}-source / {dir}-target。旧数据自动补全后缀。
  const normalizeSourceHandle = (h?: string | null): string | undefined => {
    if (!h) return undefined;
    if (h.endsWith("-source") || h.endsWith("-target")) return h;
    return `${h}-source`;
  };
  const normalizeTargetHandle = (h?: string | null): string | undefined => {
    if (!h) return undefined;
    if (h.endsWith("-source") || h.endsWith("-target")) return h;
    return `${h}-target`;
  };
  const edgeObj: Edge = {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: normalizeSourceHandle(e.sourceHandle),
    targetHandle: normalizeTargetHandle(e.targetHandle),
    label: e.label,
    type: route,
    style,
  };
  // 箭头：默认终点闭合箭头
  const markerEnd = e.style?.markerEnd ?? "arrowclosed";
  const markerStart = e.style?.markerStart ?? "none";
  if (markerEnd !== "none") {
    edgeObj.markerEnd = {
      type: markerEnd === "arrow" ? "arrow" as const : "arrowclosed" as const,
      color: e.style?.stroke ?? "var(--flowchart-edge)",
    };
  }
  if (markerStart !== "none") {
    edgeObj.markerStart = {
      type: markerStart === "arrow" ? "arrow" as const : "arrowclosed" as const,
      color: e.style?.stroke ?? "var(--flowchart-edge)",
    };
  }
  return edgeObj;
}

// ---------------------------------------------------------------------------
// 画布组件
// ---------------------------------------------------------------------------

/** 导出图片选项（设计文档 §7.12） */
export interface FlowchartExportOptions {
  /** PNG 缩放倍数：1x 用于普通场景，2x 用于高清 */
  scale?: 1 | 2;
  /** 背景：transparent 透明 / theme 当前主题画布色 */
  background?: "transparent" | "theme";
}

/** FlowchartCanvas 暴露给父组件的命令接口 */
export interface FlowchartCanvasHandle {
  /** 导出为 PNG dataURL */
  exportToPng: (options?: FlowchartExportOptions) => Promise<string>;
  /** 导出为 SVG 字符串 */
  exportToSvg: (options?: FlowchartExportOptions) => Promise<string>;
  /** 适应画布：调整 viewport 使所有节点可见 */
  fitView: (padding?: number) => void;
  /** 全选所有节点和边 */
  selectAll: () => void;
  /** 设置缩放（保留当前 x/y 平移），由 footer 滑块调用 */
  setZoom: (zoom: number) => void;
  /** 获取当前 viewport（包含 zoom），由 footer 初始化显示用 */
  getZoom: () => number;
}


/** 画布工具：选择/平移/钢笔/荧光笔/橡皮 */
export type CanvasTool = "select" | "hand" | "pen" | "highlighter" | "eraser";

/** 右键上下文：节点/边/画布 */
export type FlowchartContextMenuContext =
  | { kind: "node"; nodeId: string; x: number; y: number }
  | { kind: "edge"; edgeId: string; x: number; y: number }
  | { kind: "pane"; x: number; y: number };

/** freehand 绘制完成回调参数 */
export interface FreehandCompletePayload {
  /** 笔触原始点（flow 坐标系，含压感） */
  points: FreehandPoint[];
  /** 节点位置（左上角，flow 坐标系） */
  position: { x: number; y: number };
  /** 节点尺寸 */
  size: { width: number; height: number };
  /** 本地化 SVG path */
  path: string;
  /** 工具类型 */
  tool: "pen" | "highlighter";
  /** 笔触颜色 */
  color: string;
  /** 不透明度（荧光笔默认 0.28） */
  opacity: number;
  /** 笔触宽度 */
  strokeWidth: number;
}

export interface FlowchartCanvasProps {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  direction: FlowchartDirection;
  /** 只读模式：禁用拖动、连线和删除 */
  readOnly?: boolean;
  /** 初始 viewport（用于恢复保存的视图） */
  initialViewport?: { x: number; y: number; zoom: number } | null;
  /** 节点位置变化回调（拖动结束） */
  onNodesChange?: (changes: NodeChange[]) => void;
  /** 边变化回调（删除、选中） */
  onEdgesChange?: (changes: EdgeChange[]) => void;
  /** 新建连线回调 */
  onConnect?: (connection: {
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }) => void;
  /** 边重连回调（拖动边端点到新 Handle） */
  onReconnect?: (
    edgeId: string,
    next: {
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
    },
  ) => void;
  /** viewport 变化回调（onMoveEnd 触发，用于持久化） */
  onViewportChange?: (vp: { x: number; y: number; zoom: number }) => void;
  /** 选区变化回调 */
  onSelectionChange?: (selection: { nodeIds: string[]; edgeIds: string[] }) => void;
  /** 节点双击编辑 label 回调 */
  onNodeLabelEdit?: (nodeId: string, label: string) => void;
  /** 边双击编辑 label 回调 */
  onEdgeLabelEdit?: (edgeId: string, label: string) => void;
  /** 从图形库拖拽放置形状回调 */
  onDropShape?: (kind: FlowchartNodeKind, x: number, y: number) => void;
  /** 内部受控节点（若提供则使用受控模式） */
  internalNodes?: Node[];
  internalEdges?: Edge[];
  onInternalNodesChange?: OnNodesChange;
  onInternalEdgesChange?: OnEdgesChange;
  /** 平移拖拽模式：true=左键拖拽平移，[1]=仅中键/右键平移 */
  panOnDrag?: boolean | number[];
  /** 框选模式：true=左键拖拽框选 */
  selectionOnDrag?: boolean;
  /** 网格间距（px），默认 16 */
  gridGap?: number;
  /** 是否显示网格（默认 true），由 footer 切换 */
  showGrid?: boolean;
  /** 网格显示切换回调（由 footer 触发） */
  onShowGridChange?: (show: boolean) => void;
  /** 是否吸附网格（默认 true），由 footer 切换 */
  snapToGrid?: boolean;
  /** 吸附网格切换回调（由 footer 触发） */
  onSnapToGridChange?: (snap: boolean) => void;
  /** 自动布局回调（由 footer 触发，父组件调用 layoutEntireGraph） */
  onAutoLayout?: () => void;
  /** 右键菜单回调：根据上下文（节点/边/画布）触发 */
  onContextMenu?: (ctx: FlowchartContextMenuContext) => void;
  /** 拖出连线到空白处创建新节点并自动连线回调 */
  onCreateNodeWithConnection?: (
    kind: FlowchartNodeKind,
    position: { x: number; y: number },
    connection: {
      source: string;
      sourceHandle?: string;
    },
  ) => void;
  /** 当前文档 ID，用于切换文档时重置视图恢复状态 */
  noteId?: string;
  /** 当前激活工具（select/hand/pen/highlighter/eraser） */
  activeTool?: CanvasTool;
  /** 钢笔颜色（默认 #18181b） */
  penColor?: string;
  /** 钢笔宽度（默认 4） */
  penSize?: number;
  /** 荧光笔颜色（默认 #facc15） */
  highlighterColor?: string;
  /** 荧光笔宽度（默认 18） */
  highlighterSize?: number;
  /** freehand 绘制完成回调（pen/highlighter 抬起时触发） */
  onFreehandComplete?: (payload: FreehandCompletePayload) => void;
  /** 橡皮擦除回调：传入被命中的 freehand 节点 ID 列表 */
  onEraseFreehand?: (nodeIds: string[]) => void;
}

const FlowchartCanvasInner = forwardRef<FlowchartCanvasHandle, FlowchartCanvasProps>(function FlowchartCanvasInner({
  nodes,
  edges,
  direction,
  readOnly = false,
  initialViewport,
  noteId,
  onSelectionChange,
  onNodeLabelEdit,
  onEdgeLabelEdit,
  onDropShape,
  internalNodes,
  internalEdges,
  onInternalNodesChange,
  onInternalEdgesChange,
  panOnDrag,
  selectionOnDrag,
  gridGap = 16,
  showGrid = true,
  snapToGrid = true,
  onContextMenu,
  onConnect,
  onReconnect,
  onViewportChange,
  onCreateNodeWithConnection,
  activeTool = "select",
  penColor = "#18181b",
  penSize = PEN_STYLE.size,
  highlighterColor = "#facc15",
  highlighterSize = HIGHLIGHTER_STYLE.size,
  onFreehandComplete,
  onEraseFreehand,
}, ref) {
  // label 编辑已下沉到节点内部（EditableLabel），无需外部 state
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [edgeEditValue, setEdgeEditValue] = useState("");
  // 双击边时的屏幕坐标，编辑框定位到连线上而非屏幕中央（参考 NoteGen canvas-editor.tsx）
  const [edgeEditPosition, setEdgeEditPosition] = useState<{ x: number; y: number } | null>(null);
  const edgeEditInputRef = useRef<HTMLTextAreaElement | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, setViewport, getViewport, getNodes, getNodesBounds, setNodes, setEdges } = useReactFlow();
  // 订阅 viewport 变化，用于 freehand 预览 path 对齐
  const viewport = useViewport();

  const flowNodes = useMemo(
    () => (internalNodes ?? nodes.map((n) => toFlowNode(n, direction, readOnly, onNodeLabelEdit))),
    [internalNodes, nodes, direction, readOnly, onNodeLabelEdit],
  );
  const flowEdges = useMemo(
    () => (internalEdges ?? edges.map(toFlowEdge)),
    [internalEdges, edges],
  );

  // 恢复保存的 viewport，或在新建/默认视图时 zoom=1 居中（设计文档 §7.7）
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
      // 存在非默认的保存视图时直接恢复
      if (
        initialViewport &&
        (initialViewport.x !== 0 || initialViewport.y !== 0 || initialViewport.zoom !== 1)
      ) {
        setViewport(initialViewport, { duration: 0 });
        viewportRestoredRef.current = true;
        return;
      }
      // 新建或默认视图：强制 zoom=1，并把节点整体居中到画布
      const surfaceEl = reactFlowWrapper.current;
      if (!surfaceEl) {
        viewportRestoredRef.current = true;
        return;
      }
      const rfEl = surfaceEl.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) {
        viewportRestoredRef.current = true;
        return;
      }
      const bounds = getNodesBounds(allNodes);
      const containerRect = rfEl.getBoundingClientRect();
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      setViewport(
        {
          x: containerRect.width / 2 - centerX,
          y: containerRect.height / 2 - centerY,
          zoom: 1,
        },
        { duration: 0 },
      );
      viewportRestoredRef.current = true;
    };
    // 等待 React Flow 完成节点测量后再计算边界
    const timer = setTimeout(apply, 0);
    return () => clearTimeout(timer);
  }, [noteId, initialViewport, setViewport, getNodes, getNodesBounds]);

  // 节点双击编辑已下沉到 EditableLabel 组件，画布层不再处理

  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      if (readOnly) {
        const safe = changes.filter((c) => c.type === "position");
        if (safe.length > 0) onInternalNodesChange?.(safe);
        return;
      }
      onInternalNodesChange?.(changes);
    },
    [readOnly, onInternalNodesChange],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      if (readOnly) {
        const safe = changes.filter((c) => c.type !== "remove");
        if (safe.length > 0) onInternalEdgesChange?.(safe);
        return;
      }
      onInternalEdgesChange?.(changes);
    },
    [readOnly, onInternalEdgesChange],
  );

  const handleConnect = useCallback<OnConnect>(
    (connection) => {
      if (readOnly) return;
      if (!connection.source || !connection.target) return;
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

  // 拖出连线到空白处：弹出形状选择浮层，选择后创建节点并自动连线
  // 参考 NoteGen canvas-editor.tsx 的 onConnectEnd + Popover 交互
  const [connectionMenu, setConnectionMenu] = useState<{
    x: number;
    y: number;
    source: string;
    sourceHandle?: string;
  } | null>(null);
  // 上次选择的形状类型，下次弹出菜单时排在第一位（NoteGen preferredNodeType）
  const [preferredKind, setPreferredKind] = useState<FlowchartNodeKind | null>(null);

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      if (readOnly || !onCreateNodeWithConnection) return;
      // 连接到有效目标时不触发（让 onConnect 处理）
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
    [readOnly, onCreateNodeWithConnection],
  );

  const handleConnectionMenuSelect = useCallback(
    (kind: FlowchartNodeKind) => {
      const menu = connectionMenu;
      setConnectionMenu(null);
      if (!menu || !reactFlowWrapper.current) return;
      // 将屏幕坐标转换为画布坐标
      const flowPosition = screenToFlowPosition({ x: menu.x, y: menu.y });
      setPreferredKind(kind);
      onCreateNodeWithConnection?.(kind, flowPosition, {
        source: menu.source,
        sourceHandle: menu.sourceHandle,
      });
    },
    [connectionMenu, screenToFlowPosition, onCreateNodeWithConnection],
  );

  // 点击外部关闭浮层
  useEffect(() => {
    if (!connectionMenu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".flowchart-connection-menu")) {
        setConnectionMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectionMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [connectionMenu]);

  // 边重连：拖动边端点到新 Handle，触发 onReconnect 回调
  // 设计文档 §7.6：重连到新节点属于语义变化（产生新的 source/target，进入 hash）。
  // React Flow 不会自动修改 edge，需要由父级更新文档。
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

  // 双击边进入 label 编辑模式：编辑框定位到双击位置（连线上）
  const handleEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (readOnly || !onEdgeLabelEdit) return;
      event.stopPropagation();
      setEditingEdgeId(edge.id);
      setEdgeEditValue(String(edge.label ?? ""));
      setEdgeEditPosition({ x: event.clientX, y: event.clientY });
      requestAnimationFrame(() => {
        edgeEditInputRef.current?.focus();
        edgeEditInputRef.current?.select();
      });
    },
    [readOnly, onEdgeLabelEdit],
  );

  const commitEdgeEdit = useCallback(() => {
    if (!editingEdgeId) return;
    const trimmed = edgeEditValue.trim();
    onEdgeLabelEdit?.(editingEdgeId, trimmed);
    setEditingEdgeId(null);
    setEdgeEditValue("");
    setEdgeEditPosition(null);
  }, [editingEdgeId, edgeEditValue, onEdgeLabelEdit]);

  const cancelEdgeEdit = useCallback(() => {
    setEditingEdgeId(null);
    setEdgeEditValue("");
    setEdgeEditPosition(null);
  }, []);

  const handleEdgeEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdgeEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdgeEdit();
      }
    },
    [commitEdgeEdit, cancelEdgeEdit],
  );

  // 从图形库拖拽放置形状
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (readOnly || !onDropShape) return;
      const kind = e.dataTransfer.getData("application/x-flowchart-kind") as FlowchartNodeKind | "";
      if (!kind) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onDropShape(kind, position.x, position.y);
    },
    [readOnly, onDropShape, screenToFlowPosition],
  );

  // ── 导出图片（设计文档 §7.12）─────────────────────────────────────
  // 1. 添加 .flowchart-exporting class 隐藏 Controls/MiniMap/Handle/选择框/信息条
  // 2. 保存当前 viewport，计算全图 bounds，设置 viewport 使全图可见
  // 3. 等待渲染，调用 html-to-image 生成图片
  // 4. 恢复 viewport 和 class
  // 5. 大图导出失败时抛出明确错误，不返回空白 dataURL
  const exportImage = useCallback(
    async (
      format: "png" | "svg",
      options: FlowchartExportOptions = {},
    ): Promise<string> => {
      const scale = options.scale ?? 1;
      const background = options.background ?? "theme";

      const surfaceEl = reactFlowWrapper.current;
      if (!surfaceEl) throw new Error("画布未就绪，无法导出");
      const rfEl = surfaceEl.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) throw new Error("React Flow 容器未就绪，无法导出");

      const allNodes = getNodes();
      if (allNodes.length === 0) {
        throw new Error("画布上没有节点，无法导出");
      }

      // 1. 取消边编辑状态，避免编辑浮层被截取
      setEditingEdgeId(null);
      setEdgeEditValue("");

      // 2. 隐藏编辑 UI
      surfaceEl.classList.add("flowchart-exporting");

      // 3. 保存并设置 viewport 以包含全图
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

      // 4. 等待 DOM 更新（两帧确保 React Flow 完成渲染）
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      try {
        // 5. 计算背景色
        const backgroundColor =
          background === "transparent"
            ? undefined
            : getComputedStyle(surfaceEl)
                .getPropertyValue("--flowchart-canvas")
                .trim() || "#ffffff";

        // 6. 生成图片
        const htmlToImageOptions = {
          pixelRatio: scale,
          backgroundColor,
          // 过滤掉可能残留的编辑 UI（CSS 已隐藏，这里双重保险）
          filter: (node: HTMLElement) => {
            if (!node.classList) return true;
            return (
              !node.classList.contains("react-flow__controls") &&
              !node.classList.contains("react-flow__minimap")
            );
          },
        };

        if (format === "png") {
          return await toPng(rfEl, htmlToImageOptions);
        }
        return await toSvg(rfEl, htmlToImageOptions);
      } finally {
        // 7. 恢复 viewport 和 class
        setViewport(prevViewport, { duration: 0 });
        surfaceEl.classList.remove("flowchart-exporting");
      }
    },
    [getNodes, getNodesBounds, getViewport, setViewport],
  );

  const exportToPng = useCallback(
    (options?: FlowchartExportOptions) => exportImage("png", options),
    [exportImage],
  );
  const exportToSvg = useCallback(
    (options?: FlowchartExportOptions) => exportImage("svg", options),
    [exportImage],
  );

  // 适应画布：调整 viewport 使所有节点可见（设计文档 §7.7）
  // 使用固定像素留白（24px）而非比例留白，避免大容器时 8% 留白过大导致空间浪费。
  const fitView = useCallback(
    (padding: number = 24) => {
      const allNodes = getNodes();
      if (allNodes.length === 0) return;
      const surfaceEl = reactFlowWrapper.current;
      if (!surfaceEl) return;
      const rfEl = surfaceEl.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) return;
      const bounds = getNodesBounds(allNodes);
      const containerRect = rfEl.getBoundingClientRect();
      // 固定像素留白，保证各尺寸窗口留白一致
      const pad = typeof padding === "number" && padding < 1 ? 24 : padding;
      const availableWidth = Math.max(containerRect.width - pad * 2, 100);
      const availableHeight = Math.max(containerRect.height - pad * 2, 100);
      const zoom = Math.min(
        availableWidth / Math.max(bounds.width, 1),
        availableHeight / Math.max(bounds.height, 1),
        2.5,
      );
      const x = -bounds.x * zoom + (containerRect.width - bounds.width * zoom) / 2;
      const y = -bounds.y * zoom + (containerRect.height - bounds.height * zoom) / 2;
      setViewport({ x, y, zoom }, { duration: 200 });
    },
    [getNodes, getNodesBounds, setViewport],
  );

  // 全选：选中所有节点和边
  const selectAll = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
    setEdges((eds) => eds.map((e) => ({ ...e, selected: true })));
  }, [setNodes, setEdges]);

  // 右键菜单回调：根据事件来源（节点/边/画布）触发
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({ kind: "node", nodeId: node.id, x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );
  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({ kind: "edge", edgeId: edge.id, x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );
  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      if (!onContextMenu) return;
      event.preventDefault();
      const clientX = (event as MouseEvent).clientX ?? 0;
      const clientY = (event as MouseEvent).clientY ?? 0;
      onContextMenu({ kind: "pane", x: clientX, y: clientY });
    },
    [onContextMenu],
  );

  // ── freehand 绘制 overlay（pen/highlighter/eraser）──────────────────────
  // 参考 NoteGen canvas-editor.tsx 的 handleDrawingPointerDown/Move/Up。
  // 当 activeTool ∈ {pen, highlighter, eraser} 时，overlay 拦截 pointer 事件；
  // 否则 overlay 不存在（pointer-events: none）让 ReactFlow 正常处理。
  const isDrawingTool = activeTool === "pen" || activeTool === "highlighter" || activeTool === "eraser";
  const [previewPath, setPreviewPath] = useState<string>("");
  const drawingPointsRef = useRef<FreehandPoint[]>([]);
  const erasingIdsRef = useRef<Set<string>>(new Set());
  const drawingActiveRef = useRef(false);

  // 当前激活的笔刷样式（根据工具选择 PEN_STYLE/HIGHLIGHTER_STYLE，覆盖 size）
  const activeBrushStyle: FreehandStyle = useMemo(() => {
    if (activeTool === "highlighter") return { ...HIGHLIGHTER_STYLE, size: highlighterSize };
    return { ...PEN_STYLE, size: penSize };
  }, [activeTool, penSize, highlighterSize]);

  const activeBrushColor = activeTool === "highlighter" ? highlighterColor : penColor;
  const activeBrushOpacity = activeTool === "highlighter" ? 0.28 : 1;

  // 擦除：检测命中的 freehand 节点
  const eraseAtPoint = useCallback(
    (flowPoint: { x: number; y: number }) => {
      if (!onEraseFreehand) return;
      const allNodes = getNodes();
      const hitIds: string[] = [];
      const eraseRadius = 12; // 橡皮擦命中半径（flow 坐标系）
      for (const n of allNodes) {
        const data = n.data as FlowchartNodeData | undefined;
        if (!data || data.kind !== "freehand") continue;
        if (erasingIdsRef.current.has(n.id)) continue;
        // 命中检测：使用节点边界框 + 半径膨胀
        const nx = n.position.x;
        const ny = n.position.y;
        const nw = typeof n.width === "number" ? n.width : 0;
        const nh = typeof n.height === "number" ? n.height : 0;
        if (
          flowPoint.x >= nx - eraseRadius &&
          flowPoint.x <= nx + nw + eraseRadius &&
          flowPoint.y >= ny - eraseRadius &&
          flowPoint.y <= ny + nh + eraseRadius
        ) {
          hitIds.push(n.id);
          erasingIdsRef.current.add(n.id);
        }
      }
      if (hitIds.length > 0) {
        onEraseFreehand(hitIds);
      }
    },
    [getNodes, onEraseFreehand],
  );

  const handleDrawingPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDrawingTool || readOnly) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drawingActiveRef.current = true;
      if (activeTool === "eraser") {
        erasingIdsRef.current.clear();
      }
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const point: FreehandPoint = {
        x: flowPoint.x,
        y: flowPoint.y,
        pressure: event.pressure || 0.5,
      };
      if (activeTool === "eraser") {
        eraseAtPoint(flowPoint);
        return;
      }
      drawingPointsRef.current = [point];
    },
    [isDrawingTool, readOnly, activeTool, screenToFlowPosition, eraseAtPoint],
  );

  const handleDrawingPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drawingActiveRef.current || !isDrawingTool || readOnly) return;
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const point: FreehandPoint = {
        x: flowPoint.x,
        y: flowPoint.y,
        pressure: event.pressure || 0.5,
      };
      if (activeTool === "eraser") {
        eraseAtPoint(flowPoint);
        return;
      }
      // pen/highlighter：追加并生成预览 path
      const next = [...drawingPointsRef.current, point];
      drawingPointsRef.current = next;
      const outline = getFreehandOutline(next, activeBrushStyle);
      if (outline.length > 0) {
        setPreviewPath(getSvgPathFromStroke(outline));
      }
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
      // pen/highlighter：生成几何并回调
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

  // 工具切换或 readOnly 变化时清理绘制状态
  useEffect(() => {
    if (!isDrawingTool) {
      drawingActiveRef.current = false;
      drawingPointsRef.current = [];
      setPreviewPath("");
      erasingIdsRef.current.clear();
    }
  }, [isDrawingTool]);

  // 根据 activeTool 计算 ReactFlow 交互模式
  const rfPanOnDrag: boolean | number[] = useMemo(() => {
    if (activeTool === "hand") return true;
    if (isDrawingTool) return [1]; // 仅中键/右键平移
    return panOnDrag ?? [1];
  }, [activeTool, isDrawingTool, panOnDrag]);
  const rfSelectionOnDrag = useMemo(() => {
    if (isDrawingTool || activeTool === "hand") return false;
    return selectionOnDrag ?? true;
  }, [activeTool, isDrawingTool, selectionOnDrag]);
  const rfNodesDraggable = !readOnly && !isDrawingTool;

  // 绘制 overlay 的 cursor
  const drawingCursor = useMemo(() => {
    if (activeTool === "pen") {
      return `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M4 20l3.5-1 11-11-2.5-2.5-11 11L4 20z' fill='%23fff' stroke='%2318181b' stroke-width='1.5'/><path d='M14.8 6.7l2.5 2.5' stroke='%2318181b' stroke-width='1.5'/></svg>") 4 20, crosshair`;
    }
    if (activeTool === "highlighter") {
      return `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M4 19l4 1L20 8l-4-4L4 16z' fill='%23facc15' stroke='%2318181b' stroke-width='1.5'/><path d='M4 19h7' stroke='%2318181b' stroke-width='2'/></svg>") 4 19, crosshair`;
    }
    if (activeTool === "eraser") {
      return `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M5 16L12 6l7 5-7 10H8z' fill='%23f4f4f5' stroke='%2318181b' stroke-width='1.5'/><path d='M5 16l7 5' stroke='%23f87171' stroke-width='4'/></svg>") 7 18, cell`;
    }
    return undefined;
  }, [activeTool]);

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
      className={`flowchart-surface h-full w-full${readOnly ? " flowchart-readonly" : ""}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
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
            nodeIds: ns.map((n) => n.id),
            edgeIds: es.map((e) => e.id),
          });
        }}
        onMoveEnd={(_, vp: Viewport) => {
          if (onViewportChange) {
            onViewportChange({ x: vp.x, y: vp.y, zoom: vp.zoom });
          }
        }}
        nodesDraggable={rfNodesDraggable}
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
          <Background
            variant={BackgroundVariant.Lines}
            gap={gridGap}
            color="var(--flowchart-grid)"
          />
        )}
        <MiniMap
          pannable
          zoomable
          className="!bg-[var(--flowchart-node-bg)] !border-[var(--flowchart-node-border)]"
          maskColor="hsl(var(--muted-foreground) / 0.12)"
          nodeColor={(n) => {
            const kind = (n.data as { kind?: string } | undefined)?.kind;
            // MiniMap 在独立 SVG 上下文中渲染，使用固定颜色避免 CSS 变量解析异常
            if (kind === "start" || kind === "end") return "#3b82f6";
            if (kind === "decision") return "#f59e0b";
            if (kind === "document") return "#3b82f6";
            if (kind === "database") return "#3b82f6";
            return "#64748b";
          }}
          nodeStrokeColor={(n) => {
            const kind = (n.data as { kind?: string } | undefined)?.kind;
            if (kind === "start" || kind === "end") return "#2563eb";
            if (kind === "decision") return "#d97706";
            if (kind === "document") return "#2563eb";
            if (kind === "database") return "#2563eb";
            return "#94a3b8";
          }}
          nodeBorderRadius={8}
        />
      </ReactFlow>

      {/* 连线拖到空白处的形状选择浮层（参考 NoteGen Popover 风格） */}
      {connectionMenu && (
        <div
          className="flowchart-connection-menu absolute z-50 flex w-72 flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg"
          style={{
            left: connectionMenu.x - (reactFlowWrapper.current?.getBoundingClientRect().left ?? 0),
            top: connectionMenu.y - (reactFlowWrapper.current?.getBoundingClientRect().top ?? 0),
          }}
        >
          {/* Header */}
          <div className="flex flex-col gap-0.5 px-4 pt-3 pb-2">
            <div className="text-sm font-medium text-foreground">选择形状创建节点</div>
            <div className="text-xs text-muted-foreground">点击形状将在连线终点创建新节点并自动连线</div>
          </div>
          <Separator />
          {/* 形状网格（preferredKind 排在第一位） */}
          <ScrollArea className="h-64">
            <div className="grid grid-cols-2 gap-2 p-3">
              {[
                ...(preferredKind ? CONNECTION_MENU_SHAPES.filter((s) => s.kind === preferredKind) : []),
                ...CONNECTION_MENU_SHAPES.filter((s) => s.kind !== preferredKind),
              ].map((s) => {
                const Icon = s.icon;
                return (
                  <Button
                    key={s.kind}
                    type="button"
                    variant="outline"
                    onClick={() => handleConnectionMenuSelect(s.kind)}
                    className="h-16 flex-col gap-1 font-normal"
                  >
                    <Icon className="h-4 w-4 text-foreground/80" />
                    <span className="max-w-full truncate text-[11px] text-foreground/80">{s.label}</span>
                  </Button>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* 节点数 / 边数 / zoom 信息条已移除 */}

      {/* freehand 绘制 overlay（pen/highlighter/eraser）
          参考 NoteGen canvas-editor.tsx：当 activeTool 是绘制工具时，overlay 拦截 pointer 事件；
          否则 overlay 不存在，让 ReactFlow 正常处理。
          previewPath 在绘制过程中实时显示当前笔触。
          预览 SVG 需要应用 ReactFlow viewport 变换（translate + scale），
          因为 path 坐标是 flow 坐标系，需要变换到屏幕坐标才不会错位。 */}
      {isDrawingTool && !readOnly && (
        <div
          className="absolute inset-0 z-20"
          style={{
            pointerEvents: "auto",
            cursor: drawingCursor,
            touchAction: "none",
          }}
          onPointerDown={handleDrawingPointerDown}
          onPointerMove={handleDrawingPointerMove}
          onPointerUp={handleDrawingPointerUp}
          onPointerCancel={handleDrawingPointerUp}
        >
          {previewPath && (
            <svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
              <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
                <path
                  d={previewPath}
                  fill={activeBrushColor}
                  fillOpacity={activeBrushOpacity}
                  stroke="none"
                />
              </g>
            </svg>
          )}
        </div>
      )}

      {/* 边 label 编辑浮层：定位到双击的连线上（参考 NoteGen canvas-editor.tsx） */}
      {editingEdgeId && edgeEditPosition && (
        <div
          className="fixed inset-0 z-50"
          onMouseDown={commitEdgeEdit}
        >
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
              onKeyDown={handleEdgeEditKeyDown}
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

// 受控模式辅助：把外部 nodes/edges 转换为 React Flow 内部状态的工具
export const flowchartCanvasHelpers = {
  toFlowNode,
  toFlowEdge,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
};

export const FlowchartCanvas = forwardRef<FlowchartCanvasHandle, FlowchartCanvasProps>(
  function FlowchartCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <FlowchartCanvasInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  },
);

// ---------------------------------------------------------------------------
// Footer：底部工具条（参考 NoteGen canvas-footer.tsx）
// 左侧：网格切换 / 吸附 / 自动布局 / 适应视图
// 右侧：缩放滑块 + 百分比显示
// 替代原 ReactFlow <Controls> 的 +/-/全屏 浮动按钮，统一到底部一条
// ---------------------------------------------------------------------------

export interface FlowchartFooterProps {
  /** 当前缩放（0.2 - 2.5） */
  zoom: number;
  /** 缩放回调 */
  onZoomChange: (zoom: number) => void;
  /** 适应视图 */
  onFitView: () => void;
  /** 是否显示网格 */
  showGrid: boolean;
  /** 网格显示切换 */
  onShowGridChange: (show: boolean) => void;
  /** 是否吸附网格 */
  snapToGrid: boolean;
  /** 吸附网格切换 */
  onSnapToGridChange: (snap: boolean) => void;
  /** 自动布局 */
  onAutoLayout: () => void;
  /** 是否只读（只读时禁用自动布局和吸附） */
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

/**
 * 可编辑的缩放百分比输入框：点击进入编辑态，回车/失焦提交，Esc 取消。
 * 输入 50-500 表示百分比，自动限制到 20-250 范围。
 */
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
      // 输入百分比，转为 zoom 值并限制范围
      const z = Math.min(2.5, Math.max(0.2, num / 100));
      onZoomChange(z);
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

export function FlowchartFooter({
  zoom,
  onZoomChange,
  onFitView,
  showGrid,
  onShowGridChange,
  snapToGrid,
  onSnapToGridChange,
  onAutoLayout,
  readOnly = false,
}: FlowchartFooterProps) {
  return (
    <div className="flex h-6 min-h-6 max-h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs text-muted-foreground">
      {/* 左侧：网格 / 吸附 / 自动布局 */}
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

      {/* 右侧：缩放滑块 + 适应视图 */}
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
