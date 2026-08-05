/**
 * 图表文档哈希。
 *
 * 规范（见计划 §9.2）：
 * - 语义哈希：只含内容与连接关系（类型、文本、语义、端点引用），用于 AI 语义上下文；
 * - 完整文档哈希：含位置、尺寸、样式、图层、页面等全部字段，用于 Agent 视觉 patch
 *   的 stale 检测——任何中心文档变化都会使视觉 patch 过期；
 * - 两者均与数组原始顺序、JSON 格式无关。
 */

import type {
  DiagramConnector,
  DiagramDocument,
  DiagramElement,
  DiagramEndpoint,
} from "./diagram-document";
import { cloneDiagramDocument } from "./diagram-validator";

// ---------------------------------------------------------------------------
// 语义投影提取
// ---------------------------------------------------------------------------

/** 语义投影：必含 id，其余字段随元素类型变化。 */
type SemanticProjection = Record<string, unknown> & { id: string };

/** 提取元素的语义内容（文本 + 语义字段），不含几何与样式。 */
function semanticOfElement(el: DiagramElement): SemanticProjection {
  const out: SemanticProjection = { id: el.id, type: el.type };
  if (el.semantic) out.semantic = sortObject(el.semantic);
  switch (el.type) {
    case "shape":
      out.shapeKind = el.shapeKind;
      out.text = el.textBlocks.map((b) => ({ kind: b.kind, text: b.text }));
      break;
    case "text":
      out.text = el.textBlocks.map((b) => ({ kind: b.kind, text: b.text }));
      break;
    case "icon":
      out.iconRef = el.iconRef;
      break;
    case "image":
      out.assetId = el.assetId;
      if (el.alt) out.alt = el.alt;
      break;
    case "group":
      if (el.title !== undefined) out.title = el.title;
      break;
    case "container":
      out.containerRole = el.containerRole;
      out.title = el.title;
      break;
    case "brace":
      out.braceKind = el.braceKind;
      out.orientation = el.orientation;
      break;
    case "table":
      out.sections = el.sections.map((s) => ({
        kind: s.kind,
        rows: s.rows.map((r) => r.cells.map((c) => c.text)),
      }));
      break;
    case "lifeline":
      out.title = el.title;
      if (el.participantRole) out.participantRole = el.participantRole;
      break;
    case "activation":
      out.lifelineId = el.lifelineId;
      break;
    case "freehand":
      out.drawingTool = el.drawingTool;
      break;
  }
  if (el.parentId) out.parentId = el.parentId;
  return out;
}

function semanticOfEndpoint(ep: DiagramEndpoint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ep.elementId) out.elementId = ep.elementId;
  if (ep.point) out.point = ep.point;
  return out;
}

function semanticOfConnector(c: DiagramConnector): SemanticProjection {
  const out: SemanticProjection = {
    id: c.id,
    source: semanticOfEndpoint(c.source),
    target: semanticOfEndpoint(c.target),
  };
  if (c.label) out.label = c.label.map((b) => ({ kind: b.kind, text: b.text }));
  if (c.semantic) out.semantic = sortObject(c.semantic);
  return out;
}

/** 递归按键排序对象，保证序列化稳定。 */
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortObject(v);
    return out;
  }
  return value;
}

/** 语义哈希：内容与连接关系变化时变化；移动、缩放、改样式不影响。 */
export function computeDiagramSemanticHash(doc: DiagramDocument): string {
  const elements = doc.elements.map(semanticOfElement).sort(byId);
  const connectors = doc.connectors.map(semanticOfConnector).sort(byId);
  const canonical = {
    version: doc.version,
    diagramKind: doc.diagramKind,
    layout: doc.layout ?? null,
    elements,
    connectors,
  };
  return `s${cyrb53a(JSON.stringify(canonical)).toString(16).padStart(14, "0")}`;
}

/** 完整文档哈希：任何字段变化（含视觉）都会变化，用于 Agent patch stale 检测。 */
export function computeDiagramDocumentHash(doc: DiagramDocument): string {
  const normalized = cloneDiagramDocument(doc);
  const canonical = {
    ...normalized,
    elements: [...normalized.elements].sort(byId),
    connectors: [...normalized.connectors].sort(byId),
    assets: normalized.assets ? [...normalized.assets].sort(byId) : undefined,
    viewport: undefined, // viewport 是查看状态，不属于文档内容
  };
  return `d${cyrb53a(JSON.stringify(sortObject(canonical))).toString(16).padStart(14, "0")}`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * cyrb53a：53 位非密码学字符串哈希。
 * 参考：https://github.com/bryc/code/blob/master/jshash/PRNGs.md
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
