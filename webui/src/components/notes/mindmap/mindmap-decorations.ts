/**
 * 思维导图地图级装饰数据（arrows / summaries / boundaries）的读写与校验。
 *
 * 装饰数据存储在根节点的 `metadata.monaMap` 中，与节点元数据一起序列化到
 * Markdown 行末注释 `<!-- mona:mindmap-v1 {...} -->`。详见 mindmap-outline.ts。
 *
 * 设计原则：
 * - 装饰数据以稳定节点 ID 为引用基础，不保存像素坐标或兄弟索引；
 * - 加载时严格校验，丢弃非法记录但不阻塞导图主体打开；
 * - 节点删除后自动清理引用失效的装饰。
 */

import type { MindMapNode } from "./mindmap-outline";

/**
 * Mind Elixir 原生 Arrow 的结构类型（与 mind-elixir/dist/types/arrow.d.ts 兼容）。
 * 不直接从 mind-elixir 内部路径导入，避免版本升级失效。
 */
export interface MindElixirArrow {
  id: string;
  label: string;
  from: string;
  to: string;
  delta1?: { x: number; y: number };
  delta2?: { x: number; y: number };
  bidirectional?: boolean;
  style?: {
    stroke?: string;
    strokeWidth?: string | number;
    strokeDasharray?: string;
    strokeLinecap?: "butt" | "round" | "square";
    opacity?: string | number;
    labelColor?: string;
  };
  metadata?: unknown;
}

/** 装饰数据版本号。结构变更时递增。 */
export const MONA_MAP_VERSION = 1;
/** 根节点 metadata 中存储装饰数据的保留键。 */
export const MONA_MAP_KEY = "monaMap";

// ============================================================
// 类型定义
// ============================================================

/** 联系（Arrow）的持久化形式，只保留有效字段。 */
export interface StoredArrow {
  id: string;
  label: string;
  from: string;
  to: string;
  delta1: { x: number; y: number };
  delta2: { x: number; y: number };
  bidirectional?: boolean;
  style?: {
    stroke?: string;
    strokeWidth?: string | number;
    labelColor?: string;
  };
}

/** 概要（Summary）的持久化形式，使用稳定节点 ID 而非兄弟索引。 */
export interface StoredSummary {
  id: string;
  label: string;
  nodeIds: string[];
  style?: {
    stroke?: string;
    labelColor?: string;
  };
}

/** 外框（Boundary）的持久化形式，只保存节点 ID。 */
export interface StoredBoundary {
  id: string;
  nodeIds: string[];
}

export type BoundaryLinkEndpoint =
  | { kind: "node"; id: string }
  | { kind: "boundary"; id: string };

/** Mona 自绘的外框—节点联系。节点—节点联系仍使用 Mind Elixir 原生 Arrow。 */
export interface StoredBoundaryLink {
  id: string;
  label: string;
  from: BoundaryLinkEndpoint;
  to: BoundaryLinkEndpoint;
  delta1?: { x: number; y: number };
  delta2?: { x: number; y: number };
}

/** 装饰数据容器。 */
export interface MonaMapDecorations {
  version: number;
  arrows: StoredArrow[];
  summaries: StoredSummary[];
  boundaries: StoredBoundary[];
  boundaryLinks: StoredBoundaryLink[];
}

export const EMPTY_DECORATIONS: MonaMapDecorations = {
  version: MONA_MAP_VERSION,
  arrows: [],
  summaries: [],
  boundaries: [],
  boundaryLinks: [],
};

// ============================================================
// 读取与写入
// ============================================================

/**
 * 从根节点读取装饰数据。根节点不存在或无 monaMap 时返回空装饰。
 * 非法数据不抛错，降级为空装饰。
 */
export function readDecorations(root: MindMapNode): MonaMapDecorations {
  const raw = root.metadata?.[MONA_MAP_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_DECORATIONS };
  }
  return sanitizeDecorations(root, raw as Record<string, unknown>);
}

/**
 * 把装饰数据写回根节点的 metadata。原对象不可变，返回新根节点。
 */
export function writeDecorations(
  root: MindMapNode,
  decorations: MonaMapDecorations,
): MindMapNode {
  const next: MindMapNode = {
    ...root,
    metadata: {
      ...root.metadata,
      [MONA_MAP_KEY]: {
        version: MONA_MAP_VERSION,
        arrows: decorations.arrows,
        summaries: decorations.summaries,
        boundaries: decorations.boundaries,
        boundaryLinks: decorations.boundaryLinks,
      },
    },
  };
  return next;
}

// ============================================================
// 校验
// ============================================================

/** 收集树中所有节点 ID。 */
export function collectAllNodeIds(root: MindMapNode): Set<string> {
  const ids = new Set<string>();
  const walk = (node: MindMapNode) => {
    ids.add(node.id);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return ids;
}

/** 按节点 ID 查找节点对象。 */
export function findNodeById<T extends { id: string; children?: T[] }>(
  root: T,
  id: string,
): T | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

/** 查找节点的父节点（返回 null 表示根节点无父）。 */
export function findParent<T extends { id: string; children?: T[] }>(
  root: T,
  id: string,
): T | null {
  const walk = (node: T): T | null => {
    for (const child of node.children ?? []) {
      if (child.id === id) return node;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

/**
 * 校验并清洗从 Markdown 加载的装饰数据。
 * 丢弃缺字段、引用不存在节点、选区无效的记录，但不抛错。
 */
export function sanitizeDecorations(
  root: MindMapNode,
  raw: Record<string, unknown>,
): MonaMapDecorations {
  const validIds = collectAllNodeIds(root);
  const result: MonaMapDecorations = { ...EMPTY_DECORATIONS };

  // 版本必须为 1
  if (raw.version !== MONA_MAP_VERSION) {
    return result;
  }

  // arrows
  if (Array.isArray(raw.arrows)) {
    result.arrows = raw.arrows
      .map((a) => sanitizeArrow(a, validIds))
      .filter((a): a is StoredArrow => a !== null);
  }

  // summaries
  if (Array.isArray(raw.summaries)) {
    result.summaries = raw.summaries
      .map((s) => sanitizeSummary(s, validIds))
      .filter((s): s is StoredSummary => s !== null);
  }

  // boundaries
  if (Array.isArray(raw.boundaries)) {
    result.boundaries = raw.boundaries
      .map((b) => sanitizeBoundary(b, validIds))
      .filter((b): b is StoredBoundary => b !== null);
  }

  if (Array.isArray(raw.boundaryLinks)) {
    const validBoundaryIds = new Set(result.boundaries.map((b) => b.id));
    result.boundaryLinks = raw.boundaryLinks
      .map((link) => sanitizeBoundaryLink(link, validIds, validBoundaryIds))
      .filter((link): link is StoredBoundaryLink => link !== null);
  }

  return result;
}

function sanitizeArrow(
  raw: unknown,
  validIds: Set<string>,
): StoredArrow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id) return null;
  if (typeof a.from !== "string" || !validIds.has(a.from)) return null;
  if (typeof a.to !== "string" || !validIds.has(a.to)) return null;
  if (a.from === a.to) return null;
  const delta1 = sanitizeDelta(a.delta1);
  const delta2 = sanitizeDelta(a.delta2);
  if (!delta1 || !delta2) return null;
  const stored: StoredArrow = {
    id: a.id,
    label: typeof a.label === "string" ? a.label : "",
    from: a.from,
    to: a.to,
    delta1,
    delta2,
  };
  if (a.bidirectional === true) stored.bidirectional = true;
  if (a.style && typeof a.style === "object" && !Array.isArray(a.style)) {
    const s = a.style as Record<string, unknown>;
    const style: NonNullable<StoredArrow["style"]> = {};
    if (typeof s.stroke === "string") style.stroke = s.stroke;
    if (typeof s.strokeWidth === "string" || typeof s.strokeWidth === "number") {
      style.strokeWidth = s.strokeWidth;
    }
    if (typeof s.labelColor === "string") style.labelColor = s.labelColor;
    if (Object.keys(style).length > 0) stored.style = style;
  }
  return stored;
}

function sanitizeDelta(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.x !== "number" || typeof d.y !== "number") return null;
  return { x: d.x, y: d.y };
}

function sanitizeSummary(
  raw: unknown,
  validIds: Set<string>,
): StoredSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id) return null;
  if (!Array.isArray(s.nodeIds) || s.nodeIds.length === 0) return null;
  const nodeIds = s.nodeIds.filter(
    (id): id is string => typeof id === "string" && validIds.has(id),
  );
  if (nodeIds.length === 0) return null;
  const stored: StoredSummary = {
    id: s.id,
    label: typeof s.label === "string" ? s.label : "",
    nodeIds,
  };
  if (s.style && typeof s.style === "object" && !Array.isArray(s.style)) {
    const st = s.style as Record<string, unknown>;
    const style: NonNullable<StoredSummary["style"]> = {};
    if (typeof st.stroke === "string") style.stroke = st.stroke;
    if (typeof st.labelColor === "string") style.labelColor = st.labelColor;
    if (Object.keys(style).length > 0) stored.style = style;
  }
  return stored;
}

function sanitizeBoundary(
  raw: unknown,
  validIds: Set<string>,
): StoredBoundary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string" || !b.id) return null;
  if (!Array.isArray(b.nodeIds) || b.nodeIds.length === 0) return null;
  const nodeIds = b.nodeIds.filter(
    (id): id is string => typeof id === "string" && validIds.has(id),
  );
  if (nodeIds.length === 0) return null;
  return { id: b.id, nodeIds };
}

function sanitizeBoundaryLink(
  raw: unknown,
  validNodeIds: Set<string>,
  validBoundaryIds: Set<string>,
): StoredBoundaryLink | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const link = raw as Record<string, unknown>;
  if (typeof link.id !== "string" || !link.id) return null;
  const from = sanitizeBoundaryLinkEndpoint(link.from, validNodeIds, validBoundaryIds);
  const to = sanitizeBoundaryLinkEndpoint(link.to, validNodeIds, validBoundaryIds);
  if (!from || !to || from.kind === to.kind) return null;
  const stored: StoredBoundaryLink = {
    id: link.id,
    label: typeof link.label === "string" ? link.label : "",
    from,
    to,
  };
  const delta1 = sanitizeDelta(link.delta1);
  const delta2 = sanitizeDelta(link.delta2);
  if (delta1) stored.delta1 = delta1;
  if (delta2) stored.delta2 = delta2;
  return stored;
}

function sanitizeBoundaryLinkEndpoint(
  raw: unknown,
  validNodeIds: Set<string>,
  validBoundaryIds: Set<string>,
): BoundaryLinkEndpoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const endpoint = raw as Record<string, unknown>;
  if (typeof endpoint.id !== "string") return null;
  if (endpoint.kind === "node" && validNodeIds.has(endpoint.id)) {
    return { kind: "node", id: endpoint.id };
  }
  if (endpoint.kind === "boundary" && validBoundaryIds.has(endpoint.id)) {
    return { kind: "boundary", id: endpoint.id };
  }
  return null;
}

// ============================================================
// 选区校验
// ============================================================

export interface SelectionValidation {
  valid: boolean;
  /** 所有选中节点共有的父节点 ID，根节点选中时为 null。 */
  parentId: string | null;
  /** 选中节点在父节点 children 中的索引，按升序排列。 */
  indices: number[];
  /** 选中节点是否连续。 */
  continuous: boolean;
  /** 是否包含根节点。 */
  includesRoot: boolean;
}

export interface SelectionGroup {
  parentId: string;
  nodeIds: string[];
  start: number;
  end: number;
}

/**
 * 按 XMind 的规则把选区拆成可创建外框/概要的分组：
 * - 同一父节点下的主题合并为一组；
 * - 不同分支分别创建；
 * - 同组非连续选择会扩展为首尾之间的完整范围；
 * - 根节点和不存在的节点忽略。
 */
export function groupSelectionByBranch(
  nodeIds: string[],
  root: MindMapNode,
): SelectionGroup[] {
  const grouped = new Map<string, { parent: MindMapNode; indices: number[] }>();
  const seen = new Set<string>();

  for (const id of nodeIds) {
    if (id === root.id || seen.has(id)) continue;
    seen.add(id);
    const parent = findParent(root, id);
    if (!parent) continue;
    const index = parent.children.findIndex((child) => child.id === id);
    if (index < 0) continue;
    const entry = grouped.get(parent.id);
    if (entry) {
      entry.indices.push(index);
    } else {
      grouped.set(parent.id, { parent, indices: [index] });
    }
  }

  return [...grouped.entries()].map(([parentId, { parent, indices }]) => {
    const start = Math.min(...indices);
    const end = Math.max(...indices);
    return {
      parentId,
      start,
      end,
      nodeIds: parent.children.slice(start, end + 1).map((node) => node.id),
    };
  });
}

/**
 * 校验一组节点 ID 是否可以用于创建概要或外框。
 * 规则：
 * - 不允许选中根节点；
 * - 所有选中节点必须属于同一个父节点；
 * - 选中节点在父节点 children 中必须连续（首版要求严格连续）。
 */
export function validateSelection(
  nodeIds: string[],
  root: MindMapNode,
): SelectionValidation {
  const result: SelectionValidation = {
    valid: false,
    parentId: null,
    indices: [],
    continuous: false,
    includesRoot: false,
  };
  if (nodeIds.length === 0) return result;
  if (nodeIds.includes(root.id)) {
    result.includesRoot = true;
    return result;
  }

  // 查找每个节点的父节点
  const parentMap = new Map<string, string>(); // nodeId -> parentId
  for (const id of nodeIds) {
    const parent = findParent(root, id);
    if (!parent) return result; // 节点不存在
    parentMap.set(id, parent.id);
  }

  // 必须同一父节点
  const parentIds = new Set(parentMap.values());
  if (parentIds.size !== 1) return result;
  const parentId = parentMap.values().next().value as string;
  const parent = findNodeById(root, parentId);
  if (!parent || !parent.children) return result;

  // 计算索引
  const indices: number[] = [];
  for (const id of nodeIds) {
    const idx = parent.children.findIndex((c) => c.id === id);
    if (idx < 0) return result;
    indices.push(idx);
  }
  indices.sort((a, b) => a - b);

  // 检查连续
  let continuous = true;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      continuous = false;
      break;
    }
  }

  result.parentId = parentId;
  result.indices = indices;
  result.continuous = continuous;
  result.valid = continuous;
  return result;
}

/**
 * 把 StoredSummary 转换为 Mind Elixir 原生 Summary 所需的 { parent, start, end }。
 * 节点移动后索引变化时，根据 nodeIds 重新计算。
 * 返回 null 表示选区已失效（节点不存在、跨父级或不连续）。
 */
export function summaryToNativeRange(
  summary: StoredSummary,
  root: MindMapNode,
): { parent: string; start: number; end: number } | null {
  const v = validateSelection(summary.nodeIds, root);
  if (!v.valid || !v.parentId || v.indices.length === 0) return null;
  return {
    parent: v.parentId,
    start: v.indices[0],
    end: v.indices[v.indices.length - 1],
  };
}

// ============================================================
// Mind Elixir 原生数据转换
// ============================================================

/**
 * 把 StoredArrow 转换为 Mind Elixir 原生 Arrow 对象。
 */
export function storedArrowToNative(arrow: StoredArrow): MindElixirArrow {
  return {
    id: arrow.id,
    label: arrow.label,
    from: arrow.from,
    to: arrow.to,
    delta1: arrow.delta1,
    delta2: arrow.delta2,
    bidirectional: arrow.bidirectional,
    style: arrow.style,
  };
}

/**
 * 把 Mind Elixir 原生 Arrow 转换为 StoredArrow。
 */
export function nativeArrowToStored(arrow: MindElixirArrow): StoredArrow {
  const stored: StoredArrow = {
    id: arrow.id,
    label: arrow.label ?? "",
    from: arrow.from,
    to: arrow.to,
    delta1: arrow.delta1 ? { x: arrow.delta1.x, y: arrow.delta1.y } : { x: 0, y: 0 },
    delta2: arrow.delta2 ? { x: arrow.delta2.x, y: arrow.delta2.y } : { x: 0, y: 0 },
  };
  if (arrow.bidirectional) stored.bidirectional = true;
  if (arrow.style) {
    const style: NonNullable<StoredArrow["style"]> = {};
    if (arrow.style.stroke) style.stroke = arrow.style.stroke;
    if (arrow.style.strokeWidth !== undefined) style.strokeWidth = arrow.style.strokeWidth;
    if (arrow.style.labelColor) style.labelColor = arrow.style.labelColor;
    if (Object.keys(style).length > 0) stored.style = style;
  }
  return stored;
}

// ============================================================
// 引用清理
// ============================================================

/**
 * 清理所有引用失效节点的装饰数据。
 * 返回清理后的新对象；若无可清理则返回原对象。
 */
export function cleanupDanglingDecorations(
  decorations: MonaMapDecorations,
  root: MindMapNode,
): MonaMapDecorations {
  const validIds = collectAllNodeIds(root);
  let changed = false;

  const arrows = decorations.arrows.filter((a) => {
    const ok = validIds.has(a.from) && validIds.has(a.to) && a.from !== a.to;
    if (!ok) changed = true;
    return ok;
  });

  // summaries：丢弃全部失效的记录，部分失效的更新 nodeIds
  const summaries: StoredSummary[] = [];
  for (const s of decorations.summaries) {
    const valid = s.nodeIds.filter((id) => validIds.has(id));
    if (valid.length === 0) {
      changed = true;
      continue;
    }
    if (valid.length !== s.nodeIds.length) {
      changed = true;
      summaries.push({ ...s, nodeIds: valid });
    } else {
      summaries.push(s);
    }
  }

  // boundaries：丢弃全部失效的记录，部分失效的更新 nodeIds
  const boundaries: StoredBoundary[] = [];
  for (const b of decorations.boundaries) {
    const valid = b.nodeIds.filter((id) => validIds.has(id));
    if (valid.length === 0) {
      changed = true;
      continue;
    }
    if (valid.length !== b.nodeIds.length) {
      changed = true;
      boundaries.push({ ...b, nodeIds: valid });
    } else {
      boundaries.push(b);
    }
  }

  const validBoundaryIds = new Set(boundaries.map((b) => b.id));
  const boundaryLinks = decorations.boundaryLinks.filter((link) => {
    const endpointExists = (endpoint: BoundaryLinkEndpoint) =>
      endpoint.kind === "node"
        ? validIds.has(endpoint.id)
        : validBoundaryIds.has(endpoint.id);
    const ok =
      link.from.kind !== link.to.kind &&
      endpointExists(link.from) &&
      endpointExists(link.to);
    if (!ok) changed = true;
    return ok;
  });

  if (!changed) return decorations;
  return { ...decorations, arrows, summaries, boundaries, boundaryLinks };
}

// ============================================================
// ID 生成
// ============================================================

/** 生成装饰数据 ID（与节点 ID 体系独立，加前缀便于调试）。 */
export function generateDecorationId(
  prefix: "arrow" | "summary" | "boundary" | "boundary-link",
): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}
