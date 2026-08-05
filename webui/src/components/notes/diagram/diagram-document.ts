/**
 * 图表画布文档模型 v2。
 *
 * 规范（见 AI_EDITABLE_DIAGRAM_CANVAS_PRODUCTION_PLAN.md §7）：
 * 1. 统一 `diagram` 文档模型，`diagramKind` 区分具体图型，不新增平行笔记类型；
 * 2. JSON 是唯一权威数据源；文本投影是只读派生产物；
 * 3. 元素为可辨识联合类型（shape/text/icon/image/group/container/brace/table/lifeline/activation/freehand）；
 * 4. 语义字段与视觉字段分离，搜索消费语义投影，渲染消费完整文档；
 * 5. 坐标、尺寸必须为有限数值，尺寸必须为正；
 * 6. parentId 必须指向 group/container，父元素排在子元素之前，禁止父子循环；
 * 7. 版本升级必须通过显式迁移函数（diagram-migrate.ts），不在 parser 中静默丢字段。
 */

// ---------------------------------------------------------------------------
// 图型
// ---------------------------------------------------------------------------

export type DiagramKind =
  | "freeform"
  | "flowchart"
  | "swimlane"
  | "framework"
  | "architecture"
  | "deployment"
  | "sequence"
  | "erd"
  | "class"
  | "state"
  | "usecase"
  | "orgchart"
  | "timeline"
  | "matrix";

export const DIAGRAM_KINDS: readonly DiagramKind[] = [
  "freeform",
  "flowchart",
  "swimlane",
  "framework",
  "architecture",
  "deployment",
  "sequence",
  "erd",
  "class",
  "state",
  "usecase",
  "orgchart",
  "timeline",
  "matrix",
];

// ---------------------------------------------------------------------------
// 基础几何与样式
// ---------------------------------------------------------------------------

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface DiagramSize {
  width: number;
  height: number;
}

export interface DiagramViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ColorStop {
  offset: number;
  color: string;
}

export type Paint =
  | { type: "none" }
  | { type: "solid"; color: string }
  | { type: "linear-gradient"; angle: number; stops: ColorStop[] };

export interface DiagramStroke {
  color: string;
  width: number;
  style: "solid" | "dashed" | "dotted";
}

export const DIAGRAM_STROKE_STYLES = ["solid", "dashed", "dotted"] as const;

export interface DiagramShadow {
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
}

export interface DiagramTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  italic: boolean;
  underline: boolean;
  color: string;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  lineHeight: number;
}

export const DEFAULT_TEXT_STYLE: DiagramTextStyle = {
  fontFamily: "Inter",
  fontSize: 14,
  fontWeight: 400,
  italic: false,
  underline: false,
  color: "#1f2329",
  align: "center",
  verticalAlign: "middle",
  lineHeight: 1.4,
};

// ---------------------------------------------------------------------------
// 文本块（块级文本，不引入字符级富文本）
// ---------------------------------------------------------------------------

export type DiagramTextBlockKind = "heading" | "paragraph" | "bullet" | "numbered";

export const DIAGRAM_TEXT_BLOCK_KINDS: readonly DiagramTextBlockKind[] = [
  "heading",
  "paragraph",
  "bullet",
  "numbered",
];

export interface DiagramTextBlock {
  id: string;
  kind: DiagramTextBlockKind;
  text: string;
  level?: 1 | 2 | 3;
  style?: Partial<DiagramTextStyle>;
}

// ---------------------------------------------------------------------------
// 元素
// ---------------------------------------------------------------------------

export type ShapeKind =
  | "rectangle"
  | "rounded-rectangle"
  | "ellipse"
  | "circle"
  | "pill"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "cylinder"
  | "document"
  | "multi-document"
  | "cloud"
  | "actor"
  | "callout"
  | "chevron"
  | "pentagon"
  | "trapezoid"
  | "process"
  | "subprocess"
  | "database"
  | "junction"
  // v1 迁移兼容：保留旧流程图扩展形状
  | "predefined-process"
  | "manual-input"
  | "delay"
  | "display"
  | "off-page-connector"
  | "internal-storage"
  | "stored-data";

export const SHAPE_KINDS: readonly ShapeKind[] = [
  "rectangle",
  "rounded-rectangle",
  "ellipse",
  "circle",
  "pill",
  "diamond",
  "hexagon",
  "parallelogram",
  "cylinder",
  "document",
  "multi-document",
  "cloud",
  "actor",
  "callout",
  "chevron",
  "pentagon",
  "trapezoid",
  "process",
  "subprocess",
  "database",
  "junction",
  "predefined-process",
  "manual-input",
  "delay",
  "display",
  "off-page-connector",
  "internal-storage",
  "stored-data",
];

export type DiagramElementType =
  | "shape"
  | "text"
  | "icon"
  | "image"
  | "group"
  | "container"
  | "brace"
  | "table"
  | "lifeline"
  | "activation"
  | "freehand";

export const DIAGRAM_ELEMENT_TYPES: readonly DiagramElementType[] = [
  "shape",
  "text",
  "icon",
  "image",
  "group",
  "container",
  "brace",
  "table",
  "lifeline",
  "activation",
  "freehand",
];

/** 语义数据：搜索和知识库消费的语义投影来源；渲染不依赖它反推样式。 */
export interface DiagramSemanticData {
  /** 语义角色，如 start/end/person/system/container/component/entity/actor */
  role?: string;
  /** 职责/描述 */
  description?: string;
  /** 技术（Container/Component） */
  technology?: string;
  /** 协议（关系） */
  protocol?: string;
  /** 基数（ER 关系，如 "1:N"） */
  cardinality?: string;
  /** 状态转换事件 */
  event?: string;
  /** 状态转换条件 */
  guard?: string;
  /** 状态转换动作 */
  action?: string;
}

export interface DiagramElementBase {
  id: string;
  type: DiagramElementType;
  position: DiagramPoint;
  size: DiagramSize;
  rotation: number;
  parentId?: string;
  zIndex: number;
  locked?: boolean;
  hidden?: boolean;
  opacity?: number;
  semantic?: DiagramSemanticData;
}

export interface DiagramShapeElement extends DiagramElementBase {
  type: "shape";
  shapeKind: ShapeKind;
  fill: Paint;
  stroke?: DiagramStroke;
  cornerRadius?: number;
  shadow?: DiagramShadow;
  textBlocks: DiagramTextBlock[];
  textStyle?: Partial<DiagramTextStyle>;
}

export interface DiagramTextElement extends DiagramElementBase {
  type: "text";
  textBlocks: DiagramTextBlock[];
  textStyle?: Partial<DiagramTextStyle>;
}

export interface IconRef {
  library: "lucide" | "tabler" | "phosphor" | "simple-icons" | "cloud";
  name: string;
  variant?: string;
}

export const ICON_LIBRARIES: readonly IconRef["library"][] = [
  "lucide",
  "tabler",
  "phosphor",
  "simple-icons",
  "cloud",
];

export type DiagramObjectFit = "contain" | "cover" | "fill";

export interface DiagramIconElement extends DiagramElementBase {
  type: "icon";
  iconRef: IconRef;
  color?: string;
  fit: DiagramObjectFit;
}

export interface DiagramImageElement extends DiagramElementBase {
  type: "image";
  assetId: string;
  fit: DiagramObjectFit;
  crop?: { x: number; y: number; width: number; height: number };
  alt?: string;
}

export interface DiagramGroupElement extends DiagramElementBase {
  type: "group";
  title?: string;
  background?: Paint;
}

export type ContainerRole = "boundary" | "swimlane" | "phase" | "region" | "tier";

export const CONTAINER_ROLES: readonly ContainerRole[] = [
  "boundary",
  "swimlane",
  "phase",
  "region",
  "tier",
];

export interface DiagramContainerElement extends DiagramElementBase {
  type: "container";
  containerRole: ContainerRole;
  title: string;
  padding: number;
  background?: Paint;
  stroke?: DiagramStroke;
}

export type BraceKind = "curly" | "square" | "round";

export interface DiagramBraceElement extends DiagramElementBase {
  type: "brace";
  braceKind: BraceKind;
  orientation: "left" | "right" | "top" | "bottom";
  stroke: DiagramStroke;
}

export interface DiagramTableCell {
  id: string;
  text: string;
  style?: Partial<DiagramTextStyle>;
}

export interface DiagramTableRow {
  id: string;
  cells: DiagramTableCell[];
}

export interface DiagramTableSection {
  id: string;
  kind: "header" | "body";
  rows: DiagramTableRow[];
}

export interface DiagramTableElement extends DiagramElementBase {
  type: "table";
  sections: DiagramTableSection[];
  columnWidths: number[];
}

export interface DiagramLifelineElement extends DiagramElementBase {
  type: "lifeline";
  participantRole?: string;
  title: string;
}

export interface DiagramActivationElement extends DiagramElementBase {
  type: "activation";
  /** 所属生命线元素 id */
  lifelineId: string;
}

export interface FreehandPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface DiagramFreehandElement extends DiagramElementBase {
  type: "freehand";
  points: FreehandPoint[];
  /** 本地化后的 SVG path（相对元素左上角） */
  path?: string;
  drawingTool: "pen" | "highlighter";
  color: string;
  strokeWidth: number;
}

export type DiagramElement =
  | DiagramShapeElement
  | DiagramTextElement
  | DiagramIconElement
  | DiagramImageElement
  | DiagramGroupElement
  | DiagramContainerElement
  | DiagramBraceElement
  | DiagramTableElement
  | DiagramLifelineElement
  | DiagramActivationElement
  | DiagramFreehandElement;

// ---------------------------------------------------------------------------
// 连接器
// ---------------------------------------------------------------------------

export type EndpointMarker =
  | "none"
  | "arrow-open"
  | "arrow-closed"
  | "triangle"
  | "circle"
  | "diamond-open"
  | "diamond-filled"
  | "bar"
  | "er-one"
  | "er-one-many"
  | "er-many";

export const ENDPOINT_MARKERS: readonly EndpointMarker[] = [
  "none",
  "arrow-open",
  "arrow-closed",
  "triangle",
  "circle",
  "diamond-open",
  "diamond-filled",
  "bar",
  "er-one",
  "er-one-many",
  "er-many",
];

export type ConnectorRoute = "straight" | "orthogonal" | "bezier";

export const CONNECTOR_ROUTES: readonly ConnectorRoute[] = ["straight", "orthogonal", "bezier"];

export interface DiagramEndpoint {
  elementId?: string;
  portId?: string;
  /** 自由端点（不绑定元素） */
  point?: DiagramPoint;
}

export interface DiagramRelationshipData extends DiagramSemanticData {
  /** 关系类型，如 association/include/extend/inheritance/implementation/aggregation/composition */
  kind?: string;
}

export interface DiagramConnector {
  id: string;
  source: DiagramEndpoint;
  target: DiagramEndpoint;
  route: ConnectorRoute;
  waypoints?: DiagramPoint[];
  markerStart: EndpointMarker;
  markerEnd: EndpointMarker;
  stroke: DiagramStroke;
  label?: DiagramTextBlock[];
  zIndex: number;
  semantic?: DiagramRelationshipData;
}

// ---------------------------------------------------------------------------
// 资产
// ---------------------------------------------------------------------------

export interface DiagramAssetRef {
  /** 资产 id（文档内唯一，如 "asset-1"） */
  id: string;
  /** 相对 vault 根目录的路径（如 assets/xxx.png），禁止绝对路径与 .. */
  path: string;
  mime: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// 画布与文档
// ---------------------------------------------------------------------------

export interface DiagramGridSettings {
  visible: boolean;
  snap: boolean;
  size: number;
}

export interface DiagramCanvasSettings {
  mode: "infinite" | "page";
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape";
  background: Paint;
  padding: number;
  grid: DiagramGridSettings;
}

export type DiagramLayoutDirection = "TB" | "LR";

export interface DiagramLayoutSettings {
  direction: DiagramLayoutDirection;
}

export interface DiagramDocument {
  version: 2;
  capabilityVersion: number;
  diagramKind: DiagramKind;
  canvas: DiagramCanvasSettings;
  layout?: DiagramLayoutSettings;
  elements: DiagramElement[];
  connectors: DiagramConnector[];
  assets?: DiagramAssetRef[];
  viewport?: DiagramViewport;
}

export const DIAGRAM_FENCE_LANG = "mona-diagram";
export const DIAGRAM_PATCH_FENCE_LANG = "mona-diagram-patch";
export const DIAGRAM_DOCUMENT_VERSION = 2;
export const DIAGRAM_CAPABILITY_VERSION = 1;
export const DIAGRAM_PATCH_PROTOCOL_VERSION = 2;
export const DIAGRAM_PATCH_MAX_OPS = 50;
export const DIAGRAM_PATCH_MAX_PAYLOAD_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function generateDiagramId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function defaultCanvasSettings(kind: DiagramKind): DiagramCanvasSettings {
  const pageKinds: readonly DiagramKind[] = ["framework", "freeform"];
  return {
    mode: pageKinds.includes(kind) ? "page" : "infinite",
    background: { type: "none" },
    padding: 0,
    grid: { visible: true, snap: true, size: 8 },
  };
}

/** 构造空白图表文档。flowchart 附带开始/结束节点，其余图型为空画布。 */
export function createBlankDiagramDocument(kind: DiagramKind): DiagramDocument {
  const doc: DiagramDocument = {
    version: DIAGRAM_DOCUMENT_VERSION,
    capabilityVersion: DIAGRAM_CAPABILITY_VERSION,
    diagramKind: kind,
    canvas: defaultCanvasSettings(kind),
    elements: [],
    connectors: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  if (kind === "flowchart") {
    doc.layout = { direction: "TB" };
    doc.elements = [
      createShapeElement("n-start", "pill", "开始", { x: 0, y: 0 }, { role: "start" }),
      createShapeElement("n-end", "pill", "结束", { x: 0, y: 120 }, { role: "end" }),
    ];
  }
  return doc;
}

/** 构造一个段落文本块。 */
export function paragraphBlock(id: string, text: string): DiagramTextBlock {
  return { id, kind: "paragraph", text };
}

/** 构造 shape 元素（含默认样式）。 */
export function createShapeElement(
  id: string,
  shapeKind: ShapeKind,
  label: string,
  position: DiagramPoint,
  semantic?: DiagramSemanticData,
): DiagramShapeElement {
  const el: DiagramShapeElement = {
    id,
    type: "shape",
    shapeKind,
    position: { x: position.x, y: position.y },
    size: { width: 160, height: 60 },
    rotation: 0,
    zIndex: 0,
    fill: { type: "none" },
    textBlocks: label ? [paragraphBlock(`${id}-t0`, label)] : [],
  };
  if (semantic && Object.values(semantic).some((v) => v !== undefined)) {
    el.semantic = { ...semantic };
  }
  return el;
}
