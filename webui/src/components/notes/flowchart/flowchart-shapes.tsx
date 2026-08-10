/**
 * 流程图形状目录：统一图形库元数据与真实 SVG 几何渲染。
 *
 * 职责（FC-SHAPE-01）：
 * 1. FLOWCHART_SHAPE_CATALOG：所有形状的名称、别名、分类、默认尺寸、是否锁定比例；
 * 2. renderFlowchartShape：真实 SVG 几何渲染函数，图形库预览和画布节点共用；
 * 3. searchFlowchartShapes：形状搜索纯函数（trim、大小写不敏感、匹配 label/aliases/kind）。
 *
 * 不包含编辑器状态、Agent 能力或插件注册逻辑。
 */

import type { ReactNode } from "react";

import type { FlowchartNodeKind } from "./flowchart-document";

// ---------------------------------------------------------------------------
// 形状分类与元数据
// ---------------------------------------------------------------------------

export type FlowchartShapeCategory = "basic" | "flowchart" | "swimlane";

/** 泳道入口的创建行为：pool 新建泳池；lane/divider 向既有泳池追加泳道（divider 仅图标语义不同）。 */
export type FlowchartShapeCreation = {
  action: "pool" | "lane" | "divider";
  orientation: "horizontal" | "vertical";
};

export interface FlowchartShapeDefinition {
  kind: FlowchartNodeKind;
  label: string;
  aliases: string[];
  category: FlowchartShapeCategory;
  defaultSize: { width: number; height: number };
  /** 需要等比缩放的形状（如 circle、connector） */
  keepAspectRatio?: boolean;
  /** 目录内唯一 id：同 kind 的多个入口（如横向/纵向泳池）用 id 区分；缺省等于 kind */
  id?: string;
  /** 容器入口的创建行为（FC-SWIM-01）；普通形状不设置 */
  creation?: FlowchartShapeCreation;
}

/** 形状目录条目的唯一 id（未显式设置时等于 kind）。 */
export function getFlowchartShapeId(shape: FlowchartShapeDefinition): string {
  return shape.id ?? shape.kind;
}

/** 按目录条目 id 查找形状（普通形状 id = kind，向后兼容拖拽数据）。 */
export function getFlowchartShapeById(id: string): FlowchartShapeDefinition | undefined {
  return FLOWCHART_SHAPE_CATALOG.find((shape) => getFlowchartShapeId(shape) === id);
}

/**
 * 流程图形状目录：基础形状、流程图、泳池/泳道三类。
 * 预览和画布必须使用同一 renderFlowchartShape 函数，避免几何漂移。
 */
export const FLOWCHART_SHAPE_CATALOG: readonly FlowchartShapeDefinition[] = [
  // -------------------------------------------------------------------------
  // 基础形状（视觉元素，不改变流程语义检查规则）
  // -------------------------------------------------------------------------
  {
    kind: "text",
    label: "文本",
    aliases: ["文字", "text"],
    category: "basic",
    defaultSize: { width: 200, height: 40 },
  },
  {
    kind: "note",
    label: "便签",
    aliases: ["便签", "备注", "note", "sticky"],
    category: "basic",
    defaultSize: { width: 160, height: 160 },
  },
  {
    kind: "code-block",
    label: "代码块",
    aliases: ["代码", "code", "codeblock"],
    category: "basic",
    defaultSize: { width: 240, height: 120 },
  },
  {
    kind: "rectangle",
    label: "矩形",
    aliases: ["长方形", "rect", "rectangle", "box"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "rounded-rectangle",
    label: "圆角矩形",
    aliases: ["圆角", "rounded", "roundrect"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "ellipse",
    label: "椭圆",
    aliases: ["ellipse", "oval"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "circle",
    label: "圆形",
    aliases: ["圆", "circle"],
    category: "basic",
    defaultSize: { width: 100, height: 100 },
    keepAspectRatio: true,
  },
  {
    kind: "triangle",
    label: "三角形",
    aliases: ["triangle"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "right-triangle",
    label: "直角三角形",
    aliases: ["直角", "right triangle"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "diamond-basic",
    label: "菱形",
    aliases: ["钻石", "diamond", "rhombus"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "pentagon-basic",
    label: "五边形",
    aliases: ["pentagon"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "hexagon-basic",
    label: "六边形",
    aliases: ["hexagon"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "octagon",
    label: "八边形",
    aliases: ["octagon"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "star",
    label: "星形",
    aliases: ["星星", "star"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "cloud",
    label: "云",
    aliases: ["云朵", "cloud"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "callout",
    label: "气泡",
    aliases: ["标注", "callout", "speech"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "plus",
    label: "加号",
    aliases: ["加", "plus", "cross"],
    category: "basic",
    defaultSize: { width: 100, height: 100 },
    keepAspectRatio: true,
  },
  {
    kind: "l-shape",
    label: "L 形",
    aliases: ["l shape", "lshape"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "arrow-left",
    label: "左箭头",
    aliases: ["arrow left", "left"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "arrow-right",
    label: "右箭头",
    aliases: ["arrow right", "right"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "arrow-up",
    label: "上箭头",
    aliases: ["arrow up", "up"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "arrow-down",
    label: "下箭头",
    aliases: ["arrow down", "down"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "arrow-bidirectional",
    label: "双向箭头",
    aliases: ["双向", "bidirectional", "double arrow"],
    category: "basic",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "bracket-round",
    label: "圆括号",
    aliases: ["parentheses", "round bracket"],
    category: "basic",
    defaultSize: { width: 100, height: 100 },
  },
  {
    kind: "bracket-square",
    label: "方括号",
    aliases: ["square bracket", "brackets"],
    category: "basic",
    defaultSize: { width: 100, height: 100 },
  },
  {
    kind: "brace",
    label: "花括号",
    aliases: ["大括号", "brace", "curly"],
    category: "basic",
    defaultSize: { width: 100, height: 100 },
  },

  // -------------------------------------------------------------------------
  // 流程图形状
  // -------------------------------------------------------------------------
  {
    kind: "start",
    label: "开始",
    aliases: ["start", "begin"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "end",
    label: "结束",
    aliases: ["end", "finish"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "terminator",
    label: "起止",
    aliases: ["起止符", "terminator", "pill"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "process",
    label: "处理",
    aliases: ["process", "process box"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "subprocess",
    label: "子流程",
    aliases: ["subprocess", "sub routine"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "predefined-process",
    label: "预定义流程",
    aliases: ["predefined", "predefined process"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "alternate-process",
    label: "替代流程",
    aliases: ["alternate", "alternate process"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "decision",
    label: "判断",
    aliases: ["decision", "if", "condition"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "preparation",
    label: "准备",
    aliases: ["preparation", "setup"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "merge",
    label: "合并",
    aliases: ["merge", "join"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "extract",
    label: "提取",
    aliases: ["extract", "split"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "sort",
    label: "排序",
    aliases: ["sort", "order"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "or",
    label: "或",
    aliases: ["or", "logic or"],
    category: "flowchart",
    defaultSize: { width: 100, height: 100 },
    keepAspectRatio: true,
  },
  {
    kind: "summation",
    label: "求和连接",
    aliases: ["summation", "sum", "summing junction"],
    category: "flowchart",
    defaultSize: { width: 100, height: 100 },
    keepAspectRatio: true,
  },
  {
    kind: "input-output",
    label: "输入/输出",
    aliases: ["input", "output", "io", "data"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "manual-input",
    label: "手动输入",
    aliases: ["manual input", "keyboard"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "manual-operation",
    label: "手动操作",
    aliases: ["manual operation", "manual"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "display",
    label: "显示",
    aliases: ["display", "screen", "monitor"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "document",
    label: "文档",
    aliases: ["document", "doc", "file"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "multi-document",
    label: "多文档",
    aliases: ["multi document", "documents", "files"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "card",
    label: "卡片",
    aliases: ["card", "punched card"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "internal-storage",
    label: "内部存储",
    aliases: ["internal storage", "memory"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "database",
    label: "数据库",
    aliases: ["database", "db", "cylinder"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "stored-data",
    label: "存储数据",
    aliases: ["stored data", "data storage"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "connector",
    label: "连接圆",
    aliases: ["connector", "junction", "circle connector"],
    category: "flowchart",
    defaultSize: { width: 100, height: 100 },
    keepAspectRatio: true,
  },
  {
    kind: "off-page-connector",
    label: "跨页连接",
    aliases: ["off page", "off-page connector", "reference"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "delay",
    label: "延迟",
    aliases: ["delay", "wait"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },
  {
    kind: "annotation",
    label: "注释",
    aliases: ["annotation", "comment", "note"],
    category: "flowchart",
    defaultSize: { width: 200, height: 100 },
  },

  // -------------------------------------------------------------------------
  // 泳池 / 泳道（FC-SWIM-01：6 个入口，同 kind 用 id + creation 区分）
  // -------------------------------------------------------------------------
  {
    id: "swimlane-pool-h",
    kind: "swimlane-pool",
    label: "横向泳池",
    aliases: ["泳池", "pool", "swimlane pool", "horizontal pool"],
    category: "swimlane",
    defaultSize: { width: 600, height: 300 },
    creation: { action: "pool", orientation: "horizontal" },
  },
  {
    id: "swimlane-pool-v",
    kind: "swimlane-pool",
    label: "纵向泳池",
    aliases: ["纵向泳池", "vertical pool", "pool vertical"],
    category: "swimlane",
    defaultSize: { width: 300, height: 600 },
    creation: { action: "pool", orientation: "vertical" },
  },
  {
    id: "swimlane-lane-h",
    kind: "swimlane-lane",
    label: "横向泳道",
    aliases: ["泳道", "lane", "swimlane", "horizontal lane"],
    category: "swimlane",
    defaultSize: { width: 600, height: 140 },
    creation: { action: "lane", orientation: "horizontal" },
  },
  {
    id: "swimlane-lane-v",
    kind: "swimlane-lane",
    label: "纵向泳道",
    aliases: ["纵向泳道", "vertical lane"],
    category: "swimlane",
    defaultSize: { width: 140, height: 600 },
    creation: { action: "lane", orientation: "vertical" },
  },
  {
    id: "swimlane-divider-h",
    kind: "swimlane-lane",
    label: "横向分隔",
    aliases: ["分隔", "divider", "separator", "horizontal divider"],
    category: "swimlane",
    defaultSize: { width: 600, height: 140 },
    creation: { action: "divider", orientation: "horizontal" },
  },
  {
    id: "swimlane-divider-v",
    kind: "swimlane-lane",
    label: "纵向分隔",
    aliases: ["纵向分隔", "vertical divider"],
    category: "swimlane",
    defaultSize: { width: 140, height: 600 },
    creation: { action: "divider", orientation: "vertical" },
  },
];

// ---------------------------------------------------------------------------
// 形状搜索
// ---------------------------------------------------------------------------

/** 按 kind 查找形状定义。 */
export function getFlowchartShapeDefinition(
  kind: FlowchartNodeKind,
): FlowchartShapeDefinition | undefined {
  return FLOWCHART_SHAPE_CATALOG.find((shape) => shape.kind === kind);
}

/** 创建节点时的默认尺寸：优先 catalog defaultSize，未收录 kind 回退 200x100。 */
export function getFlowchartShapeDefaultSize(kind: FlowchartNodeKind): {
  width: number;
  height: number;
} {
  return getFlowchartShapeDefinition(kind)?.defaultSize ?? { width: 200, height: 100 };
}

/**
 * 搜索形状：trim、大小写不敏感、匹配 label/aliases/kind。
 * 返回匹配的 shape definition 数组，保持目录顺序。
 */
export function searchFlowchartShapes(query: string): FlowchartShapeDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...FLOWCHART_SHAPE_CATALOG];
  return FLOWCHART_SHAPE_CATALOG.filter((shape) => {
    if (shape.label.toLowerCase().includes(q)) return true;
    if (shape.kind.toLowerCase().includes(q)) return true;
    return shape.aliases.some((alias) => alias.toLowerCase().includes(q));
  });
}

/**
 * 按分类分组形状。
 */
export function groupShapesByCategory(
  shapes: readonly FlowchartShapeDefinition[],
): Record<FlowchartShapeCategory, FlowchartShapeDefinition[]> {
  const groups: Record<FlowchartShapeCategory, FlowchartShapeDefinition[]> = {
    basic: [],
    flowchart: [],
    swimlane: [],
  };
  for (const shape of shapes) {
    groups[shape.category].push(shape);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// SVG 几何渲染
// ---------------------------------------------------------------------------

export interface RenderShapeOptions {
  /** 用户自定义填充色（CSS 变量值） */
  fill?: string;
  /** 用户自定义边框色（CSS 变量值） */
  stroke?: string;
  /** 用户自定义边框宽度 */
  strokeWidth?: number;
  /** 用户自定义边框样式 */
  strokeDasharray?: string;
  /** 圆角半径（仅对 rectangle / rounded-rectangle 等支持圆角的几何生效） */
  cornerRadius?: number;
  /** 泳池/泳道标题区方向：horizontal 标题区在左，vertical 标题区在顶（默认 horizontal） */
  variant?: "horizontal" | "vertical";
}

/**
 * 渲染形状的真实 SVG 几何。
 * 所有形状使用统一 viewBox="0 0 200 100"、preserveAspectRatio="none" 和 vectorEffect="non-scaling-stroke"。
 * 默认 fill/stroke 只使用 flowchart 主题 token。
 */
export function renderFlowchartShape(
  kind: FlowchartNodeKind,
  options: RenderShapeOptions = {},
): ReactNode {
  const {
    fill,
    stroke,
    strokeWidth = 1,
    strokeDasharray,
    cornerRadius,
    variant = "horizontal",
  } = options;

  const style: React.CSSProperties = {
    fill: fill || undefined,
    stroke: stroke || undefined,
    strokeWidth,
    strokeDasharray,
    vectorEffect: "non-scaling-stroke",
  };

  // 未自定义时使用主题 token
  const shapeClassName = !fill && !stroke ? "fill-card stroke-border" : "";
  const common = { className: shapeClassName, style };

  switch (kind) {
    // -----------------------------------------------------------------------
    // 基础形状
    // -----------------------------------------------------------------------
    case "text":
      // text 节点无 SVG 形状，仅渲染文本
      return null;

    case "note":
      // 便签：矩形 + 右上角折角
      return (
        <>
          <rect x="1" y="1" width="198" height="98" {...common} />
          <path d="M160 1L199 40V1H160Z" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );

    case "code-block":
      // 代码块：矩形 + 左侧双线
      return (
        <>
          <rect x="1" y="1" width="198" height="98" {...common} />
          <path d="M20 1V99M30 1V99" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );

    case "rectangle":
      return <rect x="1" y="1" width="198" height="98" rx={cornerRadius && cornerRadius > 0 ? Math.min(cornerRadius, 99) : undefined} {...common} />;

    case "rounded-rectangle":
      return <rect x="1" y="1" width="198" height="98" rx={cornerRadius && cornerRadius > 0 ? Math.min(cornerRadius, 99) : 12} {...common} />;

    case "ellipse":
      return <ellipse cx="100" cy="50" rx="99" ry="49" {...common} />;

    case "circle":
      return <ellipse cx="100" cy="50" rx="49" ry="49" {...common} />;

    case "triangle":
      return <polygon points="100,1 199,99 1,99" {...common} />;

    case "right-triangle":
      return <polygon points="1,1 199,99 1,99" {...common} />;

    case "diamond-basic":
      return <polygon points="100,1 199,50 100,99 1,50" {...common} />;

    case "pentagon-basic":
      return <polygon points="100,1 199,40 160,99 40,99 1,40" {...common} />;

    case "hexagon-basic":
      return <polygon points="30,1 170,1 199,50 170,99 30,99 1,50" {...common} />;

    case "octagon":
      return <polygon points="60,1 140,1 199,30 199,70 140,99 60,99 1,70 1,30" {...common} />;

    case "star":
      return <polygon points="100,1 125,40 170,40 135,65 150,99 100,80 50,99 65,65 30,40 75,40" {...common} />;

    case "cloud":
      return (
        <path
          d="M50 90C20 90 10 60 30 45C20 20 60 5 80 20C90 1 130 1 140 20C170 5 200 35 185 60C195 80 170 95 140 90Z"
          {...common}
        />
      );

    case "callout":
      return (
        <path
          d="M1 1H199V70H120L100 99L80 70H1Z"
          {...common}
        />
      );

    case "plus":
      return <path d="M70 1H130V40H199V60H130V99H70V60H1V40H70Z" {...common} />;

    case "l-shape":
      return <path d="M1 1H60V60H99V99H1Z" {...common} />;

    case "arrow-left":
      return <polygon points="199,25 100,25 100,1 1,50 100,99 100,75 199,75" {...common} />;

    case "arrow-right":
      return <polygon points="1,25 100,25 100,1 199,50 100,99 100,75 1,75" {...common} />;

    case "arrow-up":
      return <polygon points="25,199 25,100 1,100 50,1 99,100 75,100 75,199" {...common} />;

    case "arrow-down":
      return <polygon points="25,1 25,100 1,100 50,199 99,100 75,100 75,1" {...common} />;

    case "arrow-bidirectional":
      return <polygon points="1,50 40,20 40,40 160,40 160,20 199,50 160,80 160,60 40,60 40,80" {...common} />;

    case "bracket-round":
      return <path d="M70 1C30 25 30 75 70 99M130 1C170 25 170 75 130 99" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />;

    case "bracket-square":
      return <path d="M70 1H30V99H70M130 1H170V99H130" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />;

    case "brace":
      return <path d="M70 1C50 1 50 25 30 25C50 25 50 50 30 50C50 50 50 75 30 75C50 75 50 99 70 99M130 1C150 1 150 25 170 25C150 25 150 50 170 50C150 50 150 75 170 75C150 75 150 99 130 99" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />;

    // -----------------------------------------------------------------------
    // 流程图形状
    // -----------------------------------------------------------------------
    case "start":
    case "end":
    case "terminator":
      return <rect x="1" y="1" width="198" height="98" rx="49" {...common} />;

    case "process":
      return <rect x="1" y="1" width="198" height="98" rx="8" {...common} />;

    case "subprocess":
    case "predefined-process":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" rx="6" {...common} />
          <path className="fill-none stroke-border" d="M24 1V99M176 1V99" style={style} />
        </>
      );

    case "alternate-process":
      return <rect x="1" y="1" width="198" height="98" rx="12" {...common} />;

    case "decision":
      return <polygon points="100,1 199,50 100,99 1,50" {...common} />;

    case "preparation":
      return <polygon points="28,1 172,1 199,50 172,99 28,99 1,50" {...common} />;

    case "merge":
      return <polygon points="100,99 1,1 199,1" {...common} />;

    case "extract":
      return <polygon points="100,1 1,99 199,99" {...common} />;

    case "sort":
      return (
        <>
          <polygon points="100,1 1,50 100,99" {...common} />
          <polygon points="100,1 199,50 100,99" {...common} />
        </>
      );

    case "or":
      return (
        <>
          <ellipse cx="100" cy="50" rx="49" ry="49" {...common} />
          <path d="M70 20L130 80M130 20L70 80" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );

    case "summation":
      return (
        <>
          <ellipse cx="100" cy="50" rx="49" ry="49" {...common} />
          <path d="M60 20C80 35 80 65 60 80M140 20C120 35 120 65 140 80" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
        </>
      );

    case "input-output":
      return <polygon points="24,1 199,1 176,99 1,99" {...common} />;

    case "manual-input":
      return <polygon points="1,25 199,1 199,99 1,99" {...common} />;

    case "manual-operation":
      return <polygon points="40,1 160,1 199,99 1,99" {...common} />;

    case "display":
      return <path d="M25 1H132C174 1 199 23 199 50S174 99 132 99H25C43 75 43 25 25 1Z" {...common} />;

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

    case "card":
      return <rect x="1" y="1" width="198" height="98" {...common} />;

    case "internal-storage":
      return (
        <>
          <rect x="1" y="1" width="198" height="98" rx="4" {...common} />
          <path className="fill-none stroke-border" d="M28 1V99M1 24H199" style={style} />
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

    case "stored-data":
      return <path d="M24 1H176C207 20 207 80 176 99H24C-7 80-7 20 24 1Z" {...common} />;

    case "connector":
      return <ellipse cx="100" cy="50" rx="49" ry="49" {...common} />;

    case "off-page-connector":
      return <polygon points="1,1 199,1 199,66 100,99 1,66" {...common} />;

    case "delay":
      return <path d="M1 1H126C167 1 199 23 199 50S167 99 126 99H1Z" {...common} />;

    case "annotation":
      return (
        <>
          <path d="M 1 1 L 1 99" stroke={style.stroke || "var(--flowchart-node-border)"} strokeWidth={((style.strokeWidth as number | undefined) ?? 1) * 2} strokeDasharray={style.strokeDasharray} vectorEffect="non-scaling-stroke" fill="none" />
          <rect x="1" y="1" width="198" height="98" rx="4" {...common} fill="none" />
        </>
      );

    // -----------------------------------------------------------------------
    // 泳池 / 泳道（容器，预览几何；画布完整交互渲染见 FlowchartCanvas 节点视图）
    // -----------------------------------------------------------------------
    case "swimlane-pool":
    case "swimlane-lane": {
      const vertical = variant === "vertical";
      return (
        <>
          <rect x="1" y="1" width="198" height="98" rx="4" {...common} />
          {vertical ? (
            <rect x="1" y="1" width="198" height="25" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
          ) : (
            <rect x="1" y="1" width="40" height="98" fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
          )}
        </>
      );
    }

    default:
      // 未知形状回退为矩形
      return <rect x="1" y="1" width="198" height="98" rx="8" {...common} />;
  }
}

/**
 * 图形库网格预览：普通形状与画布共用 renderFlowchartShape；
 * 分隔入口渲染为一条方向线（不创建独立无归属线条，仅作图标语义）。
 */
export function renderFlowchartShapePreview(shape: FlowchartShapeDefinition): ReactNode {
  if (shape.creation?.action === "divider") {
    const horizontal = shape.creation.orientation === "horizontal";
    return (
      <line
        x1={horizontal ? 1 : 100}
        y1={horizontal ? 50 : 1}
        x2={horizontal ? 199 : 100}
        y2={horizontal ? 50 : 99}
        stroke="hsl(var(--muted-foreground))"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  // 预览使用更显眼的颜色：浅主题底 + 深边框，确保在面板背景中清晰可辨
  return renderFlowchartShape(shape.kind, {
    variant: shape.creation?.orientation,
    fill: "hsl(var(--muted) / 0.5)",
    stroke: "hsl(var(--muted-foreground) / 0.7)",
    strokeWidth: 1.5,
  });
}
