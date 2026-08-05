/**
 * v2 图表文档 ↔ React Flow 双向转换 + 元素 SVG 渲染。
 *
 * 规范（见 AI_EDITABLE_DIAGRAM_CANVAS_PRODUCTION_PLAN.md §8、§9）：
 * 1. 元素 → React Flow Node（data 携带完整元素对象 + 渲染回调），
 *    连接器 → React Flow Edge（data 携带完整连接器对象）；
 * 2. 渲染只消费元素/连接器的视觉字段，语义字段不影响渲染；
 * 3. 形状用 SVG viewBox="0 0 200 100" + preserveAspectRatio="none" +
 *    vectorEffect: non-scaling-stroke，与 FlowchartCanvas 同一套视觉语言；
 * 4. 用户自定义 fill/stroke 覆盖默认主题 token；
 * 5. group/container 渲染为半透明背景框（React Flow 中 zIndex 最低）；
 * 6. icon 元素通过 lucide 动态组件渲染，image 通过 vault 相对路径渲染；
 * 7. 位置/尺寸变化通过 React Flow 受控模式回流到文档。
 */

import type React from "react";
import type { Edge, Node } from "@xyflow/react";

import type {
  DiagramConnector,
  DiagramDocument,
  DiagramElement,
  DiagramShapeElement,
  DiagramStroke,
  DiagramTextStyle,
  Paint,
  ShapeKind,
} from "./diagram-document";
import { DEFAULT_TEXT_STYLE } from "./diagram-document";

// ---------------------------------------------------------------------------
// 样式工具
// ---------------------------------------------------------------------------

/** 把 Paint 转为 CSS 背景（solid → backgroundColor，gradient → backgroundImage）。 */
export function paintToCss(paint: Paint | undefined): React.CSSProperties {
  if (!paint || paint.type === "none") return {};
  if (paint.type === "solid") return { backgroundColor: paint.color };
  // linear-gradient
  const stops = paint.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(", ");
  return { backgroundImage: `linear-gradient(${paint.angle}deg, ${stops})` };
}

/** 把 Paint 转为 SVG fill 属性值（solid → color，gradient → url(#id)，none → "none"）。
 *  gradient 需要调用方提供 defs。 */
export function paintToSvgFill(paint: Paint | undefined, gradientId?: string): string {
  if (!paint || paint.type === "none") return "none";
  if (paint.type === "solid") return paint.color;
  return gradientId ? `url(#${gradientId})` : "none";
}

/** 生成渐变 SVG <defs>，返回 { defs, fill }。 */
export function buildGradientDefs(
  paint: Paint | undefined,
  idPrefix: string,
): { defs: React.ReactNode; fill: string } {
  if (!paint || paint.type !== "linear-gradient") {
    return { defs: null, fill: paintToSvgFill(paint) };
  }
  const id = `${idPrefix}-grad`;
  const angle = paint.angle;
  // SVG linearGradient 用 x1/y1/x2/y2 表示方向，把角度转为向量
  const rad = ((angle - 90) * Math.PI) / 180;
  const x2 = Math.cos(rad).toFixed(4);
  const y2 = Math.sin(rad).toFixed(4);
  const defs = (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2={x2} y2={y2}>
        {paint.stops.map((s, i) => (
          <stop key={i} offset={`${s.offset * 100}%`} stopColor={s.color} />
        ))}
      </linearGradient>
    </defs>
  );
  return { defs, fill: `url(#${id})` };
}

/** 把 DiagramStroke 转为 SVG 属性。 */
export function strokeToSvgProps(stroke: DiagramStroke | undefined): {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
} {
  if (!stroke) {
    return { stroke: "var(--border)", strokeWidth: 1 };
  }
  return {
    stroke: stroke.color,
    strokeWidth: stroke.width,
    strokeDasharray:
      stroke.style === "dashed" ? "8 6" : stroke.style === "dotted" ? "2 5" : undefined,
  };
}

/** 把 textStyle 合并默认值后转 CSS。 */
export function textStyleToCss(
  textStyle: Partial<DiagramTextStyle> | undefined,
): React.CSSProperties {
  const s = { ...DEFAULT_TEXT_STYLE, ...textStyle };
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fontStyle: s.italic ? "italic" : "normal",
    textDecoration: s.underline ? "underline" : "none",
    color: s.color,
    textAlign: s.align,
    lineHeight: s.lineHeight,
  };
}

// ---------------------------------------------------------------------------
// SVG 形状渲染（viewBox="0 0 200 100"）
// ---------------------------------------------------------------------------

interface ShapeSvgProps {
  kind: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
}

/** 形状公共属性。 */
function shapeProps(props: ShapeSvgProps) {
  return {
    fill: props.fill,
    stroke: props.stroke,
    strokeWidth: props.strokeWidth,
    strokeDasharray: props.strokeDasharray,
    vectorEffect: "non-scaling-stroke" as const,
  };
}

/** 渲染 shape 元素的 SVG 几何（不含文本）。 */
export function renderShapeSvg(props: ShapeSvgProps): React.ReactNode {
  const common = shapeProps(props);
  switch (props.kind) {
    case "rectangle":
      return <rect x="1" y="1" width="198" height="98" {...common} />;
    case "rounded-rectangle":
      return <rect x="1" y="1" width="198" height="98" rx="12" {...common} />;
    case "ellipse":
      return <ellipse cx="100" cy="50" rx="99" ry="49" {...common} />;
    case "circle":
      return <ellipse cx="100" cy="50" rx="49" ry="49" {...common} />;
    case "pill":
      return <rect x="1" y="1" width="198" height="98" rx="49" {...common} />;
    case "diamond":
      return <polygon points="100,1 199,50 100,99 1,50" {...common} />;
    case "hexagon":
      return <polygon points="30,1 170,1 199,50 170,99 30,99 1,50" {...common} />;
    case "parallelogram":
      return <polygon points="24,1 199,1 176,99 1,99" {...common} />;
    case "cylinder":
    case "database":
      return (
        <>
          <path d="M1 17C1 8 45 1 100 1S199 8 199 17V83C199 92 155 99 100 99S1 92 1 83Z" {...common} />
          <ellipse cx="100" cy="17" rx="99" ry="16" fill="none" stroke={props.stroke} strokeWidth={props.strokeWidth} strokeDasharray={props.strokeDasharray} vectorEffect="non-scaling-stroke" />
        </>
      );
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
    case "cloud":
      return (
        <path
          d="M50 90C20 90 10 60 30 45C20 20 60 5 80 20C90 1 130 1 140 20C170 5 200 35 185 60C195 80 170 95 140 90Z"
          {...common}
        />
      );
    case "actor":
      return (
        <>
          <circle cx="100" cy="18" r="14" {...common} />
          <path d="M100 32V62M100 40L70 55M100 40L130 55M100 62L75 92M100 62L125 92" fill="none" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );
    case "callout":
      return (
        <path
          d="M1 1H199V70H120L100 99L80 70H1Z"
          {...common}
        />
      );
    case "chevron":
      return <polygon points="1,1 160,1 199,50 160,99 1,99 40,50" {...common} />;
    case "pentagon":
      return <polygon points="100,1 199,40 160,99 40,99 1,40" {...common} />;
    case "trapezoid":
      return <polygon points="30,1 170,1 199,99 1,99" {...common} />;
    case "process":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" {...common} />
          <line x1="20" y1="1" x2="20" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
          <line x1="180" y1="1" x2="180" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );
    case "subprocess":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" {...common} />
          <line x1="12" y1="1" x2="12" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
          <line x1="188" y1="1" x2="188" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );
    case "junction":
      return <ellipse cx="100" cy="50" rx="12" ry="12" {...common} />;
    case "predefined-process":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" {...common} />
          <line x1="15" y1="1" x2="15" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
          <line x1="185" y1="1" x2="185" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );
    case "manual-input":
      return <polygon points="1,30 199,1 199,99 1,99" {...common} />;
    case "delay":
      return <path d="M1 1H100A49 49 0 0 1 100 99H1Z" {...common} />;
    case "display":
      return <path d="M1 50L30 1H170A49 49 0 0 1 170 99H30Z" {...common} />;
    case "off-page-connector":
      return <polygon points="100,50 150,1 199,1 199,99 150,99 1,99 1,1 50,1" {...common} />;
    case "internal-storage":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" {...common} />
          <line x1="1" y1="15" x2="199" y2="15" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
          <line x1="15" y1="1" x2="15" y2="99" stroke={props.stroke} strokeWidth={props.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );
    case "stored-data":
      return <path d="M1 17C1 8 45 1 100 1S199 8 199 17V83C199 92 155 99 100 99S1 92 1 83Z" {...common} />;
    default:
      return <rect x="1" y="1" width="198" height="98" {...common} />;
  }
}

// ---------------------------------------------------------------------------
// 元素文本内容渲染
// ---------------------------------------------------------------------------

/** 渲染 textBlocks 为 HTML 内容。 */
export function renderTextBlocks(
  blocks: { kind: string; text: string; level?: 1 | 2 | 3; style?: Partial<DiagramTextStyle> }[],
  baseStyle: React.CSSProperties,
): React.ReactNode {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden px-2 py-1" style={baseStyle}>
      {blocks.map((b, i) => {
        const style: React.CSSProperties = { ...baseStyle, ...textStyleToCss(b.style) };
        if (b.kind === "heading") {
          const size = b.level === 1 ? 18 : b.level === 2 ? 16 : 14;
          return (
            <div key={i} style={{ ...style, fontSize: size, fontWeight: 700 }}>{b.text}</div>
          );
        }
        if (b.kind === "bullet") {
          return <div key={i} style={style}>• {b.text}</div>;
        }
        if (b.kind === "numbered") {
          return <div key={i} style={style}>{i + 1}. {b.text}</div>;
        }
        return <div key={i} style={style}>{b.text}</div>;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v2 文档 → React Flow
// ---------------------------------------------------------------------------

export interface DiagramNodeData extends Record<string, unknown> {
  element: DiagramElement;
  readOnly: boolean;
  /** 双击编辑 label 回调 */
  onLabelEdit?: (elementId: string, text: string) => void;
  /** 双击编辑容器标题 */
  onTitleEdit?: (elementId: string, title: string) => void;
}

export interface DiagramEdgeData extends Record<string, unknown> {
  connector: DiagramConnector;
  readOnly: boolean;
  onLabelEdit?: (connectorId: string, text: string) => void;
}

/** 把 v2 元素转为 React Flow Node。 */
export function toFlowNode(
  el: DiagramElement,
  readOnly: boolean,
  callbacks?: { onLabelEdit?: (id: string, text: string) => void; onTitleEdit?: (id: string, title: string) => void },
): Node {
  const data: DiagramNodeData = {
    element: el,
    readOnly,
    onLabelEdit: callbacks?.onLabelEdit,
    onTitleEdit: callbacks?.onTitleEdit,
  };
  return {
    id: el.id,
    type: "diagram",
    position: { x: el.position.x, y: el.position.y },
    width: el.size.width,
    height: el.size.height,
    data,
    // group/container 放最底层（React Flow 中 zIndex 小的在下）
    zIndex: el.type === "group" || el.type === "container" ? -100 + el.zIndex : el.zIndex,
    // group/container 作为父节点
    ...(el.type === "group" || el.type === "container" ? { type: "diagram-group" } : {}),
    parentId: el.parentId,
    // hidden 元素不渲染
    ...(el.hidden ? { style: { display: "none" } } : {}),
    // locked 元素不可拖动
    draggable: !readOnly && !el.locked,
    // 元素透明度
    ...(typeof el.opacity === "number" ? { style: { ...(el.hidden ? { display: "none" } : {}), opacity: el.opacity } } : {}),
  };
}

/** 把 v2 连接器转为 React Flow Edge。 */
export function toFlowEdge(
  conn: DiagramConnector,
  readOnly: boolean,
  callbacks?: { onLabelEdit?: (id: string, text: string) => void },
): Edge {
  const data: DiagramEdgeData = {
    connector: conn,
    readOnly,
    onLabelEdit: callbacks?.onLabelEdit,
  };
  // React Flow 要求 source/target 是节点 id；自由端点用虚拟锚点
  const source = conn.source.elementId ?? `__free-${conn.id}-source`;
  const target = conn.target.elementId ?? `__free-${conn.id}-target`;
  const sourceHandle = conn.source.portId ? `${conn.source.portId}-source` : undefined;
  const targetHandle = conn.target.portId ? `${conn.target.portId}-target` : undefined;
  const label = conn.label?.map((b) => b.text).join(" ") || undefined;
  const strokeDasharray =
    conn.stroke.style === "dashed" ? "6 3" : conn.stroke.style === "dotted" ? "2 3" : undefined;
  const edge: Edge = {
    id: conn.id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: conn.route === "bezier" ? "default" : conn.route === "straight" ? "straight" : "smoothstep",
    label,
    data,
    zIndex: conn.zIndex,
    markerEnd: conn.markerEnd !== "none" ? buildMarkerId(conn.markerEnd, "end") : undefined,
    markerStart: conn.markerStart !== "none" ? buildMarkerId(conn.markerStart, "start") : undefined,
    style: {
      stroke: conn.stroke.color,
      strokeWidth: conn.stroke.width,
      strokeDasharray,
    },
  };
  return edge;
}

/** 构建 React Flow marker 引用（与 DiagramCanvas 中 <DiagramMarkers> 定义的 id 对应）。 */
function buildMarkerId(marker: string, end: "start" | "end"): string {
  return `url(#diagram-marker-${marker}-${end})`;
}

/** 把 v2 文档全部元素转为 React Flow Node[]。 */
export function docToFlowNodes(
  doc: DiagramDocument,
  readOnly: boolean,
  callbacks?: { onLabelEdit?: (id: string, text: string) => void; onTitleEdit?: (id: string, title: string) => void },
): Node[] {
  // 自由端点连接器需要虚拟锚点节点（React Flow 要求 edge 必须连接节点）
  const freeAnchors: Node[] = [];
  const seen = new Set<string>();
  for (const conn of doc.connectors) {
    for (const end of [conn.source, conn.target]) {
      if (!end.elementId && end.point) {
        const anchorId = end === conn.source ? `__free-${conn.id}-source` : `__free-${conn.id}-target`;
        if (!seen.has(anchorId)) {
          seen.add(anchorId);
          freeAnchors.push({
            id: anchorId,
            type: "diagram-anchor",
            position: { x: end.point.x, y: end.point.y },
            width: 1,
            height: 1,
            data: { element: null, readOnly: true },
            draggable: false,
            selectable: false,
            style: { opacity: 0, pointerEvents: "none" },
          });
        }
      }
    }
  }
  const nodes = doc.elements.map((el) => toFlowNode(el, readOnly, callbacks));
  return [...nodes, ...freeAnchors];
}

/** 把 v2 文档全部连接器转为 React Flow Edge[]。 */
export function docToFlowEdges(
  doc: DiagramDocument,
  readOnly: boolean,
  callbacks?: { onLabelEdit?: (id: string, text: string) => void },
): Edge[] {
  return doc.connectors.map((conn) => toFlowEdge(conn, readOnly, callbacks));
}

// ---------------------------------------------------------------------------
// React Flow → v2 文档
// ---------------------------------------------------------------------------

/** 从 React Flow Node 提取位置/尺寸，更新元素。 */
export function applyFlowNodeToElement(el: DiagramElement, node: Node): DiagramElement {
  const next = { ...el, position: { x: node.position.x, y: node.position.y } };
  if (typeof node.width === "number" && typeof node.height === "number" && node.width > 0 && node.height > 0) {
    next.size = { width: node.width, height: node.height };
  }
  return next;
}

/** 从 React Flow Edge 提取连接信息，更新连接器端点。 */
export function applyFlowEdgeToConnector(
  conn: DiagramConnector,
  edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
): DiagramConnector {
  const source: DiagramConnector["source"] = { elementId: edge.source };
  if (edge.sourceHandle) source.portId = edge.sourceHandle.replace(/-source$/, "");
  const target: DiagramConnector["target"] = { elementId: edge.target };
  if (edge.targetHandle) target.portId = edge.targetHandle.replace(/-target$/, "");
  return { ...conn, source, target };
}

/** 从 React Flow connection 构造新连接器端点。 */
export function flowConnectionToEndpoint(
  nodeId: string,
  handleId: string | null | undefined,
): DiagramConnector["source"] {
  const ep: DiagramConnector["source"] = { elementId: nodeId };
  if (handleId) ep.portId = handleId.replace(/-(source|target)$/, "");
  return ep;
}

// ---------------------------------------------------------------------------
// 形状渲染（shape 元素专用）
// ---------------------------------------------------------------------------

/** 渲染 shape 元素的完整内容（SVG 形状 + 文本）。 */
export function renderShapeElement(
  el: DiagramShapeElement,
  gradientIdPrefix: string,
): React.ReactNode {
  const { defs, fill } = buildGradientDefs(el.fill, gradientIdPrefix);
  const stroke = strokeToSvgProps(el.stroke);
  const textCss = textStyleToCss(el.textStyle);
  const cornerRadius = el.cornerRadius ?? 0;
  return (
    <div className="relative h-full w-full">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 200 100"
        preserveAspectRatio="none"
      >
        {defs}
        {renderShapeSvg({ kind: el.shapeKind, fill, stroke: stroke.stroke, strokeWidth: stroke.strokeWidth, strokeDasharray: stroke.strokeDasharray })}
        {cornerRadius > 0 && el.shapeKind === "rectangle" && (
          <rect x="1" y="1" width="198" height="98" rx={cornerRadius} fill="none" stroke={stroke.stroke} strokeWidth={stroke.strokeWidth} />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {renderTextBlocks(el.textBlocks, textCss)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 选择辅助
// ---------------------------------------------------------------------------

/** 从 React Flow 选区提取元素 id 列表（排除虚拟锚点）。 */
export function flowSelectionToElementIds(nodes: Node[]): string[] {
  return nodes.filter((n) => !n.id.startsWith("__free-")).map((n) => n.id);
}

/** 从 React Flow 选区提取连接器 id 列表。 */
export function flowSelectionToConnectorIds(edges: Edge[]): string[] {
  return edges.map((e) => e.id);
}
