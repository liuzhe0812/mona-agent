/**
 * 流程图笔记文档模型、解析、序列化、校验与语义哈希。
 *
 * 规范（见 docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §6, §7, §9.8）：
 * 1. 每张流程图保存为单个 .md 文件；
 * 2. 文件包含一段 ```mona-flowchart fenced block，内含版本化 JSON；
 * 3. 围栏之前是由 serializer 自动生成的 Markdown 文本投影，是只读派生产物；
 * 4. JSON 是唯一权威数据源；外部修改文本投影不会反向影响流程图；
 * 5. 解析失败时进入错误视图，不创建空图覆盖原内容；
 * 6. JSON 使用 2 空格格式化，便于 diff；
 * 7. 语义哈希只包含排序和规范化后的 version/direction/node/edge 语义字段，
 *    排除 position、viewport、JSON 格式和数组原始顺序；
 * 8. 版本升级必须通过显式迁移函数，不在 parser 中静默丢字段。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

import { migrateFlowchartV1ToV2 } from "./flowchart-migrate";

export type FlowchartDirection = "TB" | "LR";
export type FlowchartNodeKind =
  | "start"
  | "process"
  | "decision"
  | "end"
  | "document"
  | "database"
  | "annotation"
  | "subprocess"
  | "input-output"
  // 对齐 NoteGen 的 11 种扩展形状
  | "terminator"          // 胶囊（起止）
  | "multi-document"      // 多文档
  | "predefined-process"  // 预定义流程（带竖线）
  | "manual-input"        // 手动输入（斜顶）
  | "preparation"         // 准备（六边形）
  | "delay"               // 延迟（半圆）
  | "display"             // 显示（左弧平行四边形）
  | "connector"           // 连接圆
  | "off-page-connector"  // 跨页连接（五边形）
  | "internal-storage"    // 内部存储
  | "stored-data"         // 存储数据（横胶囊）
  | "text"                // 文本节点（对齐 NoteGen text 节点）
  | "image"               // 图片（对齐 NoteGen image 节点）
  | "freehand"            // 自由手绘（钢笔/荧光笔笔触）
  // v2 流程图扩展形状
  | "alternate-process"   // 替代流程（圆角矩形）
  | "manual-operation"    // 手动操作（梯形）
  | "card"                // 卡片
  | "merge"               // 合并（倒三角）
  | "extract"             // 提取（正三角）
  | "sort"                // 排序（三角对置）
  | "or"                  // 或（圆形带叉）
  | "summation"           // 求和连接（双弧圆）
  // v2 基础形状（视觉元素，不改变流程语义检查规则）
  | "rectangle"
  | "rounded-rectangle"
  | "ellipse"
  | "circle"
  | "triangle"
  | "right-triangle"
  | "diamond-basic"       // 基础菱形（区别于 decision）
  | "pentagon-basic"      // 基础五边形
  | "hexagon-basic"       // 基础六边形（区别于 preparation）
  | "octagon"
  | "star"
  | "cloud"
  | "callout"
  | "plus"
  | "l-shape"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-down"
  | "arrow-bidirectional"
  | "bracket-round"
  | "bracket-square"
  | "brace"
  | "code-block"
  | "note"                // 便签
  // v2 容器（不进流程语义节点列表，不可作为边端点）
  | "group"
  | "swimlane-pool"
  | "swimlane-lane";

export const FLOWCHART_NODE_KINDS: readonly FlowchartNodeKind[] = [
  "start",
  "process",
  "decision",
  "end",
  "document",
  "database",
  "annotation",
  "subprocess",
  "input-output",
  "terminator",
  "multi-document",
  "predefined-process",
  "manual-input",
  "preparation",
  "delay",
  "display",
  "connector",
  "off-page-connector",
  "internal-storage",
  "stored-data",
  "text",
  "image",
  "freehand",
  "alternate-process",
  "manual-operation",
  "card",
  "merge",
  "extract",
  "sort",
  "or",
  "summation",
  "rectangle",
  "rounded-rectangle",
  "ellipse",
  "circle",
  "triangle",
  "right-triangle",
  "diamond-basic",
  "pentagon-basic",
  "hexagon-basic",
  "octagon",
  "star",
  "cloud",
  "callout",
  "plus",
  "l-shape",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "arrow-bidirectional",
  "bracket-round",
  "bracket-square",
  "brace",
  "code-block",
  "note",
  "group",
  "swimlane-pool",
  "swimlane-lane",
];

/** 容器 kind：不进入流程语义节点列表，不可作为普通流程边端点。 */
export const FLOWCHART_CONTAINER_KINDS: readonly FlowchartNodeKind[] = [
  "group",
  "swimlane-pool",
  "swimlane-lane",
];

export function isFlowchartContainerKind(kind: FlowchartNodeKind): boolean {
  return FLOWCHART_CONTAINER_KINDS.includes(kind);
}

/**
 * AI patch 可用的节点 kind（FC-AI-01）。
 *
 * - 仅包含流程语义形状：9 种基础流程 + NoteGen 11 种扩展 + v2 8 种流程扩展；
 * - 不含基础装饰形状（rectangle/star/cloud 等）：避免模型随意美化，
 *   这些形状不出现在 AI 提示中（replaceGraph 回传既有装饰节点由校验层容忍）；
 * - 不含容器（group/swimlane-pool/swimlane-lane）：泳道 AI 协议未稳定（FC-AI-02 延后）；
 * - 不含 text/image/freehand：这些元素需要尺寸/内容语义，AI 不应管理。
 */
export const FLOWCHART_AI_NODE_KINDS: readonly FlowchartNodeKind[] = [
  "start",
  "end",
  "terminator",
  "process",
  "alternate-process",
  "predefined-process",
  "subprocess",
  "manual-operation",
  "decision",
  "input-output",
  "manual-input",
  "display",
  "document",
  "multi-document",
  "database",
  "internal-storage",
  "stored-data",
  "preparation",
  "delay",
  "card",
  "merge",
  "extract",
  "sort",
  "or",
  "summation",
  "connector",
  "off-page-connector",
  "annotation",
];

export const FLOWCHART_DIRECTIONS: readonly FlowchartDirection[] = ["TB", "LR"];

/** 节点样式覆盖（全部可选，undefined 表示使用主题默认值）。 */
export interface FlowchartNodeStyle {
  /** 字体族，如 "Inter"、"宋体" */
  fontFamily?: string;
  /** 字号（px） */
  fontSize?: number;
  /** 字色（CSS color） */
  color?: string;
  /** 填充色（CSS color） */
  fill?: string;
  /** 描边色（CSS color） */
  borderColor?: string;
  /** 描边宽度（px） */
  borderWidth?: number;
  /** 描边样式 */
  borderStyle?: "solid" | "dashed" | "dotted";
  /** 加粗 */
  bold?: boolean;
  /** 斜体 */
  italic?: boolean;
  /** 下划线 */
  underline?: boolean;
  /** 文字水平对齐（多行 label 时生效） */
  textAlign?: "left" | "center" | "right";
  /** 文字垂直对齐 */
  verticalAlign?: "top" | "middle" | "bottom";
  /** 行高倍数 */
  lineHeight?: number;
  /** 圆角半径（px，仅对支持圆角的几何生效） */
  cornerRadius?: number;
}

/** 边样式覆盖（全部可选，undefined 表示使用主题默认值）。 */
export interface FlowchartEdgeStyle {
  /** 线条颜色（CSS color） */
  stroke?: string;
  /** 线条宽度（px） */
  strokeWidth?: number;
  /** 线条样式 */
  strokeDasharray?: "solid" | "dashed" | "dotted";
  /** 路由类型；不参与语义哈希，仅影响渲染。
   *  对齐 NoteGen：bezier=贝塞尔曲线、smoothstep=圆角折线、straight=直线 */
  route?: "bezier" | "smoothstep" | "straight";
  /** 起点箭头 */
  markerStart?: "none" | "arrow" | "arrowclosed";
  /** 终点箭头 */
  markerEnd?: "none" | "arrow" | "arrowclosed";
}

export interface FlowchartNode {
  id: string;
  kind: FlowchartNodeKind;
  label: string;
  position: { x: number; y: number };
  /**
   * 节点尺寸（px），由 NodeResizer 写入。
   * 不参与语义哈希；Dagre 和碰撞检测使用实际尺寸。
   */
  size?: { width: number; height: number };
  /** 节点级样式覆盖；不参与语义哈希，但会写入 JSON 与渲染 */
  style?: FlowchartNodeStyle;
  /** 图片节点：相对于 vault 根目录的图片路径（如 assets/xxx.png） */
  imagePath?: string;
  /** freehand 节点：原始笔触点（含压感），不参与语义哈希 */
  points?: Array<{ x: number; y: number; pressure: number }>;
  /** freehand 节点：本地化后的 SVG path（相对节点左上角），不参与语义哈希 */
  path?: string;
  /** freehand 节点：笔触工具类型，不参与语义哈希 */
  drawingTool?: "pen" | "highlighter";
  /** freehand 节点：笔触颜色，不参与语义哈希 */
  color?: string;
  /** 不透明度（0-1，freehand 荧光笔默认 0.28），不参与语义哈希；v2 起通用，freehand 作为笔触不透明度 */
  opacity?: number;
  /** freehand 节点：笔触宽度（参考 perfect-freehand size），不参与语义哈希 */
  strokeWidth?: number;
  /** v2：父容器 id（group/pool/lane）；指向 lane 时进入语义投影（责任分配语义） */
  parentId?: string;
  /** v2：同父级内的层叠顺序，不参与语义哈希 */
  zIndex?: number;
  /** v2：旋转角度（0-359），不参与语义哈希 */
  rotation?: number;
  /** v2：水平翻转，不参与语义哈希 */
  flipX?: boolean;
  /** v2：垂直翻转，不参与语义哈希 */
  flipY?: boolean;
  /** v2：锁定后禁止位置/尺寸修改，不参与语义哈希 */
  locked?: boolean;
  /** v2：容器结构参数，只允许挂在 group/pool/lane kind 上 */
  container?:
    | { type: "group" }
    | { type: "pool"; orientation: "horizontal" | "vertical"; headerSize: number }
    | { type: "lane"; orientation: "horizontal" | "vertical"; order: number };
}

export interface FlowchartEdge {
  id: string;
  source: string;
  target: string;
  /** 源 Handle ID（如 "top" / "right" / "bottom" / "left"）；不参与语义哈希 */
  sourceHandle?: string;
  /** 目标 Handle ID；不参与语义哈希 */
  targetHandle?: string;
  label?: string;
  /** 边级样式覆盖；不参与语义哈希，但会写入 JSON 与渲染 */
  style?: FlowchartEdgeStyle;
  /** 用户调整的控制点（画布流坐标系绝对坐标），不参与语义哈希。
   *  - smoothstep: 用户拖动产生的拐角点序列，按顺序连接 source 和 target 之间的折线段
   *  - bezier: 长度固定为 2，作为 cubic bezier 的两个控制点 [cp1, cp2]
   *  - straight: 忽略（直线不支持控制点） */
  controlPoints?: { x: number; y: number }[];
}

export interface FlowchartViewport {
  x: number;
  y: number;
  zoom: number;
}

/** v2：画布设置。 */
export interface FlowchartCanvasSettings {
  mode: "infinite" | "page";
  /** 页面模式下的页面尺寸（px） */
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape";
  /** 画布背景（CSS color） */
  background?: string;
  grid: {
    visible: boolean;
    snap: boolean;
    size: number;
  };
}

/** v2：文档主题与配色。 */
export interface FlowchartThemeSettings {
  stylePreset: "solid" | "outline" | "soft";
  /** 内置配色 id（见 flowchart-themes.ts） */
  paletteId: string;
  /** 切换主题时是否保留节点级手动样式覆盖 */
  preserveManualStyles: boolean;
}

export const DEFAULT_FLOWCHART_CANVAS: FlowchartCanvasSettings = {
  mode: "infinite",
  grid: { visible: true, snap: true, size: 16 },
};

export const DEFAULT_FLOWCHART_THEME: FlowchartThemeSettings = {
  stylePreset: "solid",
  paletteId: "default",
  preserveManualStyles: true,
};

/**
 * 流程图文档（内存中始终是 v2）。
 * v1 文件解析后经 flowchart-migrate.ts 纯迁移函数补默认值进入内存；
 * 首次真实编辑保存时写为 v2。
 */
export interface FlowchartDocument {
  version: 2;
  direction: FlowchartDirection;
  canvas: FlowchartCanvasSettings;
  theme: FlowchartThemeSettings;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  viewport?: FlowchartViewport;
}

/** 语义节点：不含 position，用于 AI 上下文和 patch。 */
export interface FlowchartSemanticNode {
  id: string;
  kind: FlowchartNodeKind;
  label: string;
  /** 所属泳道 id（责任分配语义）；仅当 parentId 指向 swimlane-lane 时存在。 */
  laneId?: string;
}

/** 语义泳道：只含 id/label，不伪装成流程节点。 */
export interface FlowchartSemanticLane {
  id: string;
  label: string;
}

/** 语义图：不含坐标和 viewport，用于 AI 上下文、patch 和语义哈希。 */
export interface FlowchartSemanticGraph {
  direction: FlowchartDirection;
  nodes: FlowchartSemanticNode[];
  edges: FlowchartEdge[];
  /** 泳道标题列表（泳道归属是流程语义的一部分） */
  lanes?: FlowchartSemanticLane[];
}

// ---------------------------------------------------------------------------
// 围栏常量与提取
// ---------------------------------------------------------------------------

export const FLOWCHART_FENCE_LANG = "mona-flowchart";
export const FLOWCHART_PATCH_FENCE_LANG = "mona-flowchart-patch";
/** 当前文档版本；v1 文件解析后经迁移进入内存。 */
export const FLOWCHART_DOCUMENT_VERSION = 2;

const FENCE_OPEN_RE = /```mona-flowchart\s*\n/g;
const FENCE_CLOSE_RE = /```/g;

export interface ExtractedFence {
  content: string;
  /** 围栏开始标记（```mona-flowchart\n）在原文中的起始字节偏移。 */
  startOffset: number;
  /** 围栏结束标记（```）在原文中的结束字节偏移。 */
  endOffset: number;
}

/**
 * 提取 markdown 中第一个 mona-flowchart fenced block 的内容。
 * 多个围栏视为硬错误（在 parser 中处理），这里只返回第一个。
 * 找不到返回 null。
 */
export function extractFlowchartFence(markdown: string): ExtractedFence | null {
  const openMatch = FENCE_OPEN_RE.exec(markdown);
  if (!openMatch) return null;
  const contentStart = openMatch.index + openMatch[0].length;
  FENCE_CLOSE_RE.lastIndex = contentStart;
  const closeMatch = FENCE_CLOSE_RE.exec(markdown);
  if (!closeMatch) return null;
  return {
    content: markdown.slice(contentStart, closeMatch.index),
    endOffset: closeMatch.index + closeMatch[0].length,
    startOffset: openMatch.index,
  };
}

/** 统计 mona-flowchart 围栏数量（用于"必须且只能存在一个"校验）。 */
export function countFlowchartFences(markdown: string): number {
  let count = 0;
  FENCE_OPEN_RE.lastIndex = 0;
  while (FENCE_OPEN_RE.exec(markdown) !== null) {
    count++;
  }
  FENCE_OPEN_RE.lastIndex = 0;
  return count;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface FlowchartValidationError {
  code: string;
  message: string;
}

export type FlowchartValidationResult =
  | { ok: true }
  | { ok: false; errors: FlowchartValidationError[] };

/** 单个错误快捷构造。 */
function invalid(code: string, message: string): FlowchartValidationError {
  return { code, message };
}

/**
 * 校验任意未知值是否为合法 FlowchartDocument。
 * 用于解析文件、应用 AI patch 后的完整文档校验。
 * 不做语义警告（开始/结束节点等），只做硬错误。
 */
export function validateFlowchartDocument(input: unknown): FlowchartValidationResult {
  const errors: FlowchartValidationError[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [invalid("not-object", "文档不是对象")] };
  }

  const doc = input as Record<string, unknown>;

  if (doc.version !== FLOWCHART_DOCUMENT_VERSION) {
    errors.push(invalid("version-unsupported", `不支持的版本：${String(doc.version)}`));
  }

  if (doc.direction !== "TB" && doc.direction !== "LR") {
    errors.push(invalid("direction-invalid", `direction 必须是 TB 或 LR`));
  }

  // canvas / theme（v2 必填）
  if (typeof doc.canvas !== "object" || doc.canvas === null || Array.isArray(doc.canvas)) {
    errors.push(invalid("canvas-missing", "缺少 canvas 设置"));
  } else {
    const c = doc.canvas as Record<string, unknown>;
    if (c.mode !== "infinite" && c.mode !== "page") {
      errors.push(invalid("canvas-mode-invalid", "canvas.mode 必须是 infinite 或 page"));
    }
    if (typeof c.grid !== "object" || c.grid === null || Array.isArray(c.grid)) {
      errors.push(invalid("canvas-grid-invalid", "canvas.grid 不是对象"));
    } else {
      const g = c.grid as Record<string, unknown>;
      if (typeof g.visible !== "boolean" || typeof g.snap !== "boolean" ||
          typeof g.size !== "number" || !Number.isFinite(g.size) || g.size <= 0) {
        errors.push(invalid("canvas-grid-invalid", "canvas.grid 字段不合法"));
      }
    }
    for (const key of ["width", "height"] as const) {
      const v = c[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
        errors.push(invalid("canvas-size-invalid", `canvas.${key} 必须为正有限数`));
      }
    }
    if (c.orientation !== undefined && c.orientation !== "portrait" && c.orientation !== "landscape") {
      errors.push(invalid("canvas-orientation-invalid", "canvas.orientation 不合法"));
    }
    if (c.background !== undefined && typeof c.background !== "string") {
      errors.push(invalid("canvas-background-invalid", "canvas.background 不是字符串"));
    }
  }

  if (typeof doc.theme !== "object" || doc.theme === null || Array.isArray(doc.theme)) {
    errors.push(invalid("theme-missing", "缺少 theme 设置"));
  } else {
    const t = doc.theme as Record<string, unknown>;
    if (t.stylePreset !== "solid" && t.stylePreset !== "outline" && t.stylePreset !== "soft") {
      errors.push(invalid("theme-preset-invalid", "theme.stylePreset 不合法"));
    }
    if (typeof t.paletteId !== "string" || t.paletteId.length === 0) {
      errors.push(invalid("theme-palette-invalid", "theme.paletteId 为空"));
    }
    if (typeof t.preserveManualStyles !== "boolean") {
      errors.push(invalid("theme-preserve-invalid", "theme.preserveManualStyles 不是布尔值"));
    }
  }

  if (!Array.isArray(doc.nodes)) {
    errors.push(invalid("nodes-not-array", "nodes 不是数组"));
  } else {
    const nodeIds = new Set<string>();
    doc.nodes.forEach((raw, i) => {
      const ctx = `nodes[${i}]`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push(invalid("node-not-object", `${ctx} 不是对象`));
        return;
      }
      const n = raw as Record<string, unknown>;
      if (typeof n.id !== "string" || n.id.length === 0) {
        errors.push(invalid("node-id-empty", `${ctx} id 为空`));
      } else if (nodeIds.has(n.id)) {
        errors.push(invalid("node-id-duplicate", `${ctx} id 重复：${n.id}`));
      } else {
        nodeIds.add(n.id);
      }
      if (!FLOWCHART_NODE_KINDS.includes(n.kind as FlowchartNodeKind)) {
        errors.push(invalid("node-kind-invalid", `${ctx} kind 不合法：${String(n.kind)}`));
      }
      if (typeof n.label !== "string") {
        errors.push(invalid("node-label-not-string", `${ctx} label 不是字符串`));
      }
      if (!isFinitePosition(n.position)) {
        errors.push(invalid("node-position-invalid", `${ctx} position 不是有限数值`));
      }
      if (n.size !== undefined) {
        if (typeof n.size !== "object" || n.size === null || Array.isArray(n.size)) {
          errors.push(invalid("node-size-invalid", `${ctx} size 不是对象`));
        } else {
          const s = n.size as Record<string, unknown>;
          if (typeof s.width !== "number" || !Number.isFinite(s.width) || s.width <= 0 || s.width > 10000 ||
              typeof s.height !== "number" || !Number.isFinite(s.height) || s.height <= 0 || s.height > 10000) {
            errors.push(invalid("node-size-invalid", `${ctx} size.width/height 必须在 0-10000 之间的正有限数`));
          }
        }
      }
      // v2 可选字段
      if (n.parentId !== undefined && (typeof n.parentId !== "string" || n.parentId.length === 0)) {
        errors.push(invalid("node-parent-invalid", `${ctx} parentId 不是非空字符串`));
      }
      if (n.zIndex !== undefined && (typeof n.zIndex !== "number" || !Number.isFinite(n.zIndex))) {
        errors.push(invalid("node-zindex-invalid", `${ctx} zIndex 不是有限数值`));
      }
      if (n.rotation !== undefined && (typeof n.rotation !== "number" || !Number.isFinite(n.rotation))) {
        errors.push(invalid("node-rotation-invalid", `${ctx} rotation 不是有限数值`));
      }
      if (n.flipX !== undefined && typeof n.flipX !== "boolean") {
        errors.push(invalid("node-flip-invalid", `${ctx} flipX 不是布尔值`));
      }
      if (n.flipY !== undefined && typeof n.flipY !== "boolean") {
        errors.push(invalid("node-flip-invalid", `${ctx} flipY 不是布尔值`));
      }
      if (n.locked !== undefined && typeof n.locked !== "boolean") {
        errors.push(invalid("node-locked-invalid", `${ctx} locked 不是布尔值`));
      }
      if (n.opacity !== undefined &&
          (typeof n.opacity !== "number" || !Number.isFinite(n.opacity) || n.opacity < 0 || n.opacity > 1)) {
        errors.push(invalid("node-opacity-invalid", `${ctx} opacity 必须在 0-1 之间`));
      }
      // container 结构参数：只允许挂在 group/pool/lane 上，且类型必须匹配 kind
      const kindIsContainer = isFlowchartContainerKind(n.kind as FlowchartNodeKind);
      if (n.container !== undefined) {
        if (!kindIsContainer || typeof n.container !== "object" || n.container === null || Array.isArray(n.container)) {
          errors.push(invalid("node-container-invalid", `${ctx} container 只允许挂在 group/pool/lane 上`));
        } else {
          const c = n.container as Record<string, unknown>;
          const expectType =
            n.kind === "group" ? "group" : n.kind === "swimlane-pool" ? "pool" : "lane";
          if (c.type !== expectType) {
            errors.push(invalid("node-container-invalid", `${ctx} container.type 与 kind 不匹配`));
          }
          if ((c.type === "pool" || c.type === "lane") &&
              c.orientation !== "horizontal" && c.orientation !== "vertical") {
            errors.push(invalid("node-container-invalid", `${ctx} container.orientation 不合法`));
          }
          if (c.type === "pool" &&
              (typeof c.headerSize !== "number" || !Number.isFinite(c.headerSize) || c.headerSize <= 0)) {
            errors.push(invalid("node-container-invalid", `${ctx} container.headerSize 必须为正有限数`));
          }
          if (c.type === "lane" &&
              (typeof c.order !== "number" || !Number.isFinite(c.order))) {
            errors.push(invalid("node-container-invalid", `${ctx} container.order 不是有限数值`));
          }
        }
      }
    });

    // 跨节点结构校验：parentId 引用、泳道归属、嵌套深度、父子循环
    const kindById = new Map<string, FlowchartNodeKind>();
    const containerById = new Map<string, Record<string, unknown>>();
    const parentById = new Map<string, string>();
    doc.nodes.forEach((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      const n = raw as Record<string, unknown>;
      if (typeof n.id !== "string" || n.id.length === 0) return;
      kindById.set(n.id, n.kind as FlowchartNodeKind);
      if (typeof n.container === "object" && n.container !== null && !Array.isArray(n.container)) {
        containerById.set(n.id, n.container as Record<string, unknown>);
      }
      if (typeof n.parentId === "string" && n.parentId.length > 0) {
        parentById.set(n.id, n.parentId);
      }
    });
    for (const [id, parentId] of parentById) {
      const parentKind = kindById.get(parentId);
      if (!parentKind) {
        errors.push(invalid("node-parent-missing", `节点 ${id} 的 parentId 指向不存在节点：${parentId}`));
        continue;
      }
      if (!isFlowchartContainerKind(parentKind)) {
        errors.push(invalid("node-parent-not-container", `节点 ${id} 的 parentId 指向非容器节点：${parentId}`));
        continue;
      }
      const kind = kindById.get(id)!;
      // 容器自身的归属：pool/group 必须在根部；lane 的 parent 必须是 pool 且方向一致
      if (kind === "swimlane-pool" || kind === "group") {
        errors.push(invalid("node-parent-nesting", `容器节点 ${id} 不能归属其他容器`));
        continue;
      }
      if (kind === "swimlane-lane" && parentKind !== "swimlane-pool") {
        errors.push(invalid("node-parent-nesting", `泳道 ${id} 的 parent 必须是泳池`));
        continue;
      }
      if (kind === "swimlane-lane" && parentKind === "swimlane-pool") {
        const laneC = containerById.get(id);
        const poolC = containerById.get(parentId);
        if (laneC && poolC && laneC.orientation !== poolC.orientation) {
          errors.push(invalid("node-parent-orientation", `泳道 ${id} 与泳池方向不一致`));
        }
      }
      // 最大嵌套：root -> group/pool -> lane -> shape；shape 的直接 parent 只能是 group 或 lane
      if (!isFlowchartContainerKind(kind) && parentKind === "swimlane-pool") {
        errors.push(invalid("node-parent-nesting", `节点 ${id} 不能直接归属泳池，应归属泳道`));
      }
      // 父子循环（parent 链回到自身）
      let cursor = parentId;
      const seen = new Set<string>([id]);
      while (true) {
        if (seen.has(cursor)) {
          errors.push(invalid("node-parent-cycle", `节点 ${id} 的 parent 链存在循环`));
          break;
        }
        seen.add(cursor);
        const next = parentById.get(cursor);
        if (!next) break;
        cursor = next;
      }
    }
  }

  if (!Array.isArray(doc.edges)) {
    errors.push(invalid("edges-not-array", "edges 不是数组"));
  } else {
    const edgeIds = new Set<string>();
    const nodeIds = new Set<string>();
    const kindById = new Map<string, FlowchartNodeKind>();
    if (Array.isArray(doc.nodes)) {
      for (const n of doc.nodes) {
        if (typeof n === "object" && n !== null && typeof (n as { id: unknown }).id === "string") {
          nodeIds.add((n as { id: string }).id);
          kindById.set((n as { id: string }).id, (n as { kind: FlowchartNodeKind }).kind);
        }
      }
    }
    doc.edges.forEach((raw, i) => {
      const ctx = `edges[${i}]`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push(invalid("edge-not-object", `${ctx} 不是对象`));
        return;
      }
      const e = raw as Record<string, unknown>;
      if (typeof e.id !== "string" || e.id.length === 0) {
        errors.push(invalid("edge-id-empty", `${ctx} id 为空`));
      } else if (edgeIds.has(e.id)) {
        errors.push(invalid("edge-id-duplicate", `${ctx} id 重复：${e.id}`));
      } else {
        edgeIds.add(e.id);
      }
      if (typeof e.source !== "string" || !nodeIds.has(e.source as string)) {
        errors.push(invalid("edge-source-missing", `${ctx} source 指向不存在节点：${String(e.source)}`));
      }
      if (typeof e.target !== "string" || !nodeIds.has(e.target as string)) {
        errors.push(invalid("edge-target-missing", `${ctx} target 指向不存在节点：${String(e.target)}`));
      }
      if (typeof e.source === "string" && typeof e.target === "string" && e.source === e.target) {
        errors.push(invalid("edge-self-loop", `${ctx} source 等于 target：${e.source}`));
      }
      // 容器（group/pool/lane）不能作为普通流程边端点
      for (const endpoint of ["source", "target"] as const) {
        const ref = e[endpoint];
        if (typeof ref === "string") {
          const k = kindById.get(ref);
          if (k && isFlowchartContainerKind(k)) {
            errors.push(invalid("edge-container-endpoint", `${ctx} ${endpoint} 指向容器节点：${ref}`));
          }
        }
      }
      if (e.label !== undefined && typeof e.label !== "string") {
        errors.push(invalid("edge-label-not-string", `${ctx} label 不是字符串`));
      }
    });
  }

  if (doc.viewport !== undefined) {
    if (typeof doc.viewport !== "object" || doc.viewport === null || Array.isArray(doc.viewport)) {
      errors.push(invalid("viewport-not-object", "viewport 不是对象"));
    } else {
      const v = doc.viewport as Record<string, unknown>;
      if (typeof v.x !== "number" || !Number.isFinite(v.x) ||
          typeof v.y !== "number" || !Number.isFinite(v.y) ||
          typeof v.zoom !== "number" || !Number.isFinite(v.zoom)) {
        errors.push(invalid("viewport-invalid", "viewport 字段不是有限数值"));
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isFinitePosition(pos: unknown): boolean {
  if (typeof pos !== "object" || pos === null || Array.isArray(pos)) return false;
  const p = pos as Record<string, unknown>;
  return typeof p.x === "number" && Number.isFinite(p.x) &&
         typeof p.y === "number" && Number.isFinite(p.y);
}

// ---------------------------------------------------------------------------
// 语义警告
// ---------------------------------------------------------------------------

export interface FlowchartSemanticWarning {
  code: string;
  message: string;
  /** 关联节点 ID（用于点击定位到画布） */
  nodeId?: string;
}

/**
 * 收集语义警告（非阻塞性）：开始/结束节点异常、判断节点无标签、孤立节点、循环等。
 * 循环不作为硬错误，因为审批退回、重试本身需要回路。
 */
export function collectFlowchartSemanticWarnings(doc: FlowchartDocument): FlowchartSemanticWarning[] {
  const warnings: FlowchartSemanticWarning[] = [];
  const nodes = doc.nodes;
  const edges = doc.edges;

  const startNodes = nodes.filter((n) => n.kind === "start");
  const endNodes = nodes.filter((n) => n.kind === "end");

  if (startNodes.length === 0) {
    warnings.push({ code: "no-start", message: "没有开始节点" });
  }
  if (endNodes.length === 0) {
    warnings.push({ code: "no-end", message: "没有结束节点" });
  }

  for (const start of startNodes) {
    if (edges.some((e) => e.target === start.id)) {
      warnings.push({ code: "start-has-incoming", message: `开始节点 ${start.id} 存在入边`, nodeId: start.id });
    }
  }
  for (const end of endNodes) {
    if (edges.some((e) => e.source === end.id)) {
      warnings.push({ code: "end-has-outgoing", message: `结束节点 ${end.id} 存在出边`, nodeId: end.id });
    }
  }

  for (const node of nodes) {
    if (node.kind !== "decision") continue;
    const outs = edges.filter((e) => e.source === node.id);
    if (outs.length > 1 && outs.some((e) => !e.label)) {
      warnings.push({ code: "decision-unlabeled-branch", message: `判断节点 ${node.id} 存在无标签出边`, nodeId: node.id });
    }
  }

  // 孤立节点：既无入边也无出边（容器只是视觉分组，不参与流程语义检查）
  for (const node of nodes) {
    if (isFlowchartContainerKind(node.kind)) continue;
    if (!edges.some((e) => e.source === node.id || e.target === node.id)) {
      warnings.push({ code: "isolated-node", message: `节点 ${node.id} 孤立`, nodeId: node.id });
    }
  }

  // 不可达节点：从 start 出发无法到达
  if (startNodes.length > 0) {
    const reachable = new Set<string>();
    const queue: string[] = startNodes.map((n) => n.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of edges) {
        if (e.source === id && !reachable.has(e.target)) queue.push(e.target);
      }
    }
    for (const node of nodes) {
      if (isFlowchartContainerKind(node.kind)) continue;
      if (!reachable.has(node.id) && node.kind !== "start") {
        warnings.push({ code: "unreachable-node", message: `节点 ${node.id} 不可从开始节点到达`, nodeId: node.id });
      }
    }
  }

  // 循环检测（DFS）
  if (hasCycle(nodes, edges)) {
    warnings.push({ code: "has-cycle", message: "存在循环" });
  }

  return warnings;
}

function hasCycle(nodes: FlowchartNode[], edges: FlowchartEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const dfs = (id: string): boolean => {
    color.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const n of nodes) {
    if (color.get(n.id) === WHITE && dfs(n.id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 解析与序列化
// ---------------------------------------------------------------------------

export type ParseFlowchartResult =
  | { ok: true; document: FlowchartDocument; title: string }
  | { ok: false; message: string };

/**
 * 解析流程图 Markdown 文件。
 *
 * 要求：
 * - 文件中必须存在且只能存在一个 ```mona-flowchart fenced block；
 * - JSON 必须能解析且通过 validateFlowchartDocument；
 * - 围栏之前是文本投影（忽略，由 serializer 重新生成）。
 *
 * 解析失败返回错误消息，不抛异常。
 */
export function parseFlowchartMarkdown(markdown: string): ParseFlowchartResult {
  const fenceCount = countFlowchartFences(markdown);
  if (fenceCount === 0) {
    return { ok: false, message: "缺少 mona-flowchart fenced block" };
  }
  if (fenceCount > 1) {
    return { ok: false, message: `存在 ${fenceCount} 个 mona-flowchart fenced block，只能有一个` };
  }

  const extracted = extractFlowchartFence(markdown);
  if (!extracted) {
    return { ok: false, message: "无法解析 mona-flowchart fenced block" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.content);
  } catch (e) {
    return { ok: false, message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }

  // v1 文件：经纯迁移函数补默认值进入内存（不静默丢字段，不写回文件）
  if (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).version === 1
  ) {
    parsed = migrateFlowchartV1ToV2(parsed as Record<string, unknown>);
  }

  const validation = validateFlowchartDocument(parsed);
  if (!validation.ok) {
    const detail = validation.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    return { ok: false, message: `文档校验失败：${detail}` };
  }

  const document = normalizeFlowchartDocument(parsed);
  const title = extractTitleFromMarkdown(markdown);
  return { ok: true, document, title };
}

/** 从文本投影中提取一级标题作为流程图标题；找不到返回空字符串。 */
function extractTitleFromMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = trimmed.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
    // 围栏之前若出现非标题内容，标题解析中止
    if (trimmed.startsWith("```")) return "";
    return "";
  }
  return "";
}

/** 规范化节点样式：只保留已知字段且值为合法类型的键；全部缺失则返回 undefined。 */
function normalizeNodeStyle(raw: unknown): FlowchartNodeStyle | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const out: FlowchartNodeStyle = {};
  if (typeof s.fontFamily === "string" && s.fontFamily.length > 0) out.fontFamily = s.fontFamily;
  if (typeof s.fontSize === "number" && Number.isFinite(s.fontSize) && s.fontSize > 0) out.fontSize = s.fontSize;
  if (typeof s.color === "string" && s.color.length > 0) out.color = s.color;
  if (typeof s.fill === "string" && s.fill.length > 0) out.fill = s.fill;
  if (typeof s.borderColor === "string" && s.borderColor.length > 0) out.borderColor = s.borderColor;
  if (typeof s.borderWidth === "number" && Number.isFinite(s.borderWidth) && s.borderWidth >= 0) out.borderWidth = s.borderWidth;
  if (s.borderStyle === "solid" || s.borderStyle === "dashed" || s.borderStyle === "dotted") out.borderStyle = s.borderStyle;
  if (typeof s.bold === "boolean") out.bold = s.bold;
  if (typeof s.italic === "boolean") out.italic = s.italic;
  if (typeof s.underline === "boolean") out.underline = s.underline;
  if (s.textAlign === "left" || s.textAlign === "center" || s.textAlign === "right") out.textAlign = s.textAlign;
  if (s.verticalAlign === "top" || s.verticalAlign === "middle" || s.verticalAlign === "bottom") out.verticalAlign = s.verticalAlign;
  if (typeof s.lineHeight === "number" && Number.isFinite(s.lineHeight) && s.lineHeight > 0) out.lineHeight = s.lineHeight;
  if (typeof s.cornerRadius === "number" && Number.isFinite(s.cornerRadius) && s.cornerRadius >= 0) out.cornerRadius = s.cornerRadius;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 规范化 canvas 设置：非法字段回退默认值。v1 迁移与 v2 解析共用。 */
export function normalizeFlowchartCanvas(raw: unknown): FlowchartCanvasSettings {
  const base: FlowchartCanvasSettings = {
    mode: DEFAULT_FLOWCHART_CANVAS.mode,
    grid: { ...DEFAULT_FLOWCHART_CANVAS.grid },
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const c = raw as Record<string, unknown>;
  if (c.mode === "page") base.mode = "page";
  if (typeof c.width === "number" && Number.isFinite(c.width) && c.width > 0) base.width = c.width;
  if (typeof c.height === "number" && Number.isFinite(c.height) && c.height > 0) base.height = c.height;
  if (c.orientation === "portrait" || c.orientation === "landscape") base.orientation = c.orientation;
  if (typeof c.background === "string" && c.background.length > 0) base.background = c.background;
  if (typeof c.grid === "object" && c.grid !== null && !Array.isArray(c.grid)) {
    const g = c.grid as Record<string, unknown>;
    if (typeof g.visible === "boolean") base.grid.visible = g.visible;
    if (typeof g.snap === "boolean") base.grid.snap = g.snap;
    if (typeof g.size === "number" && Number.isFinite(g.size) && g.size > 0) base.grid.size = g.size;
  }
  return base;
}

/** 规范化 theme 设置：非法字段回退默认值。v1 迁移与 v2 解析共用。 */
export function normalizeFlowchartTheme(raw: unknown): FlowchartThemeSettings {
  const base: FlowchartThemeSettings = { ...DEFAULT_FLOWCHART_THEME };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const t = raw as Record<string, unknown>;
  if (t.stylePreset === "outline" || t.stylePreset === "soft") base.stylePreset = t.stylePreset;
  if (typeof t.paletteId === "string" && t.paletteId.length > 0) base.paletteId = t.paletteId;
  if (typeof t.preserveManualStyles === "boolean") base.preserveManualStyles = t.preserveManualStyles;
  return base;
}

/** 规范化边样式：只保留已知字段且值为合法类型的键；全部缺失则返回 undefined。
 *  兼容旧 route 值：step → smoothstep、default → bezier */
function normalizeEdgeStyle(raw: unknown): FlowchartEdgeStyle | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const out: FlowchartEdgeStyle = {};
  if (typeof s.stroke === "string" && s.stroke.length > 0) out.stroke = s.stroke;
  if (typeof s.strokeWidth === "number" && Number.isFinite(s.strokeWidth) && s.strokeWidth > 0) out.strokeWidth = s.strokeWidth;
  if (s.strokeDasharray === "solid" || s.strokeDasharray === "dashed" || s.strokeDasharray === "dotted") out.strokeDasharray = s.strokeDasharray;
  if (s.route === "bezier" || s.route === "smoothstep" || s.route === "straight") {
    out.route = s.route;
  } else if (s.route === "default") {
    out.route = "bezier";
  } else if (s.route === "step") {
    out.route = "smoothstep";
  }
  if (s.markerStart === "none" || s.markerStart === "arrow" || s.markerStart === "arrowclosed") out.markerStart = s.markerStart;
  if (s.markerEnd === "none" || s.markerEnd === "arrow" || s.markerEnd === "arrowclosed") out.markerEnd = s.markerEnd;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 规范化控制点：仅保留有限数值坐标对；最多 16 个；全部无效返回 undefined。
 *  用于解析时容错（旧文件无此字段或字段损坏）。 */
function normalizeControlPoints(raw: unknown): { x: number; y: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { x: number; y: number }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const x = Number(p.x);
    const y = Number(p.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.push({ x, y });
    }
    if (out.length >= 16) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 把已校验的 unknown 规范化为 FlowchartDocument（去掉多余字段，规范字段顺序）。
 * 调用前必须先通过 validateFlowchartDocument。
 */
function normalizeFlowchartDocument(input: unknown): FlowchartDocument {
  const raw = input as Record<string, unknown>;
  const nodes = (raw.nodes as Array<Record<string, unknown>>).map((n) => {
    const node: FlowchartNode = {
      id: n.id as string,
      kind: n.kind as FlowchartNodeKind,
      label: n.label as string,
      position: {
        x: (n.position as { x: number }).x,
        y: (n.position as { y: number }).y,
      },
    };
    const s = normalizeNodeStyle(n.style);
    if (s) node.style = s;
    // 图片节点
    if (typeof n.imagePath === "string" && n.imagePath.length > 0) node.imagePath = n.imagePath;
    // freehand 节点：保留笔触数据
    if (n.kind === "freehand") {
      if (Array.isArray(n.points)) {
        node.points = (n.points as Array<Record<string, unknown>>).map((p) => ({
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          pressure: Number(p.pressure) ?? 0.5,
        }));
      }
      if (typeof n.path === "string") node.path = n.path;
      if (n.drawingTool === "pen" || n.drawingTool === "highlighter") node.drawingTool = n.drawingTool;
      if (typeof n.color === "string" && n.color.length > 0) node.color = n.color;
      if (typeof n.strokeWidth === "number" && Number.isFinite(n.strokeWidth) && n.strokeWidth > 0) {
        node.strokeWidth = n.strokeWidth;
      }
    }
    // 不透明度（freehand 笔触透明度与 v2 通用节点透明度共用此字段）
    if (typeof n.opacity === "number" && Number.isFinite(n.opacity) && n.opacity >= 0 && n.opacity <= 1) {
      node.opacity = n.opacity;
    }
    // 节点尺寸
    if (n.size && typeof n.size === "object" && !Array.isArray(n.size)) {
      const sz = n.size as Record<string, unknown>;
      const w = Number(sz.width);
      const h = Number(sz.height);
      if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
        node.size = { width: w, height: h };
      }
    }
    // v2：容器归属与层叠
    if (typeof n.parentId === "string" && n.parentId.length > 0) node.parentId = n.parentId;
    if (typeof n.zIndex === "number" && Number.isFinite(n.zIndex)) node.zIndex = n.zIndex;
    // v2：旋转规范化到 0..359
    if (typeof n.rotation === "number" && Number.isFinite(n.rotation)) {
      node.rotation = ((Math.round(n.rotation) % 360) + 360) % 360;
    }
    if (typeof n.flipX === "boolean") node.flipX = n.flipX;
    if (typeof n.flipY === "boolean") node.flipY = n.flipY;
    if (typeof n.locked === "boolean") node.locked = n.locked;
    // v2：容器结构参数
    if (isFlowchartContainerKind(node.kind) &&
        typeof n.container === "object" && n.container !== null && !Array.isArray(n.container)) {
      const c = n.container as Record<string, unknown>;
      if (node.kind === "group" && c.type === "group") {
        node.container = { type: "group" };
      } else if (node.kind === "swimlane-pool" && c.type === "pool") {
        node.container = {
          type: "pool",
          orientation: c.orientation === "vertical" ? "vertical" : "horizontal",
          headerSize: Number(c.headerSize),
        };
      } else if (node.kind === "swimlane-lane" && c.type === "lane") {
        node.container = {
          type: "lane",
          orientation: c.orientation === "vertical" ? "vertical" : "horizontal",
          order: Number(c.order),
        };
      }
    }
    return node;
  });
  const edges = (raw.edges as Array<Record<string, unknown>>).map((e) => {
    const edge: FlowchartEdge = {
      id: e.id as string,
      source: e.source as string,
      target: e.target as string,
    };
    if (typeof e.label === "string") edge.label = e.label;
    // 解析 sourceHandle/targetHandle，避免节点移动时 React Flow 切换 Handle
    if (typeof e.sourceHandle === "string") edge.sourceHandle = e.sourceHandle;
    if (typeof e.targetHandle === "string") edge.targetHandle = e.targetHandle;
    const s = normalizeEdgeStyle(e.style);
    if (s) edge.style = s;
    // 解析用户调整的控制点（仅保留有限数值坐标对）
    const cps = normalizeControlPoints(e.controlPoints);
    if (cps) edge.controlPoints = cps;
    return edge;
  });
  const doc: FlowchartDocument = {
    version: FLOWCHART_DOCUMENT_VERSION,
    direction: raw.direction as FlowchartDirection,
    canvas: normalizeFlowchartCanvas(raw.canvas),
    theme: normalizeFlowchartTheme(raw.theme),
    nodes,
    edges,
  };
  if (raw.viewport && typeof raw.viewport === "object") {
    const v = raw.viewport as Record<string, unknown>;
    doc.viewport = {
      x: v.x as number,
      y: v.y as number,
      zoom: v.zoom as number,
    };
  }
  return doc;
}

/**
 * 序列化流程图为 Markdown。
 *
 * 输出结构：
 * 1. 一级标题（流程图标题）；
 * 2. 文本投影（## 节点 / ## 连线），由 serializer 统一生成；
 * 3. ```mona-flowchart fenced block，内含 2 空格格式化的 JSON。
 *
 * 调用方不能手写文本投影，必须使用本函数。
 */
export function serializeFlowchartMarkdown(title: string, doc: FlowchartDocument): string {
  const projection = buildFlowchartIndexMarkdown(title, doc);
  const json = JSON.stringify(doc, null, 2);
  return `${projection}\n\n\`\`\`${FLOWCHART_FENCE_LANG}\n${json}\n\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// 文本投影
// ---------------------------------------------------------------------------

/**
 * 生成 Markdown 文本投影：一级标题 + 节点列表 + 连线列表。
 * 用于：
 * - 文件中围栏之前的可读内容；
 * - 后端 preview/plainText/search；
 * - 关系图扫描（节点和边 label 中的 [[wiki link]] 进入反链）。
 *
 * v2 规则（FC-DOC-05）：
 * - pool/lane/group 标题进入投影；
 * - 纯视觉、无文字的基础形状不制造空索引项（label 为空时跳过）。
 */
export function buildFlowchartIndexMarkdown(title: string, doc: FlowchartDocument): string {
  const lines: string[] = [];
  lines.push(`# ${title || "未命名画布"}`);
  lines.push("");
  lines.push("## 节点");
  lines.push("");
  const labeledNodes = doc.nodes.filter((n) => n.label.trim().length > 0);
  if (labeledNodes.length === 0) {
    lines.push("- （无节点）");
  } else {
    for (const n of labeledNodes) {
      lines.push(`- ${n.label}`);
    }
  }
  lines.push("");
  lines.push("## 连线");
  lines.push("");
  const labeledEdges = doc.edges.filter((e) => (e.label ?? "").trim().length > 0);
  if (labeledEdges.length === 0) {
    lines.push("- （无连线）");
  } else {
    for (const e of labeledEdges) {
      lines.push(`- ${e.label ?? ""}`.trimEnd());
    }
  }
  return lines.join("\n");
}

/**
 * 生成 plainText：用于前端 preview 显示。
 *
 * 注意：plainText 字段不参与后端 backlink/mention 扫描——后端直接扫描
 * .md 文件 body 原文，并在 `find_plain_mentions` 中跳过结构化文档
 * （见 notes_links.rs 的 `is_structured_note`）。这里生成的内容仅用于
 * preview 等前端展示场景，需要包含节点/边 label 原文以保证可读性。
 */
export function buildFlowchartPlainText(title: string, doc: FlowchartDocument): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  for (const n of doc.nodes) {
    if (n.label) parts.push(n.label);
  }
  for (const e of doc.edges) {
    if (e.label) parts.push(e.label);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 语义图与语义哈希
// ---------------------------------------------------------------------------

/**
 * 提取语义图：去掉 position 和 viewport，保留 id/kind/label/direction/edges。
 *
 * v2 规则（FC-DOC-04）：
 * - 排除 group/pool/lane 容器与 freehand/image 非流程语义节点；
 * - 节点所属泳道是责任分配语义，parentId 指向 lane 时写入 laneId；
 * - lane 标题进入 lanes 投影（不伪装成流程节点）；
 * - 普通 group 的 parentId、position、size、rotation、zIndex、style、theme、canvas 不进入。
 */
export function extractSemanticGraph(doc: FlowchartDocument): FlowchartSemanticGraph {
  const laneIds = new Set(
    doc.nodes.filter((n) => n.kind === "swimlane-lane").map((n) => n.id),
  );
  const nodes: FlowchartSemanticNode[] = [];
  for (const n of doc.nodes) {
    if (isFlowchartContainerKind(n.kind) || n.kind === "freehand" || n.kind === "image") continue;
    const node: FlowchartSemanticNode = { id: n.id, kind: n.kind, label: n.label };
    if (n.parentId && laneIds.has(n.parentId)) node.laneId = n.parentId;
    nodes.push(node);
  }
  const lanes: FlowchartSemanticLane[] = doc.nodes
    .filter((n) => n.kind === "swimlane-lane")
    .map((n) => ({ id: n.id, label: n.label }));
  const graph: FlowchartSemanticGraph = {
    direction: doc.direction,
    nodes,
    edges: doc.edges.map((e) => {
      const edge: FlowchartEdge = { id: e.id, source: e.source, target: e.target };
      if (e.label !== undefined) edge.label = e.label;
      return edge;
    }),
  };
  if (lanes.length > 0) graph.lanes = lanes;
  return graph;
}

/**
 * 计算语义哈希。
 *
 * 规范（见 §9.8）：
 * - 只包含排序和规范化后的 version、direction、node id/kind/label、edge id/source/target/label；
 * - 排除 position、viewport、JSON 格式和数组原始顺序、自动生成的文本投影。
 *
 * 实现：
 * - 用 cyrb53a 算法（53 位非密码学哈希，同步、低碰撞）；
 * - 输出 14 位 hex 字符，前缀 "h"；
 * - 节点按 id 升序排序，边按 (source, target, id) 升序排序；
 * - JSON 序列化使用无空格紧凑格式（JSON.stringify without indent）。
 *
 * 碰撞概率：对 < 10000 个流程图，碰撞概率 < 10^-6，足以满足并发保护需求。
 * 不用于密码学场景。
 */
export function computeFlowchartSemanticHash(doc: FlowchartDocument): string {
  const canonical = canonicalizeForHash(doc);
  const json = JSON.stringify(canonical);
  const hash = cyrb53a(json);
  return `h${hash.toString(16).padStart(14, "0")}`;
}

/** 规范化为可哈希对象：稳定字段顺序 + 节点/边排序；与 extractSemanticGraph 同一投影。 */
function canonicalizeForHash(doc: FlowchartDocument): Record<string, unknown> {
  const graph = extractSemanticGraph(doc);
  const nodes = [...graph.nodes]
    .map((n) => {
      const node: Record<string, unknown> = { id: n.id, kind: n.kind, label: n.label };
      if (n.laneId !== undefined) node.laneId = n.laneId;
      return node;
    })
    .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0));
  const edges = [...graph.edges]
    .map((e) => {
      const edge: Record<string, unknown> = { id: e.id, source: e.source, target: e.target };
      if (e.label !== undefined) edge.label = e.label;
      return edge;
    })
    .sort((a, b) => {
      const sa = `${a.source}|${a.target}|${a.id}`;
      const sb = `${b.source}|${b.target}|${b.id}`;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  const lanes = [...(graph.lanes ?? [])]
    .map((l) => ({ id: l.id, label: l.label }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    version: doc.version,
    direction: doc.direction,
    nodes,
    lanes,
    edges,
  };
}

/**
 * cyrb53a：53 位非密码学字符串哈希。
 * 参考：https://github.com/bryc/code/blob/master/jshash/PRNGs.md
 * 经过多轮混淆，碰撞率远低于 djb2/fnv-1a。
 */
function cyrb53a(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ---------------------------------------------------------------------------
// 深拷贝与工具
// ---------------------------------------------------------------------------

/** 深拷贝 FlowchartDocument，用于 patch 应用前的副本。 */
export function cloneFlowchartDocument(doc: FlowchartDocument): FlowchartDocument {
  return {
    version: doc.version,
    direction: doc.direction,
    canvas: {
      ...doc.canvas,
      grid: { ...doc.canvas.grid },
    },
    theme: { ...doc.theme },
    nodes: doc.nodes.map((n) => {
      const clone: FlowchartNode = {
        id: n.id,
        kind: n.kind,
        label: n.label,
        position: { x: n.position.x, y: n.position.y },
        ...(n.style ? { style: { ...n.style } } : {}),
      };
      if (n.size) clone.size = { width: n.size.width, height: n.size.height };
      if (n.imagePath) clone.imagePath = n.imagePath;
      if (n.kind === "freehand") {
        if (n.points) clone.points = n.points.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure }));
        if (n.path) clone.path = n.path;
        if (n.drawingTool) clone.drawingTool = n.drawingTool;
        if (n.color) clone.color = n.color;
        if (typeof n.strokeWidth === "number") clone.strokeWidth = n.strokeWidth;
      }
      if (typeof n.opacity === "number") clone.opacity = n.opacity;
      // v2 字段
      if (n.parentId !== undefined) clone.parentId = n.parentId;
      if (n.zIndex !== undefined) clone.zIndex = n.zIndex;
      if (n.rotation !== undefined) clone.rotation = n.rotation;
      if (n.flipX !== undefined) clone.flipX = n.flipX;
      if (n.flipY !== undefined) clone.flipY = n.flipY;
      if (n.locked !== undefined) clone.locked = n.locked;
      if (n.container) clone.container = { ...n.container };
      return clone;
    }),
    edges: doc.edges.map((e) => {
      const edge: FlowchartEdge = {
        id: e.id,
        source: e.source,
        target: e.target,
      };
      if (e.label !== undefined) edge.label = e.label;
      // 保留 sourceHandle/targetHandle，避免节点移动时 React Flow 自动切换端点
      if (typeof e.sourceHandle === "string") edge.sourceHandle = e.sourceHandle;
      if (typeof e.targetHandle === "string") edge.targetHandle = e.targetHandle;
      if (e.style) edge.style = { ...e.style };
      if (e.controlPoints) edge.controlPoints = e.controlPoints.map((p) => ({ x: p.x, y: p.y }));
      return edge;
    }),
    viewport: doc.viewport
      ? { x: doc.viewport.x, y: doc.viewport.y, zoom: doc.viewport.zoom }
      : undefined,
  };
}

/** 构造空白流程图文档：包含一个开始节点和一个结束节点，不连线。 */
export function createBlankFlowchartDocument(): FlowchartDocument {
  return {
    version: FLOWCHART_DOCUMENT_VERSION,
    direction: "TB",
    canvas: {
      ...DEFAULT_FLOWCHART_CANVAS,
      grid: { ...DEFAULT_FLOWCHART_CANVAS.grid },
    },
    theme: { ...DEFAULT_FLOWCHART_THEME },
    nodes: [
      {
        id: "n-start",
        kind: "start",
        label: "开始",
        position: { x: 0, y: 0 },
      },
      {
        id: "n-end",
        kind: "end",
        label: "结束",
        position: { x: 0, y: 120 },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** 生成新的节点 ID（UUID v4，优先 crypto.randomUUID）。 */
export function generateFlowchartNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `n-${crypto.randomUUID()}`;
  }
  return `n-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** 生成新的边 ID。 */
export function generateFlowchartEdgeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `e-${crypto.randomUUID()}`;
  }
  return `e-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
