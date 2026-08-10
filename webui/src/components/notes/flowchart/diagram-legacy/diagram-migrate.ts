/**
 * v1 流程图文档 → v2 图表文档纯函数迁移。
 *
 * 规范（见计划 §12）：
 * 1. 迁移是纯函数：相同输入必产生相同输出，可重复执行结果一致；
 * 2. 所有旧字段有明确映射或明确忽略理由；
 * 3. 迁移前后节点位置、尺寸、样式、边端点保持；
 * 4. 迁移失败不覆盖原文件（由调用方保证，本函数不接触 IO）；
 * 5. direction → layout.direction；viewport 原样迁移。
 */

import type {
  FlowchartDirection,
  FlowchartDocument,
  FlowchartEdge,
  FlowchartEdgeStyle,
  FlowchartNode,
  FlowchartNodeStyle,
} from "../flowchart-document";
import {
  DIAGRAM_CAPABILITY_VERSION,
  DIAGRAM_DOCUMENT_VERSION,
  defaultCanvasSettings,
  type ConnectorRoute,
  type DiagramConnector,
  type DiagramDocument,
  type DiagramElement,
  type DiagramSemanticData,
  type DiagramTextBlock,
  type DiagramTextStyle,
  type EndpointMarker,
  type ShapeKind,
} from "./diagram-document";

// ---------------------------------------------------------------------------
// 节点 kind 映射
// ---------------------------------------------------------------------------

interface KindMapping {
  elementType: "shape" | "text" | "image" | "freehand";
  shapeKind?: ShapeKind;
  role?: string;
}

/** v1 流程图的 23 种节点 kind（v2 扩展前的子集）。 */
type V1FlowchartNodeKind =
  | "start"
  | "process"
  | "decision"
  | "end"
  | "document"
  | "database"
  | "annotation"
  | "subprocess"
  | "input-output"
  | "terminator"
  | "multi-document"
  | "predefined-process"
  | "manual-input"
  | "preparation"
  | "delay"
  | "display"
  | "connector"
  | "off-page-connector"
  | "internal-storage"
  | "stored-data"
  | "text"
  | "image"
  | "freehand";

/** v1 全部 23 种节点 kind 的映射表；遗漏任何 kind 会在迁移时报错而不是静默近似。 */
export const V1_NODE_KIND_MAP: Record<V1FlowchartNodeKind, KindMapping> = {
  start: { elementType: "shape", shapeKind: "pill", role: "start" },
  end: { elementType: "shape", shapeKind: "pill", role: "end" },
  terminator: { elementType: "shape", shapeKind: "pill" },
  process: { elementType: "shape", shapeKind: "process" },
  decision: { elementType: "shape", shapeKind: "diamond" },
  document: { elementType: "shape", shapeKind: "document" },
  database: { elementType: "shape", shapeKind: "database" },
  annotation: { elementType: "shape", shapeKind: "callout" },
  subprocess: { elementType: "shape", shapeKind: "subprocess" },
  "input-output": { elementType: "shape", shapeKind: "parallelogram" },
  "multi-document": { elementType: "shape", shapeKind: "multi-document" },
  "predefined-process": { elementType: "shape", shapeKind: "predefined-process" },
  "manual-input": { elementType: "shape", shapeKind: "manual-input" },
  preparation: { elementType: "shape", shapeKind: "hexagon" },
  delay: { elementType: "shape", shapeKind: "delay" },
  display: { elementType: "shape", shapeKind: "display" },
  connector: { elementType: "shape", shapeKind: "junction" },
  "off-page-connector": { elementType: "shape", shapeKind: "off-page-connector" },
  "internal-storage": { elementType: "shape", shapeKind: "internal-storage" },
  "stored-data": { elementType: "shape", shapeKind: "stored-data" },
  text: { elementType: "text" },
  image: { elementType: "image" },
  freehand: { elementType: "freehand" },
};

// ---------------------------------------------------------------------------
// 样式映射
// ---------------------------------------------------------------------------

function migrateTextStyle(style: FlowchartNodeStyle | undefined): Partial<DiagramTextStyle> | undefined {
  if (!style) return undefined;
  const out: Partial<DiagramTextStyle> = {};
  if (style.fontFamily) out.fontFamily = style.fontFamily;
  if (style.fontSize) out.fontSize = style.fontSize;
  if (style.color) out.color = style.color;
  if (style.bold) out.fontWeight = 700;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.textAlign) out.align = style.textAlign;
  return Object.keys(out).length === 0 ? undefined : out;
}

function migrateRoute(route: FlowchartEdgeStyle["route"]): ConnectorRoute {
  switch (route) {
    case "straight":
      return "straight";
    case "smoothstep":
      return "orthogonal";
    case "bezier":
    case undefined:
      return "bezier";
  }
}

function migrateMarker(marker: FlowchartEdgeStyle["markerStart"] | FlowchartEdgeStyle["markerEnd"]): EndpointMarker {
  switch (marker) {
    case "arrow":
      return "arrow-open";
    case "arrowclosed":
      return "arrow-closed";
    default:
      return "none";
  }
}

function makeLabelBlock(id: string, text: string): DiagramTextBlock {
  return { id, kind: "paragraph", text };
}

// ---------------------------------------------------------------------------
// 节点迁移
// ---------------------------------------------------------------------------

const DEFAULT_NODE_SIZE = { width: 160, height: 60 };
const JUNCTION_SIZE = { width: 40, height: 40 };

/** 类型守卫：检查 kind 是否为 v1 流程图的 23 种 kind。 */
function isV1NodeKind(kind: string): kind is V1FlowchartNodeKind {
  return kind in V1_NODE_KIND_MAP;
}

function migrateNode(node: FlowchartNode, warnings: string[]): DiagramElement {
  if (!isV1NodeKind(node.kind)) {
    throw new Error(`未知节点 kind：${String(node.kind)}`);
  }
  const mapping = V1_NODE_KIND_MAP[node.kind];
  const size = node.size
    ? { width: node.size.width, height: node.size.height }
    : mapping.shapeKind === "junction"
      ? { ...JUNCTION_SIZE }
      : { ...DEFAULT_NODE_SIZE };
  const base = {
    id: node.id,
    position: { x: node.position.x, y: node.position.y },
    size,
    rotation: 0,
    zIndex: 0,
  };
  const semantic: DiagramSemanticData = {};
  if (mapping.role) semantic.role = mapping.role;
  const hasSemantic = Object.keys(semantic).length > 0;
  const textStyle = migrateTextStyle(node.style);

  switch (mapping.elementType) {
    case "shape": {
      return {
        ...base,
        type: "shape",
        shapeKind: mapping.shapeKind!,
        fill:
          node.style?.fill !== undefined
            ? { type: "solid", color: node.style.fill }
            : { type: "none" },
        ...(node.style?.borderColor !== undefined || node.style?.borderWidth !== undefined
          ? {
              stroke: {
                color: node.style.borderColor ?? "#1f2329",
                width: node.style.borderWidth ?? 1,
                style: node.style.borderStyle ?? "solid",
              },
            }
          : {}),
        textBlocks: node.label ? [makeLabelBlock(`${node.id}-t0`, node.label)] : [],
        ...(textStyle ? { textStyle } : {}),
        ...(hasSemantic ? { semantic } : {}),
      };
    }
    case "text": {
      return {
        ...base,
        type: "text",
        textBlocks: node.label ? [makeLabelBlock(`${node.id}-t0`, node.label)] : [],
        ...(textStyle ? { textStyle } : {}),
      };
    }
    case "image": {
      if (!node.imagePath) {
        warnings.push(`image 节点 ${node.id} 缺少 imagePath，迁移为占位资产`);
      }
      return {
        ...base,
        type: "image",
        assetId: node.imagePath ?? `missing-${node.id}`,
        fit: "contain",
        ...(node.label ? { alt: node.label } : {}),
      };
    }
    case "freehand": {
      return {
        ...base,
        type: "freehand",
        points: (node.points ?? []).map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })),
        ...(node.path ? { path: node.path } : {}),
        drawingTool: node.drawingTool ?? "pen",
        color: node.color ?? "#1f2329",
        strokeWidth: node.strokeWidth ?? 8,
        ...(typeof node.opacity === "number" ? { opacity: node.opacity } : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 边迁移
// ---------------------------------------------------------------------------

function migrateEdge(edge: FlowchartEdge): DiagramConnector {
  const style = edge.style;
  const connector: DiagramConnector = {
    id: edge.id,
    source: {
      elementId: edge.source,
      ...(edge.sourceHandle ? { portId: edge.sourceHandle } : {}),
    },
    target: {
      elementId: edge.target,
      ...(edge.targetHandle ? { portId: edge.targetHandle } : {}),
    },
    route: migrateRoute(style?.route),
    markerStart: migrateMarker(style?.markerStart),
    markerEnd: migrateMarker(style?.markerEnd),
    stroke: {
      color: style?.stroke ?? "#1f2329",
      width: style?.strokeWidth ?? 1.5,
      style: style?.strokeDasharray ?? "solid",
    },
    zIndex: 0,
  };
  if (edge.label) {
    connector.label = [makeLabelBlock(`${edge.id}-t0`, edge.label)];
  }
  return connector;
}

// ---------------------------------------------------------------------------
// 迁移入口
// ---------------------------------------------------------------------------

export interface DiagramMigrationResult {
  ok: true;
  document: DiagramDocument;
  /** 非阻塞性提示（如缺 imagePath 的占位资产） */
  warnings: string[];
}

/**
 * 把 v1 FlowchartDocument 迁移为 v2 DiagramDocument（diagramKind: "flowchart"）。
 * 纯函数，确定性输出；输入不合法时抛异常（调用方应先 validate v1 文档）。
 */
export function migrateFlowchartV1ToDiagramV2(v1: FlowchartDocument): DiagramMigrationResult {
  const warnings: string[] = [];
  const elements = v1.nodes.map((n) => migrateNode(n, warnings));
  const connectors = v1.edges.map(migrateEdge);

  // image 节点引用的资产登记到 assets（assetId 直接使用 v1 的相对路径）
  const assets = v1.nodes
    .filter((n) => n.kind === "image" && n.imagePath)
    .map((n) => ({ id: n.imagePath!, path: n.imagePath!, mime: guessMime(n.imagePath!) }));

  const canvas = defaultCanvasSettings("flowchart");

  const doc: DiagramDocument = {
    version: DIAGRAM_DOCUMENT_VERSION,
    capabilityVersion: DIAGRAM_CAPABILITY_VERSION,
    diagramKind: "flowchart",
    canvas,
    layout: { direction: v1.direction as FlowchartDirection as "TB" | "LR" },
    elements,
    connectors,
    ...(assets.length > 0 ? { assets } : {}),
    ...(v1.viewport
      ? { viewport: { x: v1.viewport.x, y: v1.viewport.y, zoom: v1.viewport.zoom } }
      : {}),
  };
  return { ok: true, document: doc, warnings };
}

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}
