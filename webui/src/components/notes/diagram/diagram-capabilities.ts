/**
 * 图表能力注册表（DiagramCapabilityRegistry）。
 *
 * 规范（见计划 §6.2、§9.3）：
 * 1. 单一注册表声明 UI 与 Agent 的全部能力：元素库、属性面板、Agent 契约、校验白名单；
 * 2. 新增能力必须在此登记，能力对等测试遍历注册表驱动；
 * 3. Agent prompt 中的枚举与值域由本模块生成，不允许手写漂移；
 * 4. 禁止为 Agent 提供 UI 无法检查和修改的逃生字段。
 */

import {
  CONTAINER_ROLES,
  CONNECTOR_ROUTES,
  DIAGRAM_CAPABILITY_VERSION,
  DIAGRAM_ELEMENT_TYPES,
  DIAGRAM_PATCH_FENCE_LANG,
  DIAGRAM_PATCH_MAX_OPS,
  DIAGRAM_PATCH_MAX_PAYLOAD_BYTES,
  DIAGRAM_PATCH_PROTOCOL_VERSION,
  DIAGRAM_STROKE_STYLES,
  DIAGRAM_TEXT_BLOCK_KINDS,
  ENDPOINT_MARKERS,
  ICON_LIBRARIES,
  SHAPE_KINDS,
  createShapeElement,
  generateDiagramId,
  paragraphBlock,
  type DiagramConnector,
  type DiagramElement,
  type DiagramElementType,
  type DiagramKind,
} from "./diagram-document";
import { DIAGRAM_LIMITS } from "./diagram-validator";

// ---------------------------------------------------------------------------
// 字段白名单
// ---------------------------------------------------------------------------

/** 元素公共声明字段（身份 + 几何 + 状态 + 语义）。 */
export const ELEMENT_BASE_FIELDS = [
  "id",
  "type",
  "position",
  "size",
  "rotation",
  "parentId",
  "zIndex",
  "locked",
  "hidden",
  "opacity",
  "semantic",
] as const;

/** 连接器全部声明字段。 */
export const CONNECTOR_DECLARED_FIELDS = [
  "id",
  "source",
  "target",
  "route",
  "waypoints",
  "markerStart",
  "markerEnd",
  "stroke",
  "label",
  "zIndex",
  "semantic",
] as const;

// ---------------------------------------------------------------------------
// 能力定义
// ---------------------------------------------------------------------------

export interface DiagramExportSupport {
  png: boolean;
  svg: boolean;
  pdf: boolean;
}

export interface DiagramCapabilityDefinition {
  /** 能力 id（元素类型名或 "connector"），全注册表唯一。 */
  id: string;
  category: "element" | "connector";
  elementType?: DiagramElementType;
  /** 支持的图型；"all" 表示全部图型。 */
  supportedKinds: readonly DiagramKind[] | "all";
  /** 对象允许出现的全部字段（含 id/type）。 */
  declaredFields: readonly string[];
  /** Agent patch 可写字段（updateElements/updateConnectors patch 白名单）。 */
  agentWritableFields: readonly string[];
  /** 属性面板可编辑字段。 */
  inspectorFields: readonly string[];
  /** 渲染器组件名（elements/<Name>.tsx / connectors/<Name>.tsx）。 */
  renderer: string;
  exportSupport: DiagramExportSupport;
  /** 生成带新 id 的默认对象（工厂，避免共享引用）。 */
  createDefaults: () => DiagramElement | DiagramConnector;
}

const ALL_KINDS = "all" as const;
const FULL_EXPORT: DiagramExportSupport = { png: true, svg: true, pdf: true };

function baseFields(prefix: string) {
  return {
    id: generateDiagramId(prefix),
    position: { x: 0, y: 0 },
    size: { width: 160, height: 60 },
    rotation: 0,
    zIndex: 0,
  };
}

function elementCap(
  elementType: DiagramElementType,
  specificFields: readonly string[],
  supportedKinds: readonly DiagramKind[] | "all",
  renderer: string,
  createDefaults: () => DiagramElement,
): DiagramCapabilityDefinition {
  const declaredFields = [...ELEMENT_BASE_FIELDS, ...specificFields];
  const writable = declaredFields.filter((f) => f !== "id" && f !== "type" && f !== "parentId");
  return {
    id: elementType,
    category: "element",
    elementType,
    supportedKinds,
    declaredFields,
    agentWritableFields: writable,
    inspectorFields: writable,
    renderer,
    exportSupport: FULL_EXPORT,
    createDefaults,
  };
}

const DEFAULT_STROKE = { color: "#1f2329", width: 1.5, style: "solid" as const };

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const DIAGRAM_CAPABILITY_REGISTRY: readonly DiagramCapabilityDefinition[] = [
  elementCap(
    "shape",
    ["shapeKind", "fill", "stroke", "cornerRadius", "shadow", "textBlocks", "textStyle"],
    ALL_KINDS,
    "ShapeElement",
    () => createShapeElement(generateDiagramId("shape"), "rectangle", "形状", { x: 0, y: 0 }),
  ),
  elementCap("text", ["textBlocks", "textStyle"], ALL_KINDS, "TextElement", () => ({
    ...baseFields("text"),
    type: "text",
    textBlocks: [paragraphBlock(generateDiagramId("tb"), "文本")],
  })),
  elementCap("icon", ["iconRef", "color", "fit"], ALL_KINDS, "IconElement", () => ({
    ...baseFields("icon"),
    size: { width: 48, height: 48 },
    type: "icon",
    iconRef: { library: "lucide", name: "smile" },
    fit: "contain",
  })),
  elementCap("image", ["assetId", "fit", "crop", "alt"], ALL_KINDS, "ImageElement", () => ({
    ...baseFields("image"),
    type: "image",
    assetId: "asset-placeholder",
    fit: "contain",
  })),
  elementCap("group", ["title", "background"], ALL_KINDS, "GroupElement", () => ({
    ...baseFields("group"),
    size: { width: 240, height: 160 },
    type: "group",
  })),
  elementCap(
    "container",
    ["containerRole", "title", "padding", "background", "stroke"],
    ALL_KINDS,
    "ContainerElement",
    () => ({
      ...baseFields("container"),
      size: { width: 320, height: 200 },
      type: "container",
      containerRole: "boundary",
      title: "容器",
      padding: 16,
    }),
  ),
  elementCap(
    "brace",
    ["braceKind", "orientation", "stroke"],
    ["framework", "freeform"],
    "BraceElement",
    () => ({
      ...baseFields("brace"),
      size: { width: 40, height: 160 },
      type: "brace",
      braceKind: "curly",
      orientation: "right",
      stroke: { ...DEFAULT_STROKE },
    }),
  ),
  elementCap(
    "table",
    ["sections", "columnWidths"],
    ["erd", "class", "framework", "freeform"],
    "TableElement",
    () => ({
      ...baseFields("table"),
      size: { width: 220, height: 120 },
      type: "table",
      sections: [
        {
          id: generateDiagramId("sec"),
          kind: "header",
          rows: [
            {
              id: generateDiagramId("row"),
              cells: [
                { id: generateDiagramId("cell"), text: "字段" },
                { id: generateDiagramId("cell"), text: "类型" },
              ],
            },
          ],
        },
        {
          id: generateDiagramId("sec"),
          kind: "body",
          rows: [
            {
              id: generateDiagramId("row"),
              cells: [
                { id: generateDiagramId("cell"), text: "id" },
                { id: generateDiagramId("cell"), text: "int" },
              ],
            },
          ],
        },
      ],
      columnWidths: [120, 100],
    }),
  ),
  elementCap(
    "lifeline",
    ["title", "participantRole"],
    ["sequence"],
    "LifelineElement",
    () => ({
      ...baseFields("lifeline"),
      size: { width: 140, height: 320 },
      type: "lifeline",
      title: "参与者",
    }),
  ),
  elementCap(
    "activation",
    ["lifelineId"],
    ["sequence"],
    "ActivationElement",
    () => ({
      ...baseFields("activation"),
      size: { width: 12, height: 80 },
      type: "activation",
      lifelineId: "lifeline-placeholder",
    }),
  ),
  elementCap(
    "freehand",
    ["points", "path", "drawingTool", "color", "strokeWidth"],
    ALL_KINDS,
    "FreehandElement",
    () => ({
      ...baseFields("freehand"),
      size: { width: 20, height: 20 },
      type: "freehand",
      points: [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 20, y: 20, pressure: 0.5 },
      ],
      drawingTool: "pen",
      color: "#1f2329",
      strokeWidth: 8,
    }),
  ),
  {
    id: "connector",
    category: "connector",
    supportedKinds: ALL_KINDS,
    declaredFields: CONNECTOR_DECLARED_FIELDS,
    agentWritableFields: CONNECTOR_DECLARED_FIELDS.filter((f) => f !== "id"),
    inspectorFields: CONNECTOR_DECLARED_FIELDS.filter((f) => f !== "id"),
    renderer: "DiagramConnector",
    exportSupport: FULL_EXPORT,
    createDefaults: (): DiagramConnector => ({
      id: generateDiagramId("conn"),
      source: { point: { x: 0, y: 0 } },
      target: { point: { x: 120, y: 0 } },
      route: "orthogonal",
      markerStart: "none",
      markerEnd: "arrow-closed",
      stroke: { ...DEFAULT_STROKE },
      zIndex: 0,
    }),
  },
];

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 列出某图型可用的全部能力（左侧元素库与 Agent 契约共用）。 */
export function listCapabilities(kind: DiagramKind): readonly DiagramCapabilityDefinition[] {
  return DIAGRAM_CAPABILITY_REGISTRY.filter(
    (c) => c.supportedKinds === "all" || c.supportedKinds.includes(kind),
  );
}

export function getCapability(id: string): DiagramCapabilityDefinition | undefined {
  return DIAGRAM_CAPABILITY_REGISTRY.find((c) => c.id === id);
}

export function getElementCapability(type: DiagramElementType): DiagramCapabilityDefinition | undefined {
  return DIAGRAM_CAPABILITY_REGISTRY.find((c) => c.category === "element" && c.elementType === type);
}

export function declaredElementFields(type: DiagramElementType): readonly string[] {
  return getElementCapability(type)?.declaredFields ?? [];
}

export function declaredConnectorFields(): readonly string[] {
  return CONNECTOR_DECLARED_FIELDS;
}

export function agentWritableElementFields(type: DiagramElementType): readonly string[] {
  return getElementCapability(type)?.agentWritableFields ?? [];
}

export function agentWritableConnectorFields(): readonly string[] {
  return getCapability("connector")?.agentWritableFields ?? [];
}

/** 用能力 id 生成默认对象；未知 id 返回 null。 */
export function createCapabilityDefault(id: string): DiagramElement | DiagramConnector | null {
  return getCapability(id)?.createDefaults() ?? null;
}

// ---------------------------------------------------------------------------
// Agent 契约生成（§9.3）
// ---------------------------------------------------------------------------

const OP_DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["replaceDocument", "整体替换文档（必须是唯一 op）"],
  ["addElements", "新增元素（父元素必须排在子元素之前）"],
  ["updateElements", "按 id 字段级更新元素，可提供 expected 做并发保护"],
  ["removeElements", "删除元素，必须显式列出全部级联子元素与关联连接器"],
  ["addConnectors", "新增连接器"],
  ["updateConnectors", "按 id 字段级更新连接器，可提供 expected"],
  ["removeConnectors", "按 id 删除连接器"],
  ["groupElements", "把元素组合进新建 group"],
  ["ungroupElements", "解散 group（子元素回到 group's parent）"],
  ["reparentElements", "把元素移动进 group/container 或移回根级"],
  ["reorderElements", "同父级内调整图层：front/back/forward/backward"],
  ["setCanvas", "更新画布设置（mode/尺寸/方向/背景/padding/grid）"],
  ["applyLayout", "批量写入元素坐标（和可选尺寸）"],
  ["attachAssets", "登记图片资产（image 元素只能引用已登记 assetId）"],
];

/** 从注册表生成 Agent prompt 能力契约。输出确定性文本，随注册表自动更新。 */
export function buildAgentContract(kind: DiagramKind): string {
  const caps = listCapabilities(kind);
  const elementCaps = caps.filter((c) => c.category === "element");
  const lines: string[] = [];

  lines.push(`# 图表 Agent 能力契约（diagramKind: ${kind}）`);
  lines.push("");
  lines.push("## 协议");
  lines.push(
    `- 输出 \`\`\`${DIAGRAM_PATCH_FENCE_LANG} fenced block；JSON 字段固定为 ` +
      `protocolVersion（=${DIAGRAM_PATCH_PROTOCOL_VERSION}）、capabilityVersion（<=${DIAGRAM_CAPABILITY_VERSION}）、` +
      `baseRevision、baseDocumentHash、ops；未知字段一律拒绝`,
  );
  lines.push(`- ops 数量 ≤ ${DIAGRAM_PATCH_MAX_OPS}；payload ≤ ${DIAGRAM_PATCH_MAX_PAYLOAD_BYTES} 字节`);
  lines.push("- baseRevision/baseDocumentHash 必须取自当前文档状态；任何文档变化都会使视觉 patch 过期");
  lines.push("");
  lines.push("## 可用操作");
  for (const [name, desc] of OP_DESCRIPTIONS) {
    lines.push(`- ${name}：${desc}`);
  }
  lines.push("");
  lines.push("## 可用元素");
  for (const cap of elementCaps) {
    const writable = cap.agentWritableFields.filter(
      (f) => !["position", "size", "rotation", "zIndex", "locked", "hidden", "opacity", "semantic"].includes(f),
    );
    lines.push(`- ${cap.id}：可写字段 ${writable.join(", ")}（另含通用字段）`);
  }
  lines.push("");
  lines.push("## 通用元素字段");
  lines.push("- position {x,y}、size {width,height}（正数）、rotation、zIndex（整数）、locked、hidden、opacity（0..1）");
  lines.push("- semantic {role?,description?,technology?,protocol?,cardinality?,event?,guard?,action?,kind?}");
  lines.push("- parentId 只能通过 reparentElements/groupElements 修改，updateElements 不接受");
  lines.push("");
  lines.push("## 连接器");
  lines.push(`- route：${CONNECTOR_ROUTES.join(" | ")}`);
  lines.push(`- markerStart/markerEnd：${ENDPOINT_MARKERS.join(" | ")}`);
  lines.push(`- stroke {color,width,style: ${DIAGRAM_STROKE_STYLES.join(" | ")}}`);
  lines.push("- source/target 端点：{elementId?,portId?} 或自由端点 {point:{x,y}}；不允许两端引用同一元素");
  lines.push("- label 为文本块数组");
  lines.push("");
  lines.push("## 样式与文本");
  lines.push(
    '- Paint：{"type":"none"} | {"type":"solid","color":"#RRGGBB"} | ' +
      `{"type":"linear-gradient","angle":number,"stops":[{"offset":0..1,"color":...}]}（stops ≤ ${DIAGRAM_LIMITS.maxGradientStops}）`,
  );
  lines.push(
    `- 文本块：{"id","kind":"${DIAGRAM_TEXT_BLOCK_KINDS.join("|")}","text","level?":1|2|3,` +
      '"style?":{fontFamily,fontSize,fontWeight:400|500|600|700,italic,underline,color,align,verticalAlign,lineHeight}}',
  );
  if (elementCaps.some((c) => c.id === "shape")) {
    lines.push(`- shapeKind：${SHAPE_KINDS.join(" | ")}`);
  }
  if (elementCaps.some((c) => c.id === "container")) {
    lines.push(`- containerRole：${CONTAINER_ROLES.join(" | ")}`);
  }
  if (elementCaps.some((c) => c.id === "icon")) {
    lines.push(`- iconRef.library：${ICON_LIBRARIES.join(" | ")}（只允许注册表内图标，不允许任意 SVG）`);
  }
  lines.push("");
  lines.push("## 限制");
  lines.push(
    `- elements ≤ ${DIAGRAM_LIMITS.maxElements}；connectors ≤ ${DIAGRAM_LIMITS.maxConnectors}；` +
      `assets ≤ ${DIAGRAM_LIMITS.maxAssets}；id 长度 ≤ ${DIAGRAM_LIMITS.maxIdLength}`,
  );
  lines.push(
    `- 单段文本 ≤ ${DIAGRAM_LIMITS.maxTextLength} 字符；单元素文本块 ≤ ${DIAGRAM_LIMITS.maxTextBlocksPerElement}；` +
      `waypoints ≤ ${DIAGRAM_LIMITS.maxWaypoints}；freehand 点 ≤ ${DIAGRAM_LIMITS.maxFreehandPoints}；嵌套深度 ≤ ${DIAGRAM_LIMITS.maxNestingDepth}`,
  );
  lines.push("");
  lines.push("## 安全边界");
  lines.push("- 禁止原始 HTML、CSS、JavaScript、任意 SVG markup");
  lines.push("- 图片只能引用 assets 中已登记的 assetId；禁止绝对路径与 .. 路径穿越");
  lines.push("- 所有文本按纯文本/块级文本处理；未知字段、未知枚举、不存在资产一律拒绝");
  return lines.join("\n");
}

/** 供调试页/测试使用：全部元素类型都有注册能力的断言。 */
export function registryCoversAllElementTypes(): boolean {
  return DIAGRAM_ELEMENT_TYPES.every((t) => getElementCapability(t) !== undefined);
}
