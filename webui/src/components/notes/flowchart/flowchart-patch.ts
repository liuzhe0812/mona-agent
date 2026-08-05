/**
 * 流程图 AI patch 协议：解析、校验、原子应用和新节点分组放置。
 *
 * 规范（见 docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §9.6, §9.7, §8.3）：
 * 1. AI 只输出一种 ```mona-flowchart-patch fenced block，包含 baseHash 和 ops 数组；
 * 2. ops 类型：replaceGraph / addNode / updateNode / removeSubgraph / addEdge / updateEdge / removeEdge；
 * 3. replaceGraph 必须是唯一 op；
 * 4. removeSubgraph 必须显式列出待删节点和这些节点的全部关联边，不允许漏列、夹带或隐式级联；
 * 5. 不对 ops 自动排序，按 AI 声明顺序校验和执行；
 * 6. 任一 op 失败则整个 patch 不应用（原子性）；
 * 7. AI 不输出 position，新节点全部创建成功后统一执行局部放置；
 * 8. 局部放置：按新节点之间的边拆成弱连通分组，每组用 Dagre 局部布局；
 * 9. 共享同一现有锚点入边的新节点合并到同一分组（避免副轴错开过远）；
 * 10. 碰撞检测使用包围盒，沿副轴按 0、+1、-1、+2、-2... 网格间距确定性避让。
 */

import dagre from "@dagrejs/dagre";

import {
  cloneFlowchartDocument,
  computeFlowchartSemanticHash,
  extractFlowchartFence,
  FLOWCHART_NODE_KINDS,
  FLOWCHART_PATCH_FENCE_LANG,
  generateFlowchartEdgeId,
  generateFlowchartNodeId,
  validateFlowchartDocument,
  type FlowchartDocument,
  type FlowchartEdge,
  type FlowchartNode,
  type FlowchartNodeKind,
  type FlowchartSemanticGraph,
  type FlowchartSemanticNode,
} from "./flowchart-document";

// ---------------------------------------------------------------------------
// Patch 类型定义
// ---------------------------------------------------------------------------

export interface FlowchartPatch {
  baseHash: string;
  ops: FlowchartPatchOp[];
}

export type FlowchartPatchOp =
  | { name: "replaceGraph"; graph: FlowchartSemanticGraph }
  | { name: "addNode"; node: FlowchartSemanticNode }
  | {
      name: "updateNode";
      id: string;
      expectedLabel: string;
      patch: { kind?: FlowchartNodeKind; label?: string };
    }
  | {
      name: "removeSubgraph";
      nodes: Array<{ id: string; expectedLabel: string }>;
      edges: Array<{
        id: string;
        expected: { source: string; target: string; label?: string };
      }>;
    }
  | { name: "addEdge"; edge: FlowchartEdge }
  | {
      name: "updateEdge";
      id: string;
      expected: { source: string; target: string; label?: string };
      patch: { source?: string; target?: string; label?: string };
    }
  | {
      name: "removeEdge";
      id: string;
      expected: { source: string; target: string; label?: string };
    };

// ---------------------------------------------------------------------------
// 载荷上限（见 §7.1）
// ---------------------------------------------------------------------------

export const FLOWCHART_PATCH_MAX_OPS = 50;
export const FLOWCHART_PATCH_MAX_PAYLOAD_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Patch 解析
// ---------------------------------------------------------------------------

export type ParsePatchResult =
  | { ok: true; patch: FlowchartPatch }
  | { ok: false; message: string };

/**
 * 从 AI 回答文本中提取并解析最后一个 mona-flowchart-patch fenced block。
 * 找不到返回错误，不抛异常。
 */
export function parseFlowchartPatch(text: string): ParsePatchResult {
  const re = new RegExp("```" + FLOWCHART_PATCH_FENCE_LANG + "\\s*\\n([\\s\\S]*?)```", "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1].trim();
  }
  if (last === null) {
    return { ok: false, message: `AI 未返回 ${FLOWCHART_PATCH_FENCE_LANG} fenced block` };
  }

  if (last.length > FLOWCHART_PATCH_MAX_PAYLOAD_BYTES) {
    return { ok: false, message: `AI 返回的修改过大（${last.length} 字节），未应用` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (e) {
    return { ok: false, message: `AI 返回格式错误：${e instanceof Error ? e.message : String(e)}` };
  }

  return validatePatchShape(parsed);
}

/** 校验 patch 顶层结构（不校验 op 语义，语义校验在 apply 时进行）。 */
function validatePatchShape(input: unknown): ParsePatchResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "AI 返回未知或缺失字段：patch 不是对象" };
  }
  const p = input as Record<string, unknown>;
  if (typeof p.baseHash !== "string" || p.baseHash.length === 0) {
    return { ok: false, message: "AI 返回未知或缺失字段：baseHash 缺失" };
  }
  if (!Array.isArray(p.ops)) {
    return { ok: false, message: "AI 返回未知或缺失字段：ops 不是数组" };
  }
  if (p.ops.length > FLOWCHART_PATCH_MAX_OPS) {
    return { ok: false, message: `AI 返回的修改过大：ops 数量 ${p.ops.length} 超过上限 ${FLOWCHART_PATCH_MAX_OPS}` };
  }
  // 逐 op 形状校验
  for (let i = 0; i < p.ops.length; i++) {
    const r = validateOpShape(p.ops[i], i);
    if (r) return { ok: false, message: r };
  }
  // replaceGraph 必须是唯一 op
  const hasReplaceGraph = p.ops.some((op) => (op as { name?: string })?.name === "replaceGraph");
  if (hasReplaceGraph && p.ops.length > 1) {
    return { ok: false, message: "replaceGraph 必须是唯一 op，不能与其他 op 混用" };
  }
  return { ok: true, patch: p as unknown as FlowchartPatch };
}

function validateOpShape(raw: unknown, index: number): string | null {
  const ctx = `ops[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${ctx} 不是对象`;
  }
  const op = raw as Record<string, unknown>;
  switch (op.name) {
    case "replaceGraph":
      return validateSemanticGraph(op, ctx);
    case "addNode":
      return validateSemanticNode(op, "node", ctx);
    case "updateNode":
      if (typeof op.id !== "string") return `${ctx}.id 不是字符串`;
      if (typeof op.expectedLabel !== "string") return `${ctx}.expectedLabel 不是字符串`;
      if (typeof op.patch !== "object" || op.patch === null) return `${ctx}.patch 不是对象`;
      return null;
    case "removeSubgraph":
      if (!Array.isArray(op.nodes)) return `${ctx}.nodes 不是数组`;
      if (!Array.isArray(op.edges)) return `${ctx}.edges 不是数组`;
      return null;
    case "addEdge":
      return validateEdge(op, "edge", ctx);
    case "updateEdge":
    case "removeEdge":
      if (typeof op.id !== "string") return `${ctx}.id 不是字符串`;
      if (typeof op.expected !== "object" || op.expected === null) return `${ctx}.expected 不是对象`;
      if (op.name === "updateEdge" && (typeof op.patch !== "object" || op.patch === null)) {
        return `${ctx}.patch 不是对象`;
      }
      return null;
    default:
      return `${ctx} 未知 op name：${String(op.name)}`;
  }
}

function validateSemanticGraph(op: Record<string, unknown>, ctx: string): string | null {
  if (typeof op.graph !== "object" || op.graph === null) return `${ctx}.graph 不是对象`;
  const g = op.graph as Record<string, unknown>;
  if (g.direction !== "TB" && g.direction !== "LR") return `${ctx}.graph.direction 不合法`;
  if (!Array.isArray(g.nodes)) return `${ctx}.graph.nodes 不是数组`;
  if (!Array.isArray(g.edges)) return `${ctx}.graph.edges 不是数组`;
  return null;
}

function validateSemanticNode(op: Record<string, unknown>, key: string, ctx: string): string | null {
  if (typeof op[key] !== "object" || op[key] === null) return `${ctx}.${key} 不是对象`;
  const n = op[key] as Record<string, unknown>;
  if (typeof n.id !== "string") return `${ctx}.${key}.id 不是字符串`;
  if (!FLOWCHART_NODE_KINDS.includes(n.kind as FlowchartNodeKind)) {
    return `${ctx}.${key}.kind 不合法`;
  }
  if (typeof n.label !== "string") return `${ctx}.${key}.label 不是字符串`;
  return null;
}

function validateEdge(op: Record<string, unknown>, key: string, ctx: string): string | null {
  if (typeof op[key] !== "object" || op[key] === null) return `${ctx}.${key} 不是对象`;
  const e = op[key] as Record<string, unknown>;
  if (typeof e.id !== "string") return `${ctx}.${key}.id 不是字符串`;
  if (typeof e.source !== "string") return `${ctx}.${key}.source 不是字符串`;
  if (typeof e.target !== "string") return `${ctx}.${key}.target 不是字符串`;
  if (e.label !== undefined && typeof e.label !== "string") return `${ctx}.${key}.label 不是字符串`;
  return null;
}

// ---------------------------------------------------------------------------
// Patch 应用
// ---------------------------------------------------------------------------

export type ApplyPatchResult =
  | { ok: true; document: FlowchartDocument; summary: FlowchartPatchSummary }
  | { ok: false; message: string };

export interface FlowchartPatchSummary {
  addedNodes: number;
  updatedNodes: number;
  removedNodes: number;
  addedEdges: number;
  updatedEdges: number;
  removedEdges: number;
  replacedGraph: boolean;
}

/**
 * 在原文档副本上原子应用 patch。
 *
 * 步骤：
 * 1. 校验 baseHash 与当前文档语义哈希一致；
 * 2. 按 ops 顺序逐一校验 expected 并应用到副本；
 * 3. 任一 op 失败则整个 patch 不应用（返回原文档不变）；
 * 4. 新节点统一执行局部放置；
 * 5. 应用完成后再次执行完整文档校验。
 *
 * 调用方应在用户点击"应用"时对中心状态重新校验 baseHash，避免应用过期 patch。
 */
export function applyFlowchartPatch(
  doc: FlowchartDocument,
  patch: FlowchartPatch,
): ApplyPatchResult {
  const currentHash = computeFlowchartSemanticHash(doc);
  if (patch.baseHash !== currentHash) {
    return {
      ok: false,
      message: "AI 处理期间流程图已被修改，请重新生成",
    };
  }

  const work = cloneFlowchartDocument(doc);
  const summary: FlowchartPatchSummary = {
    addedNodes: 0,
    updatedNodes: 0,
    removedNodes: 0,
    addedEdges: 0,
    updatedEdges: 0,
    removedEdges: 0,
    replacedGraph: false,
  };

  const newNodeIds = new Set<string>();

  for (let i = 0; i < patch.ops.length; i++) {
    const op = patch.ops[i];
    const r = applyOp(work, op, newNodeIds, i);
    if (!r.ok) return r;
    accumulateSummary(summary, op);
  }

  // 新节点统一放置
  if (newNodeIds.size > 0) {
    placeNewNodes(work, newNodeIds);
  }

  // 完整文档校验
  const validation = validateFlowchartDocument(work);
  if (!validation.ok) {
    const detail = validation.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    return { ok: false, message: `修改会产生无效引用或重复 ID：${detail}` };
  }

  return { ok: true, document: work, summary };
}

function accumulateSummary(summary: FlowchartPatchSummary, op: FlowchartPatchOp): void {
  switch (op.name) {
    case "replaceGraph":
      summary.replacedGraph = true;
      break;
    case "addNode":
      summary.addedNodes++;
      break;
    case "updateNode":
      summary.updatedNodes++;
      break;
    case "removeSubgraph":
      summary.removedNodes += op.nodes.length;
      summary.removedEdges += op.edges.length;
      break;
    case "addEdge":
      summary.addedEdges++;
      break;
    case "updateEdge":
      summary.updatedEdges++;
      break;
    case "removeEdge":
      summary.removedEdges++;
      break;
  }
}

type OpResult = { ok: true } | { ok: false; message: string };

function applyOp(
  doc: FlowchartDocument,
  op: FlowchartPatchOp,
  newNodeIds: Set<string>,
  index: number,
): OpResult {
  const ctx = `ops[${index}]`;
  switch (op.name) {
    case "replaceGraph":
      return applyReplaceGraph(doc, op, ctx);
    case "addNode":
      return applyAddNode(doc, op, newNodeIds, ctx);
    case "updateNode":
      return applyUpdateNode(doc, op, ctx);
    case "removeSubgraph":
      return applyRemoveSubgraph(doc, op, ctx);
    case "addEdge":
      return applyAddEdge(doc, op, ctx);
    case "updateEdge":
      return applyUpdateEdge(doc, op, ctx);
    case "removeEdge":
      return applyRemoveEdge(doc, op, ctx);
  }
}

function applyReplaceGraph(
  doc: FlowchartDocument,
  op: { name: "replaceGraph"; graph: FlowchartSemanticGraph },
  ctx: string,
): OpResult {
  const graph = op.graph;
  // ID 唯一性校验
  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) return { ok: false, message: `${ctx}: 节点 id 重复 ${n.id}` };
    nodeIds.add(n.id);
  }
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) return { ok: false, message: `${ctx}: 边 id 重复 ${e.id}` };
    edgeIds.add(e.id);
    if (!nodeIds.has(e.source)) return { ok: false, message: `${ctx}: 边 source 指向不存在节点 ${e.source}` };
    if (!nodeIds.has(e.target)) return { ok: false, message: `${ctx}: 边 target 指向不存在节点 ${e.target}` };
    if (e.source === e.target) return { ok: false, message: `${ctx}: 自环边 ${e.source}` };
  }
  // 全量替换，使用 Dagre 布局
  doc.direction = graph.direction;
  doc.nodes = graph.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    position: { x: 0, y: 0 },
  }));
  doc.edges = graph.edges.map((e) => {
    const edge: FlowchartEdge = { id: e.id, source: e.source, target: e.target };
    if (e.label !== undefined) edge.label = e.label;
    return edge;
  });
  // 触发全量布局
  layoutEntireGraph(doc);
  return { ok: true };
}

function applyAddNode(
  doc: FlowchartDocument,
  op: { name: "addNode"; node: FlowchartSemanticNode },
  newNodeIds: Set<string>,
  ctx: string,
): OpResult {
  const n = op.node;
  if (newNodeIds.has(n.id)) {
    return { ok: false, message: `${ctx}: 同一 patch 中节点 id 重复 ${n.id}` };
  }
  if (doc.nodes.some((x) => x.id === n.id)) {
    return { ok: false, message: `${ctx}: 节点 id 已存在 ${n.id}` };
  }
  const node: FlowchartNode = {
    id: n.id,
    kind: n.kind,
    label: n.label,
    position: { x: 0, y: 0 }, // 占位，由 placeNewNodes 统一放置
  };
  doc.nodes.push(node);
  newNodeIds.add(n.id);
  return { ok: true };
}

function applyUpdateNode(
  doc: FlowchartDocument,
  op: {
    name: "updateNode";
    id: string;
    expectedLabel: string;
    patch: { kind?: FlowchartNodeKind; label?: string };
  },
  ctx: string,
): OpResult {
  const node = doc.nodes.find((x) => x.id === op.id);
  if (!node) return { ok: false, message: `${ctx}: 节点不存在 ${op.id}` };
  if (node.label !== op.expectedLabel) {
    return { ok: false, message: `${ctx}: 节点 ${op.id} expectedLabel 不匹配（期望 "${op.expectedLabel}"，实际 "${node.label}"）` };
  }
  if (op.patch.kind !== undefined) node.kind = op.patch.kind;
  if (op.patch.label !== undefined) node.label = op.patch.label;
  return { ok: true };
}

function applyRemoveSubgraph(
  doc: FlowchartDocument,
  op: {
    name: "removeSubgraph";
    nodes: Array<{ id: string; expectedLabel: string }>;
    edges: Array<{ id: string; expected: { source: string; target: string; label?: string } }>;
  },
  ctx: string,
): OpResult {
  // 1. 节点/边 ID 在 op 内部唯一
  const opNodeIds = new Set<string>();
  for (const n of op.nodes) {
    if (opNodeIds.has(n.id)) return { ok: false, message: `${ctx}: removeSubgraph 节点 id 重复 ${n.id}` };
    opNodeIds.add(n.id);
  }
  const opEdgeIds = new Set<string>();
  for (const e of op.edges) {
    if (opEdgeIds.has(e.id)) return { ok: false, message: `${ctx}: removeSubgraph 边 id 重复 ${e.id}` };
    opEdgeIds.add(e.id);
  }

  // 2. 校验 expectedLabel
  for (const n of op.nodes) {
    const node = doc.nodes.find((x) => x.id === n.id);
    if (!node) return { ok: false, message: `${ctx}: 节点不存在 ${n.id}` };
    if (node.label !== n.expectedLabel) {
      return { ok: false, message: `${ctx}: 节点 ${n.id} expectedLabel 不匹配` };
    }
  }

  // 3. 校验 expected edge 字段
  for (const e of op.edges) {
    const edge = doc.edges.find((x) => x.id === e.id);
    if (!edge) return { ok: false, message: `${ctx}: 边不存在 ${e.id}` };
    if (edge.source !== e.expected.source || edge.target !== e.expected.target) {
      return { ok: false, message: `${ctx}: 边 ${e.id} expected source/target 不匹配` };
    }
    if (e.expected.label !== undefined && edge.label !== e.expected.label) {
      return { ok: false, message: `${ctx}: 边 ${e.id} expected label 不匹配` };
    }
  }

  // 4. 校验 edges 恰好等于待删节点关联边的并集
  const expectedEdgeIds = new Set<string>();
  for (const edge of doc.edges) {
    if (opNodeIds.has(edge.source) || opNodeIds.has(edge.target)) {
      expectedEdgeIds.add(edge.id);
    }
  }
  if (expectedEdgeIds.size !== opEdgeIds.size) {
    return {
      ok: false,
      message: `${ctx}: removeSubgraph 边列表不完整或不精确（期望 ${expectedEdgeIds.size} 条，实际声明 ${opEdgeIds.size} 条）`,
    };
  }
  for (const id of expectedEdgeIds) {
    if (!opEdgeIds.has(id)) {
      return { ok: false, message: `${ctx}: removeSubgraph 漏列关联边 ${id}` };
    }
  }
  for (const id of opEdgeIds) {
    if (!expectedEdgeIds.has(id)) {
      return { ok: false, message: `${ctx}: removeSubgraph 夹带无关边 ${id}` };
    }
  }

  // 5. 原子删除：先删边，后删节点
  doc.edges = doc.edges.filter((e) => !opEdgeIds.has(e.id));
  doc.nodes = doc.nodes.filter((n) => !opNodeIds.has(n.id));
  return { ok: true };
}

function applyAddEdge(
  doc: FlowchartDocument,
  op: { name: "addEdge"; edge: FlowchartEdge },
  ctx: string,
): OpResult {
  const e = op.edge;
  if (doc.edges.some((x) => x.id === e.id)) {
    return { ok: false, message: `${ctx}: 边 id 已存在 ${e.id}` };
  }
  // source/target 必须存在（可能是前面 op 创建的新节点）
  if (!doc.nodes.some((n) => n.id === e.source)) {
    return { ok: false, message: `${ctx}: 边 source 指向不存在节点 ${e.source}` };
  }
  if (!doc.nodes.some((n) => n.id === e.target)) {
    return { ok: false, message: `${ctx}: 边 target 指向不存在节点 ${e.target}` };
  }
  if (e.source === e.target) {
    return { ok: false, message: `${ctx}: 自环边 ${e.source}` };
  }
  const edge: FlowchartEdge = { id: e.id, source: e.source, target: e.target };
  if (e.label !== undefined) edge.label = e.label;
  doc.edges.push(edge);
  return { ok: true };
}

function applyUpdateEdge(
  doc: FlowchartDocument,
  op: {
    name: "updateEdge";
    id: string;
    expected: { source: string; target: string; label?: string };
    patch: { source?: string; target?: string; label?: string };
  },
  ctx: string,
): OpResult {
  const edge = doc.edges.find((x) => x.id === op.id);
  if (!edge) return { ok: false, message: `${ctx}: 边不存在 ${op.id}` };
  if (edge.source !== op.expected.source || edge.target !== op.expected.target) {
    return { ok: false, message: `${ctx}: 边 ${op.id} expected source/target 不匹配` };
  }
  if (op.expected.label !== undefined && edge.label !== op.expected.label) {
    return { ok: false, message: `${ctx}: 边 ${op.id} expected label 不匹配` };
  }
  if (op.patch.source !== undefined) {
    if (!doc.nodes.some((n) => n.id === op.patch.source)) {
      return { ok: false, message: `${ctx}: patch.source 指向不存在节点 ${op.patch.source}` };
    }
    edge.source = op.patch.source;
  }
  if (op.patch.target !== undefined) {
    if (!doc.nodes.some((n) => n.id === op.patch.target)) {
      return { ok: false, message: `${ctx}: patch.target 指向不存在节点 ${op.patch.target}` };
    }
    edge.target = op.patch.target;
  }
  if (op.patch.label !== undefined) edge.label = op.patch.label;
  if (edge.source === edge.target) {
    return { ok: false, message: `${ctx}: 修改后产生自环边 ${edge.source}` };
  }
  return { ok: true };
}

function applyRemoveEdge(
  doc: FlowchartDocument,
  op: {
    name: "removeEdge";
    id: string;
    expected: { source: string; target: string; label?: string };
  },
  ctx: string,
): OpResult {
  const idx = doc.edges.findIndex((x) => x.id === op.id);
  if (idx < 0) return { ok: false, message: `${ctx}: 边不存在 ${op.id}` };
  const edge = doc.edges[idx];
  if (edge.source !== op.expected.source || edge.target !== op.expected.target) {
    return { ok: false, message: `${ctx}: 边 ${op.id} expected source/target 不匹配` };
  }
  if (op.expected.label !== undefined && edge.label !== op.expected.label) {
    return { ok: false, message: `${ctx}: 边 ${op.id} expected label 不匹配` };
  }
  doc.edges.splice(idx, 1);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 局部放置：弱连通分组 + Dagre + 碰撞避让
// ---------------------------------------------------------------------------

/** 标准节点尺寸和间距（用于 Dagre 和碰撞检测）。 */
const NODE_WIDTH = 140;
const NODE_HEIGHT = 48;
const NODE_SPACING_X = 60;
const NODE_SPACING_Y = 80;
const GRID_UNIT = 40;

/**
 * 放置本次 patch 新增的节点。
 *
 * 规则（见 §8.3）：
 * 1. 收集所有新节点，按新节点之间的边拆成弱连通分组；
 * 2. 共享同一现有锚点入边的新节点合并到同一分组；
 * 3. 每个分组只对新节点运行一次 Dagre，输入顺序固定为 addNode op 顺序、再按 ID 排序；
 * 4. 分组存在"现有节点 → 新节点"入边时，放在主轴上最后一个入边来源之后；
 * 5. 没有入边但存在"新节点 → 现有节点"出边时，放在主轴上第一个出边目标之前；
 * 6. 同时有多个锚点时，副轴坐标取锚点中心的中位数；
 * 7. 没有任何现有节点锚点时，从当前 viewport 中心开始放置；
 * 8. 碰撞检测使用包围盒，沿副轴按 0、+1、-1、+2、-2... 网格间距确定性避让；
 * 9. 重复应用相同输入得到相同坐标（不依赖随机性）。
 */
function placeNewNodes(doc: FlowchartDocument, newNodeIds: Set<string>): void {
  if (newNodeIds.size === 0) return;

  // 1. 拆分弱连通分组（包含共享锚点的合并）
  const groups = partitionIntoGroups(doc, newNodeIds);

  // 2. 收集现有节点包围盒（用于碰撞检测）
  const existingBoxes = doc.nodes
    .filter((n) => !newNodeIds.has(n.id))
    .map((n) => nodeBox(n));

  // 3. 按 addNode op 顺序处理每个分组（groups 已按首次出现顺序排列）
  for (const group of groups) {
    placeGroup(doc, group, existingBoxes);
    // 把已放置的新节点加入碰撞集合
    for (const id of group.nodeIds) {
      const node = doc.nodes.find((n) => n.id === id);
      if (node) existingBoxes.push(nodeBox(node));
    }
  }
}

interface NewNodeGroup {
  nodeIds: string[];
  /** 入边锚点：现有节点中存在指向本分组新节点的入边来源节点。 */
  inAnchors: string[];
  /** 出边锚点：本分组新节点存在指向现有节点的出边目标。 */
  outAnchors: string[];
}

function partitionIntoGroups(doc: FlowchartDocument, newNodeIds: Set<string>): NewNodeGroup[] {
  // 邻接表：新节点之间的边
  const adj = new Map<string, Set<string>>();
  for (const id of newNodeIds) adj.set(id, new Set());
  for (const e of doc.edges) {
    if (newNodeIds.has(e.source) && newNodeIds.has(e.target)) {
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
  }

  // 共享锚点合并：若两个新节点有同一现有入边锚点，视为同一组
  const anchorToNewNodes = new Map<string, Set<string>>();
  for (const e of doc.edges) {
    if (!newNodeIds.has(e.target)) continue;
    if (newNodeIds.has(e.source)) continue;
    // 现有节点 → 新节点
    if (!anchorToNewNodes.has(e.source)) anchorToNewNodes.set(e.source, new Set());
    anchorToNewNodes.get(e.source)!.add(e.target);
  }
  // 把共享锚点的新节点用 union-find 合并
  const parent = new Map<string, string>();
  for (const id of newNodeIds) parent.set(id, id);
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const ids of anchorToNewNodes.values()) {
    const arr = [...ids];
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  }
  // 同时按边连通性合并
  for (const id of newNodeIds) {
    for (const nb of adj.get(id) ?? []) union(id, nb);
  }

  // 收集分组
  const groupMap = new Map<string, string[]>();
  for (const id of newNodeIds) {
    const root = find(id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(id);
  }

  // 按首次出现顺序（doc.nodes 中新节点出现的顺序，等价于 addNode op 顺序）排序
  const orderInDoc = new Map<string, number>();
  doc.nodes.forEach((n, i) => {
    if (newNodeIds.has(n.id)) orderInDoc.set(n.id, i);
  });
  const groups: NewNodeGroup[] = [];
  for (const ids of groupMap.values()) {
    ids.sort((a, b) => (orderInDoc.get(a) ?? 0) - (orderInDoc.get(b) ?? 0));
    const idSet = new Set(ids);
    const inAnchors: string[] = [];
    const outAnchors: string[] = [];
    for (const e of doc.edges) {
      if (idSet.has(e.target) && !idSet.has(e.source)) inAnchors.push(e.source);
      if (idSet.has(e.source) && !idSet.has(e.target)) outAnchors.push(e.target);
    }
    groups.push({ nodeIds: ids, inAnchors, outAnchors });
  }
  groups.sort((a, b) => (orderInDoc.get(a.nodeIds[0]) ?? 0) - (orderInDoc.get(b.nodeIds[0]) ?? 0));
  return groups;
}

function placeGroup(
  doc: FlowchartDocument,
  group: NewNodeGroup,
  existingBoxes: Array<{ x: number; y: number; w: number; h: number }>,
): void {
  const isTB = doc.direction === "TB";
  const groupNodes = group.nodeIds
    .map((id) => doc.nodes.find((n) => n.id === id)!)
    .filter(Boolean);

  // 1. 用 Dagre 对分组内新节点布局（得到相对坐标）
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: isTB ? "TB" : "LR",
    nodesep: NODE_SPACING_Y,
    ranksep: NODE_SPACING_Y,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of groupNodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const idSet = new Set(group.nodeIds);
  for (const e of doc.edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }
  dagre.layout(g);

  // 2. 计算分组包围盒
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of groupNodes) {
    const ln = g.node(n.id);
    if (!ln) continue;
    minX = Math.min(minX, ln.x - ln.width / 2);
    minY = Math.min(minY, ln.y - ln.height / 2);
    maxX = Math.max(maxX, ln.x + ln.width / 2);
    maxY = Math.max(maxY, ln.y + ln.height / 2);
  }
  const groupW = maxX - minX;
  const groupH = maxY - minY;

  // 3. 计算锚点：主轴位置 + 副轴中位数
  let mainAxis: number;
  let crossAxis: number;
  if (group.inAnchors.length > 0) {
    // 入边锚点：放在主轴上最后一个入边来源之后
    const anchorNodes = group.inAnchors
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter(Boolean) as FlowchartNode[];
    if (isTB) {
      const maxBottom = Math.max(...anchorNodes.map((n) => n.position.y + NODE_HEIGHT / 2));
      mainAxis = maxBottom + NODE_SPACING_Y + groupH / 2;
      const xs = anchorNodes.map((n) => n.position.x).sort((a, b) => a - b);
      crossAxis = median(xs);
    } else {
      const maxRight = Math.max(...anchorNodes.map((n) => n.position.x + NODE_WIDTH / 2));
      mainAxis = maxRight + NODE_SPACING_X + groupW / 2;
      const ys = anchorNodes.map((n) => n.position.y).sort((a, b) => a - b);
      crossAxis = median(ys);
    }
  } else if (group.outAnchors.length > 0) {
    // 出边锚点：放在主轴上第一个出边目标之前
    const anchorNodes = group.outAnchors
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter(Boolean) as FlowchartNode[];
    if (isTB) {
      const minTop = Math.min(...anchorNodes.map((n) => n.position.y - NODE_HEIGHT / 2));
      mainAxis = minTop - NODE_SPACING_Y - groupH / 2;
      const xs = anchorNodes.map((n) => n.position.x).sort((a, b) => a - b);
      crossAxis = median(xs);
    } else {
      const minLeft = Math.min(...anchorNodes.map((n) => n.position.x - NODE_WIDTH / 2));
      mainAxis = minLeft - NODE_SPACING_X - groupW / 2;
      const ys = anchorNodes.map((n) => n.position.y).sort((a, b) => a - b);
      crossAxis = median(ys);
    }
  } else {
    // 无锚点：viewport 中心
    const vp = doc.viewport ?? { x: 0, y: 0, zoom: 1 };
    if (isTB) {
      mainAxis = -vp.y / (vp.zoom || 1) + groupH / 2;
      crossAxis = -vp.x / (vp.zoom || 1);
    } else {
      mainAxis = -vp.x / (vp.zoom || 1) + groupW / 2;
      crossAxis = -vp.y / (vp.zoom || 1);
    }
  }

  // 4. 平移分组使包围盒中心对齐到 (crossAxis, mainAxis)
  // 主轴对应 mainAxis，副轴对应 crossAxis
  const groupCenterMain = isTB ? (minY + maxY) / 2 : (minX + maxX) / 2;
  const groupCenterCross = isTB ? (minX + maxX) / 2 : (minY + maxY) / 2;
  const mainOffset = mainAxis - groupCenterMain;
  const crossOffset = crossAxis - groupCenterCross;

  // 5. 碰撞避让：沿副轴按 0、+1、-1、+2、-2... 网格间距偏移（确定性，无随机性）
  let crossShift = 0;
  const candidateOffsets = [0];
  for (let n = 1; n * GRID_UNIT <= 10000; n++) {
    candidateOffsets.push(n * GRID_UNIT, -n * GRID_UNIT);
  }
  for (const offset of candidateOffsets) {
    const dx = isTB ? crossOffset + offset : mainOffset;
    const dy = isTB ? mainOffset : crossOffset + offset;
    const candidateBoxes = groupNodes.map((n) => {
      const ln = g.node(n.id);
      const cx = ln.x + dx;
      const cy = ln.y + dy;
      return { x: cx - NODE_WIDTH / 2, y: cy - NODE_HEIGHT / 2, w: NODE_WIDTH, h: NODE_HEIGHT };
    });
    if (!candidateBoxes.some((b) => existingBoxes.some((e) => boxesOverlap(b, e)))) {
      crossShift = offset;
      break;
    }
  }

  // 6. 写入坐标
  for (const n of groupNodes) {
    const ln = g.node(n.id);
    if (!ln) {
      n.position = { x: crossAxis, y: mainAxis };
      continue;
    }
    const dx = isTB ? crossOffset + crossShift : mainOffset;
    const dy = isTB ? mainOffset : crossOffset + crossShift;
    n.position = { x: ln.x + dx, y: ln.y + dy };
  }
}

function nodeBox(n: FlowchartNode): { x: number; y: number; w: number; h: number } {
  return { x: n.position.x - NODE_WIDTH / 2, y: n.position.y - NODE_HEIGHT / 2, w: NODE_WIDTH, h: NODE_HEIGHT };
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// 全量布局
// ---------------------------------------------------------------------------

/**
 * 对整个文档运行 Dagre 布局，覆盖所有节点坐标。
 * 用于 replaceGraph 和"重新布局"按钮。
 *
 * 关键：dagre 返回的节点坐标是中心点，但 ReactFlow 的 position 是左上角，
 * 需要减去节点宽高的一半进行转换。使用节点实际 size（NodeResizer 写入），
 * 没有时回退到默认尺寸。
 */
export function layoutEntireGraph(doc: FlowchartDocument): void {
  if (doc.nodes.length === 0) return;
  // 默认节点尺寸（与 NODE_WIDTH/NODE_HEIGHT 一致）
  const DEFAULT_W = 140;
  const DEFAULT_H = 48;
  // 间距：同层节点间距、层间距、边间距均加大，避免节点/连线拥挤重叠
  const NODE_SEP = 90;
  const RANK_SEP = 110;
  const EDGE_SEP = 30;

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: doc.direction === "TB" ? "TB" : "LR",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    edgesep: EDGE_SEP,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));
  // 使用实际尺寸，没有时回退默认值
  for (const n of doc.nodes) {
    const w = n.size?.width ?? DEFAULT_W;
    const h = n.size?.height ?? DEFAULT_H;
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of doc.edges) {
    if (doc.nodes.some((n) => n.id === e.source) && doc.nodes.some((n) => n.id === e.target)) {
      g.setEdge(e.source, e.target);
    }
  }
  dagre.layout(g);
  // dagre 返回中心点，转换为 ReactFlow 左上角坐标
  for (const n of doc.nodes) {
    const ln = g.node(n.id);
    if (ln) {
      const w = n.size?.width ?? DEFAULT_W;
      const h = n.size?.height ?? DEFAULT_H;
      n.position = { x: ln.x - w / 2, y: ln.y - h / 2 };
    }
  }
  // 根据源/目标相对位置为边分配连接点，减少连线重叠
  assignEdgeHandles(doc, DEFAULT_W, DEFAULT_H);
}

/**
 * 根据布局后的节点相对位置为边分配合适的 source/target handle。
 * 同一节点有多条出边/入边时，按目标/来源的相对方位排序后分配不同侧面，
 * 避免所有连线都从底部正中出发/到达导致的重叠。
 */
function assignEdgeHandles(
  doc: FlowchartDocument,
  defaultW: number,
  defaultH: number,
): void {
  const isTB = doc.direction === "TB";
  const nodeMap = new Map(doc.nodes.map((n) => [n.id, n]));

  const nodeCenter = (n: FlowchartNode) => ({
    x: n.position.x + (n.size?.width ?? defaultW) / 2,
    y: n.position.y + (n.size?.height ?? defaultH) / 2,
  });

  // 按源节点分组的出边
  const outEdges = new Map<string, FlowchartEdge[]>();
  // 按目标节点分组的入边
  const inEdges = new Map<string, FlowchartEdge[]>();
  for (const e of doc.edges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push(e);
    if (!inEdges.has(e.target)) inEdges.set(e.target, []);
    inEdges.get(e.target)!.push(e);
  }

  // 根据方位选择 handle：TB 方向优先用 top/bottom，侧向连接用 left/right
  const chooseHandles = (
    source: FlowchartNode,
    target: FlowchartNode,
  ): { source: string; target: string } => {
    const s = nodeCenter(source);
    const t = nodeCenter(target);
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (isTB) {
      // 目标在下方：默认 bottom -> top
      if (dy > 0 && absDy >= absDx) return { source: "bottom-source", target: "top-target" };
      // 目标在上方：反馈边，从侧面绕回（根据水平相对位置选 left/right）
      if (dy < 0 && absDy >= absDx) {
        return dx >= 0
          ? { source: "right-source", target: "right-target" }
          : { source: "left-source", target: "left-target" };
      }
      // 目标在右侧：right -> left
      if (dx > 0) return { source: "right-source", target: "left-target" };
      // 目标在左侧：left -> right
      return { source: "left-source", target: "right-target" };
    }
    // LR 方向
    // 目标在右侧：right -> left
    if (dx > 0 && absDx >= absDy) return { source: "right-source", target: "left-target" };
    // 目标在左侧：反馈边，从顶部或底部绕回
    if (dx < 0 && absDx >= absDy) {
      return dy >= 0
        ? { source: "bottom-source", target: "bottom-target" }
        : { source: "top-source", target: "top-target" };
    }
    // 目标在下方
    if (dy > 0) return { source: "bottom-source", target: "top-target" };
    return { source: "top-source", target: "bottom-target" };
  };

  // 对同一源节点的多条出边，按目标相对方位排序后，若多个目标在同一主方向则错开 handle
  for (const [, edges] of outEdges) {
    if (edges.length <= 1) continue;
    const source = nodeMap.get(edges[0]!.source);
    if (!source) continue;
    // 按目标中心相对源中心的角度排序
    const sorted = [...edges].sort((a, b) => {
      const ca = nodeCenter(nodeMap.get(a.target)!);
      const cb = nodeCenter(nodeMap.get(b.target)!);
      const sa = nodeCenter(source);
      const angleA = Math.atan2(ca.y - sa.y, ca.x - sa.x);
      const angleB = Math.atan2(cb.y - sa.y, cb.x - sa.x);
      return angleA - angleB;
    });
    // 统计各主方向数量并分配
    const counts = { bottom: 0, top: 0, left: 0, right: 0 };
    for (const e of sorted) {
      const target = nodeMap.get(e.target);
      if (!target) continue;
      const handles = chooseHandles(source, target);
      // 若该方向已用过，尝试换到相邻方向以错开连线
      const mainDir = handles.source.replace("-source", "") as "bottom" | "top" | "left" | "right";
      counts[mainDir]++;
      if (counts[mainDir] > 1) {
        // 尝试根据目标位置选择次优方向
        const s = nodeCenter(source);
        const t = nodeCenter(target);
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        if (isTB) {
          if (mainDir === "bottom" || mainDir === "top") {
            handles.source = dx >= 0 ? "right-source" : "left-source";
          }
        } else {
          if (mainDir === "right" || mainDir === "left") {
            handles.source = dy >= 0 ? "bottom-source" : "top-source";
          }
        }
      }
      e.sourceHandle = handles.source;
      if (!e.targetHandle) e.targetHandle = handles.target;
    }
  }

  // 对同一目标节点的多条入边做类似处理
  for (const [, edges] of inEdges) {
    if (edges.length <= 1) continue;
    const target = nodeMap.get(edges[0]!.target);
    if (!target) continue;
    const sorted = [...edges].sort((a, b) => {
      const ca = nodeCenter(nodeMap.get(a.source)!);
      const cb = nodeCenter(nodeMap.get(b.source)!);
      const ta = nodeCenter(target);
      const angleA = Math.atan2(ca.y - ta.y, ca.x - ta.x);
      const angleB = Math.atan2(cb.y - ta.y, cb.x - ta.x);
      return angleA - angleB;
    });
    const counts = { bottom: 0, top: 0, left: 0, right: 0 };
    for (const e of sorted) {
      const source = nodeMap.get(e.source);
      if (!source) continue;
      const handles = chooseHandles(source, target);
      const mainDir = handles.target.replace("-target", "") as "bottom" | "top" | "left" | "right";
      counts[mainDir]++;
      if (counts[mainDir] > 1) {
        const s = nodeCenter(source);
        const t = nodeCenter(target);
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        if (isTB) {
          if (mainDir === "top" || mainDir === "bottom") {
            handles.target = dx >= 0 ? "left-target" : "right-target";
          }
        } else {
          if (mainDir === "left" || mainDir === "right") {
            handles.target = dy >= 0 ? "top-target" : "bottom-target";
          }
        }
      }
      e.targetHandle = handles.target;
      if (!e.sourceHandle) e.sourceHandle = handles.source;
    }
  }

  // 处理未被上面覆盖的边
  for (const e of doc.edges) {
    const source = nodeMap.get(e.source);
    const target = nodeMap.get(e.target);
    if (!source || !target) continue;
    const handles = chooseHandles(source, target);
    if (!e.sourceHandle) e.sourceHandle = handles.source;
    if (!e.targetHandle) e.targetHandle = handles.target;
  }
}

// ---------------------------------------------------------------------------
// 变更摘要文案
// ---------------------------------------------------------------------------

export function summarizePatch(s: FlowchartPatchSummary): string {
  if (s.replacedGraph) return "替换为完整新流程图";
  const parts: string[] = [];
  if (s.addedNodes > 0) parts.push(`新增 ${s.addedNodes} 个节点`);
  if (s.updatedNodes > 0) parts.push(`修改 ${s.updatedNodes} 个节点`);
  if (s.removedNodes > 0) parts.push(`删除 ${s.removedNodes} 个节点`);
  if (s.addedEdges > 0) parts.push(`新增 ${s.addedEdges} 条连线`);
  if (s.updatedEdges > 0) parts.push(`修改 ${s.updatedEdges} 条连线`);
  if (s.removedEdges > 0) parts.push(`删除 ${s.removedEdges} 条连线`);
  return parts.length === 0 ? "无变更" : parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 工具：从 AI 文本中提取 patch（公开 API）
// ---------------------------------------------------------------------------

export { extractFlowchartFence, generateFlowchartNodeId, generateFlowchartEdgeId };
