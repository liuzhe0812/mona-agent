/**
 * 图表文档 v2 严格校验与规范化。
 *
 * 规范（见计划 §7、§9.6、§13.4）：
 * 1. 所有外部输入（文件、Agent、导入器）视为不可信；
 * 2. 硬错误：版本、枚举、引用完整性、几何约束、父子结构、资产引用；
 * 3. 限制：对象深度、数组长度、文本长度、渐变节点数、路径点数；
 * 4. 规范化：去除未声明字段、规范字段顺序；normalize 前必须先 validate 通过；
 * 5. 禁止绝对路径与 `..` 路径穿越。
 */

import {
  CONNECTOR_ROUTES,
  CONTAINER_ROLES,
  DIAGRAM_CAPABILITY_VERSION,
  DIAGRAM_DOCUMENT_VERSION,
  DIAGRAM_ELEMENT_TYPES,
  DIAGRAM_KINDS,
  DIAGRAM_STROKE_STYLES,
  DIAGRAM_TEXT_BLOCK_KINDS,
  ENDPOINT_MARKERS,
  ICON_LIBRARIES,
  SHAPE_KINDS,
  type ColorStop,
  type ContainerRole,
  type DiagramAssetRef,
  type DiagramCanvasSettings,
  type DiagramConnector,
  type DiagramDocument,
  type DiagramElement,
  type DiagramEndpoint,
  type DiagramKind,
  type DiagramPoint,
  type DiagramSemanticData,
  type DiagramShadow,
  type DiagramStroke,
  type DiagramTableCell,
  type DiagramTableRow,
  type DiagramTableSection,
  type DiagramTextBlock,
  type DiagramTextStyle,
  type DiagramViewport,
  type EndpointMarker,
  type FreehandPoint,
  type IconRef,
  type Paint,
  type ShapeKind,
} from "./diagram-document";

// ---------------------------------------------------------------------------
// 限制（安全边界，见 §13.4）
// ---------------------------------------------------------------------------

export const DIAGRAM_LIMITS = {
  maxElements: 2000,
  maxConnectors: 3000,
  maxAssets: 200,
  maxIdLength: 128,
  maxTextLength: 10000,
  maxTextBlocksPerElement: 200,
  maxGradientStops: 8,
  maxFreehandPoints: 5000,
  maxWaypoints: 100,
  maxNestingDepth: 8,
  maxTableRows: 500,
  maxTableCellsPerRow: 50,
  maxColorLength: 64,
  maxIconNameLength: 128,
} as const;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export interface DiagramValidationError {
  code: string;
  message: string;
}

export type DiagramValidationResult =
  | { ok: true }
  | { ok: false; errors: DiagramValidationError[] };

function invalid(code: string, message: string): DiagramValidationError {
  return { code, message };
}

// ---------------------------------------------------------------------------
// 基础检查
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= DIAGRAM_LIMITS.maxIdLength;
}

function isValidColor(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= DIAGRAM_LIMITS.maxColorLength;
}

function isValidPoint(v: unknown): v is DiagramPoint {
  return isRecord(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y);
}

function isValidSize(v: unknown): boolean {
  return isRecord(v) && isPositiveNumber(v.width) && isPositiveNumber(v.height);
}

function isValidPaint(v: unknown): v is Paint {
  if (!isRecord(v)) return false;
  if (v.type === "none") return true;
  if (v.type === "solid") return isValidColor(v.color);
  if (v.type === "linear-gradient") {
    if (!isFiniteNumber(v.angle)) return false;
    if (!Array.isArray(v.stops) || v.stops.length === 0) return false;
    if (v.stops.length > DIAGRAM_LIMITS.maxGradientStops) return false;
    return (v.stops as unknown[]).every(
      (s) => isRecord(s) && isFiniteNumber(s.offset) && s.offset >= 0 && s.offset <= 1 && isValidColor(s.color),
    );
  }
  return false;
}

function isValidStroke(v: unknown): v is DiagramStroke {
  return (
    isRecord(v) &&
    isValidColor(v.color) &&
    isPositiveNumber(v.width) &&
    DIAGRAM_STROKE_STYLES.includes(v.style as (typeof DIAGRAM_STROKE_STYLES)[number])
  );
}

function isValidTextStylePatch(v: unknown): boolean {
  if (!isRecord(v)) return false;
  for (const [key, value] of Object.entries(v)) {
    switch (key) {
      case "fontFamily":
      case "color":
        if (typeof value !== "string" || value.length === 0) return false;
        break;
      case "fontSize":
      case "lineHeight":
        if (!isPositiveNumber(value)) return false;
        break;
      case "fontWeight":
        if (value !== 400 && value !== 500 && value !== 600 && value !== 700) return false;
        break;
      case "italic":
      case "underline":
        if (typeof value !== "boolean") return false;
        break;
      case "align":
        if (value !== "left" && value !== "center" && value !== "right") return false;
        break;
      case "verticalAlign":
        if (value !== "top" && value !== "middle" && value !== "bottom") return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function isValidTextBlock(v: unknown): v is DiagramTextBlock {
  if (!isRecord(v)) return false;
  if (!isValidId(v.id)) return false;
  if (!DIAGRAM_TEXT_BLOCK_KINDS.includes(v.kind as (typeof DIAGRAM_TEXT_BLOCK_KINDS)[number])) return false;
  if (typeof v.text !== "string" || v.text.length > DIAGRAM_LIMITS.maxTextLength) return false;
  if (v.level !== undefined && v.level !== 1 && v.level !== 2 && v.level !== 3) return false;
  if (v.style !== undefined && !isValidTextStylePatch(v.style)) return false;
  return true;
}

function isValidTextBlocks(v: unknown): v is DiagramTextBlock[] {
  if (!Array.isArray(v)) return false;
  if (v.length > DIAGRAM_LIMITS.maxTextBlocksPerElement) return false;
  return (v as unknown[]).every(isValidTextBlock);
}

function isValidSemantic(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const allowed = ["role", "description", "technology", "protocol", "cardinality", "event", "guard", "action", "kind"];
  for (const [key, value] of Object.entries(v)) {
    if (!allowed.includes(key)) return false;
    if (typeof value !== "string" || value.length > DIAGRAM_LIMITS.maxTextLength) return false;
  }
  return true;
}

function isValidIconRef(v: unknown): v is IconRef {
  return (
    isRecord(v) &&
    ICON_LIBRARIES.includes(v.library as (typeof ICON_LIBRARIES)[number]) &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    v.name.length <= DIAGRAM_LIMITS.maxIconNameLength &&
    (v.variant === undefined || (typeof v.variant === "string" && v.variant.length <= DIAGRAM_LIMITS.maxIconNameLength))
  );
}

function isValidAssetPath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  // 禁止绝对路径与路径穿越
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v)) return false;
  if (v.split(/[\\/]/).some((seg) => seg === "..")) return false;
  return true;
}

function isValidTableSection(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isValidId(v.id)) return false;
  if (v.kind !== "header" && v.kind !== "body") return false;
  if (!Array.isArray(v.rows) || v.rows.length > DIAGRAM_LIMITS.maxTableRows) return false;
  return (v.rows as unknown[]).every((row) => {
    if (!isRecord(row)) return false;
    if (!isValidId(row.id)) return false;
    if (!Array.isArray(row.cells) || row.cells.length > DIAGRAM_LIMITS.maxTableCellsPerRow) return false;
    return (row.cells as unknown[]).every(
      (cell) =>
        isRecord(cell) &&
        isValidId(cell.id) &&
        typeof cell.text === "string" &&
        cell.text.length <= DIAGRAM_LIMITS.maxTextLength &&
        (cell.style === undefined || isValidTextStylePatch(cell.style)),
    );
  });
}

// ---------------------------------------------------------------------------
// 元素校验
// ---------------------------------------------------------------------------

const GROUPING_TYPES = new Set(["group", "container"]);

function validateElementCommon(
  raw: Record<string, unknown>,
  ctx: string,
  errors: DiagramValidationError[],
): void {
  if (!isValidId(raw.id)) {
    errors.push(invalid("element-id-invalid", `${ctx} id 为空或过长`));
  }
  if (!DIAGRAM_ELEMENT_TYPES.includes(raw.type as (typeof DIAGRAM_ELEMENT_TYPES)[number])) {
    errors.push(invalid("element-type-invalid", `${ctx} type 不合法：${String(raw.type)}`));
  }
  if (!isValidPoint(raw.position)) {
    errors.push(invalid("element-position-invalid", `${ctx} position 不是有限数值`));
  }
  if (!isValidSize(raw.size)) {
    errors.push(invalid("element-size-invalid", `${ctx} size 必须为正有限数`));
  }
  if (!isFiniteNumber(raw.rotation)) {
    errors.push(invalid("element-rotation-invalid", `${ctx} rotation 不是有限数值`));
  }
  if (raw.parentId !== undefined && !isValidId(raw.parentId)) {
    errors.push(invalid("element-parent-invalid", `${ctx} parentId 不合法`));
  }
  if (!Number.isInteger(raw.zIndex)) {
    errors.push(invalid("element-zindex-invalid", `${ctx} zIndex 必须是整数`));
  }
  if (raw.locked !== undefined && typeof raw.locked !== "boolean") {
    errors.push(invalid("element-locked-invalid", `${ctx} locked 必须是布尔值`));
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
    errors.push(invalid("element-hidden-invalid", `${ctx} hidden 必须是布尔值`));
  }
  if (raw.opacity !== undefined && (!isFiniteNumber(raw.opacity) || raw.opacity < 0 || raw.opacity > 1)) {
    errors.push(invalid("element-opacity-invalid", `${ctx} opacity 必须在 0..1`));
  }
  if (raw.semantic !== undefined && !isValidSemantic(raw.semantic)) {
    errors.push(invalid("element-semantic-invalid", `${ctx} semantic 含未声明字段或非法值`));
  }
}

function validateElementByType(
  raw: Record<string, unknown>,
  ctx: string,
  errors: DiagramValidationError[],
): void {
  switch (raw.type) {
    case "shape": {
      if (!SHAPE_KINDS.includes(raw.shapeKind as ShapeKind)) {
        errors.push(invalid("shape-kind-invalid", `${ctx} shapeKind 不合法：${String(raw.shapeKind)}`));
      }
      if (!isValidPaint(raw.fill)) {
        errors.push(invalid("shape-fill-invalid", `${ctx} fill 不合法`));
      }
      if (raw.stroke !== undefined && !isValidStroke(raw.stroke)) {
        errors.push(invalid("shape-stroke-invalid", `${ctx} stroke 不合法`));
      }
      if (raw.cornerRadius !== undefined && (!isFiniteNumber(raw.cornerRadius) || raw.cornerRadius < 0)) {
        errors.push(invalid("shape-radius-invalid", `${ctx} cornerRadius 必须为非负有限数`));
      }
      if (raw.shadow !== undefined && !isValidShadow(raw.shadow)) {
        errors.push(invalid("shape-shadow-invalid", `${ctx} shadow 不合法`));
      }
      if (!isValidTextBlocks(raw.textBlocks)) {
        errors.push(invalid("shape-textblocks-invalid", `${ctx} textBlocks 不合法`));
      }
      if (raw.textStyle !== undefined && !isValidTextStylePatch(raw.textStyle)) {
        errors.push(invalid("shape-textstyle-invalid", `${ctx} textStyle 不合法`));
      }
      break;
    }
    case "text": {
      if (!isValidTextBlocks(raw.textBlocks)) {
        errors.push(invalid("text-textblocks-invalid", `${ctx} textBlocks 不合法`));
      }
      if (raw.textStyle !== undefined && !isValidTextStylePatch(raw.textStyle)) {
        errors.push(invalid("text-textstyle-invalid", `${ctx} textStyle 不合法`));
      }
      break;
    }
    case "icon": {
      if (!isValidIconRef(raw.iconRef)) {
        errors.push(invalid("icon-ref-invalid", `${ctx} iconRef 不合法`));
      }
      if (raw.color !== undefined && !isValidColor(raw.color)) {
        errors.push(invalid("icon-color-invalid", `${ctx} color 不合法`));
      }
      if (raw.fit !== "contain" && raw.fit !== "cover" && raw.fit !== "fill") {
        errors.push(invalid("icon-fit-invalid", `${ctx} fit 不合法`));
      }
      break;
    }
    case "image": {
      if (!isValidId(raw.assetId)) {
        errors.push(invalid("image-assetid-invalid", `${ctx} assetId 不合法`));
      }
      if (raw.fit !== "contain" && raw.fit !== "cover" && raw.fit !== "fill") {
        errors.push(invalid("image-fit-invalid", `${ctx} fit 不合法`));
      }
      if (raw.alt !== undefined && typeof raw.alt !== "string") {
        errors.push(invalid("image-alt-invalid", `${ctx} alt 必须是字符串`));
      }
      break;
    }
    case "group": {
      if (raw.title !== undefined && typeof raw.title !== "string") {
        errors.push(invalid("group-title-invalid", `${ctx} title 必须是字符串`));
      }
      if (raw.background !== undefined && !isValidPaint(raw.background)) {
        errors.push(invalid("group-background-invalid", `${ctx} background 不合法`));
      }
      break;
    }
    case "container": {
      if (!CONTAINER_ROLES.includes(raw.containerRole as ContainerRole)) {
        errors.push(invalid("container-role-invalid", `${ctx} containerRole 不合法`));
      }
      if (typeof raw.title !== "string") {
        errors.push(invalid("container-title-invalid", `${ctx} title 必须是字符串`));
      }
      if (!isFiniteNumber(raw.padding) || raw.padding < 0) {
        errors.push(invalid("container-padding-invalid", `${ctx} padding 必须为非负有限数`));
      }
      if (raw.background !== undefined && !isValidPaint(raw.background)) {
        errors.push(invalid("container-background-invalid", `${ctx} background 不合法`));
      }
      if (raw.stroke !== undefined && !isValidStroke(raw.stroke)) {
        errors.push(invalid("container-stroke-invalid", `${ctx} stroke 不合法`));
      }
      break;
    }
    case "brace": {
      if (raw.braceKind !== "curly" && raw.braceKind !== "square" && raw.braceKind !== "round") {
        errors.push(invalid("brace-kind-invalid", `${ctx} braceKind 不合法`));
      }
      if (raw.orientation !== "left" && raw.orientation !== "right" && raw.orientation !== "top" && raw.orientation !== "bottom") {
        errors.push(invalid("brace-orientation-invalid", `${ctx} orientation 不合法`));
      }
      if (!isValidStroke(raw.stroke)) {
        errors.push(invalid("brace-stroke-invalid", `${ctx} stroke 不合法`));
      }
      break;
    }
    case "table": {
      if (!Array.isArray(raw.sections) || !(raw.sections as unknown[]).every(isValidTableSection)) {
        errors.push(invalid("table-sections-invalid", `${ctx} sections 不合法`));
      }
      if (!Array.isArray(raw.columnWidths) || !(raw.columnWidths as unknown[]).every(isPositiveNumber)) {
        errors.push(invalid("table-columns-invalid", `${ctx} columnWidths 必须为正数数组`));
      }
      break;
    }
    case "lifeline": {
      if (typeof raw.title !== "string") {
        errors.push(invalid("lifeline-title-invalid", `${ctx} title 必须是字符串`));
      }
      if (raw.participantRole !== undefined && typeof raw.participantRole !== "string") {
        errors.push(invalid("lifeline-role-invalid", `${ctx} participantRole 必须是字符串`));
      }
      break;
    }
    case "activation": {
      if (!isValidId(raw.lifelineId)) {
        errors.push(invalid("activation-lifeline-invalid", `${ctx} lifelineId 不合法`));
      }
      break;
    }
    case "freehand": {
      if (!Array.isArray(raw.points) || raw.points.length > DIAGRAM_LIMITS.maxFreehandPoints) {
        errors.push(invalid("freehand-points-invalid", `${ctx} points 不合法或超过上限`));
      } else if (
        !(raw.points as unknown[]).every(
          (p) => isRecord(p) && isFiniteNumber(p.x) && isFiniteNumber(p.y) && isFiniteNumber(p.pressure),
        )
      ) {
        errors.push(invalid("freehand-points-invalid", `${ctx} points 含非法点`));
      }
      if (raw.path !== undefined && typeof raw.path !== "string") {
        errors.push(invalid("freehand-path-invalid", `${ctx} path 必须是字符串`));
      }
      if (raw.drawingTool !== "pen" && raw.drawingTool !== "highlighter") {
        errors.push(invalid("freehand-tool-invalid", `${ctx} drawingTool 不合法`));
      }
      if (!isValidColor(raw.color)) {
        errors.push(invalid("freehand-color-invalid", `${ctx} color 不合法`));
      }
      if (!isPositiveNumber(raw.strokeWidth)) {
        errors.push(invalid("freehand-width-invalid", `${ctx} strokeWidth 必须为正数`));
      }
      break;
    }
    default:
      // type 非法已在 common 中报告
      break;
  }
}

function isValidShadow(v: unknown): v is DiagramShadow {
  return (
    isRecord(v) &&
    isValidColor(v.color) &&
    isFiniteNumber(v.offsetX) &&
    isFiniteNumber(v.offsetY) &&
    isFiniteNumber(v.blur) &&
    v.blur >= 0
  );
}

// ---------------------------------------------------------------------------
// 连接器校验
// ---------------------------------------------------------------------------

function isValidEndpoint(v: unknown): v is DiagramEndpoint {
  if (!isRecord(v)) return false;
  const hasElement = v.elementId !== undefined;
  const hasPoint = v.point !== undefined;
  if (!hasElement && !hasPoint) return false;
  if (hasElement && !isValidId(v.elementId)) return false;
  if (hasPoint && !isValidPoint(v.point)) return false;
  if (v.portId !== undefined && !isValidId(v.portId)) return false;
  return true;
}

function validateConnector(
  raw: Record<string, unknown>,
  ctx: string,
  errors: DiagramValidationError[],
): void {
  if (!isValidId(raw.id)) {
    errors.push(invalid("connector-id-invalid", `${ctx} id 为空或过长`));
  }
  if (!isValidEndpoint(raw.source)) {
    errors.push(invalid("connector-source-invalid", `${ctx} source 端点不合法`));
  }
  if (!isValidEndpoint(raw.target)) {
    errors.push(invalid("connector-target-invalid", `${ctx} target 端点不合法`));
  }
  if (!CONNECTOR_ROUTES.includes(raw.route as (typeof CONNECTOR_ROUTES)[number])) {
    errors.push(invalid("connector-route-invalid", `${ctx} route 不合法：${String(raw.route)}`));
  }
  if (raw.waypoints !== undefined) {
    if (!Array.isArray(raw.waypoints) || raw.waypoints.length > DIAGRAM_LIMITS.maxWaypoints) {
      errors.push(invalid("connector-waypoints-invalid", `${ctx} waypoints 不合法或超过上限`));
    } else if (!(raw.waypoints as unknown[]).every(isValidPoint)) {
      errors.push(invalid("connector-waypoints-invalid", `${ctx} waypoints 含非法点`));
    }
  }
  if (!ENDPOINT_MARKERS.includes(raw.markerStart as EndpointMarker)) {
    errors.push(invalid("connector-marker-invalid", `${ctx} markerStart 不合法`));
  }
  if (!ENDPOINT_MARKERS.includes(raw.markerEnd as EndpointMarker)) {
    errors.push(invalid("connector-marker-invalid", `${ctx} markerEnd 不合法`));
  }
  if (!isValidStroke(raw.stroke)) {
    errors.push(invalid("connector-stroke-invalid", `${ctx} stroke 不合法`));
  }
  if (raw.label !== undefined && !isValidTextBlocks(raw.label)) {
    errors.push(invalid("connector-label-invalid", `${ctx} label 不合法`));
  }
  if (!Number.isInteger(raw.zIndex)) {
    errors.push(invalid("connector-zindex-invalid", `${ctx} zIndex 必须是整数`));
  }
  if (raw.semantic !== undefined && !isValidSemantic(raw.semantic)) {
    errors.push(invalid("connector-semantic-invalid", `${ctx} semantic 含未声明字段或非法值`));
  }
}

// ---------------------------------------------------------------------------
// 文档校验
// ---------------------------------------------------------------------------

export function validateDiagramDocument(input: unknown): DiagramValidationResult {
  const errors: DiagramValidationError[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: [invalid("not-object", "文档不是对象")] };
  }
  const doc = input;

  if (doc.version !== DIAGRAM_DOCUMENT_VERSION) {
    errors.push(invalid("version-unsupported", `不支持的版本：${String(doc.version)}`));
  }
  if (!Number.isInteger(doc.capabilityVersion) || (doc.capabilityVersion as number) < 1) {
    errors.push(invalid("capability-version-invalid", "capabilityVersion 必须是 >= 1 的整数"));
  } else if ((doc.capabilityVersion as number) > DIAGRAM_CAPABILITY_VERSION) {
    errors.push(
      invalid(
        "capability-version-too-new",
        `capabilityVersion ${String(doc.capabilityVersion)} 超出客户端支持的 ${DIAGRAM_CAPABILITY_VERSION}`,
      ),
    );
  }
  if (!DIAGRAM_KINDS.includes(doc.diagramKind as DiagramKind)) {
    errors.push(invalid("kind-invalid", `diagramKind 不合法：${String(doc.diagramKind)}`));
  }

  // canvas
  if (!isRecord(doc.canvas)) {
    errors.push(invalid("canvas-invalid", "canvas 不是对象"));
  } else {
    const c = doc.canvas;
    if (c.mode !== "infinite" && c.mode !== "page") {
      errors.push(invalid("canvas-mode-invalid", "canvas.mode 必须是 infinite 或 page"));
    }
    if (c.width !== undefined && !isPositiveNumber(c.width)) {
      errors.push(invalid("canvas-size-invalid", "canvas.width 必须为正数"));
    }
    if (c.height !== undefined && !isPositiveNumber(c.height)) {
      errors.push(invalid("canvas-size-invalid", "canvas.height 必须为正数"));
    }
    if (c.orientation !== undefined && c.orientation !== "portrait" && c.orientation !== "landscape") {
      errors.push(invalid("canvas-orientation-invalid", "canvas.orientation 不合法"));
    }
    if (!isValidPaint(c.background)) {
      errors.push(invalid("canvas-background-invalid", "canvas.background 不合法"));
    }
    if (!isFiniteNumber(c.padding) || c.padding < 0) {
      errors.push(invalid("canvas-padding-invalid", "canvas.padding 必须为非负有限数"));
    }
    if (!isRecord(c.grid)) {
      errors.push(invalid("canvas-grid-invalid", "canvas.grid 不是对象"));
    } else {
      if (typeof c.grid.visible !== "boolean" || typeof c.grid.snap !== "boolean") {
        errors.push(invalid("canvas-grid-invalid", "canvas.grid.visible/snap 必须是布尔值"));
      }
      if (!isPositiveNumber(c.grid.size)) {
        errors.push(invalid("canvas-grid-invalid", "canvas.grid.size 必须为正数"));
      }
    }
  }

  // layout
  if (doc.layout !== undefined) {
    if (!isRecord(doc.layout) || (doc.layout.direction !== "TB" && doc.layout.direction !== "LR")) {
      errors.push(invalid("layout-invalid", "layout.direction 必须是 TB 或 LR"));
    }
  }

  // elements
  const elementIds = new Set<string>();
  const elementTypes = new Map<string, string>();
  if (!Array.isArray(doc.elements)) {
    errors.push(invalid("elements-not-array", "elements 不是数组"));
  } else {
    if (doc.elements.length > DIAGRAM_LIMITS.maxElements) {
      errors.push(invalid("elements-too-many", `elements 超过上限 ${DIAGRAM_LIMITS.maxElements}`));
    }
    doc.elements.forEach((raw, i) => {
      const ctx = `elements[${i}]`;
      if (!isRecord(raw)) {
        errors.push(invalid("element-not-object", `${ctx} 不是对象`));
        return;
      }
      validateElementCommon(raw, ctx, errors);
      validateElementByType(raw, ctx, errors);
      if (isValidId(raw.id)) {
        if (elementIds.has(raw.id)) {
          errors.push(invalid("element-id-duplicate", `${ctx} id 重复：${raw.id}`));
        } else {
          elementIds.add(raw.id);
          elementTypes.set(raw.id, raw.type as string);
        }
      }
    });

    // parentId 引用、父先子后、循环检测
    const elementList: unknown[] = doc.elements;
    const indexOf = new Map<string, number>();
    elementList.forEach((raw, i) => {
      if (isRecord(raw) && isValidId(raw.id)) indexOf.set(raw.id, i);
    });
    elementList.forEach((raw, i) => {
      if (!isRecord(raw) || raw.parentId === undefined || !isValidId(raw.parentId)) return;
      const ctx = `elements[${i}]`;
      const parentId = raw.parentId;
      const parentType = elementTypes.get(parentId);
      if (parentType === undefined) {
        errors.push(invalid("element-parent-missing", `${ctx} parentId 指向不存在元素：${parentId}`));
        return;
      }
      if (!GROUPING_TYPES.has(parentType)) {
        errors.push(invalid("element-parent-not-group", `${ctx} parentId 必须指向 group/container`));
      }
      const parentIndex = indexOf.get(parentId);
      if (parentIndex !== undefined && parentIndex >= i) {
        errors.push(invalid("element-parent-order", `${ctx} 父元素必须排在子元素之前`));
      }
      // 深度与循环
      let depth = 0;
      let cursor: string | undefined = parentId;
      const seen = new Set<string>([raw.id as string]);
      while (cursor !== undefined) {
        if (seen.has(cursor)) {
          errors.push(invalid("element-parent-cycle", `${ctx} 存在父子循环`));
          break;
        }
        seen.add(cursor);
        depth++;
        if (depth > DIAGRAM_LIMITS.maxNestingDepth) {
          errors.push(invalid("element-nesting-too-deep", `${ctx} 嵌套深度超过 ${DIAGRAM_LIMITS.maxNestingDepth}`));
          break;
        }
        const parentRaw: unknown = elementList[indexOf.get(cursor) ?? -1];
        cursor = isRecord(parentRaw) && isValidId(parentRaw.parentId) ? parentRaw.parentId : undefined;
      }
    });
  }

  // assets
  const assetIds = new Set<string>();
  if (doc.assets !== undefined) {
    if (!Array.isArray(doc.assets)) {
      errors.push(invalid("assets-not-array", "assets 不是数组"));
    } else {
      if (doc.assets.length > DIAGRAM_LIMITS.maxAssets) {
        errors.push(invalid("assets-too-many", `assets 超过上限 ${DIAGRAM_LIMITS.maxAssets}`));
      }
      doc.assets.forEach((raw, i) => {
        const ctx = `assets[${i}]`;
        if (!isRecord(raw)) {
          errors.push(invalid("asset-not-object", `${ctx} 不是对象`));
          return;
        }
        if (!isValidId(raw.id)) {
          errors.push(invalid("asset-id-invalid", `${ctx} id 不合法`));
        } else if (assetIds.has(raw.id)) {
          errors.push(invalid("asset-id-duplicate", `${ctx} id 重复：${raw.id}`));
        } else {
          assetIds.add(raw.id);
        }
        if (!isValidAssetPath(raw.path)) {
          errors.push(invalid("asset-path-invalid", `${ctx} path 必须是相对路径且不含 ..`));
        }
        if (typeof raw.mime !== "string" || !raw.mime.startsWith("image/")) {
          errors.push(invalid("asset-mime-invalid", `${ctx} mime 必须是 image/*`));
        }
        if (raw.width !== undefined && !isPositiveNumber(raw.width)) {
          errors.push(invalid("asset-size-invalid", `${ctx} width 必须为正数`));
        }
        if (raw.height !== undefined && !isPositiveNumber(raw.height)) {
          errors.push(invalid("asset-size-invalid", `${ctx} height 必须为正数`));
        }
      });
    }
  }

  // image 元素的 assetId 必须存在
  if (Array.isArray(doc.elements) && doc.assets !== undefined && Array.isArray(doc.assets)) {
    doc.elements.forEach((raw, i) => {
      if (isRecord(raw) && raw.type === "image" && isValidId(raw.assetId) && !assetIds.has(raw.assetId)) {
        errors.push(invalid("image-asset-missing", `elements[${i}] assetId 指向不存在资产：${raw.assetId}`));
      }
    });
  } else if (Array.isArray(doc.elements)) {
    doc.elements.forEach((raw, i) => {
      if (isRecord(raw) && raw.type === "image" && isValidId(raw.assetId)) {
        errors.push(invalid("image-asset-missing", `elements[${i}] assetId 指向不存在资产：${raw.assetId}`));
      }
    });
  }

  // connectors
  if (!Array.isArray(doc.connectors)) {
    errors.push(invalid("connectors-not-array", "connectors 不是数组"));
  } else {
    if (doc.connectors.length > DIAGRAM_LIMITS.maxConnectors) {
      errors.push(invalid("connectors-too-many", `connectors 超过上限 ${DIAGRAM_LIMITS.maxConnectors}`));
    }
    const connectorIds = new Set<string>();
    doc.connectors.forEach((raw, i) => {
      const ctx = `connectors[${i}]`;
      if (!isRecord(raw)) {
        errors.push(invalid("connector-not-object", `${ctx} 不是对象`));
        return;
      }
      validateConnector(raw, ctx, errors);
      if (isValidId(raw.id)) {
        if (connectorIds.has(raw.id)) {
          errors.push(invalid("connector-id-duplicate", `${ctx} id 重复：${raw.id}`));
        } else {
          connectorIds.add(raw.id);
        }
      }
      // 端点元素引用必须存在
      for (const end of ["source", "target"] as const) {
        const ep = raw[end];
        if (isRecord(ep) && isValidId(ep.elementId) && !elementIds.has(ep.elementId)) {
          errors.push(invalid("connector-endpoint-missing", `${ctx} ${end} 指向不存在元素：${ep.elementId}`));
        }
      }
      // 不允许两端都引用同一元素（自环）
      const s = raw.source;
      const t = raw.target;
      if (
        isRecord(s) &&
        isRecord(t) &&
        isValidId(s.elementId) &&
        isValidId(t.elementId) &&
        s.elementId === t.elementId
      ) {
        errors.push(invalid("connector-self-loop", `${ctx} source 与 target 引用同一元素`));
      }
    });
  }

  // viewport
  if (doc.viewport !== undefined) {
    if (
      !isRecord(doc.viewport) ||
      !isFiniteNumber(doc.viewport.x) ||
      !isFiniteNumber(doc.viewport.y) ||
      !isFiniteNumber(doc.viewport.zoom)
    ) {
      errors.push(invalid("viewport-invalid", "viewport 字段不是有限数值"));
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// 规范化（调用前必须先通过 validateDiagramDocument）
// ---------------------------------------------------------------------------

function normPoint(p: DiagramPoint): DiagramPoint {
  return { x: p.x, y: p.y };
}

function normPaint(p: Paint): Paint {
  if (p.type === "none") return { type: "none" };
  if (p.type === "solid") return { type: "solid", color: p.color };
  return {
    type: "linear-gradient",
    angle: p.angle,
    stops: p.stops.map((s: ColorStop) => ({ offset: s.offset, color: s.color })),
  };
}

function normStroke(s: DiagramStroke): DiagramStroke {
  return { color: s.color, width: s.width, style: s.style };
}

function normTextStylePatch(raw: unknown): Partial<DiagramTextStyle> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Partial<DiagramTextStyle> = {};
  if (typeof raw.fontFamily === "string") out.fontFamily = raw.fontFamily;
  if (isPositiveNumber(raw.fontSize)) out.fontSize = raw.fontSize;
  if (raw.fontWeight === 400 || raw.fontWeight === 500 || raw.fontWeight === 600 || raw.fontWeight === 700) {
    out.fontWeight = raw.fontWeight;
  }
  if (typeof raw.italic === "boolean") out.italic = raw.italic;
  if (typeof raw.underline === "boolean") out.underline = raw.underline;
  if (typeof raw.color === "string") out.color = raw.color;
  if (raw.align === "left" || raw.align === "center" || raw.align === "right") out.align = raw.align;
  if (raw.verticalAlign === "top" || raw.verticalAlign === "middle" || raw.verticalAlign === "bottom") {
    out.verticalAlign = raw.verticalAlign;
  }
  if (isPositiveNumber(raw.lineHeight)) out.lineHeight = raw.lineHeight;
  return Object.keys(out).length === 0 ? undefined : out;
}

function normTextBlock(b: DiagramTextBlock): DiagramTextBlock {
  const out: DiagramTextBlock = { id: b.id, kind: b.kind, text: b.text };
  if (b.level !== undefined) out.level = b.level;
  const style = normTextStylePatch(b.style);
  if (style) out.style = style;
  return out;
}

function normSemantic(raw: unknown): DiagramSemanticData | undefined {
  if (!isRecord(raw)) return undefined;
  const out: DiagramSemanticData = {};
  for (const key of ["role", "description", "technology", "protocol", "cardinality", "event", "guard", "action", "kind"] as const) {
    if (typeof raw[key] === "string") (out as Record<string, string>)[key] = raw[key] as string;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function normElementBase(raw: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    id: raw.id,
    type: raw.type,
    position: normPoint(raw.position as DiagramPoint),
    size: { width: (raw.size as { width: number }).width, height: (raw.size as { height: number }).height },
    rotation: raw.rotation,
    zIndex: raw.zIndex,
  };
  if (isValidId(raw.parentId)) base.parentId = raw.parentId;
  if (typeof raw.locked === "boolean") base.locked = raw.locked;
  if (typeof raw.hidden === "boolean") base.hidden = raw.hidden;
  if (isFiniteNumber(raw.opacity)) base.opacity = raw.opacity;
  const semantic = normSemantic(raw.semantic);
  if (semantic) base.semantic = semantic;
  return base;
}

function normElement(raw: Record<string, unknown>): DiagramElement {
  const base = normElementBase(raw);
  switch (raw.type) {
    case "shape": {
      const el: Record<string, unknown> = {
        ...base,
        shapeKind: raw.shapeKind,
        fill: normPaint(raw.fill as Paint),
        textBlocks: (raw.textBlocks as DiagramTextBlock[]).map(normTextBlock),
      };
      if (raw.stroke) el.stroke = normStroke(raw.stroke as DiagramStroke);
      if (isFiniteNumber(raw.cornerRadius)) el.cornerRadius = raw.cornerRadius;
      if (raw.shadow) {
        const s = raw.shadow as DiagramShadow;
        el.shadow = { color: s.color, offsetX: s.offsetX, offsetY: s.offsetY, blur: s.blur };
      }
      const ts = normTextStylePatch(raw.textStyle);
      if (ts) el.textStyle = ts;
      return el as unknown as DiagramElement;
    }
    case "text": {
      const el: Record<string, unknown> = {
        ...base,
        textBlocks: (raw.textBlocks as DiagramTextBlock[]).map(normTextBlock),
      };
      const ts = normTextStylePatch(raw.textStyle);
      if (ts) el.textStyle = ts;
      return el as unknown as DiagramElement;
    }
    case "icon": {
      const ref = raw.iconRef as IconRef;
      const iconRef: IconRef = { library: ref.library, name: ref.name };
      if (ref.variant) iconRef.variant = ref.variant;
      const el: Record<string, unknown> = { ...base, iconRef, fit: raw.fit };
      if (typeof raw.color === "string") el.color = raw.color;
      return el as unknown as DiagramElement;
    }
    case "image": {
      const el: Record<string, unknown> = { ...base, assetId: raw.assetId, fit: raw.fit };
      if (isRecord(raw.crop)) {
        el.crop = {
          x: raw.crop.x,
          y: raw.crop.y,
          width: raw.crop.width,
          height: raw.crop.height,
        };
      }
      if (typeof raw.alt === "string") el.alt = raw.alt;
      return el as unknown as DiagramElement;
    }
    case "group": {
      const el: Record<string, unknown> = { ...base };
      if (typeof raw.title === "string") el.title = raw.title;
      if (raw.background) el.background = normPaint(raw.background as Paint);
      return el as unknown as DiagramElement;
    }
    case "container": {
      const el: Record<string, unknown> = {
        ...base,
        containerRole: raw.containerRole,
        title: raw.title,
        padding: raw.padding,
      };
      if (raw.background) el.background = normPaint(raw.background as Paint);
      if (raw.stroke) el.stroke = normStroke(raw.stroke as DiagramStroke);
      return el as unknown as DiagramElement;
    }
    case "brace": {
      return {
        ...base,
        braceKind: raw.braceKind,
        orientation: raw.orientation,
        stroke: normStroke(raw.stroke as DiagramStroke),
      } as unknown as DiagramElement;
    }
    case "table": {
      const sections = (raw.sections as Array<Record<string, unknown>>).map((s) => {
        const section: DiagramTableSection = {
          id: s.id as string,
          kind: s.kind as "header" | "body",
          rows: (s.rows as Array<Record<string, unknown>>).map((r) => {
            const row: DiagramTableRow = {
              id: r.id as string,
              cells: (r.cells as Array<Record<string, unknown>>).map((c) => {
                const cell: DiagramTableCell = { id: c.id as string, text: c.text as string };
                const cs = normTextStylePatch(c.style);
                if (cs) cell.style = cs;
                return cell;
              }),
            };
            return row;
          }),
        };
        return section;
      });
      return {
        ...base,
        sections,
        columnWidths: (raw.columnWidths as number[]).slice(),
      } as unknown as DiagramElement;
    }
    case "lifeline": {
      const el: Record<string, unknown> = { ...base, title: raw.title };
      if (typeof raw.participantRole === "string") el.participantRole = raw.participantRole;
      return el as unknown as DiagramElement;
    }
    case "activation": {
      return { ...base, lifelineId: raw.lifelineId } as unknown as DiagramElement;
    }
    case "freehand": {
      const el: Record<string, unknown> = {
        ...base,
        points: (raw.points as FreehandPoint[]).map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })),
        drawingTool: raw.drawingTool,
        color: raw.color,
        strokeWidth: raw.strokeWidth,
      };
      if (typeof raw.path === "string") el.path = raw.path;
      return el as unknown as DiagramElement;
    }
    default:
      throw new Error(`unknown element type: ${String(raw.type)}`);
  }
}

function normEndpoint(raw: unknown): DiagramEndpoint {
  const ep = raw as Record<string, unknown>;
  const out: DiagramEndpoint = {};
  if (isValidId(ep.elementId)) out.elementId = ep.elementId;
  if (isValidId(ep.portId)) out.portId = ep.portId;
  if (isValidPoint(ep.point)) out.point = normPoint(ep.point);
  return out;
}

function normConnector(raw: Record<string, unknown>): DiagramConnector {
  const out: DiagramConnector = {
    id: raw.id as string,
    source: normEndpoint(raw.source),
    target: normEndpoint(raw.target),
    route: raw.route as DiagramConnector["route"],
    markerStart: raw.markerStart as EndpointMarker,
    markerEnd: raw.markerEnd as EndpointMarker,
    stroke: normStroke(raw.stroke as DiagramStroke),
    zIndex: raw.zIndex as number,
  };
  if (Array.isArray(raw.waypoints)) {
    out.waypoints = (raw.waypoints as DiagramPoint[]).map(normPoint);
  }
  if (Array.isArray(raw.label)) {
    out.label = (raw.label as DiagramTextBlock[]).map(normTextBlock);
  }
  const semantic = normSemantic(raw.semantic);
  if (semantic) out.semantic = semantic;
  return out;
}

/** 规范化已校验文档：去除未声明字段、规范字段顺序。 */
export function normalizeDiagramDocument(input: unknown): DiagramDocument {
  const raw = input as Record<string, unknown>;
  const canvasRaw = raw.canvas as Record<string, unknown>;
  const gridRaw = canvasRaw.grid as Record<string, unknown>;
  const canvas: DiagramCanvasSettings = {
    mode: canvasRaw.mode as "infinite" | "page",
    background: normPaint(canvasRaw.background as Paint),
    padding: canvasRaw.padding as number,
    grid: {
      visible: gridRaw.visible as boolean,
      snap: gridRaw.snap as boolean,
      size: gridRaw.size as number,
    },
  };
  if (isPositiveNumber(canvasRaw.width)) canvas.width = canvasRaw.width;
  if (isPositiveNumber(canvasRaw.height)) canvas.height = canvasRaw.height;
  if (canvasRaw.orientation === "portrait" || canvasRaw.orientation === "landscape") {
    canvas.orientation = canvasRaw.orientation;
  }

  const doc: DiagramDocument = {
    version: DIAGRAM_DOCUMENT_VERSION,
    capabilityVersion: raw.capabilityVersion as number,
    diagramKind: raw.diagramKind as DiagramKind,
    canvas,
    elements: (raw.elements as Array<Record<string, unknown>>).map(normElement),
    connectors: (raw.connectors as Array<Record<string, unknown>>).map(normConnector),
  };
  if (isRecord(raw.layout)) {
    doc.layout = { direction: raw.layout.direction as "TB" | "LR" };
  }
  if (Array.isArray(raw.assets)) {
    doc.assets = (raw.assets as Array<Record<string, unknown>>).map((a) => {
      const asset: DiagramAssetRef = { id: a.id as string, path: a.path as string, mime: a.mime as string };
      if (isPositiveNumber(a.width)) asset.width = a.width;
      if (isPositiveNumber(a.height)) asset.height = a.height;
      return asset;
    });
  }
  if (isRecord(raw.viewport)) {
    const v = raw.viewport as unknown as DiagramViewport;
    doc.viewport = { x: v.x, y: v.y, zoom: v.zoom };
  }
  return doc;
}

/** 深拷贝 DiagramDocument。 */
export function cloneDiagramDocument(doc: DiagramDocument): DiagramDocument {
  return normalizeDiagramDocument(JSON.parse(JSON.stringify(doc)));
}
