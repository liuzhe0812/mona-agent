/**
 * 流程图 AI patch 协议：解析、校验、原子应用和新节点分组放置。
 *
 * 规范（见 docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §9.6, §9.7, §8.3）：
 * 1. AI 只输出一种 ```mona-flowchart-patch fenced block，包含语义/文档哈希和 ops 数组；
 * 2. ops 类型：replaceGraph / addNode / updateNode / removeSubgraph / addEdge / updateEdge / removeEdge
 *    / addGroup / updateGroup / removeGroup / addPool / addLane / moveNodeToLane（FC-AI-02 泳道操作）；
 * 3. replaceGraph 必须是唯一 op；完整创建可携带视觉 blueprint；
 * 4. removeSubgraph 必须显式列出待删节点和这些节点的全部关联边，不允许漏列、夹带或隐式级联；
 * 5. 不对 ops 自动排序，按 AI 声明顺序校验和执行；
 * 6. 任一 op 失败则整个 patch 不应用（原子性）；
 * 7. 自动布局由本地完成；只有 manual blueprint 接受显式 position；
 * 8. 局部放置：按新节点之间的边拆成弱连通分组，每组用 Dagre 局部布局；
 * 9. 共享同一现有锚点入边的新节点合并到同一分组（避免副轴错开过远）；
 * 10. 碰撞检测使用包围盒，沿副轴按 0、+1、-1、+2、-2... 网格间距确定性避让。
 */

import dagre from "@dagrejs/dagre";

import {
  cloneFlowchartDocument,
  computeFlowchartDocumentHash,
  computeFlowchartSemanticHash,
  extractFlowchartFence,
  FLOWCHART_AI_NODE_KINDS,
  FLOWCHART_PATCH_FENCE_LANG,
  generateFlowchartEdgeId,
  generateFlowchartNodeId,
  isFlowchartContainerKind,
  validateFlowchartDocument,
  type FlowchartDocument,
  type FlowchartDirection,
  type FlowchartEdge,
  type FlowchartEdgeStyle,
  type FlowchartIconName,
  type FlowchartNode,
  type FlowchartNodeKind,
  type FlowchartNodeStyle,
  type FlowchartSemanticNode,
  type FlowchartThemeSettings,
  FLOWCHART_ICON_NAMES,
} from "./flowchart-document";
import {
  addLaneToPool,
  createPoolNodes,
  FLOWCHART_GROUP_HEADER_SIZE,
  FLOWCHART_GROUP_PADDING,
  flowchartNodeAbsolutePosition,
  groupNodes,
  reparentNodes,
  ungroupNodes,
} from "./flowchart-operations";
import {
  inspectFlowchartQuality,
  recommendedFlowchartNodeSize,
  type FlowchartQualityIssue,
} from "./flowchart-quality";
import { stripThemeProvidedStyles } from "./flowchart-themes";
import { flowchartPortPoint, isFlowchartPort } from "./flowchart-ports";
import { getFlowchartShapeDefaultSize } from "./flowchart-shapes";
import { flowchartEdgeSegments, flowchartEdgeLabelBox, sharedRouteLength, type FlowchartRouteSegment } from "./flowchart-edge-geometry";

// ---------------------------------------------------------------------------
// Patch 类型定义
// ---------------------------------------------------------------------------

export interface FlowchartPatch {
  baseHash: string;
  /** 完整可见文档哈希；新 prompt 始终提供，兼容旧的纯语义 patch 时可缺省。 */
  baseDocumentHash?: string;
  ops: FlowchartPatchOp[];
}

export interface FlowchartPatchNode extends FlowchartSemanticNode {
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  style?: FlowchartNodeStyle;
  icon?: FlowchartIconName;
  zIndex?: number;
  rotation?: number;
  opacity?: number;
  decorative?: boolean;
}

export interface FlowchartPatchGroup {
  id: string;
  label: string;
  memberIds: string[];
  style?: FlowchartNodeStyle;
}

export interface FlowchartPatchPool {
  id: string;
  label: string;
  orientation?: "horizontal" | "vertical";
  lanes: Array<{ id: string; label: string }>;
}

export interface FlowchartPatchGraph {
  direction: FlowchartDirection;
  layout?: "auto" | "manual";
  theme?: FlowchartThemeSettings;
  background?: string;
  nodes: FlowchartPatchNode[];
  edges: FlowchartEdge[];
  groups?: FlowchartPatchGroup[];
  pools?: FlowchartPatchPool[];
}

export interface FlowchartNodePatch {
  kind?: FlowchartNodeKind;
  label?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  style?: FlowchartNodeStyle;
  icon?: FlowchartIconName | null;
  zIndex?: number;
  rotation?: number;
  opacity?: number;
  decorative?: boolean;
}

export interface FlowchartEdgePatch {
  source?: string;
  target?: string;
  label?: string;
  style?: FlowchartEdgeStyle;
  sourceHandle?: string;
  targetHandle?: string;
  sourcePort?: number;
  targetPort?: number;
  controlPoints?: { x: number; y: number }[];
}

export interface FlowchartGroupPatch {
  label?: string;
  position?: { x: number; y: number };
  memberIds?: string[];
  style?: FlowchartNodeStyle;
}

export type FlowchartPatchOp =
  | { name: "replaceGraph"; graph: FlowchartPatchGraph }
  | { name: "addNode"; node: FlowchartPatchNode }
  | {
      name: "updateNode";
      id: string;
      expectedLabel: string;
      patch: FlowchartNodePatch;
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
      patch: FlowchartEdgePatch;
    }
  | {
      name: "removeEdge";
      id: string;
      expected: { source: string; target: string; label?: string };
    }
  | { name: "addGroup"; group: FlowchartPatchGroup }
  | {
      name: "updateGroup";
      id: string;
      expectedLabel: string;
      patch: FlowchartGroupPatch;
    }
  | { name: "removeGroup"; id: string; expectedLabel: string }
  | {
      /** 创建泳池：恰好 2 条泳道，坐标/尺寸由本地确定性生成（FC-AI-02）。 */
      name: "addPool";
      pool: {
        id: string;
        label: string;
        orientation?: "horizontal" | "vertical";
        lanes: [{ id: string; label: string }, { id: string; label: string }];
      };
    }
  | {
      /** 在既有泳池末尾追加一条泳道，泳池自动扩容。 */
      name: "addLane";
      poolId: string;
      lane: { id: string; label?: string };
    }
  | {
      /** 把普通节点移入泳道（laneId=null 移回根级）。 */
      name: "moveNodeToLane";
      id: string;
      expectedLabel: string;
      laneId: string | null;
    }
  | { name: "setTheme"; theme: FlowchartThemeSettings; background?: string }
  | { name: "reflow"; direction?: FlowchartDirection };

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
  const topUnknown = findUnknownField(p, ["baseHash", "baseDocumentHash", "ops"]);
  if (topUnknown) return { ok: false, message: `patch.${topUnknown} 是未知字段` };
  if (typeof p.baseHash !== "string" || p.baseHash.length === 0) {
    return { ok: false, message: "AI 返回未知或缺失字段：baseHash 缺失" };
  }
  if (p.baseDocumentHash !== undefined && (typeof p.baseDocumentHash !== "string" || p.baseDocumentHash.length === 0)) {
    return { ok: false, message: "AI 返回未知或缺失字段：baseDocumentHash 不合法" };
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
  if (p.baseDocumentHash === undefined && p.ops.some((op) => operationTouchesVisualState(op))) {
    return { ok: false, message: "包含视觉修改的 patch 必须提供 baseDocumentHash" };
  }
  // replaceGraph 必须是唯一 op
  const hasReplaceGraph = p.ops.some((op) => (op as { name?: string })?.name === "replaceGraph");
  if (hasReplaceGraph && p.ops.length > 1) {
    return { ok: false, message: "replaceGraph 必须是唯一 op，不能与其他 op 混用" };
  }
  return { ok: true, patch: p as unknown as FlowchartPatch };
}

function operationTouchesVisualState(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const op = raw as Record<string, unknown>;
  const hasAny = (value: unknown, fields: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return fields.some((field) => record[field] !== undefined);
  };
  if (op.name === "setTheme" || op.name === "reflow" || op.name === "addGroup" || op.name === "removeGroup") return true;
  if (op.name === "updateGroup") return hasAny(op.patch, ["label", "position", "memberIds", "style"]);
  if (op.name === "addNode") return hasAny(op.node, ["position", "size", "style", "icon", "zIndex", "rotation", "opacity", "decorative"]);
  if (op.name === "updateNode") return hasAny(op.patch, ["position", "size", "style", "icon", "zIndex", "rotation", "opacity", "decorative"]);
  if (op.name === "addEdge") return hasAny(op.edge, ["style", "sourceHandle", "targetHandle", "sourcePort", "targetPort", "controlPoints"]);
  if (op.name === "updateEdge") return hasAny(op.patch, ["style", "sourceHandle", "targetHandle", "sourcePort", "targetPort", "controlPoints"]);
  if (op.name !== "replaceGraph" || !op.graph || typeof op.graph !== "object") return false;
  const graph = op.graph as Record<string, unknown>;
  if (hasAny(graph, ["theme", "background", "groups", "pools"]) || graph.layout === "manual") return true;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return nodes.some((node) => hasAny(node, ["position", "size", "style", "icon", "zIndex", "rotation", "opacity", "decorative"]))
    || edges.some((edge) => hasAny(edge, ["style", "sourceHandle", "targetHandle", "sourcePort", "targetPort", "controlPoints"]));
}

function validateOpShape(raw: unknown, index: number): string | null {
  const ctx = `ops[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${ctx} 不是对象`;
  }
  const op = raw as Record<string, unknown>;
  const allowedByName: Record<string, string[]> = {
    replaceGraph: ["name", "graph"],
    addNode: ["name", "node"],
    updateNode: ["name", "id", "expectedLabel", "patch"],
    removeSubgraph: ["name", "nodes", "edges"],
    addEdge: ["name", "edge"],
    updateEdge: ["name", "id", "expected", "patch"],
    removeEdge: ["name", "id", "expected"],
    addGroup: ["name", "group"],
    updateGroup: ["name", "id", "expectedLabel", "patch"],
    removeGroup: ["name", "id", "expectedLabel"],
    addPool: ["name", "pool"],
    addLane: ["name", "poolId", "lane"],
    moveNodeToLane: ["name", "id", "expectedLabel", "laneId"],
    setTheme: ["name", "theme", "background"],
    reflow: ["name", "direction"],
  };
  const allowed = typeof op.name === "string" ? allowedByName[op.name] : undefined;
  if (allowed) {
    const unknown = findUnknownField(op, allowed);
    if (unknown) return `${ctx}.${unknown} 是未知字段`;
  }
  switch (op.name) {
    case "replaceGraph":
      return validateSemanticGraph(op, ctx);
    case "addNode":
      return validateSemanticNode(op, "node", ctx);
    case "updateNode":
      if (typeof op.id !== "string") return `${ctx}.id 不是字符串`;
      if (typeof op.expectedLabel !== "string") return `${ctx}.expectedLabel 不是字符串`;
      if (typeof op.patch !== "object" || op.patch === null) return `${ctx}.patch 不是对象`;
      return validateNodeKindPatch(op.patch as Record<string, unknown>, ctx);
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
      return op.name === "updateEdge" ? validateEdgePatch(op.patch, `${ctx}.patch`) : null;
    case "addGroup":
      return validateGroup(op.group, `${ctx}.group`);
    case "updateGroup":
      if (typeof op.id !== "string") return `${ctx}.id 不是字符串`;
      if (typeof op.expectedLabel !== "string") return `${ctx}.expectedLabel 不是字符串`;
      return validateGroupPatch(op.patch, `${ctx}.patch`);
    case "removeGroup":
      if (typeof op.id !== "string") return `${ctx}.id 不是字符串`;
      if (typeof op.expectedLabel !== "string") return `${ctx}.expectedLabel 不是字符串`;
      return null;
    case "addPool": {
      if (typeof op.pool !== "object" || op.pool === null) return `${ctx}.pool 不是对象`;
      const p = op.pool as Record<string, unknown>;
      if (typeof p.id !== "string") return `${ctx}.pool.id 不是字符串`;
      if (typeof p.label !== "string") return `${ctx}.pool.label 不是字符串`;
      if (p.orientation !== undefined && p.orientation !== "horizontal" && p.orientation !== "vertical") {
        return `${ctx}.pool.orientation 不合法`;
      }
      if (!Array.isArray(p.lanes) || p.lanes.length !== 2) {
        return `${ctx}.pool.lanes 必须恰好 2 条泳道`;
      }
      for (let i = 0; i < p.lanes.length; i++) {
        const l = p.lanes[i] as Record<string, unknown> | null;
        if (typeof l !== "object" || l === null) return `${ctx}.pool.lanes[${i}] 不是对象`;
        if (typeof l.id !== "string") return `${ctx}.pool.lanes[${i}].id 不是字符串`;
        if (typeof l.label !== "string") return `${ctx}.pool.lanes[${i}].label 不是字符串`;
      }
      return null;
    }
    case "addLane": {
      if (typeof op.poolId !== "string") return `${ctx}.poolId 不是字符串`;
      if (typeof op.lane !== "object" || op.lane === null) return `${ctx}.lane 不是对象`;
      const l = op.lane as Record<string, unknown>;
      if (typeof l.id !== "string") return `${ctx}.lane.id 不是字符串`;
      if (l.label !== undefined && typeof l.label !== "string") return `${ctx}.lane.label 不是字符串`;
      return null;
    }
    case "moveNodeToLane":
      if (typeof op.id !== "string") return `${ctx}.id 不是字符串`;
      if (typeof op.expectedLabel !== "string") return `${ctx}.expectedLabel 不是字符串`;
      if (op.laneId !== null && typeof op.laneId !== "string") {
        return `${ctx}.laneId 必须是泳道 id 或 null`;
      }
      return null;
    case "setTheme":
      return validateTheme(op.theme, `${ctx}.theme`) ?? validateOptionalColor(op.background, `${ctx}.background`);
    case "reflow":
      if (op.direction !== undefined && op.direction !== "TB" && op.direction !== "LR") {
        return `${ctx}.direction 不合法`;
      }
      return null;
    default:
      return `${ctx} 未知 op name：${String(op.name)}`;
  }
}

function validateSemanticGraph(op: Record<string, unknown>, ctx: string): string | null {
  if (typeof op.graph !== "object" || op.graph === null) return `${ctx}.graph 不是对象`;
  const g = op.graph as Record<string, unknown>;
  const graphUnknown = findUnknownField(g, ["direction", "layout", "theme", "background", "nodes", "edges", "groups", "pools"]);
  if (graphUnknown) return `${ctx}.graph.${graphUnknown} 是未知字段`;
  if (g.direction !== "TB" && g.direction !== "LR") return `${ctx}.graph.direction 不合法`;
  if (!Array.isArray(g.nodes)) return `${ctx}.graph.nodes 不是数组`;
  if (!Array.isArray(g.edges)) return `${ctx}.graph.edges 不是数组`;
  if (g.layout !== undefined && g.layout !== "auto" && g.layout !== "manual") {
    return `${ctx}.graph.layout 不合法`;
  }
  const themeError = g.theme === undefined ? null : validateTheme(g.theme, `${ctx}.graph.theme`);
  if (themeError) return themeError;
  const backgroundError = validateOptionalColor(g.background, `${ctx}.graph.background`);
  if (backgroundError) return backgroundError;
  for (let i = 0; i < g.nodes.length; i++) {
    const nodeErr = validateSemanticNode({ node: g.nodes[i] }, "node", `${ctx}.graph.nodes[${i}]`, true);
    if (nodeErr) return nodeErr;
  }
  for (let i = 0; i < g.edges.length; i++) {
    const edgeErr = validateEdge({ edge: g.edges[i] }, "edge", `${ctx}.graph.edges[${i}]`);
    if (edgeErr) return edgeErr;
  }
  if (g.layout === "manual" && g.nodes.some((node) => !isPosition((node as Record<string, unknown>).position))) {
    return `${ctx}.graph manual 布局要求每个节点提供 position`;
  }
  if (g.layout === "manual" && Array.isArray(g.pools) && g.pools.length > 0) {
    return `${ctx}.graph 泳道图使用 auto 布局`;
  }
  if (g.groups !== undefined) {
    if (!Array.isArray(g.groups)) return `${ctx}.graph.groups 不是数组`;
    const groupIds = new Set<string>();
    const memberIds = new Set<string>();
    for (let i = 0; i < g.groups.length; i++) {
      const group = g.groups[i] as Record<string, unknown> | null;
      const groupCtx = `${ctx}.graph.groups[${i}]`;
      if (!group || typeof group !== "object" || Array.isArray(group)) return `${groupCtx} 不是对象`;
      const groupUnknown = findUnknownField(group, ["id", "label", "memberIds", "style"]);
      if (groupUnknown) return `${groupCtx}.${groupUnknown} 是未知字段`;
      if (typeof group.id !== "string" || !group.id) return `${groupCtx}.id 不是非空字符串`;
      if (groupIds.has(group.id)) return `${groupCtx}.id 重复`;
      groupIds.add(group.id);
      if (typeof group.label !== "string") return `${groupCtx}.label 不是字符串`;
      if (!Array.isArray(group.memberIds) || group.memberIds.length < 2) return `${groupCtx}.memberIds 至少包含 2 个节点`;
      for (const member of group.memberIds) {
        if (typeof member !== "string") return `${groupCtx}.memberIds 只能包含字符串`;
        if (memberIds.has(member)) return `${groupCtx}.memberIds 节点不能属于多个分组：${member}`;
        memberIds.add(member);
      }
      const styleError = group.style === undefined ? null : validateNodeStyle(group.style, `${groupCtx}.style`);
      if (styleError) return styleError;
    }
  }
  if (g.pools !== undefined) {
    if (!Array.isArray(g.pools)) return `${ctx}.graph.pools 不是数组`;
    const poolIds = new Set<string>();
    const laneIds = new Set<string>();
    for (let i = 0; i < g.pools.length; i++) {
      const pool = g.pools[i] as Record<string, unknown> | null;
      const poolCtx = `${ctx}.graph.pools[${i}]`;
      if (!pool || typeof pool !== "object" || Array.isArray(pool)) return `${poolCtx} 不是对象`;
      const poolUnknown = findUnknownField(pool, ["id", "label", "orientation", "lanes"]);
      if (poolUnknown) return `${poolCtx}.${poolUnknown} 是未知字段`;
      if (typeof pool.id !== "string" || !pool.id) return `${poolCtx}.id 不是非空字符串`;
      if (poolIds.has(pool.id)) return `${poolCtx}.id 重复`;
      poolIds.add(pool.id);
      if (typeof pool.label !== "string") return `${poolCtx}.label 不是字符串`;
      if (pool.orientation !== undefined && pool.orientation !== "horizontal" && pool.orientation !== "vertical") return `${poolCtx}.orientation 不合法`;
      if (!Array.isArray(pool.lanes) || pool.lanes.length < 2 || pool.lanes.length > 12) return `${poolCtx}.lanes 必须包含 2-12 条泳道`;
      for (const lane of pool.lanes) {
        if (!lane || typeof lane !== "object" || Array.isArray(lane)) return `${poolCtx}.lanes 包含非法泳道`;
        const value = lane as Record<string, unknown>;
        if (typeof value.id !== "string" || !value.id || typeof value.label !== "string") return `${poolCtx}.lanes 的 id/label 不合法`;
        if (laneIds.has(value.id)) return `${poolCtx}.lanes id 重复：${value.id}`;
        laneIds.add(value.id);
      }
    }
    for (const rawNode of g.nodes) {
      const node = rawNode as Record<string, unknown>;
      if (node.laneId !== undefined && !laneIds.has(node.laneId as string)) return `${ctx}.graph 节点 ${String(node.id)} 引用不存在泳道 ${String(node.laneId)}`;
    }
  } else if (g.nodes.some((node) => (node as Record<string, unknown>).laneId !== undefined)) {
    return `${ctx}.graph 节点使用 laneId 时必须提供 pools`;
  }
  return null;
}

function validateGroup(value: unknown, ctx: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const group = value as Record<string, unknown>;
  const unknown = findUnknownField(group, ["id", "label", "memberIds", "style"]);
  if (unknown) return `${ctx}.${unknown} 是未知字段`;
  if (typeof group.id !== "string" || !group.id) return `${ctx}.id 不是非空字符串`;
  if (typeof group.label !== "string") return `${ctx}.label 不是字符串`;
  const memberError = validateGroupMemberIds(group.memberIds, `${ctx}.memberIds`);
  if (memberError) return memberError;
  return group.style === undefined ? null : validateNodeStyle(group.style, `${ctx}.style`);
}

function validateGroupPatch(value: unknown, ctx: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const patch = value as Record<string, unknown>;
  const unknown = findUnknownField(patch, ["label", "position", "memberIds", "style"]);
  if (unknown) return `${ctx}.${unknown} 是未知字段`;
  if (patch.label !== undefined && typeof patch.label !== "string") return `${ctx}.label 不是字符串`;
  if (patch.position !== undefined && !isPosition(patch.position)) return `${ctx}.position 不合法`;
  const memberError = patch.memberIds === undefined ? null : validateGroupMemberIds(patch.memberIds, `${ctx}.memberIds`);
  if (memberError) return memberError;
  return patch.style === undefined ? null : validateNodeStyle(patch.style, `${ctx}.style`);
}

function validateGroupMemberIds(value: unknown, ctx: string): string | null {
  if (!Array.isArray(value) || value.length < 2) return `${ctx} 至少包含 2 个节点`;
  const ids = new Set<string>();
  for (const member of value) {
    if (typeof member !== "string" || !member) return `${ctx} 只能包含非空字符串`;
    if (ids.has(member)) return `${ctx} 不能包含重复节点 ${member}`;
    ids.add(member);
  }
  return null;
}

function validateSemanticNode(op: Record<string, unknown>, key: string, ctx: string, allowLaneId = false): string | null {
  if (typeof op[key] !== "object" || op[key] === null) return `${ctx}.${key} 不是对象`;
  const n = op[key] as Record<string, unknown>;
  const nodeUnknown = findUnknownField(n, ["id", "kind", "label", "laneId", "position", "size", "style", "icon", "zIndex", "rotation", "opacity", "decorative"]);
  if (nodeUnknown) return `${ctx}.${key}.${nodeUnknown} 是未知字段`;
  if (typeof n.id !== "string") return `${ctx}.${key}.id 不是字符串`;
  if (isFlowchartContainerKind(n.kind as FlowchartNodeKind)) {
    return `${ctx}.${key}.kind 不允许：AI 不能创建容器（${String(n.kind)}）`;
  }
  if (!FLOWCHART_AI_NODE_KINDS.includes(n.kind as FlowchartNodeKind)) {
    return `${ctx}.${key}.kind 不合法`;
  }
  if (typeof n.label !== "string") return `${ctx}.${key}.label 不是字符串`;
  // 泳道归属只能通过 moveNodeToLane 变更（FC-AI-02），addNode/replaceGraph 不接受 laneId
  if (n.laneId !== undefined && !allowLaneId) {
    return `${ctx}.${key}.laneId 不允许：请使用 moveNodeToLane op 调整泳道归属`;
  }
  if (n.laneId !== undefined && typeof n.laneId !== "string") return `${ctx}.${key}.laneId 不是字符串`;
  if (n.position !== undefined && !isPosition(n.position)) return `${ctx}.${key}.position 不合法`;
  const sizeError = n.size === undefined
    ? null
    : validateSize(n.size, `${ctx}.${key}.size`, n.decorative === true ? 2 : 48, n.decorative === true ? 2 : 28);
  if (sizeError) return sizeError;
  const styleError = n.style === undefined ? null : validateNodeStyle(n.style, `${ctx}.${key}.style`);
  if (styleError) return styleError;
  if (n.icon !== undefined && !FLOWCHART_ICON_NAMES.includes(n.icon as FlowchartIconName)) {
    return `${ctx}.${key}.icon 不合法`;
  }
  const visualError = validateVisualNodeFields(n, `${ctx}.${key}`);
  if (visualError) return visualError;
  return null;
}

/** 校验 updateNode 的 patch.kind：只允许合法非容器 kind。 */
function validateNodeKindPatch(patch: Record<string, unknown>, ctx: string): string | null {
  const unknown = findUnknownField(patch, ["kind", "label", "position", "size", "style", "icon", "zIndex", "rotation", "opacity", "decorative"]);
  if (unknown) return `${ctx}.patch.${unknown} 是未知字段`;
  if (patch.kind !== undefined) {
    if (isFlowchartContainerKind(patch.kind as FlowchartNodeKind)) {
      return `${ctx}.patch.kind 不允许：AI 不能把节点改为容器（${patch.kind}）`;
    }
    if (typeof patch.kind !== "string" || !FLOWCHART_AI_NODE_KINDS.includes(patch.kind as FlowchartNodeKind)) {
      return `${ctx}.patch.kind 不合法`;
    }
  }
  if (patch.label !== undefined && typeof patch.label !== "string") return `${ctx}.patch.label 不是字符串`;
  if (patch.position !== undefined && !isPosition(patch.position)) return `${ctx}.patch.position 不合法`;
  const sizeError = patch.size === undefined
    ? null
    : validateSize(patch.size, `${ctx}.patch.size`, patch.decorative === true ? 2 : 48, patch.decorative === true ? 2 : 28);
  if (sizeError) return sizeError;
  const styleError = patch.style === undefined ? null : validateNodeStyle(patch.style, `${ctx}.patch.style`);
  if (styleError) return styleError;
  if (patch.icon !== undefined && patch.icon !== null && !FLOWCHART_ICON_NAMES.includes(patch.icon as FlowchartIconName)) {
    return `${ctx}.patch.icon 不合法`;
  }
  const visualError = validateVisualNodeFields(patch, `${ctx}.patch`);
  if (visualError) return visualError;
  return null;
}

function validateVisualNodeFields(value: Record<string, unknown>, ctx: string): string | null {
  if (value.zIndex !== undefined &&
      (typeof value.zIndex !== "number" || !Number.isFinite(value.zIndex) || value.zIndex < -100 || value.zIndex > 100)) {
    return `${ctx}.zIndex 必须在 -100 到 100 之间`;
  }
  if (value.rotation !== undefined &&
      (typeof value.rotation !== "number" || !Number.isFinite(value.rotation) || Math.abs(value.rotation) > 360)) {
    return `${ctx}.rotation 必须在 -360 到 360 之间`;
  }
  if (value.opacity !== undefined &&
      (typeof value.opacity !== "number" || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1)) {
    return `${ctx}.opacity 必须在 0 到 1 之间`;
  }
  if (value.decorative !== undefined && typeof value.decorative !== "boolean") {
    return `${ctx}.decorative 不是布尔值`;
  }
  return null;
}

function validateEdge(op: Record<string, unknown>, key: string, ctx: string): string | null {
  if (typeof op[key] !== "object" || op[key] === null) return `${ctx}.${key} 不是对象`;
  const e = op[key] as Record<string, unknown>;
  const edgeUnknown = findUnknownField(e, ["id", "source", "target", "label", "style", "sourceHandle", "targetHandle", "sourcePort", "targetPort", "controlPoints"]);
  if (edgeUnknown) return `${ctx}.${key}.${edgeUnknown} 是未知字段`;
  if (typeof e.id !== "string") return `${ctx}.${key}.id 不是字符串`;
  if (typeof e.source !== "string") return `${ctx}.${key}.source 不是字符串`;
  if (typeof e.target !== "string") return `${ctx}.${key}.target 不是字符串`;
  if (e.label !== undefined && typeof e.label !== "string") return `${ctx}.${key}.label 不是字符串`;
  const styleError = e.style === undefined ? null : validateEdgeStyle(e.style, `${ctx}.${key}.style`);
  if (styleError) return styleError;
  if (e.sourceHandle !== undefined && !isHandle(e.sourceHandle, "source")) return `${ctx}.${key}.sourceHandle 不合法`;
  if (e.targetHandle !== undefined && !isHandle(e.targetHandle, "target")) return `${ctx}.${key}.targetHandle 不合法`;
  for (const field of ["sourcePort", "targetPort"] as const) {
    if (e[field] !== undefined && !isFlowchartPort(e[field])) return `${ctx}.${key}.${field} 必须在 0.05-0.95 之间`;
  }
  const pointsError = e.controlPoints === undefined ? null : validateControlPoints(e.controlPoints, `${ctx}.${key}.controlPoints`);
  if (pointsError) return pointsError;
  return null;
}

function validateEdgePatch(value: unknown, ctx: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const patch = value as Record<string, unknown>;
  const unknown = findUnknownField(patch, ["source", "target", "label", "style", "sourceHandle", "targetHandle", "sourcePort", "targetPort", "controlPoints"]);
  if (unknown) return `${ctx}.${unknown} 是未知字段`;
  if (patch.source !== undefined && typeof patch.source !== "string") return `${ctx}.source 不是字符串`;
  if (patch.target !== undefined && typeof patch.target !== "string") return `${ctx}.target 不是字符串`;
  if (patch.label !== undefined && typeof patch.label !== "string") return `${ctx}.label 不是字符串`;
  const styleError = patch.style === undefined ? null : validateEdgeStyle(patch.style, `${ctx}.style`);
  if (styleError) return styleError;
  if (patch.sourceHandle !== undefined && !isHandle(patch.sourceHandle, "source")) return `${ctx}.sourceHandle 不合法`;
  if (patch.targetHandle !== undefined && !isHandle(patch.targetHandle, "target")) return `${ctx}.targetHandle 不合法`;
  for (const field of ["sourcePort", "targetPort"] as const) {
    if (patch[field] !== undefined && !isFlowchartPort(patch[field])) return `${ctx}.${field} 必须在 0.05-0.95 之间`;
  }
  return patch.controlPoints === undefined ? null : validateControlPoints(patch.controlPoints, `${ctx}.controlPoints`);
}

function validateSize(value: unknown, ctx: string, minWidth = 48, minHeight = 28): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const size = value as Record<string, unknown>;
  if (typeof size.width !== "number" || !Number.isFinite(size.width) || size.width < minWidth || size.width > 1200) {
    return `${ctx}.width 必须在 ${minWidth}-1200 之间`;
  }
  if (typeof size.height !== "number" || !Number.isFinite(size.height) || size.height < minHeight || size.height > 800) {
    return `${ctx}.height 必须在 ${minHeight}-800 之间`;
  }
  return null;
}

function isPosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return typeof position.x === "number" && Number.isFinite(position.x)
    && typeof position.y === "number" && Number.isFinite(position.y)
    && Math.abs(position.x) <= 100000 && Math.abs(position.y) <= 100000;
}

function validateOptionalColor(value: unknown, ctx: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^(?:#[0-9a-f]{3,8}|transparent)$/i.test(value)) {
    return `${ctx} 只允许十六进制颜色或 transparent`;
  }
  return null;
}

function validateNodeStyle(value: unknown, ctx: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const style = value as Record<string, unknown>;
  const allowed = new Set(["fontFamily", "fontSize", "color", "fill", "borderColor", "borderWidth", "borderStyle", "bold", "italic", "underline", "textAlign", "verticalAlign", "lineHeight", "cornerRadius"]);
  const unknown = Object.keys(style).find((name) => !allowed.has(name));
  if (unknown) return `${ctx}.${unknown} 是未知字段`;
  for (const field of ["color", "fill", "borderColor"] as const) {
    const error = validateOptionalColor(style[field], `${ctx}.${field}`);
    if (error) return error;
  }
  if (style.fontFamily !== undefined && (typeof style.fontFamily !== "string" || style.fontFamily.length > 80)) return `${ctx}.fontFamily 不合法`;
  if (style.fontSize !== undefined && (typeof style.fontSize !== "number" || !Number.isFinite(style.fontSize) || style.fontSize < 10 || style.fontSize > 48)) return `${ctx}.fontSize 必须在 10-48 之间`;
  if (style.borderWidth !== undefined && (typeof style.borderWidth !== "number" || !Number.isFinite(style.borderWidth) || style.borderWidth < 0 || style.borderWidth > 12)) return `${ctx}.borderWidth 必须在 0-12 之间`;
  if (style.cornerRadius !== undefined && (typeof style.cornerRadius !== "number" || !Number.isFinite(style.cornerRadius) || style.cornerRadius < 0 || style.cornerRadius > 80)) return `${ctx}.cornerRadius 必须在 0-80 之间`;
  if (style.lineHeight !== undefined && (typeof style.lineHeight !== "number" || !Number.isFinite(style.lineHeight) || style.lineHeight < 1 || style.lineHeight > 2.2)) return `${ctx}.lineHeight 必须在 1-2.2 之间`;
  if (style.borderStyle !== undefined && !["solid", "dashed", "dotted"].includes(style.borderStyle as string)) return `${ctx}.borderStyle 不合法`;
  if (style.textAlign !== undefined && !["left", "center", "right"].includes(style.textAlign as string)) return `${ctx}.textAlign 不合法`;
  if (style.verticalAlign !== undefined && !["top", "middle", "bottom"].includes(style.verticalAlign as string)) return `${ctx}.verticalAlign 不合法`;
  for (const field of ["bold", "italic", "underline"] as const) {
    if (style[field] !== undefined && typeof style[field] !== "boolean") return `${ctx}.${field} 不是布尔值`;
  }
  return null;
}

function validateEdgeStyle(value: unknown, ctx: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const style = value as Record<string, unknown>;
  const allowed = new Set(["stroke", "strokeWidth", "strokeDasharray", "route", "markerStart", "markerEnd", "labelColor", "labelBackground", "labelFontSize", "labelBold", "labelOffsetX", "labelOffsetY"]);
  const unknown = Object.keys(style).find((name) => !allowed.has(name));
  if (unknown) return `${ctx}.${unknown} 是未知字段`;
  const colorError = validateOptionalColor(style.stroke, `${ctx}.stroke`);
  if (colorError) return colorError;
  for (const field of ["labelColor", "labelBackground"] as const) {
    const error = validateOptionalColor(style[field], `${ctx}.${field}`);
    if (error) return error;
  }
  if (style.strokeWidth !== undefined && (typeof style.strokeWidth !== "number" || !Number.isFinite(style.strokeWidth) || style.strokeWidth < 0.5 || style.strokeWidth > 12)) return `${ctx}.strokeWidth 必须在 0.5-12 之间`;
  if (style.strokeDasharray !== undefined &&
      !["solid", "dashed", "dotted"].includes(style.strokeDasharray as string) &&
      (typeof style.strokeDasharray !== "string" || !/^\d{1,2}[ ,]+\d{1,2}$/.test(style.strokeDasharray))) {
    return `${ctx}.strokeDasharray 不合法`;
  }
  if (style.route !== undefined && !["bezier", "smoothstep", "straight"].includes(style.route as string)) return `${ctx}.route 不合法`;
  if (style.markerStart !== undefined && !["none", "arrow", "arrowclosed"].includes(style.markerStart as string)) return `${ctx}.markerStart 不合法`;
  if (style.markerEnd !== undefined && !["none", "arrow", "arrowclosed"].includes(style.markerEnd as string)) return `${ctx}.markerEnd 不合法`;
  if (style.labelFontSize !== undefined && (typeof style.labelFontSize !== "number" || !Number.isFinite(style.labelFontSize) || style.labelFontSize < 8 || style.labelFontSize > 32)) return `${ctx}.labelFontSize 必须在 8-32 之间`;
  if (style.labelBold !== undefined && typeof style.labelBold !== "boolean") return `${ctx}.labelBold 不是布尔值`;
  for (const field of ["labelOffsetX", "labelOffsetY"] as const) {
    if (style[field] !== undefined && (typeof style[field] !== "number" || !Number.isFinite(style[field]) || Math.abs(style[field] as number) > 400)) return `${ctx}.${field} 必须在 -400 到 400 之间`;
  }
  return null;
}

function isHandle(value: unknown, kind: "source" | "target"): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^(top|right|bottom|left)(?:-(top|right|bottom|left))?(?:-(source|target))?$/);
  return Boolean(match && (!match[3] || match[3] === kind));
}

function validateControlPoints(value: unknown, ctx: string): string | null {
  if (!Array.isArray(value) || value.length > 8) return `${ctx} 必须是不超过 8 个点的数组`;
  return value.every(isPosition) ? null : `${ctx} 包含非法坐标`;
}

function validateTheme(value: unknown, ctx: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${ctx} 不是对象`;
  const theme = value as Record<string, unknown>;
  const unknown = findUnknownField(theme, ["stylePreset", "paletteId", "preserveManualStyles"]);
  if (unknown) return `${ctx}.${unknown} 是未知字段`;
  if (!['solid', 'outline', 'soft'].includes(theme.stylePreset as string)) return `${ctx}.stylePreset 不合法`;
  if (typeof theme.paletteId !== "string" || !["default", "deep-blue", "blue-gray", "green", "orange", "red", "purple", "monochrome"].includes(theme.paletteId)) return `${ctx}.paletteId 不合法`;
  if (typeof theme.preserveManualStyles !== "boolean") return `${ctx}.preserveManualStyles 不是布尔值`;
  return null;
}

function findUnknownField(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const keys = new Set(allowed);
  return Object.keys(value).find((key) => !keys.has(key));
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
  addedGroups?: number;
  updatedGroups?: number;
  removedGroups?: number;
  /** 新增泳池数（FC-AI-02）；泳池自带的 2 条泳道不重复计入 addedLanes。 */
  addedPools: number;
  /** 通过 addLane 追加的泳道数。 */
  addedLanes: number;
  /** 泳道归属变更的节点数（含移出泳道）。 */
  movedToLane: number;
  updatedTheme?: boolean;
  reflowed?: boolean;
  qualityIssues?: FlowchartQualityIssue[];
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
  if (patch.baseDocumentHash !== undefined && patch.baseDocumentHash !== computeFlowchartDocumentHash(doc)) {
    return { ok: false, message: "AI 处理期间流程图的布局或样式已被修改，请重新生成" };
  }

  const work = cloneFlowchartDocument(doc);
  const summary: FlowchartPatchSummary = {
    addedNodes: 0,
    updatedNodes: 0,
    removedNodes: 0,
    addedEdges: 0,
    updatedEdges: 0,
    removedEdges: 0,
    addedGroups: 0,
    updatedGroups: 0,
    removedGroups: 0,
    addedPools: 0,
    addedLanes: 0,
    movedToLane: 0,
    replacedGraph: false,
  };

  const newNodeIds = new Set<string>();

  for (let i = 0; i < patch.ops.length; i++) {
    const op = patch.ops[i];
    const r = applyOp(work, op, newNodeIds, i);
    if (!r.ok) return r;
    accumulateSummary(summary, op);
  }

  // 新节点统一放置：根级节点走局部放置，泳道归属节点走泳道内放置
  if (newNodeIds.size > 0) {
    placeNewNodes(work, newNodeIds);
    placeNewNodesInLanes(work, newNodeIds);
  }

  const routeScope = routeScopeForPatch(work, patch.ops);
  if (routeScope === "all") routeFlowchartEdges(work);
  else if (routeScope.size > 0) routeFlowchartEdges(work, routeScope);

  // 完整文档校验
  const validation = validateFlowchartDocument(work);
  if (!validation.ok) {
    const detail = validation.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    return { ok: false, message: `修改会产生无效引用或重复 ID：${detail}` };
  }

  const qualityIssues = inspectFlowchartQuality(work);
  if (qualityIssues.length > 0) summary.qualityIssues = qualityIssues;

  return { ok: true, document: work, summary };
}

function routeScopeForPatch(doc: FlowchartDocument, ops: readonly FlowchartPatchOp[]): "all" | Set<string> {
  const edgeIds = new Set<string>();
  for (const op of ops) {
    if (["replaceGraph", "addNode", "addPool", "addLane", "moveNodeToLane", "reflow"].includes(op.name)) {
      return "all";
    }
    if (op.name === "addEdge") edgeIds.add(op.edge.id);
    if (op.name === "updateNode") {
      const geometryChanged = op.patch.kind !== undefined
        || op.patch.label !== undefined
        || op.patch.position !== undefined
        || op.patch.size !== undefined
        || op.patch.icon !== undefined
        || op.patch.style?.fontSize !== undefined
        || op.patch.style?.fontFamily !== undefined
        || op.patch.style?.lineHeight !== undefined;
      if (geometryChanged) {
        for (const edge of doc.edges) {
          if (edge.source === op.id || edge.target === op.id) edgeIds.add(edge.id);
        }
      }
    } else if (op.name === "updateEdge") {
      const routeChanged = op.patch.source !== undefined
        || op.patch.target !== undefined
        || op.patch.sourceHandle !== undefined
        || op.patch.targetHandle !== undefined
        || op.patch.sourcePort !== undefined
        || op.patch.targetPort !== undefined
        || op.patch.controlPoints !== undefined
        || op.patch.style?.route !== undefined;
      if (routeChanged) edgeIds.add(op.id);
    } else if (op.name === "updateGroup" && op.patch.position !== undefined) {
      const memberIds = new Set(doc.nodes.filter((node) => node.parentId === op.id).map((node) => node.id));
      for (const edge of doc.edges) {
        if (memberIds.has(edge.source) || memberIds.has(edge.target)) edgeIds.add(edge.id);
      }
    }
  }
  return edgeIds;
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
    case "addGroup":
      summary.addedGroups = (summary.addedGroups ?? 0) + 1;
      break;
    case "updateGroup":
      summary.updatedGroups = (summary.updatedGroups ?? 0) + 1;
      break;
    case "removeGroup":
      summary.removedGroups = (summary.removedGroups ?? 0) + 1;
      break;
    case "addPool":
      summary.addedPools++;
      break;
    case "addLane":
      summary.addedLanes++;
      break;
    case "moveNodeToLane":
      summary.movedToLane++;
      break;
    case "setTheme":
      summary.updatedTheme = true;
      break;
    case "reflow":
      summary.reflowed = true;
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
    case "addGroup":
      return applyAddGroup(doc, op, ctx);
    case "updateGroup":
      return applyUpdateGroup(doc, op, ctx);
    case "removeGroup":
      return applyRemoveGroup(doc, op, ctx);
    case "addPool":
      return applyAddPool(doc, op, ctx);
    case "addLane":
      return applyAddLane(doc, op, ctx);
    case "moveNodeToLane":
      return applyMoveNodeToLane(doc, op, ctx);
    case "setTheme":
      doc.theme = { ...op.theme };
      if (!op.theme.preserveManualStyles) doc.nodes = stripThemeProvidedStyles(doc.nodes);
      if (op.background !== undefined) doc.canvas.background = op.background;
      return { ok: true };
    case "reflow":
      if (op.direction) doc.direction = op.direction;
      for (const edge of doc.edges) {
        delete edge.sourceHandle;
        delete edge.targetHandle;
        delete edge.controlPoints;
        delete edge.autoRouted;
      }
      layoutFlowchartWithContainers(doc);
      return { ok: true };
  }
}

function applyReplaceGraph(
  doc: FlowchartDocument,
  op: { name: "replaceGraph"; graph: FlowchartPatchGraph },
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
  const structuralIds = new Set(nodeIds);
  for (const group of graph.groups ?? []) {
    if (structuralIds.has(group.id)) return { ok: false, message: `${ctx}: 分组 id 重复 ${group.id}` };
    structuralIds.add(group.id);
    for (const memberId of group.memberIds) {
      if (!nodeIds.has(memberId)) return { ok: false, message: `${ctx}: 分组 ${group.id} 引用不存在节点 ${memberId}` };
    }
  }
  for (const pool of graph.pools ?? []) {
    for (const id of [pool.id, ...pool.lanes.map((lane) => lane.id)]) {
      if (structuralIds.has(id)) return { ok: false, message: `${ctx}: 泳池或泳道 id 重复 ${id}` };
      structuralIds.add(id);
    }
  }
  // 全量替换：自动布局使用 Dagre，manual 保留经过校验的显式坐标
  doc.direction = graph.direction;
  if (graph.theme) doc.theme = { ...graph.theme };
  if (graph.background !== undefined) doc.canvas.background = graph.background;
  const compactNodes = graph.layout !== "manual" && graph.nodes.length > 10;
  doc.nodes = graph.nodes.map((n) => patchNodeToDocumentNode(n, graph.layout === "manual", compactNodes));
  doc.edges = graph.edges.map(clonePatchEdge);
  for (const [poolIndex, pool] of (graph.pools ?? []).entries()) {
    const position = doc.direction === "LR"
      ? { x: poolIndex * 1120, y: 0 }
      : { x: 0, y: poolIndex * 760 };
    const created = createPoolNodes({
      poolId: pool.id,
      laneIds: [pool.lanes[0].id, pool.lanes[1].id],
      orientation: pool.orientation ?? "horizontal",
      position,
      poolTitle: pool.label,
      laneTitles: [pool.lanes[0].label, pool.lanes[1].label],
    });
    doc.nodes.push(...created);
    for (const lane of pool.lanes.slice(2)) {
      const next = addLaneToPool(doc.nodes, pool.id, lane.id, lane.label);
      if (!next) return { ok: false, message: `${ctx}: 无法创建泳道 ${lane.id}` };
      doc.nodes = next;
    }
  }
  const laneIds = new Set((graph.pools ?? []).flatMap((pool) => pool.lanes.map((lane) => lane.id)));
  for (const patchNode of graph.nodes) {
    if (!patchNode.laneId) continue;
    const node = doc.nodes.find((candidate) => candidate.id === patchNode.id);
    if (!node || !laneIds.has(patchNode.laneId)) return { ok: false, message: `${ctx}: 无法设置节点泳道 ${patchNode.id}` };
    node.parentId = patchNode.laneId;
  }
  if (graph.layout !== "manual") {
    if ((graph.pools?.length ?? 0) > 0) layoutFlowchartWithContainers(doc);
    else {
      layoutEntireGraph(doc);
      fitAutoLayoutToPage(doc);
    }
  }
  for (const group of graph.groups ?? []) {
    const grouped = groupNodes(doc.nodes, group.memberIds, group.id, group.label);
    if (!grouped) return { ok: false, message: `${ctx}: 无法创建分区 ${group.id}` };
    doc.nodes = grouped.nodes;
    const created = doc.nodes.find((node) => node.id === group.id)!;
    created.style = group.style ? { ...group.style } : undefined;
    created.zIndex = -1;
  }
  return { ok: true };
}

function patchNodeToDocumentNode(node: FlowchartPatchNode, manual: boolean, compact = false): FlowchartNode {
  const base: FlowchartNode = {
    id: node.id,
    kind: node.kind,
    label: node.label,
    position: manual && node.position ? { ...node.position } : { x: 0, y: 0 },
  };
  if (node.style) base.style = { ...node.style };
  if (node.icon) base.icon = node.icon;
  if (node.size) base.size = { ...node.size };
  if (node.zIndex !== undefined) base.zIndex = node.zIndex;
  if (node.rotation !== undefined) base.rotation = ((Math.round(node.rotation) % 360) + 360) % 360;
  if (node.opacity !== undefined) base.opacity = node.opacity;
  if (node.decorative !== undefined) base.decorative = node.decorative;
  base.size = recommendedFlowchartNodeSize(base, compact ? 180 : 320);
  return base;
}

function clonePatchEdge(edge: FlowchartEdge): FlowchartEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.label !== undefined ? { label: edge.label } : {}),
    ...(edge.sourceHandle ? { sourceHandle: normalizePatchHandle(edge.sourceHandle, "source") } : {}),
    ...(edge.targetHandle ? { targetHandle: normalizePatchHandle(edge.targetHandle, "target") } : {}),
    ...(edge.sourcePort !== undefined ? { sourcePort: edge.sourcePort } : {}),
    ...(edge.targetPort !== undefined ? { targetPort: edge.targetPort } : {}),
    ...(edge.style ? { style: normalizePatchEdgeStyle(edge.style) } : {}),
    ...(edge.controlPoints ? { controlPoints: edge.controlPoints.map((point) => ({ ...point })) } : {}),
  };
}

function normalizePatchEdgeStyle(style: FlowchartEdgeStyle): FlowchartEdgeStyle {
  const normalized = { ...style };
  const dash = style.strokeDasharray as string | undefined;
  const pattern = dash?.replaceAll(",", " ").replace(/\s+/g, " ").trim();
  if (/^\d{1,2} \d{1,2}$/.test(pattern ?? "")) {
    normalized.strokeDasharray = Number(pattern!.split(" ")[0]) <= 2 ? "dotted" : "dashed";
  }
  return normalized;
}

function normalizePatchHandle(value: string, kind: "source" | "target"): string {
  return `${value.split("-")[0]}-${kind}`;
}

function applyAddNode(
  doc: FlowchartDocument,
  op: { name: "addNode"; node: FlowchartPatchNode },
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
  const keepPosition = n.position !== undefined;
  const node = patchNodeToDocumentNode(n, keepPosition);
  doc.nodes.push(node);
  if (!keepPosition) newNodeIds.add(n.id);
  return { ok: true };
}

function applyUpdateNode(
  doc: FlowchartDocument,
  op: {
    name: "updateNode";
    id: string;
    expectedLabel: string;
    patch: FlowchartNodePatch;
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
  if (op.patch.position !== undefined) node.position = { ...op.patch.position };
  if (op.patch.size !== undefined) node.size = { ...op.patch.size };
  if (op.patch.style !== undefined) node.style = { ...(node.style ?? {}), ...op.patch.style };
  if (op.patch.icon === null) delete node.icon;
  else if (op.patch.icon !== undefined) node.icon = op.patch.icon;
  if (op.patch.zIndex !== undefined) node.zIndex = op.patch.zIndex;
  if (op.patch.rotation !== undefined) node.rotation = ((Math.round(op.patch.rotation) % 360) + 360) % 360;
  if (op.patch.opacity !== undefined) node.opacity = op.patch.opacity;
  if (op.patch.decorative !== undefined) node.decorative = op.patch.decorative;
  if (op.patch.size === undefined && (op.patch.label !== undefined || op.patch.icon !== undefined || op.patch.style?.fontSize !== undefined)) {
    node.size = recommendedFlowchartNodeSize(node);
  }
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
  doc.edges.push(clonePatchEdge(e));
  return { ok: true };
}

function applyUpdateEdge(
  doc: FlowchartDocument,
  op: {
    name: "updateEdge";
    id: string;
    expected: { source: string; target: string; label?: string };
    patch: FlowchartEdgePatch;
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
  if (op.patch.style !== undefined) edge.style = normalizePatchEdgeStyle({ ...(edge.style ?? {}), ...op.patch.style });
  if (op.patch.sourceHandle !== undefined) edge.sourceHandle = normalizePatchHandle(op.patch.sourceHandle, "source");
  if (op.patch.targetHandle !== undefined) edge.targetHandle = normalizePatchHandle(op.patch.targetHandle, "target");
  if (op.patch.sourcePort !== undefined) edge.sourcePort = op.patch.sourcePort;
  if (op.patch.targetPort !== undefined) edge.targetPort = op.patch.targetPort;
  if (op.patch.controlPoints !== undefined) {
    edge.controlPoints = op.patch.controlPoints.map((point) => ({ ...point }));
    delete edge.autoRouted;
  }
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

function applyAddGroup(
  doc: FlowchartDocument,
  op: { name: "addGroup"; group: FlowchartPatchGroup },
  ctx: string,
): OpResult {
  if (doc.nodes.some((node) => node.id === op.group.id)) {
    return { ok: false, message: `${ctx}: 分区 id 已存在 ${op.group.id}` };
  }
  const grouped = groupNodes(doc.nodes, op.group.memberIds, op.group.id, op.group.label);
  if (!grouped) return { ok: false, message: `${ctx}: 分区成员必须是未分组的普通根级节点` };
  doc.nodes = grouped.nodes;
  const group = doc.nodes.find((node) => node.id === op.group.id)!;
  if (op.group.style) group.style = { ...op.group.style };
  group.zIndex = -1;
  return { ok: true };
}

function applyUpdateGroup(
  doc: FlowchartDocument,
  op: { name: "updateGroup"; id: string; expectedLabel: string; patch: FlowchartGroupPatch },
  ctx: string,
): OpResult {
  const group = doc.nodes.find((node) => node.id === op.id);
  if (!group || group.kind !== "group") return { ok: false, message: `${ctx}: 分区不存在 ${op.id}` };
  if (group.label !== op.expectedLabel) return { ok: false, message: `${ctx}: 分区 ${op.id} expectedLabel 不匹配` };

  if (op.patch.memberIds) {
    const desired = new Set(op.patch.memberIds);
    for (const id of desired) {
      const member = doc.nodes.find((node) => node.id === id);
      if (!member || isFlowchartContainerKind(member.kind) || (member.parentId !== undefined && member.parentId !== group.id)) {
        return { ok: false, message: `${ctx}: 节点 ${id} 不能加入分区 ${group.id}` };
      }
    }
    const current = doc.nodes.filter((node) => node.parentId === group.id).map((node) => node.id);
    const leaving = current.filter((id) => !desired.has(id));
    if (leaving.length > 0) {
      const next = reparentNodes(doc.nodes, leaving, undefined);
      if (!next) return { ok: false, message: `${ctx}: 无法移出分区成员` };
      doc.nodes = next;
    }
    const joining = op.patch.memberIds.filter((id) => !current.includes(id));
    if (joining.length > 0) {
      const next = reparentNodes(doc.nodes, joining, group.id);
      if (!next) return { ok: false, message: `${ctx}: 无法加入分区成员` };
      doc.nodes = next;
    }
  }
  const updated = doc.nodes.find((node) => node.id === op.id)!;
  if (op.patch.label !== undefined) updated.label = op.patch.label;
  if (op.patch.style !== undefined) updated.style = { ...(updated.style ?? {}), ...op.patch.style };
  fitGroupToMembers(doc, updated);
  if (op.patch.position !== undefined) updated.position = { ...op.patch.position };
  return { ok: true };
}

function applyRemoveGroup(
  doc: FlowchartDocument,
  op: { name: "removeGroup"; id: string; expectedLabel: string },
  ctx: string,
): OpResult {
  const group = doc.nodes.find((node) => node.id === op.id);
  if (!group || group.kind !== "group") return { ok: false, message: `${ctx}: 分区不存在 ${op.id}` };
  if (group.label !== op.expectedLabel) return { ok: false, message: `${ctx}: 分区 ${op.id} expectedLabel 不匹配` };
  const result = ungroupNodes(doc.nodes, doc.edges, [op.id]);
  if (!result) return { ok: false, message: `${ctx}: 无法删除分区 ${op.id}` };
  doc.nodes = result.nodes;
  doc.edges = result.edges;
  return { ok: true };
}

function fitGroupToMembers(doc: FlowchartDocument, group: FlowchartNode): void {
  const members = doc.nodes.filter((node) => node.parentId === group.id);
  if (members.length === 0) return;
  const absolute = members.map((node) => {
    const position = flowchartNodeAbsolutePosition(doc.nodes, node.id) ?? node.position;
    const size = node.size ?? getFlowchartShapeDefaultSize(node.kind);
    return { node, position, size };
  });
  const minX = Math.min(...absolute.map(({ position }) => position.x));
  const minY = Math.min(...absolute.map(({ position }) => position.y));
  const maxX = Math.max(...absolute.map(({ position, size }) => position.x + size.width));
  const maxY = Math.max(...absolute.map(({ position, size }) => position.y + size.height));
  const header = group.label.trim() ? FLOWCHART_GROUP_HEADER_SIZE : 0;
  group.position = {
    x: minX - FLOWCHART_GROUP_PADDING,
    y: minY - FLOWCHART_GROUP_PADDING - header,
  };
  group.size = {
    width: maxX - minX + FLOWCHART_GROUP_PADDING * 2,
    height: maxY - minY + FLOWCHART_GROUP_PADDING * 2 + header,
  };
  for (const { node, position } of absolute) {
    node.position = {
      x: position.x - group.position.x,
      y: position.y - group.position.y,
    };
  }
}

// ---------------------------------------------------------------------------
// 泳道 ops（FC-AI-02）
// ---------------------------------------------------------------------------

/** 泳池放置间距：放在既有内容右侧。 */
const POOL_PLACEMENT_GAP = 80;

/**
 * 创建泳池：AI 只给 id/标题/方向/泳道标题，坐标和尺寸由本地确定性生成。
 * 位置放在当前全部内容包围盒右侧（空文档放原点），重复应用结果一致。
 */
function applyAddPool(
  doc: FlowchartDocument,
  op: {
    name: "addPool";
    pool: {
      id: string;
      label: string;
      orientation?: "horizontal" | "vertical";
      lanes: [{ id: string; label: string }, { id: string; label: string }];
    };
  },
  ctx: string,
): OpResult {
  const p = op.pool;
  const ids = [p.id, p.lanes[0].id, p.lanes[1].id];
  if (new Set(ids).size !== ids.length) {
    return { ok: false, message: `${ctx}: 泳池/泳道 id 重复` };
  }
  for (const id of ids) {
    if (doc.nodes.some((n) => n.id === id)) {
      return { ok: false, message: `${ctx}: 节点 id 已存在 ${id}` };
    }
  }
  let position = { x: 0, y: 0 };
  if (doc.nodes.length > 0) {
    let maxRight = -Infinity;
    let minTop = Infinity;
    for (const n of doc.nodes) {
      const abs = flowchartNodeAbsolutePosition(doc.nodes, n.id) ?? n.position;
      const size = n.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
      maxRight = Math.max(maxRight, abs.x + size.width);
      minTop = Math.min(minTop, abs.y);
    }
    position = { x: maxRight + POOL_PLACEMENT_GAP, y: minTop };
  }
  const created = createPoolNodes({
    poolId: p.id,
    laneIds: [p.lanes[0].id, p.lanes[1].id],
    orientation: p.orientation ?? "horizontal",
    position,
    poolTitle: p.label,
    laneTitles: [p.lanes[0].label, p.lanes[1].label],
  });
  doc.nodes.push(...created);
  return { ok: true };
}

/** 追加泳道：结构与泳池扩容由 addLaneToPool 确定性完成。 */
function applyAddLane(
  doc: FlowchartDocument,
  op: { name: "addLane"; poolId: string; lane: { id: string; label?: string } },
  ctx: string,
): OpResult {
  const pool = doc.nodes.find((n) => n.id === op.poolId);
  if (!pool || pool.kind !== "swimlane-pool") {
    return { ok: false, message: `${ctx}: 泳池不存在 ${op.poolId}` };
  }
  const next = addLaneToPool(doc.nodes, op.poolId, op.lane.id, op.lane.label);
  if (!next) {
    return { ok: false, message: `${ctx}: 添加泳道失败（泳道 id 重复 ${op.lane.id}）` };
  }
  doc.nodes = next;
  return { ok: true };
}

/**
 * 移动节点泳道归属。
 * - 现有节点：保持屏幕位置（坐标换算为泳道相对坐标），与手动拖入一致；
 * - 同 patch 新增节点：坐标是占位值，由 placeNewNodesInLanes 在放置阶段统一计算；
 * - laneId=null 移回根级；归属未变化时幂等成功。
 */
function applyMoveNodeToLane(
  doc: FlowchartDocument,
  op: { name: "moveNodeToLane"; id: string; expectedLabel: string; laneId: string | null },
  ctx: string,
): OpResult {
  const node = doc.nodes.find((n) => n.id === op.id);
  if (!node) return { ok: false, message: `${ctx}: 节点不存在 ${op.id}` };
  if (node.label !== op.expectedLabel) {
    return { ok: false, message: `${ctx}: 节点 ${op.id} expectedLabel 不匹配（期望 "${op.expectedLabel}"，实际 "${node.label}"）` };
  }
  if (isFlowchartContainerKind(node.kind)) {
    return { ok: false, message: `${ctx}: 容器节点不能移动归属 ${op.id}` };
  }
  if (op.laneId !== null) {
    const lane = doc.nodes.find((n) => n.id === op.laneId);
    if (!lane || lane.kind !== "swimlane-lane") {
      return { ok: false, message: `${ctx}: laneId 不是泳道 ${op.laneId}` };
    }
  }
  const next = reparentNodes(doc.nodes, [op.id], op.laneId ?? undefined);
  if (next) doc.nodes = next;
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

  // 已归属泳道的新节点由 placeNewNodesInLanes 处理，不参与根级放置
  const laneIds = new Set(
    doc.nodes.filter((n) => n.kind === "swimlane-lane").map((n) => n.id),
  );
  const rootNewIds = new Set<string>();
  for (const n of doc.nodes) {
    if (newNodeIds.has(n.id) && !(n.parentId !== undefined && laneIds.has(n.parentId))) {
      rootNewIds.add(n.id);
    }
  }
  if (rootNewIds.size === 0) return;

  // 1. 拆分弱连通分组（包含共享锚点的合并）
  const groups = partitionIntoGroups(doc, rootNewIds);

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

/**
 * 泳道内新节点放置（FC-AI-02）。
 *
 * - 按泳道分组，组内用 Dagre 布局（仅新节点之间的边参与排序）；
 * - 新节点块放在泳道既有内容之后（沿文档方向），坐标相对泳道左上角；
 * - 放置后泳池按内容只增不减扩容（rebalancePoolExtents）；
 * - 坐标为左上角语义（与 layoutFlowchartWithContainers 一致）；
 * - 重复应用相同输入得到相同坐标。
 */
function placeNewNodesInLanes(doc: FlowchartDocument, newNodeIds: Set<string>): void {
  const laneById = new Map(
    doc.nodes.filter((n) => n.kind === "swimlane-lane").map((n) => [n.id, n]),
  );
  const byLane = new Map<string, FlowchartNode[]>();
  for (const n of doc.nodes) {
    if (!newNodeIds.has(n.id)) continue;
    if (n.parentId === undefined || !laneById.has(n.parentId)) continue;
    const arr = byLane.get(n.parentId) ?? [];
    arr.push(n);
    byLane.set(n.parentId, arr);
  }
  if (byLane.size === 0) return;

  const isTB = doc.direction === "TB";
  const affectedPools = new Set<string>();
  for (const [laneId, newNodes] of byLane) {
    const lane = laneById.get(laneId)!;
    const horizontal =
      lane.container?.type === "lane" ? lane.container.orientation === "horizontal" : true;
    const existing = doc.nodes.filter(
      (n) => n.parentId === laneId && !newNodeIds.has(n.id) && !isFlowchartContainerKind(n.kind),
    );
    const idSet = new Set(newNodes.map((n) => n.id));
    const innerEdges = doc.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    const pos = runDagreLayout(newNodes, innerEdges, doc.direction);
    let minX = Infinity;
    let minY = Infinity;
    for (const c of newNodes) {
      const p = pos.get(c.id);
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      minX = 0;
      minY = 0;
    }
    const originX = (horizontal ? LAYOUT_LANE_HEADER_SIZE : 0) + LAYOUT_LANE_PADDING;
    const originY = (horizontal ? 0 : LAYOUT_LANE_HEADER_SIZE) + LAYOUT_LANE_PADDING;
    // 既有内容在文档方向主轴上的末尾
    let existEnd = 0;
    for (const c of existing) {
      const s = c.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
      existEnd = Math.max(existEnd, isTB ? c.position.y + s.height : c.position.x + s.width);
    }
    const startMain =
      existing.length > 0 ? existEnd + LAYOUT_RANK_SEP : isTB ? originY : originX;
    for (const c of newNodes) {
      const p = pos.get(c.id);
      if (!p) continue;
      c.position = isTB
        ? { x: p.x - minX + originX, y: p.y - minY + startMain }
        : { x: p.x - minX + startMain, y: p.y - minY + originY };
    }
    if (lane.parentId !== undefined) affectedPools.add(lane.parentId);
  }

  // 泳池按内容只增不减扩容
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const poolId of affectedPools) {
    const pool = nodeById.get(poolId);
    if (!pool || pool.container?.type !== "pool") continue;
    const horizontal = pool.container.orientation === "horizontal";
    const poolHeader = pool.container.headerSize;
    const sorted = doc.nodes
      .filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId)
      .sort((a, b) => {
        const oa = a.container?.type === "lane" ? a.container.order : 0;
        const ob = b.container?.type === "lane" ? b.container.order : 0;
        return oa - ob;
      });
    const laneExtents = new Map<string, number>();
    let maxNeedCross = 0;
    for (const lane of sorted) {
      const laneSize = lane.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
      const currentExtent = horizontal ? laneSize.height : laneSize.width;
      const children = doc.nodes.filter(
        (n) => n.parentId === lane.id && !isFlowchartContainerKind(n.kind),
      );
      let maxX = 0;
      let maxY = 0;
      for (const c of children) {
        const s = c.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
        maxX = Math.max(maxX, c.position.x + s.width);
        maxY = Math.max(maxY, c.position.y + s.height);
      }
      const needExtent =
        children.length === 0
          ? currentExtent
          : Math.max(currentExtent, Math.ceil((horizontal ? maxY : maxX) + LAYOUT_LANE_PADDING));
      laneExtents.set(lane.id, needExtent);
      if (children.length > 0) {
        maxNeedCross = Math.max(
          maxNeedCross,
          Math.ceil(poolHeader + (horizontal ? maxX : maxY) + LAYOUT_LANE_PADDING),
        );
      }
    }
    rebalancePoolExtents(pool, sorted, laneExtents, maxNeedCross);
  }
}

// ---------------------------------------------------------------------------
// 全量布局
// ---------------------------------------------------------------------------

const LAYOUT_DEFAULT_W = 140;
const LAYOUT_DEFAULT_H = 48;
// 间距：同层节点间距、层间距、边间距均加大，避免节点/连线拥挤重叠
const LAYOUT_NODE_SEP = 90;
const LAYOUT_RANK_SEP = 110;
const LAYOUT_EDGE_SEP = 30;

/**
 * 对节点子集运行 Dagre 布局，返回左上角坐标（未归一化，含 dagre margin）。
 * 关键：dagre 返回的节点坐标是中心点，需要减去节点宽高的一半转换为左上角。
 * 使用节点实际 size（NodeResizer 写入），没有时回退到默认尺寸。
 */
function runDagreLayout(
  nodes: readonly FlowchartNode[],
  edges: readonly FlowchartEdge[],
  direction: FlowchartDirection,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return out;
  const compact = nodes.length > 10;
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction === "TB" ? "TB" : "LR",
    nodesep: compact ? 56 : LAYOUT_NODE_SEP,
    ranksep: compact ? 52 : LAYOUT_RANK_SEP,
    edgesep: compact ? 18 : LAYOUT_EDGE_SEP,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, {
      width: n.size?.width ?? LAYOUT_DEFAULT_W,
      height: n.size?.height ?? LAYOUT_DEFAULT_H,
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  for (const n of nodes) {
    const ln = g.node(n.id);
    if (!ln) continue;
    const w = n.size?.width ?? LAYOUT_DEFAULT_W;
    const h = n.size?.height ?? LAYOUT_DEFAULT_H;
    out.set(n.id, { x: ln.x - w / 2, y: ln.y - h / 2 });
  }
  return out;
}

/**
 * 对整个文档运行 Dagre 布局，覆盖所有节点坐标。
 * 用于 replaceGraph 和"重新布局"按钮（无容器场景）。
 */
export function layoutEntireGraph(doc: FlowchartDocument): void {
  if (doc.nodes.length === 0) return;
  const pos = runDagreLayout(doc.nodes, doc.edges, doc.direction);
  for (const n of doc.nodes) {
    const p = pos.get(n.id);
    if (p) n.position = p;
  }
  // 根据源/目标相对位置为边分配连接点，减少连线重叠
  assignEdgeHandles(doc, LAYOUT_DEFAULT_W, LAYOUT_DEFAULT_H);
  routeFlowchartEdges(doc);
}

/** 泳道内布局的泳道标题区尺寸（与 flowchart-operations 一致，避免循环依赖）。 */
const LAYOUT_LANE_HEADER_SIZE = 32;
/** 泳道内容区内边距 */
const LAYOUT_LANE_PADDING = 16;

/**
 * 泳池尺寸与泳道位置重排（只增不减）：
 * 泳道按 order 紧凑重排并写入沿向尺寸，泳池沿向取泳道总和、跨向取内容需要。
 * layoutFlowchartWithContainers 与 placeNewNodesInLanes 共用。
 */
function rebalancePoolExtents(
  pool: FlowchartNode,
  sortedLanes: FlowchartNode[],
  laneExtents: Map<string, number>,
  maxNeedCross: number,
): void {
  if (pool.container?.type !== "pool") return;
  const horizontal = pool.container.orientation === "horizontal";
  const poolHeader = pool.container.headerSize;
  const poolSize = pool.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
  // 泳池跨向：只增不减；泳道跨向 = 泳池跨向 - 池标题区
  const currentCross = horizontal ? poolSize.width : poolSize.height;
  const newCross = Math.max(currentCross, maxNeedCross);
  const laneCross = newCross - poolHeader;
  let offset = 0;
  for (const lane of sortedLanes) {
    const extent = laneExtents.get(lane.id)!;
    lane.position = horizontal ? { x: poolHeader, y: offset } : { x: offset, y: poolHeader };
    lane.size = horizontal
      ? { width: laneCross, height: extent }
      : { width: extent, height: laneCross };
    offset += extent;
  }
  // 泳池沿向 = max(当前, 泳道总和)，只增不减
  const currentAlong = horizontal ? poolSize.height : poolSize.width;
  const newAlong = Math.max(currentAlong, Math.ceil(offset));
  pool.size = horizontal
    ? { width: newCross, height: newAlong }
    : { width: newAlong, height: newCross };
}

/**
 * 容器感知的全量布局（FC-SWIM-05）：
 * - pool/lane/group 本身位置不动，泳道顺序不变；
 * - 根级普通节点用 Dagre 布局（仅根级之间的边参与排序）；
 * - 每条泳道内按当前 direction 用 Dagre 布局（仅泳道内部边参与排序）；
 * - 泳道尺寸按内容最小尺寸扩展，不自动缩小用户手调尺寸；
 * - 泳池沿向尺寸取泳道总和（只增不减），跨向按内容需要扩展；
 * - 跨容器边不参与任何子图排序，只在最后统一分配连接点。
 */
export function layoutFlowchartWithContainers(doc: FlowchartDocument): void {
  if (doc.nodes.length === 0) return;
  const hasContainer = doc.nodes.some((n) => isFlowchartContainerKind(n.kind));
  if (!hasContainer) {
    layoutEntireGraph(doc);
    return;
  }
  const sizeOf = (n: FlowchartNode) =>
    n.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));

  // 1. 视觉分区：成员使用既有 parentId 持久化。reflow 只重排分区内部，
  // 保留分区在整图中的位置，并重新计算标题区和包围盒。
  const groups = doc.nodes.filter((node) => node.kind === "group");
  for (const group of groups) {
    const children = doc.nodes.filter(
      (node) => node.parentId === group.id && !isFlowchartContainerKind(node.kind),
    );
    if (children.length === 0) continue;
    const childIds = new Set(children.map((child) => child.id));
    const innerEdges = doc.edges.filter((edge) => childIds.has(edge.source) && childIds.has(edge.target));
    const positions = runDagreLayout(children, innerEdges, doc.direction);
    let minX = Infinity;
    let minY = Infinity;
    for (const child of children) {
      const position = positions.get(child.id);
      if (!position) continue;
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
    }
    const header = group.label.trim() ? FLOWCHART_GROUP_HEADER_SIZE : 0;
    let maxX = 0;
    let maxY = 0;
    for (const child of children) {
      const position = positions.get(child.id);
      if (!position) continue;
      child.position = {
        x: position.x - minX + FLOWCHART_GROUP_PADDING,
        y: position.y - minY + FLOWCHART_GROUP_PADDING + header,
      };
      const size = sizeOf(child);
      maxX = Math.max(maxX, child.position.x + size.width);
      maxY = Math.max(maxY, child.position.y + size.height);
    }
    group.size = {
      width: Math.ceil(maxX + FLOWCHART_GROUP_PADDING),
      height: Math.ceil(maxY + FLOWCHART_GROUP_PADDING),
    };
  }

  // 2. 根级普通节点（group/pool 等容器与其子树不在此布局）
  const rootNormals = doc.nodes.filter(
    (n) => n.parentId === undefined && !isFlowchartContainerKind(n.kind),
  );
  const rootIds = new Set(rootNormals.map((n) => n.id));
  const rootEdges = doc.edges.filter((e) => rootIds.has(e.source) && rootIds.has(e.target));
  const rootPos = runDagreLayout(rootNormals, rootEdges, doc.direction);
  for (const n of rootNormals) {
    const p = rootPos.get(n.id);
    if (p) n.position = p;
  }

  // 3. 每个泳池：逐泳道布局 + 泳道扩容 + 泳池扩容
  const lanesByPool = new Map<string, FlowchartNode[]>();
  for (const n of doc.nodes) {
    if (n.kind !== "swimlane-lane" || n.parentId === undefined) continue;
    const arr = lanesByPool.get(n.parentId) ?? [];
    arr.push(n);
    lanesByPool.set(n.parentId, arr);
  }
  for (const [poolId, poolLanes] of lanesByPool) {
    const pool = nodeById.get(poolId);
    if (!pool || pool.container?.type !== "pool") continue;
    const orientation = pool.container.orientation;
    const poolHeader = pool.container.headerSize;
    const horizontal = orientation === "horizontal";
    const sorted = [...poolLanes].sort((a, b) => {
      const oa = a.container?.type === "lane" ? a.container.order : 0;
      const ob = b.container?.type === "lane" ? b.container.order : 0;
      return oa - ob;
    });
    const allChildren = sorted.flatMap((lane) => doc.nodes.filter(
      (node) => node.parentId === lane.id && !isFlowchartContainerKind(node.kind),
    ));
    const useSharedRanks = (horizontal && doc.direction === "LR")
      || (!horizontal && doc.direction === "TB");
    if (useSharedRanks && allChildren.length > 0) {
      const childIds = new Set(allChildren.map((child) => child.id));
      const innerEdges = doc.edges.filter((edge) => childIds.has(edge.source) && childIds.has(edge.target));
      const positions = runDagreLayout(allChildren, innerEdges, doc.direction);
      let minMain = Infinity;
      for (const child of allChildren) {
        const position = positions.get(child.id);
        if (!position) continue;
        minMain = Math.min(minMain, horizontal ? position.x : position.y);
      }
      if (!Number.isFinite(minMain)) minMain = 0;
      const laneExtents = new Map<string, number>();
      let maxMainEnd = 0;
      for (const lane of sorted) {
        const children = allChildren.filter((child) => child.parentId === lane.id);
        const largestCross = Math.max(
          LAYOUT_DEFAULT_H,
          ...children.map((child) => {
            const size = sizeOf(child);
            return horizontal ? size.height : size.width;
          }),
        );
        const laneExtent = Math.max(
          horizontal ? (lane.size?.height ?? 0) : (lane.size?.width ?? 0),
          largestCross + LAYOUT_LANE_PADDING * 2,
          96,
        );
        laneExtents.set(lane.id, Math.ceil(laneExtent));
        for (const child of children) {
          const position = positions.get(child.id);
          if (!position) continue;
          const size = sizeOf(child);
          if (horizontal) {
            child.position = {
              x: position.x - minMain + LAYOUT_LANE_HEADER_SIZE + LAYOUT_LANE_PADDING,
              y: (laneExtent - size.height) / 2,
            };
            maxMainEnd = Math.max(maxMainEnd, child.position.x + size.width);
          } else {
            child.position = {
              x: (laneExtent - size.width) / 2,
              y: position.y - minMain + LAYOUT_LANE_HEADER_SIZE + LAYOUT_LANE_PADDING,
            };
            maxMainEnd = Math.max(maxMainEnd, child.position.y + size.height);
          }
        }
      }
      const requiredCross = poolHeader + maxMainEnd + LAYOUT_LANE_PADDING;
      rebalancePoolExtents(pool, sorted, laneExtents, requiredCross);
      continue;
    }
    const laneExtents = new Map<string, number>();
    let maxNeedCross = 0;
    for (const lane of sorted) {
      const laneSize = sizeOf(lane);
      const currentExtent = horizontal ? laneSize.height : laneSize.width;
      const children = doc.nodes.filter(
        (n) => n.parentId === lane.id && !isFlowchartContainerKind(n.kind),
      );
      if (children.length === 0) {
        laneExtents.set(lane.id, currentExtent);
        continue;
      }
      const childIds = new Set(children.map((c) => c.id));
      const innerEdges = doc.edges.filter((e) => childIds.has(e.source) && childIds.has(e.target));
      const pos = runDagreLayout(children, innerEdges, doc.direction);
      // 归一化到内容区原点（避开 lane 标题区 + 内边距）
      let minX = Infinity;
      let minY = Infinity;
      for (const c of children) {
        const p = pos.get(c.id);
        if (!p) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
      }
      const originX = (horizontal ? LAYOUT_LANE_HEADER_SIZE : 0) + LAYOUT_LANE_PADDING;
      const originY = (horizontal ? 0 : LAYOUT_LANE_HEADER_SIZE) + LAYOUT_LANE_PADDING;
      let maxX = 0;
      let maxY = 0;
      for (const c of children) {
        const p = pos.get(c.id);
        if (!p) continue;
        c.position = { x: p.x - minX + originX, y: p.y - minY + originY };
        const s = sizeOf(c);
        maxX = Math.max(maxX, c.position.x + s.width);
        maxY = Math.max(maxY, c.position.y + s.height);
      }
      // 泳道沿向需要容纳内容（含尾部内边距），只增不减
      const needExtent = (horizontal ? maxY : maxX) + LAYOUT_LANE_PADDING;
      laneExtents.set(lane.id, Math.max(currentExtent, Math.ceil(needExtent)));
      // 泳池跨向需要 = 池标题区 + 内容跨向（含内边距）
      maxNeedCross = Math.max(
        maxNeedCross,
        Math.ceil(poolHeader + (horizontal ? maxX : maxY) + LAYOUT_LANE_PADDING),
      );
    }
    // 泳池跨向：只增不减；泳道按 order 紧凑重排，泳池沿向取泳道总和
    rebalancePoolExtents(pool, sorted, laneExtents, maxNeedCross);
  }

  // 4. 统一分配连接点（跨容器边参与端口选择）
  assignEdgeHandles(doc, LAYOUT_DEFAULT_W, LAYOUT_DEFAULT_H);
  routeFlowchartEdges(doc);
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
  edgeIds?: ReadonlySet<string>,
): void {
  const isTB = doc.direction === "TB";
  const nodeMap = new Map(doc.nodes.map((n) => [n.id, n]));

  // 使用绝对坐标：泳道/group 内节点的 position 是相对父容器的，
  // 跨容器边需要用绝对中心点判断相对方位
  const nodeCenter = (n: FlowchartNode) => {
    const abs = flowchartNodeAbsolutePosition(doc.nodes, n.id) ?? n.position;
    return {
      x: abs.x + (n.size?.width ?? defaultW) / 2,
      y: abs.y + (n.size?.height ?? defaultH) / 2,
    };
  };

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
      if (edgeIds && !edgeIds.has(e.id)) continue;
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
      if (!e.sourceHandle) e.sourceHandle = handles.source;
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
      if (edgeIds && !edgeIds.has(e.id)) continue;
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
      if (!e.targetHandle) e.targetHandle = handles.target;
      if (!e.sourceHandle) e.sourceHandle = handles.source;
    }
  }

  // 处理未被上面覆盖的边
  for (const e of doc.edges) {
    if (edgeIds && !edgeIds.has(e.id)) continue;
    const source = nodeMap.get(e.source);
    const target = nodeMap.get(e.target);
    if (!source || !target) continue;
    const handles = chooseHandles(source, target);
    if (!e.sourceHandle) e.sourceHandle = handles.source;
    if (!e.targetHandle) e.targetHandle = handles.target;
  }
}

/**
 * 把 Dagre 的层级结果收紧到有界页面；只调整同层间距和页面尺寸，不缩放节点或字号。
 * 页面最多扩展到 1600×1200，超出时保留质量问题交给 Agent 重新构图。
 */
function fitAutoLayoutToPage(doc: FlowchartDocument): void {
  if (doc.canvas.mode !== "page" || !doc.canvas.width || !doc.canvas.height) return;
  const nodes = doc.nodes.filter((node) => node.parentId === undefined && !isFlowchartContainerKind(node.kind) && !node.decorative);
  if (nodes.length < 2) return;
  const sizeOf = (node: FlowchartNode) => node.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
  const primary = (node: FlowchartNode) => doc.direction === "TB" ? node.position.y : node.position.x;
  const cross = (node: FlowchartNode) => doc.direction === "TB" ? node.position.x : node.position.y;
  const ordered = [...nodes].sort((a, b) => primary(a) - primary(b) || cross(a) - cross(b));
  const ranks: FlowchartNode[][] = [];
  for (const node of ordered) {
    const last = ranks.at(-1);
    if (!last || Math.abs(primary(node) - primary(last[0])) > 4) ranks.push([node]);
    else last.push(node);
  }
  const rankGap = 24;
  const itemGap = 40;
  const rankExtents = ranks.map((rank) => Math.max(...rank.map((node) => {
    const size = sizeOf(node);
    return doc.direction === "TB" ? size.height : size.width;
  })));
  const rankCrossExtents = ranks.map((rank) => rank.reduce((total, node, index) => {
    const size = sizeOf(node);
    return total + (doc.direction === "TB" ? size.width : size.height) + (index === 0 ? 0 : itemGap);
  }, 0));
  const contentPrimary = rankExtents.reduce((total, extent) => total + extent, 0) + rankGap * (ranks.length - 1);
  const contentCross = Math.max(...rankCrossExtents);
  const requiredWidth = doc.direction === "TB" ? contentCross + 64 : contentPrimary + 64;
  const requiredHeight = doc.direction === "TB" ? contentPrimary + 64 : contentCross + 64;
  const ratio = doc.canvas.width / doc.canvas.height;
  let width = Math.max(doc.canvas.width, requiredWidth, requiredHeight * ratio);
  let height = Math.max(doc.canvas.height, requiredHeight, width / ratio);
  width = Math.min(1600, Math.ceil(width));
  height = Math.min(1200, Math.ceil(height));
  doc.canvas.width = width;
  doc.canvas.height = height;

  let primaryCursor = (doc.direction === "TB" ? height : width) / 2 - contentPrimary / 2;
  for (let rankIndex = 0; rankIndex < ranks.length; rankIndex++) {
    const rank = [...ranks[rankIndex]].sort((a, b) => cross(a) - cross(b));
    let crossCursor = (doc.direction === "TB" ? width : height) / 2 - rankCrossExtents[rankIndex] / 2;
    for (const node of rank) {
      const size = sizeOf(node);
      node.position = doc.direction === "TB"
        ? { x: crossCursor, y: primaryCursor + (rankExtents[rankIndex] - size.height) / 2 }
        : { x: primaryCursor + (rankExtents[rankIndex] - size.width) / 2, y: crossCursor };
      crossCursor += (doc.direction === "TB" ? size.width : size.height) + itemGap;
    }
    primaryCursor += rankExtents[rankIndex] + rankGap;
  }
  for (const edge of doc.edges) {
    delete edge.sourceHandle;
    delete edge.targetHandle;
    if (edge.autoRouted) delete edge.controlPoints;
    delete edge.autoRouted;
  }
}

/**
 * 为需要绕回或穿过节点的正交边生成确定性控制点。
 * 已有控制点视为人工/AI 显式设计，不覆盖。
 */
export function routeFlowchartEdges(doc: FlowchartDocument, edgeIds?: ReadonlySet<string>): void {
  assignEdgeHandles(doc, LAYOUT_DEFAULT_W, LAYOUT_DEFAULT_H, edgeIds);
  const ordinary = doc.nodes.filter((node) => !isFlowchartContainerKind(node.kind) && !node.decorative);
  const boxes = new Map(ordinary.map((node) => {
    const position = flowchartNodeAbsolutePosition(doc.nodes, node.id) ?? node.position;
    const size = node.size ?? { width: LAYOUT_DEFAULT_W, height: LAYOUT_DEFAULT_H };
    return [node.id, { ...position, ...size }] as const;
  }));
  const sorted = [...doc.edges].sort((a, b) => a.id.localeCompare(b.id));
  const automatic = (edge: FlowchartEdge) => (!edgeIds || edgeIds.has(edge.id))
    && !(edge.controlPoints?.length && !edge.autoRouted)
    && edge.style?.route !== "straight" && edge.style?.route !== "bezier";
  type Box = { x: number; y: number; width: number; height: number };
  type Point = { x: number; y: number };
  type Endpoint = { edge: FlowchartEdge; field: "sourcePort" | "targetPort" };
  const ports = new Map<string, Endpoint[]>();
  for (const edge of sorted) {
    for (const role of ["source", "target"] as const) {
      const key = `${edge[role]}:${edge[`${role}Handle`]?.split("-")[0]}`;
      const entries = ports.get(key) ?? [];
      entries.push({ edge, field: `${role}Port` });
      ports.set(key, entries);
    }
  }
  // Only unassigned automatic endpoints move; existing and explicit ports reserve their positions.
  for (const entries of ports.values()) {
    if (entries.length < 2) continue;
    const fixed = entries.filter(({ edge, field }) => !automatic(edge) || edge[field] !== undefined);
    const occupied = fixed.map(({ edge, field }) => edge[field] ?? 0.5);
    entries.forEach(({ edge, field }, index) => {
      if (!automatic(edge) || edge[field] !== undefined) return;
      const desired = (index + 1) / (entries.length + 1);
      const slots = Array.from({ length: entries.length * 2 + 1 }, (_, i) => (i + 1) / (entries.length * 2 + 2))
        .filter((port) => port >= 0.05 && port <= 0.95);
      slots.sort((a, b) => {
        const blockedA = occupied.some((port) => Math.abs(port - a) < 0.025);
        const blockedB = occupied.some((port) => Math.abs(port - b) < 0.025);
        return Number(blockedA) - Number(blockedB) || Math.abs(a - desired) - Math.abs(b - desired);
      });
      edge[field] = Math.round(slots[0] * 1000) / 1000;
      occupied.push(edge[field]!);
    });
  }
  const intersects = ({ from: a, to: b }: FlowchartRouteSegment, box: Box, padding = 0) => {
    if (Math.abs(a.x - b.x) < 0.01) return a.x > box.x - padding && a.x < box.x + box.width + padding
      && Math.max(a.y, b.y) > box.y - padding && Math.min(a.y, b.y) < box.y + box.height + padding;
    if (Math.abs(a.y - b.y) < 0.01) return a.y > box.y - padding && a.y < box.y + box.height + padding
      && Math.max(a.x, b.x) > box.x - padding && Math.min(a.x, b.x) < box.x + box.width + padding;
    return false;
  };
  const overlap = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
  const reserved: Array<{ edge: FlowchartEdge; segments: FlowchartRouteSegment[]; label: Box | null }> = [];
  const reserve = (edge: FlowchartEdge) => {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) return;
    const segments = flowchartEdgeSegments(edge, source, target);
    reserved.push({ edge, segments, label: flowchartEdgeLabelBox(edge, segments) });
  };
  sorted.filter((edge) => !automatic(edge)).forEach(reserve);
  const labelCollisions = (edge: FlowchartEdge, box: Box) => {
    let count = 0;
    for (const [id, nodeBox] of boxes) {
      if (id !== edge.source && id !== edge.target && overlap(box, nodeBox)) count++;
    }
    for (const route of reserved) {
      if (route.label && overlap(box, route.label)) count++;
      if (route.segments.some((segment) => intersects(segment, box, 2))) count++;
    }
    return count;
  };
  const exit = (point: Point, handle: string | undefined): Point => {
    const side = handle?.split("-")[0];
    return { x: point.x + (side === "left" ? -24 : side === "right" ? 24 : 0),
      y: point.y + (side === "top" ? -24 : side === "bottom" ? 24 : 0) };
  };
  for (const edge of sorted) {
    if (!automatic(edge)) continue;
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;
    if (edge.autoRouted) delete edge.controlPoints;
    delete edge.autoRouted;
    edge.style = { stroke: "#64748B", strokeWidth: 1.8, ...edge.style, route: "smoothstep" };
    const score = (candidate: FlowchartEdge): number[] => {
      const segments = flowchartEdgeSegments(candidate, source, target);
      let hits = 0;
      for (const [id, box] of boxes) {
        const padding = id === edge.source || id === edge.target ? -1 : 16;
        if (segments.some((segment) => intersects(segment, box, padding))) hits++;
      }
      const shared = reserved.reduce((total, route) => total + Math.max(0, sharedRouteLength(segments, route.segments) - 16), 0);
      const label = flowchartEdgeLabelBox(candidate, segments);
      const labelHits = label ? labelCollisions(candidate, label) : 0;
      const length = segments.reduce((sum, segment) => sum + Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y), 0);
      return [hits, shared, labelHits, length];
    };
    const better = (a: number[], b: number[]) => {
      for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i] - b[i]) > 0.01) return a[i] < b[i];
      }
      return false;
    };
    let best = edge;
    let bestScore = score(edge);
    if (bestScore[0] > 0 || bestScore[1] > 0 || bestScore[2] > 0) {
      const start = flowchartPortPoint(source, edge.sourceHandle, edge.sourcePort, "source");
      const end = flowchartPortPoint(target, edge.targetHandle, edge.targetPort, "target");
      const from = exit(start, edge.sourceHandle);
      const to = exit(end, edge.targetHandle);
      const bounds = {
        left: Math.min(source.x, target.x), right: Math.max(source.x + source.width, target.x + target.width),
        top: Math.min(source.y, target.y), bottom: Math.max(source.y + source.height, target.y + target.height),
      };
      for (const side of ["left", "right", "top", "bottom"] as const) {
        const vertical = side === "left" || side === "right";
        const sign = side === "left" || side === "top" ? -1 : 1;
        let lane = bounds[side] + sign * 48;
        // Allocate against all routes, including reverse edges and unrelated endpoint pairs.
        for (let attempt = 0; attempt <= reserved.length; attempt++) {
          const corridor = vertical
            ? { from: { x: lane, y: from.y }, to: { x: lane, y: to.y } }
            : { from: { x: from.x, y: lane }, to: { x: to.x, y: lane } };
          const occupied = reserved.some((route) => route.segments.some((segment) => {
            const aligned = vertical ? Math.abs(segment.from.x - segment.to.x) < 0.01 : Math.abs(segment.from.y - segment.to.y) < 0.01;
            if (!aligned) return false;
            const coordinate = vertical ? segment.from.x : segment.from.y;
            if (Math.abs(coordinate - lane) >= 20) return false;
            const projected = vertical
              ? { from: { x: lane, y: segment.from.y }, to: { x: lane, y: segment.to.y } }
              : { from: { x: segment.from.x, y: lane }, to: { x: segment.to.x, y: lane } };
            return sharedRouteLength([corridor], [projected]) > 16;
          }));
          if (!occupied) break;
          lane += sign * 28;
        }
        const raw = vertical
          ? [from, { x: lane, y: from.y }, { x: lane, y: to.y }, to]
          : [from, { x: from.x, y: lane }, { x: to.x, y: lane }, to];
        const points = [start, ...raw, end].filter((point, i, all) => i === 0 || point.x !== all[i - 1].x || point.y !== all[i - 1].y);
        const controlPoints = points.filter((point, i) => i > 0 && i < points.length - 1 && !(
          (points[i - 1].x === point.x && point.x === points[i + 1].x)
          || (points[i - 1].y === point.y && point.y === points[i + 1].y)
        ));
        const candidate = { ...edge, controlPoints };
        const cost = score(candidate);
        if (better(cost, bestScore)) { best = candidate; bestScore = cost; }
      }
    }
    if (best !== edge) { edge.controlPoints = best.controlPoints; edge.autoRouted = true; }
    const segments = flowchartEdgeSegments(edge, source, target);
    const label = flowchartEdgeLabelBox(edge, segments);
    if (label && labelCollisions(edge, label) > 0 && edge.style.labelOffsetX === undefined && edge.style.labelOffsetY === undefined) {
      const center = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
      for (const segment of [...segments].sort((a, b) => Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y) - Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y))) {
        let placed = false;
        for (const fraction of [0.5, 0.25, 0.75]) {
          const point = { x: segment.from.x + (segment.to.x - segment.from.x) * fraction, y: segment.from.y + (segment.to.y - segment.from.y) * fraction };
          const shifted = { ...label, x: point.x - label.width / 2, y: point.y - label.height / 2 };
          if (Math.abs(point.x - center.x) > 400 || Math.abs(point.y - center.y) > 400 || labelCollisions(edge, shifted) > 0) continue;
          edge.style.labelOffsetX = point.x - center.x;
          edge.style.labelOffsetY = point.y - center.y;
          placed = true;
          break;
        }
        if (placed) break;
      }
    }
    reserve(edge);
  }
}

// ---------------------------------------------------------------------------
// 变更摘要文案
// ---------------------------------------------------------------------------

export function summarizePatch(s: FlowchartPatchSummary): string {
  if (s.replacedGraph) {
    return (s.qualityIssues?.length ?? 0) > 0
      ? `替换为完整新流程图 · ${s.qualityIssues!.length} 项布局提醒`
      : "替换为完整新流程图";
  }
  const parts: string[] = [];
  if (s.addedPools > 0) parts.push(`新增 ${s.addedPools} 个泳池`);
  if (s.addedLanes > 0) parts.push(`新增 ${s.addedLanes} 条泳道`);
  if (s.movedToLane > 0) parts.push(`移动 ${s.movedToLane} 个节点归属`);
  if ((s.addedGroups ?? 0) > 0) parts.push(`新增 ${s.addedGroups} 个分区`);
  if ((s.updatedGroups ?? 0) > 0) parts.push(`修改 ${s.updatedGroups} 个分区`);
  if ((s.removedGroups ?? 0) > 0) parts.push(`删除 ${s.removedGroups} 个分区`);
  if (s.updatedTheme) parts.push("更新主题");
  if (s.reflowed) parts.push("重新布局");
  if (s.addedNodes > 0) parts.push(`新增 ${s.addedNodes} 个节点`);
  if (s.updatedNodes > 0) parts.push(`修改 ${s.updatedNodes} 个节点`);
  if (s.removedNodes > 0) parts.push(`删除 ${s.removedNodes} 个节点`);
  if (s.addedEdges > 0) parts.push(`新增 ${s.addedEdges} 条连线`);
  if (s.updatedEdges > 0) parts.push(`修改 ${s.updatedEdges} 条连线`);
  if (s.removedEdges > 0) parts.push(`删除 ${s.removedEdges} 条连线`);
  if ((s.qualityIssues?.length ?? 0) > 0) parts.push(`${s.qualityIssues!.length} 项布局提醒`);
  return parts.length === 0 ? "无变更" : parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 工具：从 AI 文本中提取 patch（公开 API）
// ---------------------------------------------------------------------------

export { extractFlowchartFence, generateFlowchartNodeId, generateFlowchartEdgeId };
