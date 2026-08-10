/**
 * diagram v2 -> flowchart v2 一次性迁移器。
 *
 * 规范（见 FLOWCHART_DEVELOPMENT_PLAN.md §10.2）：
 * 1. shape/text/image/freehand/group/container/brace 映射为 flowchart 节点；
 *    connector 映射为 edge；canvas/viewport/layout 映射为同名字段；
 * 2. table/lifeline/activation/icon、无法映射的 shapeKind 或 marker、自由端点
 *    连接器视为不支持：迁移整体失败并给出原因，不生成部分结果，不覆盖原文件；
 * 3. 渐变填充/渐变背景降级为第一个色标的纯色并记录 warning；
 * 4. 嵌套 group/container 拍平到根级（坐标转绝对）并记录 warning；
 * 5. hidden 元素保留并记录 warning（不丢数据）；
 * 6. 迁移结果必须通过 validateFlowchartDocument，否则视为失败；
 * 7. 相同输入产生相同输出（纯函数，不生成新 id）。
 */

import type {
  ContainerRole,
  DiagramContainerElement,
  DiagramDocument,
  DiagramElement,
  DiagramFreehandElement,
  DiagramGroupElement,
  DiagramImageElement,
  DiagramShapeElement,
  DiagramStroke,
  DiagramTextBlock,
  DiagramTextElement,
  DiagramTextStyle,
  EndpointMarker,
  Paint,
  ShapeKind,
} from "./diagram-legacy/diagram-document";
import type {
  FlowchartCanvasSettings,
  FlowchartDocument,
  FlowchartEdge,
  FlowchartEdgeStyle,
  FlowchartNode,
  FlowchartNodeKind,
  FlowchartNodeStyle,
} from "./flowchart-document";
import {
  DEFAULT_FLOWCHART_THEME,
  FLOWCHART_DOCUMENT_VERSION,
  validateFlowchartDocument,
} from "./flowchart-document";

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type DiagramToFlowchartResult =
  | { ok: true; document: FlowchartDocument; warnings: string[] }
  | { ok: false; reasons: string[] };

// ---------------------------------------------------------------------------
// shapeKind 映射
// ---------------------------------------------------------------------------

/**
 * diagram ShapeKind -> flowchart NodeKind。
 * null 表示无对应形状，迁移失败。
 * 视觉保真优先：diagram 的 process/subprocess 渲染为带竖线矩形，
 * 分别对应 flowchart 的 predefined-process/subprocess。
 */
const SHAPE_KIND_MAP: Record<ShapeKind, FlowchartNodeKind | null> = {
  rectangle: "rectangle",
  "rounded-rectangle": "rounded-rectangle",
  ellipse: "ellipse",
  circle: "circle",
  pill: "terminator",
  diamond: "diamond-basic",
  hexagon: "hexagon-basic",
  parallelogram: "input-output",
  cylinder: "database",
  document: "document",
  "multi-document": "multi-document",
  cloud: "cloud",
  actor: null,
  callout: "callout",
  chevron: null,
  pentagon: "pentagon-basic",
  trapezoid: "manual-operation",
  process: "predefined-process",
  subprocess: "subprocess",
  database: "database",
  junction: "connector",
  "predefined-process": "predefined-process",
  "manual-input": "manual-input",
  delay: "delay",
  display: "display",
  "off-page-connector": "off-page-connector",
  "internal-storage": "internal-storage",
  "stored-data": "stored-data",
};

/** pill + 语义角色 start/end 升级为 flowchart 语义 kind（视觉同为胶囊）。 */
function resolveShapeKind(el: DiagramShapeElement): FlowchartNodeKind | null {
  if (el.shapeKind === "pill" && el.semantic?.role === "start") return "start";
  if (el.shapeKind === "pill" && el.semantic?.role === "end") return "end";
  return SHAPE_KIND_MAP[el.shapeKind];
}

// ---------------------------------------------------------------------------
// marker / route 映射
// ---------------------------------------------------------------------------

const MARKER_MAP: Record<EndpointMarker, "none" | "arrow" | "arrowclosed" | null> = {
  none: "none",
  "arrow-open": "arrow",
  "arrow-closed": "arrowclosed",
  triangle: null,
  circle: null,
  "diamond-open": null,
  "diamond-filled": null,
  bar: null,
  "er-one": null,
  "er-one-many": null,
  "er-many": null,
};

const ROUTE_MAP: Record<string, "straight" | "smoothstep" | "bezier"> = {
  straight: "straight",
  orthogonal: "smoothstep",
  bezier: "bezier",
};

// ---------------------------------------------------------------------------
// 样式映射
// ---------------------------------------------------------------------------

/** Paint -> CSS color；渐变降级为第一个色标并记录 warning。 */
function convertPaint(
  paint: Paint | undefined,
  ctx: string,
  warnings: string[],
): string | undefined {
  if (!paint || paint.type === "none") return undefined;
  if (paint.type === "solid") return paint.color;
  const first = paint.stops[0];
  if (!first) return undefined;
  warnings.push(`${ctx}：渐变填充已降级为纯色 ${first.color}`);
  return first.color;
}

function applyStroke(style: FlowchartNodeStyle, stroke: DiagramStroke | undefined): void {
  if (!stroke) return;
  style.borderColor = stroke.color;
  style.borderWidth = stroke.width;
  if (stroke.style !== "solid") style.borderStyle = stroke.style;
}

function applyTextStyle(
  style: FlowchartNodeStyle,
  textStyle: Partial<DiagramTextStyle> | undefined,
): void {
  if (!textStyle) return;
  if (textStyle.fontFamily) style.fontFamily = textStyle.fontFamily;
  if (typeof textStyle.fontSize === "number") style.fontSize = textStyle.fontSize;
  if (textStyle.color) style.color = textStyle.color;
  if (typeof textStyle.fontWeight === "number" && textStyle.fontWeight >= 600) {
    style.bold = true;
  }
  if (textStyle.italic) style.italic = true;
  if (textStyle.underline) style.underline = true;
  if (textStyle.align) style.textAlign = textStyle.align;
  if (textStyle.verticalAlign) style.verticalAlign = textStyle.verticalAlign;
  if (typeof textStyle.lineHeight === "number") style.lineHeight = textStyle.lineHeight;
}

/** 合并文本块为节点 label（块间换行）。 */
function blocksToLabel(blocks: DiagramTextBlock[]): string {
  return blocks
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// 元素映射
// ---------------------------------------------------------------------------

interface ConvertContext {
  warnings: string[];
  reasons: string[];
}

/** 公共字段：position/size/rotation/zIndex/locked/opacity/parentId。 */
function applyCommonFields(node: FlowchartNode, el: DiagramElement, ctx: ConvertContext): void {
  node.size = { width: el.size.width, height: el.size.height };
  if (el.rotation !== 0) node.rotation = ((el.rotation % 360) + 360) % 360;
  if (el.zIndex !== 0) node.zIndex = el.zIndex;
  if (el.locked) node.locked = true;
  if (typeof el.opacity === "number") node.opacity = el.opacity;
  if (el.parentId) node.parentId = el.parentId;
  if (el.hidden) {
    ctx.warnings.push(`元素 ${el.id} 在旧图中被隐藏，迁移后将显示`);
  }
}

function convertShape(el: DiagramShapeElement, ctx: ConvertContext): FlowchartNode | null {
  const kind = resolveShapeKind(el);
  if (!kind) {
    ctx.reasons.push(`元素 ${el.id}：不支持的形状类型 "${el.shapeKind}"`);
    return null;
  }
  const node: FlowchartNode = {
    id: el.id,
    kind,
    label: blocksToLabel(el.textBlocks),
    position: { x: el.position.x, y: el.position.y },
  };
  applyCommonFields(node, el, ctx);
  const style: FlowchartNodeStyle = {};
  const fill = convertPaint(el.fill, `元素 ${el.id}`, ctx.warnings);
  if (fill) style.fill = fill;
  applyStroke(style, el.stroke);
  applyTextStyle(style, el.textStyle);
  if (typeof el.cornerRadius === "number") style.cornerRadius = el.cornerRadius;
  if (el.shadow) {
    ctx.warnings.push(`元素 ${el.id}：阴影效果不支持，已忽略`);
  }
  if (Object.keys(style).length > 0) node.style = style;
  return node;
}

function convertText(el: DiagramTextElement, ctx: ConvertContext): FlowchartNode {
  const node: FlowchartNode = {
    id: el.id,
    kind: "text",
    label: blocksToLabel(el.textBlocks),
    position: { x: el.position.x, y: el.position.y },
  };
  applyCommonFields(node, el, ctx);
  const style: FlowchartNodeStyle = {};
  applyTextStyle(style, el.textStyle);
  if (Object.keys(style).length > 0) node.style = style;
  return node;
}

function convertImage(
  el: DiagramImageElement,
  doc: DiagramDocument,
  ctx: ConvertContext,
): FlowchartNode | null {
  const asset = doc.assets?.find((a) => a.id === el.assetId);
  if (!asset) {
    ctx.reasons.push(`图片元素 ${el.id}：找不到资产 "${el.assetId}"`);
    return null;
  }
  const node: FlowchartNode = {
    id: el.id,
    kind: "image",
    label: el.alt ?? "",
    position: { x: el.position.x, y: el.position.y },
    imagePath: asset.path,
  };
  applyCommonFields(node, el, ctx);
  if (el.crop) {
    ctx.warnings.push(`图片元素 ${el.id}：裁剪设置不支持，已忽略`);
  }
  return node;
}

function convertFreehand(el: DiagramFreehandElement, ctx: ConvertContext): FlowchartNode {
  const node: FlowchartNode = {
    id: el.id,
    kind: "freehand",
    label: "",
    position: { x: el.position.x, y: el.position.y },
    points: el.points.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })),
    drawingTool: el.drawingTool,
    color: el.color,
    strokeWidth: el.strokeWidth,
  };
  if (el.path) node.path = el.path;
  applyCommonFields(node, el, ctx);
  // freehand 的 opacity 是笔触不透明度，缺省时荧光笔 0.28、钢笔 1
  if (typeof el.opacity !== "number") {
    node.opacity = el.drawingTool === "highlighter" ? 0.28 : 1;
  }
  return node;
}

/** 容器角色的中文标签（用于迁移 warning）。 */
const CONTAINER_ROLE_LABELS: Record<ContainerRole, string> = {
  boundary: "边界",
  swimlane: "泳道",
  phase: "阶段",
  region: "区域",
  tier: "层级",
};

function convertGroup(
  el: DiagramGroupElement | DiagramContainerElement,
  ctx: ConvertContext,
): FlowchartNode {
  const isContainer = el.type === "container";
  const label = isContainer ? el.title : (el.title ?? "");
  const node: FlowchartNode = {
    id: el.id,
    kind: "group",
    label,
    position: { x: el.position.x, y: el.position.y },
    container: { type: "group" },
  };
  applyCommonFields(node, el, ctx);
  const style: FlowchartNodeStyle = {};
  const background = convertPaint(el.background, `容器 ${el.id}`, ctx.warnings);
  if (background) style.fill = background;
  if (isContainer) applyStroke(style, el.stroke);
  if (isContainer && el.containerRole !== "boundary") {
    ctx.warnings.push(
      `容器 ${el.id}（${CONTAINER_ROLE_LABELS[el.containerRole]}）已转换为普通组合框`,
    );
  }
  if (Object.keys(style).length > 0) node.style = style;
  return node;
}

function convertElement(
  el: DiagramElement,
  doc: DiagramDocument,
  ctx: ConvertContext,
): FlowchartNode | null {
  switch (el.type) {
    case "shape":
      return convertShape(el, ctx);
    case "text":
      return convertText(el, ctx);
    case "image":
      return convertImage(el, doc, ctx);
    case "freehand":
      return convertFreehand(el, ctx);
    case "group":
    case "container":
      return convertGroup(el, ctx);
    case "brace": {
      const node: FlowchartNode = {
        id: el.id,
        kind: "brace",
        label: "",
        position: { x: el.position.x, y: el.position.y },
      };
      applyCommonFields(node, el, ctx);
      const style: FlowchartNodeStyle = {};
      applyStroke(style, el.stroke);
      if (Object.keys(style).length > 0) node.style = style;
      return node;
    }
    case "icon":
      ctx.reasons.push(`图标元素 ${el.id}（${el.iconRef.library}:${el.iconRef.name}）无法迁移`);
      return null;
    case "table":
      ctx.reasons.push(`表格元素 ${el.id} 无法迁移`);
      return null;
    case "lifeline":
      ctx.reasons.push(`生命线元素 ${el.id} 无法迁移`);
      return null;
    case "activation":
      ctx.reasons.push(`激活条元素 ${el.id} 无法迁移`);
      return null;
    default: {
      const neverEl: never = el;
      ctx.reasons.push(`未知元素类型：${JSON.stringify((neverEl as DiagramElement).type)}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// 嵌套 group 拍平
// ---------------------------------------------------------------------------

/**
 * flowchart v2 不允许 group 归属其他容器。
 * diagram 允许 group/container 嵌套，迁移时把嵌套 group 拍平到根级：
 * position 转为绝对坐标，其子元素相对坐标不变。
 */
function flattenNestedGroups(nodes: FlowchartNode[], ctx: ConvertContext): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absoluteCache = new Map<string, { x: number; y: number }>();
  const absolutePosition = (node: FlowchartNode): { x: number; y: number } => {
    const cached = absoluteCache.get(node.id);
    if (cached) return cached;
    let x = node.position.x;
    let y = node.position.y;
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) {
        const abs = absolutePosition(parent);
        x += abs.x;
        y += abs.y;
      }
    }
    const abs = { x, y };
    absoluteCache.set(node.id, abs);
    return abs;
  };
  for (const node of nodes) {
    if (node.kind !== "group" || !node.parentId) continue;
    const parent = byId.get(node.parentId);
    if (parent && parent.kind === "group") {
      const abs = absolutePosition(node);
      node.position = abs;
      delete node.parentId;
      ctx.warnings.push(`嵌套组合 ${node.id} 已拍平到根级画布`);
    }
  }
}

// ---------------------------------------------------------------------------
// 连接器映射
// ---------------------------------------------------------------------------

function convertConnector(
  conn: DiagramDocument["connectors"][number],
  nodeIds: Set<string>,
  ctx: ConvertContext,
): FlowchartEdge | null {
  const sourceId = conn.source.elementId;
  const targetId = conn.target.elementId;
  if (!sourceId || !targetId) {
    ctx.reasons.push(`连接器 ${conn.id}：自由端点（未绑定元素）无法迁移`);
    return null;
  }
  if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
    ctx.reasons.push(`连接器 ${conn.id}：端点引用了无法迁移的元素`);
    return null;
  }
  const markerStart = MARKER_MAP[conn.markerStart];
  const markerEnd = MARKER_MAP[conn.markerEnd];
  if (markerStart === null || markerEnd === null) {
    ctx.reasons.push(
      `连接器 ${conn.id}：不支持的端点样式（${conn.markerStart}/${conn.markerEnd}）`,
    );
    return null;
  }
  const edge: FlowchartEdge = { id: conn.id, source: sourceId, target: targetId };
  const label = conn.label ? blocksToLabel(conn.label) : "";
  if (label) edge.label = label;
  const style: FlowchartEdgeStyle = {};
  const route = ROUTE_MAP[conn.route];
  if (route && route !== "bezier") style.route = route;
  if (markerStart !== "none") style.markerStart = markerStart;
  if (markerEnd !== "arrowclosed") style.markerEnd = markerEnd;
  if (conn.stroke) {
    style.stroke = conn.stroke.color;
    style.strokeWidth = conn.stroke.width;
    if (conn.stroke.style !== "solid") style.strokeDasharray = conn.stroke.style;
  }
  if (conn.waypoints && conn.waypoints.length > 0) {
    ctx.warnings.push(`连接器 ${conn.id}：手动控制点不支持，已按自动路由处理`);
  }
  if (Object.keys(style).length > 0) edge.style = style;
  return edge;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把 diagram v2 文档迁移为 flowchart v2 文档。
 * 全成全败：存在任何不支持元素时返回失败原因列表，不产出部分结果。
 */
export function convertDiagramToFlowchart(doc: DiagramDocument): DiagramToFlowchartResult {
  const ctx: ConvertContext = { warnings: [], reasons: [] };

  const nodes: FlowchartNode[] = [];
  for (const el of doc.elements) {
    const node = convertElement(el, doc, ctx);
    if (node) nodes.push(node);
  }
  if (ctx.reasons.length > 0) return { ok: false, reasons: ctx.reasons };

  flattenNestedGroups(nodes, ctx);

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: FlowchartEdge[] = [];
  for (const conn of doc.connectors) {
    const edge = convertConnector(conn, nodeIds, ctx);
    if (edge) edges.push(edge);
  }
  if (ctx.reasons.length > 0) return { ok: false, reasons: ctx.reasons };

  const canvas: FlowchartCanvasSettings = {
    mode: doc.canvas.mode,
    grid: {
      visible: doc.canvas.grid.visible,
      snap: doc.canvas.grid.snap,
      size: doc.canvas.grid.size,
    },
  };
  if (typeof doc.canvas.width === "number") canvas.width = doc.canvas.width;
  if (typeof doc.canvas.height === "number") canvas.height = doc.canvas.height;
  if (doc.canvas.orientation) canvas.orientation = doc.canvas.orientation;
  const background = convertPaint(doc.canvas.background, "画布背景", ctx.warnings);
  if (background) canvas.background = background;

  const result: FlowchartDocument = {
    version: FLOWCHART_DOCUMENT_VERSION,
    direction: doc.layout?.direction ?? "TB",
    canvas,
    theme: { ...DEFAULT_FLOWCHART_THEME },
    nodes,
    edges,
    viewport: doc.viewport ? { ...doc.viewport } : undefined,
  };

  const validation = validateFlowchartDocument(result);
  if (!validation.ok) {
    return {
      ok: false,
      reasons: validation.errors.map((e) => `迁移结果校验失败：[${e.code}] ${e.message}`),
    };
  }

  return { ok: true, document: result, warnings: ctx.warnings };
}
