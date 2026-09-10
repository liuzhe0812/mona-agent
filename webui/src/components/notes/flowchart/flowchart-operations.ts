/**
 * 流程图文档纯变换操作（FC-ARRANGE-01 / FC-GROUP-01 / FC-LAYER-01 / FC-SWIM-01..05）。
 *
 * 仅包含有多个调用方或需要独立测试的文档变换纯函数。
 * 所有函数不修改输入，返回新的 nodes（必要时含 edges）数组；调用方负责 commit（形成一个历史单元）。
 *
 * Batch 3：matchNodesWidth / matchNodesHeight / matchNodesSize / nudgeNodes。
 * Batch 4：group / ungroup / reparent / reorder / pool-lane 创建、归属、resize、安全删除。
 *
 * 坐标语义（v2）：
 * - 根级节点 position 为画布绝对坐标；
 * - group/lane 子节点 position 为相对父容器左上角的坐标（与 React Flow parent 语义一致）；
 * - lane 子节点相对 lane 左上角，内容区原点为 lane 左上角 + 标题区偏移（laneContentOrigin）。
 */

import {
  isFlowchartContainerKind,
  type FlowchartEdge,
  type FlowchartNode,
} from "./flowchart-document";
import { getFlowchartShapeDefinition } from "./flowchart-shapes";

function nodeSize(n: FlowchartNode): { width: number; height: number } {
  return n.size ?? { width: 200, height: 100 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 等比形状（keepAspectRatio，如 circle/connector）匹配尺寸后仍保持自身宽高比。 */
function constrainSize(
  n: FlowchartNode,
  size: { width: number; height: number },
  width: number,
  height: number,
  dim: "width" | "height" | "both",
): { width: number; height: number } {
  const keepAspect = getFlowchartShapeDefinition(n.kind)?.keepAspectRatio === true;
  if (!keepAspect || size.height <= 0) return { width, height };
  const aspect = size.width / size.height;
  if (dim === "height") return { width: round2(height * aspect), height };
  // width / both：以宽度为驱动，高度按比例推导（both 无法同时满足时优先保持约束）
  return { width, height: round2(width / aspect) };
}

/**
 * 匹配宽度：把 targetIds 节点的 width 统一为参考值。
 * 参考值取第一个 target 的宽度（调用方按选中顺序传入，锚定首选）。
 * 锁定节点跳过。返回 null 表示无可修改节点。
 */
export function matchNodesWidth(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
): FlowchartNode[] | null {
  return matchNodesSizeInternal(nodes, targetIds, "width");
}

/** 匹配高度：同 matchNodesWidth，维度为 height。 */
export function matchNodesHeight(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
): FlowchartNode[] | null {
  return matchNodesSizeInternal(nodes, targetIds, "height");
}

/** 匹配大小：宽高同时匹配参考节点。 */
export function matchNodesSize(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
): FlowchartNode[] | null {
  return matchNodesSizeInternal(nodes, targetIds, "both");
}

function matchNodesSizeInternal(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
  dim: "width" | "height" | "both",
): FlowchartNode[] | null {
  if (targetIds.length < 2) return null;
  const idSet = new Set(targetIds);
  const targets = nodes.filter((n) => idSet.has(n.id));
  if (targets.length < 2) return null;
  const ref = nodeSize(targets[0]);
  let changed = false;
  const next = nodes.map((n) => {
    if (!idSet.has(n.id) || n.locked) return n;
    const size = nodeSize(n);
    const wantW = dim === "height" ? size.width : ref.width;
    const wantH = dim === "width" ? size.height : ref.height;
    const { width, height } = constrainSize(n, size, wantW, wantH, dim);
    if (size.width === width && size.height === height) return n;
    changed = true;
    return { ...n, size: { width, height } };
  });
  return changed ? next : null;
}

/**
 * 键盘微移：把 targetIds 节点平移 (dx, dy)。
 * 锁定节点不移动。返回 null 表示无可移动节点。
 */
export function nudgeNodes(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
  dx: number,
  dy: number,
): FlowchartNode[] | null {
  if (targetIds.length === 0) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const idSet = new Set(targetIds);
  let changed = false;
  const next = nodes.map((n) => {
    if (!idSet.has(n.id) || n.locked) return n;
    changed = true;
    return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
  });
  return changed ? next : null;
}

// ---------------------------------------------------------------------------
// 通用辅助（Batch 4）
// ---------------------------------------------------------------------------

function byIdMap(nodes: readonly FlowchartNode[]): Map<string, FlowchartNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function laneOrder(n: FlowchartNode): number {
  return n.container?.type === "lane" ? n.container.order : 0;
}

/** 有效层级：显式 zIndex 优先；容器默认位于普通节点下层（FC-LAYER-01）。 */
function effectiveZ(n: FlowchartNode): number {
  if (n.zIndex !== undefined) return n.zIndex;
  return isFlowchartContainerKind(n.kind) ? -1 : 0;
}

/**
 * 节点画布绝对坐标：沿 parentId 链累加（子节点 position 为相对父容器左上角）。
 * 带循环保护，结构损坏时返回已累加部分。
 */
export function flowchartNodeAbsolutePosition(
  nodes: readonly FlowchartNode[],
  id: string,
): { x: number; y: number } | null {
  const byId = byIdMap(nodes);
  const start = byId.get(id);
  if (!start) return null;
  let x = start.position.x;
  let y = start.position.y;
  let cursor = start.parentId;
  const seen = new Set<string>([id]);
  while (cursor !== undefined) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    cursor = parent.parentId;
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// 组合 / 取消组合（FC-GROUP-01）
// ---------------------------------------------------------------------------

export const FLOWCHART_GROUP_PADDING = 16;
export const FLOWCHART_GROUP_HEADER_SIZE = 30;

/**
 * 组合：把 ≥2 个根级普通节点装入新建 group。
 *
 * 规则：
 * - 目标必须全部存在、未锁定、非容器、无 parentId（group 依校验规则必须在根部）；
 * - group 包围盒 = 目标包围盒 + 固定 padding；
 * - 子节点 position 转为相对 group 左上角；
 * - group zIndex 取子节点最小值（占据其层级槽位）；
 * - 数组顺序保持父先子后（React Flow 要求）。
 *
 * groupId 由调用方生成传入，保证纯函数确定性。
 * 返回 null 表示不满足组合条件。
 */
export function groupNodes(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
  groupId: string,
  title?: string,
): { nodes: FlowchartNode[]; groupId: string } | null {
  if (targetIds.length < 2) return null;
  const idSet = new Set(targetIds);
  if (idSet.size !== targetIds.length) return null;
  const byId = byIdMap(nodes);
  if (byId.has(groupId)) return null;
  const targets: FlowchartNode[] = [];
  for (const id of targetIds) {
    const n = byId.get(id);
    if (!n) return null;
    if (n.locked) return null;
    if (isFlowchartContainerKind(n.kind)) return null;
    if (n.parentId !== undefined) return null;
    targets.push(n);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of targets) {
    const size = nodeSize(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + size.width);
    maxY = Math.max(maxY, n.position.y + size.height);
  }
  const headerSize = title?.trim() ? FLOWCHART_GROUP_HEADER_SIZE : 0;
  const groupPos = {
    x: round2(minX - FLOWCHART_GROUP_PADDING),
    y: round2(minY - FLOWCHART_GROUP_PADDING - headerSize),
  };
  const group: FlowchartNode = {
    id: groupId,
    kind: "group",
    label: title ?? "",
    position: groupPos,
    size: {
      width: round2(maxX - minX + FLOWCHART_GROUP_PADDING * 2),
      height: round2(maxY - minY + FLOWCHART_GROUP_PADDING * 2 + headerSize),
    },
    container: { type: "group" },
  };
  const childZ = targets.map((n) => n.zIndex).filter((z): z is number => z !== undefined);
  if (childZ.length > 0) group.zIndex = Math.min(...childZ);

  const firstIndex = Math.min(...targetIds.map((id) => nodes.findIndex((n) => n.id === id)));
  const next: FlowchartNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (i === firstIndex) next.push(group);
    const n = nodes[i];
    if (idSet.has(n.id)) {
      next.push({
        ...n,
        parentId: groupId,
        position: {
          x: round2(n.position.x - groupPos.x),
          y: round2(n.position.y - groupPos.y),
        },
      });
    } else {
      next.push(n);
    }
  }
  return { nodes: next, groupId };
}

/**
 * 取消组合：解散指定 group，子节点恢复根级绝对坐标。
 * 引用 group 的边被级联删除（子节点保留）。返回 null 表示目标不全是 group。
 */
export function ungroupNodes(
  nodes: readonly FlowchartNode[],
  edges: readonly FlowchartEdge[],
  groupIds: readonly string[],
): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } | null {
  if (groupIds.length === 0) return null;
  const byId = byIdMap(nodes);
  for (const id of groupIds) {
    const g = byId.get(id);
    if (!g || g.kind !== "group") return null;
  }
  const dropped = new Set(groupIds);
  const nextNodes: FlowchartNode[] = [];
  for (const n of nodes) {
    if (dropped.has(n.id)) continue;
    if (n.parentId !== undefined && dropped.has(n.parentId)) {
      // group 必在根部（校验规则），绝对坐标 = group.position + child.position
      const g = byId.get(n.parentId)!;
      nextNodes.push({
        ...n,
        parentId: undefined,
        position: {
          x: round2(n.position.x + g.position.x),
          y: round2(n.position.y + g.position.y),
        },
      });
    } else {
      nextNodes.push(n);
    }
  }
  const nextEdges = edges.filter((e) => !dropped.has(e.source) && !dropped.has(e.target));
  return { nodes: nextNodes, edges: nextEdges };
}

/**
 * 归属变更（FC-SWIM-03）：把普通节点移入 group/lane 或移回根级。
 *
 * - 目标必须是存在、未锁定、非容器的节点；
 * - parentId 目标只能是 group 或 swimlane-lane（不能直挂 pool）；
 * - 位置按绝对坐标换算为新父容器相对坐标（拖出时保持屏幕位置）；
 * - 跳过归属未变化的节点；全部未变化返回 null。
 */
export function reparentNodes(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
  parentId: string | undefined,
): FlowchartNode[] | null {
  if (targetIds.length === 0) return null;
  const byId = byIdMap(nodes);
  let parentAbs = { x: 0, y: 0 };
  if (parentId !== undefined) {
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (parent.kind !== "group" && parent.kind !== "swimlane-lane") return null;
    parentAbs = flowchartNodeAbsolutePosition(nodes, parentId)!;
  }
  const idSet = new Set(targetIds);
  let changed = false;
  const next = nodes.map((n) => {
    if (!idSet.has(n.id)) return n;
    if (n.locked) return n;
    if (isFlowchartContainerKind(n.kind)) return n;
    if ((n.parentId ?? null) === (parentId ?? null)) return n;
    const abs = flowchartNodeAbsolutePosition(nodes, n.id);
    if (!abs) return n;
    changed = true;
    return {
      ...n,
      parentId,
      position: { x: round2(abs.x - parentAbs.x), y: round2(abs.y - parentAbs.y) },
    };
  });
  return changed ? next : null;
}

// ---------------------------------------------------------------------------
// 层级（FC-LAYER-01）
// ---------------------------------------------------------------------------

export type FlowchartLayerAction = "front" | "back" | "forward" | "backward";

/**
 * 层级调整：置顶 / 置底 / 上移一层 / 下移一层。
 *
 * zIndex 只需同父级内稳定排序：
 * - 同父级兄弟先按（有效 zIndex、数组序）排出当前视觉顺序；
 * - 目标在序列内移动（多选保持相对顺序）；
 * - 顺序发生变化的父级组内，全部兄弟重写为密集 zIndex（0..n-1）；
 * - 所有父级组顺序均未变化时返回 null。
 */
export function reorderNodes(
  nodes: readonly FlowchartNode[],
  targetIds: readonly string[],
  action: FlowchartLayerAction,
): FlowchartNode[] | null {
  if (targetIds.length === 0) return null;
  const byId = byIdMap(nodes);
  const idSet = new Set(targetIds);
  const parentKeys = new Set<string | null>();
  for (const id of targetIds) {
    const n = byId.get(id);
    if (n) parentKeys.add(n.parentId ?? null);
  }
  const indexOf = new Map<string, number>();
  nodes.forEach((n, i) => indexOf.set(n.id, i));

  const newZ = new Map<string, number>();
  let anyChanged = false;
  for (const key of parentKeys) {
    const siblings = nodes.filter((n) => (n.parentId ?? null) === key);
    const order = siblings
      .map((n) => n.id)
      .sort((a, b) => {
        const za = effectiveZ(byId.get(a)!);
        const zb = effectiveZ(byId.get(b)!);
        if (za !== zb) return za - zb;
        return indexOf.get(a)! - indexOf.get(b)!;
      });
    const moving = order.filter((id) => idSet.has(id));
    if (moving.length === 0) continue;
    let nextOrder: string[];
    if (action === "front") {
      nextOrder = [...order.filter((id) => !idSet.has(id)), ...moving];
    } else if (action === "back") {
      nextOrder = [...moving, ...order.filter((id) => !idSet.has(id))];
    } else if (action === "forward") {
      nextOrder = [...order];
      for (let i = nextOrder.length - 2; i >= 0; i--) {
        if (idSet.has(nextOrder[i]) && !idSet.has(nextOrder[i + 1])) {
          [nextOrder[i], nextOrder[i + 1]] = [nextOrder[i + 1], nextOrder[i]];
        }
      }
    } else {
      nextOrder = [...order];
      for (let i = 1; i < nextOrder.length; i++) {
        if (idSet.has(nextOrder[i]) && !idSet.has(nextOrder[i - 1])) {
          [nextOrder[i], nextOrder[i - 1]] = [nextOrder[i - 1], nextOrder[i]];
        }
      }
    }
    if (nextOrder.every((id, i) => id === order[i])) continue;
    anyChanged = true;
    nextOrder.forEach((id, i) => newZ.set(id, i));
  }
  if (!anyChanged) return null;
  return nodes.map((n) => {
    const z = newZ.get(n.id);
    return z === undefined ? n : { ...n, zIndex: z };
  });
}

// ---------------------------------------------------------------------------
// 泳池 / 泳道（FC-SWIM-01 / FC-SWIM-03 / FC-SWIM-04）
// ---------------------------------------------------------------------------

export const FLOWCHART_POOL_HEADER_SIZE = 40;
export const FLOWCHART_LANE_HEADER_SIZE = 32;

/** 泳池默认尺寸：横向 600x300 / 纵向 300x600（转置）。 */
export function flowchartPoolDefaultSize(
  orientation: "horizontal" | "vertical",
): { width: number; height: number } {
  return orientation === "horizontal" ? { width: 600, height: 300 } : { width: 300, height: 600 };
}

export interface CreatePoolOptions {
  poolId: string;
  laneIds: [string, string];
  orientation: "horizontal" | "vertical";
  /** 泳池左上角画布绝对坐标 */
  position: { x: number; y: number };
  poolTitle?: string;
  laneTitles?: [string, string];
}

/**
 * 创建泳池（FC-SWIM-01）：1 个 pool + 2 条同方向 lane。
 * lane 作为 pool 子节点（父先子后数组序），返回待追加的 3 个节点。
 */
export function createPoolNodes(options: CreatePoolOptions): FlowchartNode[] {
  const { poolId, laneIds, orientation, position } = options;
  const size = flowchartPoolDefaultSize(orientation);
  const header = FLOWCHART_POOL_HEADER_SIZE;
  const pool: FlowchartNode = {
    id: poolId,
    kind: "swimlane-pool",
    label: options.poolTitle ?? "泳池",
    position: { x: position.x, y: position.y },
    size,
    container: { type: "pool", orientation, headerSize: header },
  };
  const laneExtent =
    orientation === "horizontal"
      ? { width: size.width - header, height: size.height / 2 }
      : { width: size.width / 2, height: size.height - header };
  const lanes = laneIds.map((laneId, i): FlowchartNode => {
    const pos =
      orientation === "horizontal"
        ? { x: header, y: i * laneExtent.height }
        : { x: i * laneExtent.width, y: header };
    return {
      id: laneId,
      kind: "swimlane-lane",
      label: options.laneTitles?.[i] ?? `泳道 ${i + 1}`,
      parentId: poolId,
      position: pos,
      size: { width: laneExtent.width, height: laneExtent.height },
      container: { type: "lane", orientation, order: i },
    };
  });
  return [pool, ...lanes];
}

/**
 * 在既有泳池末尾追加一条泳道（FC-SWIM-01）。
 *
 * - 新泳道尺寸取最后一条泳道沿泳池方向的长度（无既有泳道时用泳池内容区一半）；
 * - 泳池沿方向扩容，既有泳道尺寸不动（不压缩用户手调尺寸）；
 * - 插入位置紧跟该泳池最后一条子节点之后（父先子后）。
 */
export function addLaneToPool(
  nodes: readonly FlowchartNode[],
  poolId: string,
  laneId: string,
  title?: string,
): FlowchartNode[] | null {
  const byId = byIdMap(nodes);
  const pool = byId.get(poolId);
  if (!pool || pool.kind !== "swimlane-pool" || pool.container?.type !== "pool") return null;
  if (byId.has(laneId)) return null;
  const orientation = pool.container.orientation;
  const header = pool.container.headerSize;
  const poolSize = nodeSize(pool);
  const existingLanes = nodes
    .filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId)
    .sort((a, b) => laneOrder(a) - laneOrder(b));
  const ref = existingLanes[existingLanes.length - 1];
  const refSize = ref ? nodeSize(ref) : null;
  const laneSize =
    orientation === "horizontal"
      ? { width: poolSize.width - header, height: refSize?.height ?? round2(poolSize.height / 2) }
      : { width: refSize?.width ?? round2(poolSize.width / 2), height: poolSize.height - header };
  const order = existingLanes.length;
  const lanePos =
    orientation === "horizontal"
      ? { x: header, y: poolSize.height }
      : { x: poolSize.width, y: header };
  const lane: FlowchartNode = {
    id: laneId,
    kind: "swimlane-lane",
    label: title ?? `泳道 ${order + 1}`,
    parentId: poolId,
    position: lanePos,
    size: laneSize,
    container: { type: "lane", orientation, order },
  };
  const newPoolSize =
    orientation === "horizontal"
      ? { width: poolSize.width, height: round2(poolSize.height + laneSize.height) }
      : { width: round2(poolSize.width + laneSize.width), height: poolSize.height };
  const next = nodes.map((n) => (n.id === poolId ? { ...n, size: newPoolSize } : n));
  // 插入到该泳池子树末尾（泳池自身或最后一个子孙之后）
  const subtree = new Set<string>([poolId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of next) {
      if (n.parentId && subtree.has(n.parentId) && !subtree.has(n.id)) {
        subtree.add(n.id);
        grew = true;
      }
    }
  }
  let insertAt = 0;
  next.forEach((n, i) => {
    if (subtree.has(n.id)) insertAt = i + 1;
  });
  next.splice(insertAt, 0, lane);
  return next;
}

/**
 * 泳道重排（FC-SWIM-03）：把 laneId 沿泳池方向上移/下移一位。
 * 泳道交换 order 与位置（累积偏移重排），尺寸各自保持，节点归属不变。
 */
export function reorderLane(
  nodes: readonly FlowchartNode[],
  poolId: string,
  laneId: string,
  direction: "forward" | "backward",
): FlowchartNode[] | null {
  const byId = byIdMap(nodes);
  const pool = byId.get(poolId);
  if (!pool || pool.container?.type !== "pool") return null;
  const orientation = pool.container.orientation;
  const header = pool.container.headerSize;
  const lanes = nodes
    .filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId)
    .sort((a, b) => laneOrder(a) - laneOrder(b));
  const idx = lanes.findIndex((l) => l.id === laneId);
  if (idx < 0) return null;
  const swapIdx = direction === "forward" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= lanes.length) return null;
  const arranged = [...lanes];
  [arranged[idx], arranged[swapIdx]] = [arranged[swapIdx], arranged[idx]];
  const updates = new Map<string, { position: { x: number; y: number }; order: number }>();
  let offset = 0;
  for (const [i, l] of arranged.entries()) {
    const s = nodeSize(l);
    updates.set(l.id, {
      position: orientation === "horizontal" ? { x: header, y: offset } : { x: offset, y: header },
      order: i,
    });
    offset += orientation === "horizontal" ? s.height : s.width;
  }
  return nodes.map((n) => {
    const u = updates.get(n.id);
    if (!u) return n;
    return { ...n, position: u.position, container: { type: "lane", orientation, order: u.order } };
  });
}

// ---------------------------------------------------------------------------
// 泳池 / 泳道尺寸调整（FC-SWIM-02）
// ---------------------------------------------------------------------------

/** 泳道沿泳池方向的最小尺寸（resize 保护，不产生负尺寸/重叠）。 */
export const FLOWCHART_LANE_MIN_EXTENT = 60;

/**
 * pool 尺寸变更后按策略分配 lane 尺寸（FC-SWIM-02）：
 * - 垂直泳池方向：所有 lane 跟随 pool 内容区（宽 = pool.w - header / 高 = pool.h - header）；
 * - 沿泳池方向：lanes 按原有比例缩放，每条保最小尺寸 FLOWCHART_LANE_MIN_EXTENT；
 * - lane 位置按 order 紧凑重排（lane 内子节点相对坐标不变，随 lane 平移）；
 * - 最小尺寸保护导致 lanes 总和超出新 pool 尺寸时，pool 取 lanes 总和（不产生负尺寸）。
 * 校验失败返回 null。
 */
export function resizePoolNodes(
  nodes: readonly FlowchartNode[],
  poolId: string,
  newPoolSize: { width: number; height: number },
): FlowchartNode[] | null {
  const byId = byIdMap(nodes);
  const pool = byId.get(poolId);
  if (!pool || pool.kind !== "swimlane-pool" || pool.container?.type !== "pool") return null;
  if (!Number.isFinite(newPoolSize.width) || !Number.isFinite(newPoolSize.height)) return null;
  if (newPoolSize.width <= 0 || newPoolSize.height <= 0) return null;
  const orientation = pool.container.orientation;
  const header = pool.container.headerSize;
  const oldSize = nodeSize(pool);
  const lanes = nodes
    .filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId)
    .sort((a, b) => laneOrder(a) - laneOrder(b));
  if (lanes.length === 0) {
    return nodes.map((n) => (n.id === poolId ? { ...n, size: { ...newPoolSize } } : n));
  }
  const oldExtent = orientation === "horizontal" ? oldSize.height : oldSize.width;
  const newExtent = orientation === "horizontal" ? newPoolSize.height : newPoolSize.width;
  const ratio = oldExtent > 0 ? newExtent / oldExtent : 1;
  const cross =
    orientation === "horizontal"
      ? round2(newPoolSize.width - header)
      : round2(newPoolSize.height - header);
  if (cross <= 0) return null;
  const laneUpdates = new Map<string, { position: { x: number; y: number }; size: { width: number; height: number } }>();
  let offset = 0;
  for (const lane of lanes) {
    const s = nodeSize(lane);
    const oldE = orientation === "horizontal" ? s.height : s.width;
    const e = Math.max(FLOWCHART_LANE_MIN_EXTENT, round2(oldE * ratio));
    laneUpdates.set(lane.id, {
      position: orientation === "horizontal" ? { x: header, y: offset } : { x: offset, y: header },
      size: orientation === "horizontal" ? { width: cross, height: e } : { width: e, height: cross },
    });
    offset += e;
  }
  const totalExtent = round2(offset);
  const finalPoolSize =
    orientation === "horizontal"
      ? { width: round2(newPoolSize.width), height: Math.max(round2(newPoolSize.height), totalExtent) }
      : { width: Math.max(round2(newPoolSize.width), totalExtent), height: round2(newPoolSize.height) };
  return nodes.map((n) => {
    if (n.id === poolId) return { ...n, size: finalPoolSize };
    const upd = laneUpdates.get(n.id);
    return upd ? { ...n, position: upd.position, size: upd.size } : n;
  });
}

/**
 * lane 尺寸变更（FC-SWIM-02）：
 * - 只允许沿泳池方向的维度变化（横向 lane 改高度、纵向 lane 改宽度）；
 *   另一维强制为 pool 内容区尺寸（忽略请求值）；
 * - 目标尺寸 clamp 到 FLOWCHART_LANE_MIN_EXTENT，不产生负尺寸；
 * - 其余 lane 尺寸不变，pool 沿方向尺寸取 lanes 总和，位置紧凑重排（不重叠）。
 * 校验失败返回 null。
 */
export function resizeLaneNodes(
  nodes: readonly FlowchartNode[],
  laneId: string,
  requested: { width: number; height: number },
): FlowchartNode[] | null {
  const byId = byIdMap(nodes);
  const lane = byId.get(laneId);
  if (!lane || lane.kind !== "swimlane-lane" || lane.container?.type !== "lane") return null;
  const poolId = lane.parentId;
  const pool = poolId ? byId.get(poolId) : undefined;
  if (!poolId || !pool || pool.kind !== "swimlane-pool" || pool.container?.type !== "pool") return null;
  const orientation = pool.container.orientation;
  const header = pool.container.headerSize;
  const poolSize = nodeSize(pool);
  const requestedExtent = orientation === "horizontal" ? requested.height : requested.width;
  if (!Number.isFinite(requestedExtent)) return null;
  const targetExtent = Math.max(FLOWCHART_LANE_MIN_EXTENT, round2(requestedExtent));
  const cross =
    orientation === "horizontal"
      ? round2(poolSize.width - header)
      : round2(poolSize.height - header);
  const lanes = nodes
    .filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId)
    .sort((a, b) => laneOrder(a) - laneOrder(b));
  const laneUpdates = new Map<string, { position: { x: number; y: number }; size: { width: number; height: number } }>();
  let offset = 0;
  for (const l of lanes) {
    const s = nodeSize(l);
    const e = l.id === laneId ? targetExtent : orientation === "horizontal" ? s.height : s.width;
    laneUpdates.set(l.id, {
      position: orientation === "horizontal" ? { x: header, y: offset } : { x: offset, y: header },
      size: orientation === "horizontal" ? { width: cross, height: e } : { width: e, height: cross },
    });
    offset += e;
  }
  const totalExtent = round2(offset);
  const newPoolSize =
    orientation === "horizontal"
      ? { width: poolSize.width, height: totalExtent }
      : { width: totalExtent, height: poolSize.height };
  return nodes.map((n) => {
    if (n.id === poolId) return { ...n, size: newPoolSize };
    const upd = laneUpdates.get(n.id);
    return upd ? { ...n, position: upd.position, size: upd.size } : n;
  });
}

// ---------------------------------------------------------------------------
// 安全删除（FC-SWIM-04）
// ---------------------------------------------------------------------------

export type RemoveLaneStrategy =
  | { type: "move-to-lane"; targetLaneId: string }
  | { type: "move-to-root" }
  | { type: "delete-content" };

/**
 * 删除泳道（FC-SWIM-04）。
 *
 * - move-to-lane：内容移到同池其他泳道，保持屏幕绝对位置；
 * - move-to-root：内容移到根画布，保持屏幕绝对位置；
 * - delete-content：连同内容删除（级联删除相关边）。
 *
 * 删除后泳池沿方向收缩，剩余泳道按 order 紧凑重排（其内部节点随泳道一起平移）。
 * 泳池无剩余泳道时一并删除泳池。目标泳道校验失败返回 null。
 */
export function removeLane(
  nodes: readonly FlowchartNode[],
  edges: readonly FlowchartEdge[],
  laneId: string,
  strategy: RemoveLaneStrategy,
): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } | null {
  const byId = byIdMap(nodes);
  const lane = byId.get(laneId);
  if (!lane || lane.kind !== "swimlane-lane" || lane.container?.type !== "lane") return null;
  const poolId = lane.parentId;
  const pool = poolId ? byId.get(poolId) : undefined;
  if (!poolId || !pool || pool.kind !== "swimlane-pool" || pool.container?.type !== "pool") return null;
  const orientation = pool.container.orientation;
  const header = pool.container.headerSize;
  const laneSize = nodeSize(lane);
  const laneAbs = flowchartNodeAbsolutePosition(nodes, laneId)!;

  const remainingLanes = nodes
    .filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId && n.id !== laneId)
    .sort((a, b) => laneOrder(a) - laneOrder(b));
  if (strategy.type === "move-to-lane") {
    const target = byId.get(strategy.targetLaneId);
    if (!target || target.parentId !== poolId || target.id === laneId) return null;
  }

  // 剩余泳道紧凑重排 + 泳池收缩
  const laneUpdates = new Map<string, { position: { x: number; y: number }; order: number }>();
  let offset = 0;
  for (const [i, l] of remainingLanes.entries()) {
    const s = nodeSize(l);
    laneUpdates.set(l.id, {
      position: orientation === "horizontal" ? { x: header, y: offset } : { x: offset, y: header },
      order: i,
    });
    offset += orientation === "horizontal" ? s.height : s.width;
  }
  const poolSize = nodeSize(pool);
  const newPoolSize =
    orientation === "horizontal"
      ? { width: poolSize.width, height: round2(poolSize.height - laneSize.height) }
      : { width: round2(poolSize.width - laneSize.width), height: poolSize.height };

  const dropContent = strategy.type === "delete-content";
  const gone = new Set<string>([laneId]);
  if (dropContent) {
    for (const n of nodes) {
      if (n.parentId === laneId) gone.add(n.id);
    }
  }
  if (remainingLanes.length === 0) gone.add(poolId);

  let nextNodes: FlowchartNode[] = [];
  for (const n of nodes) {
    if (gone.has(n.id)) continue;
    if (n.id === poolId) {
      nextNodes.push({ ...n, size: newPoolSize });
      continue;
    }
    const laneUpd = laneUpdates.get(n.id);
    if (laneUpd) {
      nextNodes.push({
        ...n,
        position: laneUpd.position,
        container: { type: "lane", orientation, order: laneUpd.order },
      });
      continue;
    }
    if (n.parentId === laneId && !dropContent) {
      const abs = { x: laneAbs.x + n.position.x, y: laneAbs.y + n.position.y };
      if (strategy.type === "move-to-root") {
        nextNodes.push({ ...n, parentId: undefined, position: abs });
      } else if (strategy.type === "move-to-lane") {
        const targetUpd = laneUpdates.get(strategy.targetLaneId)!;
        const targetAbs = {
          x: pool.position.x + targetUpd.position.x,
          y: pool.position.y + targetUpd.position.y,
        };
        nextNodes.push({
          ...n,
          parentId: strategy.targetLaneId,
          position: { x: round2(abs.x - targetAbs.x), y: round2(abs.y - targetAbs.y) },
        });
      }
      continue;
    }
    nextNodes.push(n);
  }
  // 泳池被删除时，其子树中尚存的节点（move-to-root 已处理的除外）不应残留；
  // 此处 remainingLanes 为空时所有 lane 已随 gone 移除，内容节点按策略均已处理。
  const nextEdges = edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
  return { nodes: nextNodes, edges: nextEdges };
}

export type RemovePoolStrategy = { type: "move-to-root" } | { type: "delete-content" };

/**
 * 删除泳池（FC-SWIM-04）。
 *
 * - move-to-root：全部泳道内普通节点移到根画布并保持绝对位置，泳池与泳道删除；
 * - delete-content：泳池、泳道、内容节点全部删除，相关边级联删除。
 */
export function removePool(
  nodes: readonly FlowchartNode[],
  edges: readonly FlowchartEdge[],
  poolId: string,
  strategy: RemovePoolStrategy,
): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } | null {
  const byId = byIdMap(nodes);
  const pool = byId.get(poolId);
  if (!pool || pool.kind !== "swimlane-pool") return null;
  const laneIds = new Set(
    nodes.filter((n) => n.kind === "swimlane-lane" && n.parentId === poolId).map((n) => n.id),
  );
  const gone = new Set<string>([poolId, ...laneIds]);
  if (strategy.type === "delete-content") {
    for (const n of nodes) {
      if (n.parentId !== undefined && laneIds.has(n.parentId)) gone.add(n.id);
    }
  }
  const nextNodes: FlowchartNode[] = [];
  for (const n of nodes) {
    if (gone.has(n.id)) continue;
    if (strategy.type === "move-to-root" && n.parentId !== undefined && laneIds.has(n.parentId)) {
      const abs = flowchartNodeAbsolutePosition(nodes, n.id)!;
      nextNodes.push({ ...n, parentId: undefined, position: abs });
      continue;
    }
    nextNodes.push(n);
  }
  const nextEdges = edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
  return { nodes: nextNodes, edges: nextEdges };
}
