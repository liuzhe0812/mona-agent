/**
 * WPS 风格自定义边组件：支持控制点拖动调整连接线形状。
 *
 * 1. 折线（smoothstep）：
 *    - 蓝色实心方块（1/2 中点）：选中后每条非 terminal 可视段中点显示；拖动后插入一个
 *      白色真实控制点（waypoint），路径经过此点重新路由。用 insertIndex 定位插入位置。
 *    - 白色空心方块（已有 waypoint）：可拖动调整位置（自由 x/y），双击删除。
 *    - 拐角点不单独显示操作点。
 * 2. 曲线（bezier）：渲染两个把手（cubic bezier 的 cp1/cp2），拖动把手调整曲线形状。
 *
 * 控制点坐标使用画布流坐标系（与节点 position 同坐标系）绝对坐标，存储到 FlowchartEdge.controlPoints。
 * 不参与语义哈希，仅影响渲染。
 */

import { Fragment, memo, useCallback, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  Position,
  getBezierPath,
  useReactFlow,
  useViewport,
} from "@xyflow/react";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 折线段长度阈值（px）：超过此长度的段才显示中点拖拽圆点 */
const SEGMENT_LENGTH_THRESHOLD = 32;

/** 折线圆角半径（px）*/
const SMOOTHSTEP_BORDER_RADIUS = 8;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface FlowchartControlEdgeData {
  /** 用户调整的控制点（流坐标系绝对坐标）*/
  controlPoints?: { x: number; y: number }[];
  /** 只读模式：禁用拖拽 */
  readOnly?: boolean;
  /** 边标签相对自动位置的像素偏移。 */
  labelOffset?: { x: number; y: number };
  /** 文档/受控节点计算出的可靠端点，避免 React Flow 节点重建期间复用旧测量。 */
  sourcePoint?: Point;
  targetPoint?: Point;
  /** 控制点实时变更回调（拖动期间高频触发，仅更新视图，不提交历史） */
  onControlPointsChange?: (
    edgeId: string,
    controlPoints: { x: number; y: number }[] | undefined,
  ) => void;
  /** 控制点提交回调（拖动结束时触发一次，提交到历史栈） */
  onControlPointsCommit?: (
    edgeId: string,
    controlPoints: { x: number; y: number }[] | undefined,
  ) => void;
  [key: string]: unknown;
}

export type Point = { x: number; y: number };

// ---------------------------------------------------------------------------
// memo 比较函数：避免 data 引用变化（每次 toFlowEdge 都创建新对象）导致的无效重渲染。
// 只比较有意义的字段：端点坐标、handle 方向、label、selected、style、marker、
// 以及 data 中的 controlPoints（深比较）和 readOnly。
// 回调函数（onControlPointsChange/Commit）不比较——它们通过闭包访问 ref，引用变化不影响行为。
// ---------------------------------------------------------------------------

function areEdgePropsEqual(prev: EdgeProps, next: EdgeProps): boolean {
  if (prev.id !== next.id) return false;
  if (prev.sourceX !== next.sourceX || prev.sourceY !== next.sourceY) return false;
  if (prev.targetX !== next.targetX || prev.targetY !== next.targetY) return false;
  if (prev.sourcePosition !== next.sourcePosition) return false;
  if (prev.targetPosition !== next.targetPosition) return false;
  if (prev.label !== next.label) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.style !== next.style) return false;
  if (prev.markerEnd !== next.markerEnd) return false;
  if (prev.markerStart !== next.markerStart) return false;
  // data 深比较：controlPoints + readOnly
  const pd = (prev.data ?? {}) as FlowchartControlEdgeData;
  const nd = (next.data ?? {}) as FlowchartControlEdgeData;
  if (pd.readOnly !== nd.readOnly) return false;
  if (pd.labelOffset?.x !== nd.labelOffset?.x || pd.labelOffset?.y !== nd.labelOffset?.y) return false;
  if (pd.sourcePoint?.x !== nd.sourcePoint?.x || pd.sourcePoint?.y !== nd.sourcePoint?.y) return false;
  if (pd.targetPoint?.x !== nd.targetPoint?.x || pd.targetPoint?.y !== nd.targetPoint?.y) return false;
  const pc = pd.controlPoints;
  const nc = nd.controlPoints;
  if (pc === nc) return true;
  if (!pc || !nc || pc.length !== nc.length) return false;
  for (let i = 0; i < pc.length; i++) {
    if (pc[i].x !== nc[i].x || pc[i].y !== nc[i].y) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 反转 Position：Top↔Bottom、Left↔Right */
function oppositePosition(pos: Position): Position {
  switch (pos) {
    case Position.Top:
      return Position.Bottom;
    case Position.Bottom:
      return Position.Top;
    case Position.Left:
      return Position.Right;
    case Position.Right:
      return Position.Left;
  }
}

/** 根据 dx/dy 推断主导方向（用于无明确 handle 方向的中间点）。
 *  dx 占优返回 Left/Right；dy 占优返回 Top/Bottom；默认返回 Bottom */
function dominantPosition(from: Point, to: Point): Position {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (dx > dy) {
    return to.x >= from.x ? Position.Right : Position.Left;
  }
  return to.y >= from.y ? Position.Bottom : Position.Top;
}

// ---------------------------------------------------------------------------
// 正交折线可视几何（移植自 @xyflow/system 的 getPoints / getBend）
//
// 段中点把手与拖拽必须基于「实际渲染出来的可视折线」计算：xyflow 的折线路径会在
// 端点处加 gap 偏移并自动产生拐角，逻辑点对连线的中点往往不在可视折线上（把手悬空），
// 必须先把可视顶点算出来，再在可视段上放把手。
// ---------------------------------------------------------------------------

const HANDLE_DIRECTIONS: Record<Position, Point> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

/** 端点 gap 偏移（px）：与 xyflow getSmoothStepPath 的 offset 默认值一致 */
const EDGE_GAP_OFFSET = 20;

/** 移植 xyflow getDirection：根据 handle 方向返回目标相对来源的主导方向向量 */
function getOrthoDirection(source: Point, sourcePosition: Position, target: Point): Point {
  if (sourcePosition === Position.Left || sourcePosition === Position.Right) {
    return source.x < target.x ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  return source.y < target.y ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

/** 移植 xyflow getPoints：一对端点之间的正交折线可视顶点（含起终点、gap 点、拐角点） */
function getPairVisualPoints(
  source: Point,
  sourcePosition: Position,
  target: Point,
  targetPosition: Position,
  offset: number,
): Point[] {
  const sourceDir = HANDLE_DIRECTIONS[sourcePosition];
  const targetDir = HANDLE_DIRECTIONS[targetPosition];
  const sourceGapped = { x: source.x + sourceDir.x * offset, y: source.y + sourceDir.y * offset };
  const targetGapped = { x: target.x + targetDir.x * offset, y: target.y + targetDir.y * offset };
  const dir = getOrthoDirection(sourceGapped, sourcePosition, targetGapped);
  const dirAccessor: "x" | "y" = dir.x !== 0 ? "x" : "y";
  const currDir = dir[dirAccessor];

  let points: Point[];
  const sourceGapOffset = { x: 0, y: 0 };
  const targetGapOffset = { x: 0, y: 0 };

  // 相对的 handle 方向（默认情形）
  if (sourceDir[dirAccessor] * targetDir[dirAccessor] === -1) {
    let centerX: number;
    let centerY: number;
    if (dirAccessor === "x") {
      centerX = sourceGapped.x + (targetGapped.x - sourceGapped.x) * 0.5;
      centerY = (sourceGapped.y + targetGapped.y) / 2;
    } else {
      centerX = (sourceGapped.x + targetGapped.x) / 2;
      centerY = sourceGapped.y + (targetGapped.y - sourceGapped.y) * 0.5;
    }
    const verticalSplit = [
      { x: centerX, y: sourceGapped.y },
      { x: centerX, y: targetGapped.y },
    ];
    const horizontalSplit = [
      { x: sourceGapped.x, y: centerY },
      { x: targetGapped.x, y: centerY },
    ];
    if (sourceDir[dirAccessor] === currDir) {
      points = dirAccessor === "x" ? verticalSplit : horizontalSplit;
    } else {
      points = dirAccessor === "x" ? horizontalSplit : verticalSplit;
    }
  } else {
    // sourceTarget 取 source 的 x + target 的 y，targetSource 反之
    const sourceTarget = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource = [{ x: targetGapped.x, y: sourceGapped.y }];
    // 相同 handle 方向
    if (dirAccessor === "x") {
      points = sourceDir.x === currDir ? targetSource : sourceTarget;
    } else {
      points = sourceDir.y === currDir ? sourceTarget : targetSource;
    }
    if (sourcePosition === targetPosition) {
      // 同向 handle 且间距小于 offset 时 gap 点会重叠导致路径怪异，补 gapOffset 让开
      const diff = Math.abs(source[dirAccessor] - target[dirAccessor]);
      if (diff <= offset) {
        const gapOffset = Math.min(offset - 1, offset - diff);
        if (sourceDir[dirAccessor] === currDir) {
          sourceGapOffset[dirAccessor] =
            (sourceGapped[dirAccessor] > source[dirAccessor] ? -1 : 1) * gapOffset;
        } else {
          targetGapOffset[dirAccessor] =
            (targetGapped[dirAccessor] > target[dirAccessor] ? -1 : 1) * gapOffset;
        }
      }
    }
    // 混合 handle 方向（如 Right → Bottom）
    if (sourcePosition !== targetPosition) {
      const dirAccessorOpposite: "x" | "y" = dirAccessor === "x" ? "y" : "x";
      const isSameDir = sourceDir[dirAccessor] === targetDir[dirAccessorOpposite];
      const sourceGtTargetOppo =
        sourceGapped[dirAccessorOpposite] > targetGapped[dirAccessorOpposite];
      const sourceLtTargetOppo =
        sourceGapped[dirAccessorOpposite] < targetGapped[dirAccessorOpposite];
      const flipSourceTarget =
        (sourceDir[dirAccessor] === 1 &&
          ((!isSameDir && sourceGtTargetOppo) || (isSameDir && sourceLtTargetOppo))) ||
        (sourceDir[dirAccessor] !== 1 &&
          ((!isSameDir && sourceLtTargetOppo) || (isSameDir && sourceGtTargetOppo)));
      if (flipSourceTarget) {
        points = dirAccessor === "x" ? sourceTarget : targetSource;
      }
    }
  }

  const gappedSource = {
    x: sourceGapped.x + sourceGapOffset.x,
    y: sourceGapped.y + sourceGapOffset.y,
  };
  const gappedTarget = {
    x: targetGapped.x + targetGapOffset.x,
    y: targetGapped.y + targetGapOffset.y,
  };
  const first = points[0];
  const last = points[points.length - 1];
  const raw: (Point | null)[] = [
    source,
    // 与拐角重合时省略 gap 点，避免重复顶点产生多余拐弯
    first && (gappedSource.x !== first.x || gappedSource.y !== first.y) ? gappedSource : null,
    ...points,
    last && (gappedTarget.x !== last.x || gappedTarget.y !== last.y) ? gappedTarget : null,
    target,
  ];
  // 去重相邻重复点（共线点对会产生退化的重复中间点，如 (170,70),(170,70)）
  const out: Point[] = [];
  for (const p of raw) {
    if (!p) continue;
    const prev = out[out.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    out.push(p);
  }
  return out;
}

/** 移植 xyflow getBend：在顶点 b 处生成带圆角的拐弯路径片段 */
function getBend(a: Point, b: Point, c: Point, size: number): string {
  const bendSize = Math.min(dist(a, b) / 2, dist(b, c) / 2, size);
  const { x, y } = b;
  // 共线：无拐弯
  if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) {
    return `L${x} ${y}`;
  }
  // 前一段水平
  if (a.y === y) {
    const xDir = a.x < c.x ? -1 : 1;
    const yDir = a.y < c.y ? 1 : -1;
    return `L ${x + bendSize * xDir},${y}Q ${x},${y} ${x},${y + bendSize * yDir}`;
  }
  const xDir = a.x < c.x ? 1 : -1;
  const yDir = a.y < c.y ? -1 : 1;
  return `L ${x},${y + bendSize * yDir}Q ${x},${y} ${x + bendSize * xDir},${y}`;
}

/** 可视折线上的一段（把手挂载单位） */
export interface VisualSegment {
  from: Point;
  to: Point;
  mid: Point;
  length: number;
  /** 所属逻辑点对下标（controlPoints 的插入/移动定位用） */
  insertIndex: number;
  /** 贴 source/target 的 terminal stub 段不可拖 */
  terminal: boolean;
  /** from 端是 source 节点（不可移动，需物化为 CP） */
  fromIsSource: boolean;
  /** to 端是 target 节点（不可移动，需物化为 CP） */
  toIsTarget: boolean;
}

export interface EdgeGeometry {
  path: string;
  segments: VisualSegment[];
}

/** 合并共线的相邻段：确保一条直线上只产生一个段、一个蓝色中点。
 *  mergeCollinear 可能因 getPairVisualPoints 生成的拐角点不共线而遗漏，
 *  这里作为兜底：如果前一段和当前段在同一条直线上（同 x 或同 y）且端点连续，
 *  直接扩展前一段的 to，不新增段。insertIndex 取前一段的（第一个匹配的逻辑点对）。
 *  这样 materializeEndpoints 也能拿到正确的插入位置，避免 controlPoints 顺序错乱。 */
export function mergeCollinearSegments(segments: VisualSegment[]): VisualSegment[] {
  if (segments.length <= 1) return segments;
  const result: VisualSegment[] = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const s = segments[i];
    // 连续性：前一段的 to === 当前段的 from
    const continuous = prev.to.x === s.from.x && prev.to.y === s.from.y;
    if (!continuous) {
      result.push({ ...s });
      continue;
    }
    // 共线：两段都水平且 y 相同，或都垂直且 x 相同
    const sameHorizontal =
      prev.from.y === prev.to.y && s.from.y === s.to.y && prev.from.y === s.from.y;
    const sameVertical =
      prev.from.x === prev.to.x && s.from.x === s.to.x && prev.from.x === s.from.x;
    if (sameHorizontal || sameVertical) {
      // 合并：扩展 prev 的 to，重新计算 mid 和 length
      prev.to = s.to;
      prev.mid = { x: (prev.from.x + prev.to.x) / 2, y: (prev.from.y + prev.to.y) / 2 };
      prev.length = dist(prev.from, prev.to);
      prev.toIsTarget = s.toIsTarget;
      prev.terminal = prev.terminal || s.terminal;
    } else {
      result.push({ ...s });
    }
  }
  return result;
}

/** polyline 顶点：标记是否为逻辑点（source/CP/target，不可合并） */
export interface PolylineVertex {
  point: Point;
  isLogical: boolean;
}

/** 合并共线顶点：如果 a→b→c 共线，跳过 b（无论是否逻辑点）。
 *  共线的 CP 会被 normalizeControlPoints 在提交时清理，
 *  渲染期间也应合并以保证一条直线只产生一个段、一个中点把手。 */
export function mergeCollinear(vertices: PolylineVertex[]): Point[] {
  if (vertices.length <= 2) return vertices.map((v) => v.point);
  const result: Point[] = [vertices[0].point];
  for (let i = 1; i < vertices.length - 1; i++) {
    const a = result[result.length - 1];
    const b = vertices[i].point;
    const c = vertices[i + 1].point;
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
      continue;
    }
    result.push(b);
  }
  result.push(vertices[vertices.length - 1].point);
  return result;
}

/** 计算整条边的可视几何。
 *  逐逻辑点对用 xyflow 同款算法算可视顶点，拼接后合并共线虚拟拐角（仅合并非逻辑点），
 *  基于合并后的 polyline 生成 path 和 segments。
 *  每个段携带 insertIndex（= 所属逻辑点对下标），蓝色点拖动时直接用此下标插入 waypoint。
 *  stub 段（贴 source/target）标记 terminal，不显示蓝色点。 */
export function buildEdgeGeometry(
  logicalPoints: Point[],
  sourcePos: Position,
  targetPos: Position,
): EdgeGeometry {
  const vertices: PolylineVertex[] = [];

  for (let i = 0; i < logicalPoints.length - 1; i++) {
    const isFirst = i === 0;
    const isLast = i === logicalPoints.length - 2;
    const dom = dominantPosition(logicalPoints[i], logicalPoints[i + 1]);
    const pairPoints = getPairVisualPoints(
      logicalPoints[i],
      isFirst ? sourcePos : dom,
      logicalPoints[i + 1],
      isLast ? targetPos : oppositePosition(dom),
      EDGE_GAP_OFFSET,
    );
    // 拼接可视折线，标记逻辑点
    for (let j = 0; j < pairPoints.length; j++) {
      const p = pairPoints[j];
      if (i > 0 && j === 0) continue;
      const prev = vertices[vertices.length - 1];
      if (prev && prev.point.x === p.x && prev.point.y === p.y) continue;
      const isLogical = j === 0 || j === pairPoints.length - 1;
      vertices.push({ point: p, isLogical });
    }
  }

  // 合并共线虚拟拐角
  const polyline = mergeCollinear(vertices);

  // 生成 path（带圆角）
  let path = "";
  const firstPt = polyline[0];
  const lastPt = polyline[polyline.length - 1];
  if (firstPt && lastPt) {
    path = `M${firstPt.x} ${firstPt.y}`;
    for (let i = 1; i < polyline.length - 1; i++) {
      path += getBend(polyline[i - 1], polyline[i], polyline[i + 1], SMOOTHSTEP_BORDER_RADIUS);
    }
    if (polyline.length > 1) {
      path += `L${lastPt.x} ${lastPt.y}`;
    }
  }

  // 为每个可视段计算 insertIndex 和 terminal
  // insertIndex = 该段所属的逻辑点对下标 i，新 waypoint 插入 controlPoints[i]
  // 通过段端点坐标匹配逻辑点对来确定
  const numCPs = logicalPoints.length - 2; // 去掉 source 和 target
  const segments: VisualSegment[] = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    const from = polyline[i];
    const to = polyline[i + 1];
    const length = dist(from, to);
    if (length === 0) continue;

    // 确定该段属于哪个逻辑点对
    // 逻辑点对 i 连接 logicalPoints[i] → logicalPoints[i+1]
    // 段的 from/to 坐标在逻辑点对 i 的可视折线范围内时，insertIndex = i
    let insertIndex = -1;
    // 简单策略：遍历逻辑点对，找到第一个包含该段的范围
    for (let pairIdx = 0; pairIdx < logicalPoints.length - 1; pairIdx++) {
      const lpFrom = logicalPoints[pairIdx];
      const lpTo = logicalPoints[pairIdx + 1];
      // 段端点在逻辑点对连线方向上的投影区间内
      const minX = Math.min(lpFrom.x, lpTo.x) - EDGE_GAP_OFFSET;
      const maxX = Math.max(lpFrom.x, lpTo.x) + EDGE_GAP_OFFSET;
      const minY = Math.min(lpFrom.y, lpTo.y) - EDGE_GAP_OFFSET;
      const maxY = Math.max(lpFrom.y, lpTo.y) + EDGE_GAP_OFFSET;
      if (from.x >= minX - 1 && from.x <= maxX + 1 && from.y >= minY - 1 && from.y <= maxY + 1 &&
          to.x >= minX - 1 && to.x <= maxX + 1 && to.y >= minY - 1 && to.y <= maxY + 1) {
        insertIndex = pairIdx;
        break;
      }
    }
    // fallback：用段在 polyline 中的位置估算
    if (insertIndex < 0) {
      insertIndex = Math.min(i, numCPs);
    }

    // fromIsSource: from 坐标等于 source 坐标
    const fromIsSource = from.x === logicalPoints[0].x && from.y === logicalPoints[0].y;
    // toIsTarget: to 坐标等于 target 坐标
    const toIsTarget =
      to.x === logicalPoints[logicalPoints.length - 1].x &&
      to.y === logicalPoints[logicalPoints.length - 1].y;

    // terminal：仅标记 target gap stub（末段贴 target 的短桩，不可拖）。
    // 例外：如果整条折线只有 1 个段（source→target 直连），它不是 terminal，应可编辑。
    const terminal = toIsTarget && polyline.length > 2;

    segments.push({
      from,
      to,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      length,
      insertIndex,
      terminal,
      fromIsSource,
      toIsTarget,
    });
  }

  // 兜底：合并共线相邻段，确保一条直线上只有一个段、一个蓝色中点。
  // mergeCollinear 可能因 getPairVisualPoints 生成的拐角点不共线而遗漏。
  return { path, segments: mergeCollinearSegments(segments) };
}

// ---------------------------------------------------------------------------
// 路径归一化：三条规则
// ---------------------------------------------------------------------------

/** 归一化 controlPoints（不含 source/target）。
 *  规则 1：删除相邻重复点
 *  规则 2：删除三点共线的中间点（不含 source/target，因为它们不在 cps 数组里）
 *  规则 3：发现非相邻同轴线段重叠时，删除中间折返回路
 *  找到第一个可消除回路就合并，然后重新扫描，不做候选评分。 */
export function normalizeControlPoints(
  cps: Point[],
  source: Point,
  target: Point,
): Point[] {
  // 完整顶点序列 = source + cps + target
  let pts = [source, ...cps, target];

  let changed = true;
  while (changed) {
    changed = false;

    // 规则 1：删除相邻重复点
    const deduped: Point[] = [];
    for (const p of pts) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.x === p.x && prev.y === p.y) {
        changed = true;
        continue;
      }
      deduped.push(p);
    }
    pts = deduped;

    // 规则 2：删除三点共线的中间点（保留 source 和 target）
    const colCleaned: Point[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = colCleaned[colCleaned.length - 1];
      const b = pts[i];
      const c = pts[i + 1];
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
        changed = true;
        continue;
      }
      colCleaned.push(b);
    }
    colCleaned.push(pts[pts.length - 1]);
    pts = colCleaned;

    // 规则 3：非相邻同轴线段重叠 → 删除中间折返回路
    // 检查段 i 和段 j（j > i+1），如果同轴（同 x 或同 y）且方向相同且投影重叠，
    // 则删除段 i+1 到段 j 之间的所有顶点，直接连接
    for (let i = 0; i < pts.length - 2; i++) {
      let merged = false;
      for (let j = i + 2; j < pts.length - 1; j++) {
        const segA = { from: pts[i], to: pts[i + 1] };
        const segB = { from: pts[j], to: pts[j + 1] };
        // 同轴：两段都是水平（y 相同）或都是垂直（x 相同）
        const aHoriz = segA.from.y === segA.to.y;
        const bHoriz = segB.from.y === segB.to.y;
        const aVert = segA.from.x === segA.to.x;
        const bVert = segB.from.x === segB.to.x;
        if (!((aHoriz && bHoriz && segA.from.y === segB.from.y) ||
              (aVert && bVert && segA.from.x === segB.from.x))) {
          continue;
        }
        // 投影重叠检查
        const axis: "x" | "y" = aHoriz ? "x" : "y";
        const aMin = Math.min(segA.from[axis], segA.to[axis]);
        const aMax = Math.max(segA.from[axis], segA.to[axis]);
        const bMin = Math.min(segB.from[axis], segB.to[axis]);
        const bMax = Math.max(segB.from[axis], segB.to[axis]);
        if (aMax < bMin || bMax < aMin) continue; // 无重叠

        // 检查中间路径是否构成完整回路（i→i+1...j→j+1 必须形成折返回路）
        // 简单验证：中间段的端点必须能连回
        // 删除 pts[i+1..j]，用新点连接 pts[i] → pts[j+1]
        // 新点取重叠区间的交点
        const overlapMin = Math.max(aMin, bMin);
        const overlapMax = Math.min(aMax, bMax);
        if (aHoriz) {
          // 水平段重叠，y 相同
          const newPt1 = { x: overlapMin, y: segA.from.y };
          const newPt2 = { x: overlapMax, y: segA.from.y };
          pts = [...pts.slice(0, i + 1), newPt1, newPt2, ...pts.slice(j + 1)];
        } else {
          // 垂直段重叠，x 相同
          const newPt1 = { x: segA.from.x, y: overlapMin };
          const newPt2 = { x: segA.from.x, y: overlapMax };
          pts = [...pts.slice(0, i + 1), newPt1, newPt2, ...pts.slice(j + 1)];
        }
        changed = true;
        merged = true;
        break;
      }
      if (merged) break;
    }
  }

  // 去掉 source 和 target，返回中间点
  return pts.slice(1, -1);
}

// ---------------------------------------------------------------------------
// 拖拽 Hook
// ---------------------------------------------------------------------------

/** 通用拖拽逻辑：在 SVG/HTML 元素上监听 pointerdown，触发 onDragStart(startPos) → onMove(pos) → onEnd(lastPos)。
 *  使用屏幕坐标到流坐标的转换，支持画布缩放。
 *  onEnd 在 pointerup 时触发，接收最后一个 pos（用于"提交"语义）。
 *  Escape / pointercancel 取消拖拽，不触发 onEnd。 */
function useFlowDrag(
  onMove: (pos: Point) => void,
  onEnd?: (lastPos: Point) => void,
  onDragStart?: (startPos: Point) => void,
) {
  const { screenToFlowPosition } = useReactFlow();
  const draggingRef = useRef(false);
  const lastPosRef = useRef<Point | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // 阻止画布拖拽和边选择
      event.stopPropagation();
      event.preventDefault();
      draggingRef.current = true;
      setIsDragging(true);
      const startPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      lastPosRef.current = startPos;
      onDragStart?.(startPos);
      const handleMove = (e: PointerEvent) => {
        if (!draggingRef.current) return;
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        lastPosRef.current = pos;
        onMove(pos);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("keydown", handleKeyDown);
      };
      const handleCancel = () => {
        cleanup();
        draggingRef.current = false;
        setIsDragging(false);
        lastPosRef.current = null;
      };
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") handleCancel();
      };
      const handleUp = () => {
        if (!draggingRef.current) return;
        cleanup();
        draggingRef.current = false;
        setIsDragging(false);
        if (lastPosRef.current) onEnd?.(lastPosRef.current);
        lastPosRef.current = null;
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("keydown", handleKeyDown);
    },
    [screenToFlowPosition, onMove, onEnd, onDragStart],
  );

  return { onPointerDown, isDragging };
}

// ---------------------------------------------------------------------------
// 折线边（带分段控制点）
// ---------------------------------------------------------------------------

export const SmoothstepControlEdge = memo(function SmoothstepControlEdge(
  props: EdgeProps,
) {
  const {
    id,
    sourceX: measuredSourceX,
    sourceY: measuredSourceY,
    targetX: measuredTargetX,
    targetY: measuredTargetY,
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
    style,
    markerEnd,
    markerStart,
    label,
    labelStyle,
    labelShowBg,
    labelBgStyle,
    labelBgPadding,
    labelBgBorderRadius,
    data,
    selected,
  } = props;

  const d = (data ?? {}) as FlowchartControlEdgeData;
  const controlPoints = d.controlPoints ?? [];
  const readOnly = d.readOnly === true;
  const onControlPointsChange = d.onControlPointsChange;
  const onControlPointsCommit = d.onControlPointsCommit;
  const labelOffset = d.labelOffset ?? { x: 0, y: 0 };
  const sourceX = d.sourcePoint?.x ?? measuredSourceX;
  const sourceY = d.sourcePoint?.y ?? measuredSourceY;
  const targetX = d.targetPoint?.x ?? measuredTargetX;
  const targetY = d.targetPoint?.y ?? measuredTargetY;

  // 完整路径点：source → controlPoints → target
  const points: Point[] = useMemo(
    () => [{ x: sourceX, y: sourceY }, ...controlPoints, { x: targetX, y: targetY }],
    [sourceX, sourceY, targetX, targetY, controlPoints],
  );

  // 边的可视几何：SVG path + 可视段。段中点把手基于实际渲染的折线段，
  // 保证把手落在路径上（逻辑点对连线的中点会悬空）。
  const { path, segments } = useMemo(
    () => buildEdgeGeometry(points, sourcePosition, targetPosition),
    [points, sourcePosition, targetPosition],
  );

  // label 位置取最长可视段的中点：保证在路径上且不被端点节点遮挡
  const [labelX, labelY] = useMemo(() => {
    let longest: VisualSegment | null = null;
    for (const s of segments) {
      if (!longest || s.length > longest.length) longest = s;
    }
    return longest
      ? ([longest.mid.x + labelOffset.x, longest.mid.y + labelOffset.y] as const)
      : ([(sourceX + targetX) / 2 + labelOffset.x, (sourceY + targetY) / 2 + labelOffset.y] as const);
  }, [segments, sourceX, sourceY, targetX, targetY, labelOffset.x, labelOffset.y]);

  // dragRef：统一管理拖拽状态
  // 蓝色（1/2 中点）→ 整段平移（from + to 同步移动，垂直于段方向）
  // 白色（1/4 点）→ 只移动 from 端
  // 白色（3/4 点）→ 只移动 to 端
  const { screenToFlowPosition, setEdges } = useReactFlow();
  const { zoom } = useViewport();
  const [hoveredSegmentIdx, setHoveredSegmentIdx] = useState<number | null>(null);
  const [edgeHovered, setEdgeHovered] = useState(false);
  const dragRef = useRef<{
    segment: VisualSegment;
    startFlow: Point;
    originalCps: Point[];     // 拖拽前的 controlPoints（取消时恢复）
    materializedCps: Point[];  // 物化后的 controlPoints（from/to 不是 CP 时插入新点）
    fromIdx: number;          // from 端在 materializedCps 中的下标（-1 = 不移动）
    toIdx: number;            // to 端在 materializedCps 中的下标（-1 = 不移动）
    dragAxis: "x" | "y";      // 拖动轴（垂直于段方向）
    fromBase: Point;          // from 端原始位置
    toBase: Point;            // to 端原始位置
    started: boolean;
  } | null>(null);
  const controlPointsRef = useRef(controlPoints);
  controlPointsRef.current = controlPoints;

  // zoom 感知阈值
  const zoomAwareThreshold = zoom > 0 ? SEGMENT_LENGTH_THRESHOLD / zoom : SEGMENT_LENGTH_THRESHOLD;

  /** 物化段端点：如果 from/to 不是已有 CP，插入新 CP。
   *  坐标匹配查找已有 CP；虚拟拐角插入到 insertIndex 位置
   * （pair i 的虚拟拐角在 CP[i-1] 和 CP[i] 之间，即下标 i）。 */
  function materializeEndpoints(
    segment: VisualSegment,
    cps: Point[],
    moveFrom: boolean,
    moveTo: boolean,
  ): { cps: Point[]; fromIdx: number; toIdx: number } {
    const next = [...cps];
    let fromIdx = -1;
    let toIdx = -1;
    // from 插入后后续 CP 下标偏移 +1，to 的插入位置需要加这个偏移
    let offset = 0;

    const findCp = (p: Point) =>
      next.findIndex(cp => Math.abs(cp.x - p.x) < 0.5 && Math.abs(cp.y - p.y) < 0.5);

    if (moveFrom) {
      if (segment.fromIsSource) {
        next.unshift({ x: segment.from.x, y: segment.from.y });
        fromIdx = 0;
        offset = 1;
      } else {
        const existing = findCp(segment.from);
        if (existing >= 0) {
          fromIdx = existing;
        } else {
          // 虚拟拐角：pair insertIndex 的 from 虚拟拐角应在 CP[insertIndex-1] 之后，
          // 即插入到 CP[insertIndex] 之前
          const insertPos = Math.min(segment.insertIndex, next.length);
          next.splice(insertPos, 0, { x: segment.from.x, y: segment.from.y });
          fromIdx = insertPos;
          offset = 1;
        }
      }
    }

    if (moveTo) {
      if (segment.toIsTarget) {
        toIdx = next.length;
        next.push({ x: segment.to.x, y: segment.to.y });
      } else {
        const existing = findCp(segment.to);
        if (existing >= 0) {
          toIdx = existing;
        } else {
          // 虚拟拐角：pair insertIndex 的 to 虚拟拐角也在 CP[insertIndex] 之前，
          // 但 from 刚插入占了 insertIndex 位置，to 插入到 insertIndex + offset
          const insertPos = Math.min(segment.insertIndex + offset, next.length);
          next.splice(insertPos, 0, { x: segment.to.x, y: segment.to.y });
          toIdx = insertPos;
        }
      }
    }

    return { cps: next, fromIdx, toIdx };
  }

  /** 统一拖拽入口：蓝色（both）、白色 1/4（from only）、白色 3/4（to only） */
  const handleSegmentPointerDown = useCallback(
    (segment: VisualSegment, mode: "blue" | "white-quarter" | "white-three-quarter", event: React.PointerEvent) => {
      if (readOnly || !onControlPointsChange) return;
      event.stopPropagation();
      event.preventDefault();

      // source/target 端不物化：它们固定在节点 handle 上，移动后路由仍按
      // sourcePosition/targetPosition 生成 gap stub，会产生 S 型弯。
      // 例外：直连线（两端都是 source/target）必须物化两端才能创建 CP。
      const bothFixed = segment.fromIsSource && segment.toIsTarget;
      const moveFrom = (mode === "blue" || mode === "white-quarter") && (!segment.fromIsSource || bothFixed);
      const moveTo = (mode === "blue" || mode === "white-three-quarter") && (!segment.toIsTarget || bothFixed);

      // 拖动轴：水平段 → y 轴；垂直段 → x 轴
      const dragAxis: "x" | "y" =
        Math.abs(segment.to.y - segment.from.y) < 0.5 ? "y" : "x";

      const originalCps = [...controlPointsRef.current];
      const startFlow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      dragRef.current = {
        segment,
        startFlow,
        originalCps,
        materializedCps: originalCps,
        fromIdx: -1,
        toIdx: -1,
        dragAxis,
        fromBase: { x: segment.from.x, y: segment.from.y },
        toBase: { x: segment.to.x, y: segment.to.y },
        started: false,
      };

      const startClient = { x: event.clientX, y: event.clientY };

      const handleMove = (e: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (!drag.started) {
          if (Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < 3) return;
          drag.started = true;
          // 首次移动：物化端点
          const mat = materializeEndpoints(drag.segment, drag.originalCps, moveFrom, moveTo);
          drag.materializedCps = mat.cps;
          drag.fromIdx = mat.fromIdx;
          drag.toIdx = mat.toIdx;
        }

        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const delta = drag.dragAxis === "x" ? pos.x - drag.startFlow.x : pos.y - drag.startFlow.y;

        const cps = [...drag.materializedCps];
        if (drag.fromIdx >= 0 && cps[drag.fromIdx]) {
          cps[drag.fromIdx] =
            drag.dragAxis === "x"
              ? { x: drag.fromBase.x + delta, y: drag.fromBase.y }
              : { x: drag.fromBase.x, y: drag.fromBase.y + delta };
        }
        if (drag.toIdx >= 0 && cps[drag.toIdx]) {
          cps[drag.toIdx] =
            drag.dragAxis === "x"
              ? { x: drag.toBase.x + delta, y: drag.toBase.y }
              : { x: drag.toBase.x, y: drag.toBase.y + delta };
        }
        controlPointsRef.current = cps;
        onControlPointsChange(id, cps);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("keydown", handleKeyDown);
      };
      const handleCancel = () => {
        cleanup();
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag?.started) return;
        controlPointsRef.current = drag.originalCps;
        onControlPointsChange(id, drag.originalCps);
      };
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") handleCancel();
      };
      const handleUp = () => {
        cleanup();
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag?.started) return;
        const final = normalizeControlPoints(
          controlPointsRef.current,
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY },
        );
        controlPointsRef.current = final;
        onControlPointsCommit?.(id, final.length > 0 ? final : undefined);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("keydown", handleKeyDown);
    },
    [readOnly, onControlPointsChange, onControlPointsCommit, id, screenToFlowPosition, sourceX, sourceY, targetX, targetY],
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        labelX={labelX}
        labelY={labelY}
        label={label}
        labelStyle={labelStyle}
        labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        style={style}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {!readOnly && (
        <EdgeLabelRenderer>
          {segments
            .filter((s) => !s.terminal && s.length > zoomAwareThreshold)
            .map((s, idx) => {
              // 1/4 和 3/4 位置
              const quarter = {
                x: s.from.x + (s.to.x - s.from.x) * 0.25,
                y: s.from.y + (s.to.y - s.from.y) * 0.25,
              };
              const threeQuarter = {
                x: s.from.x + (s.to.x - s.from.x) * 0.75,
                y: s.from.y + (s.to.y - s.from.y) * 0.75,
              };
              const isHovered = hoveredSegmentIdx === idx;
              const showHandles = selected === true || (edgeHovered && isHovered);
              const isHorizontal = Math.abs(s.to.y - s.from.y) < 0.5;
              return (
                <Fragment key={`seg-${idx}`}>
                  {/* 蓝色 1/2 中点：选中时全部显示，hover 时显示当前段。
                      点击拖动时自动选中边。 */}
                  {showHandles && (
                    <div style={{ position: "relative", zIndex: 2 }}>
                      <SegmentHandle
                        x={s.mid.x}
                        y={s.mid.y}
                        variant="blue"
                        onPointerDown={(e) => {
                          // 选中边 + 开始拖动
                          if (selected !== true) {
                            setEdges((edges) =>
                              edges.map((ed) =>
                                ed.id === id ? { ...ed, selected: true } : { ...ed, selected: false },
                              ),
                            );
                          }
                          handleSegmentPointerDown(s, "blue", e);
                        }}
                      />
                    </div>
                  )}
                  {/* 白色 1/4 点：只在 hover 的那段显示。from 是 source 时不显示（除非直连线）。
                      白色点需 onPointerEnter 重新设置 hover——光标从热区移到白色点时，
                      热区 pointerleave 会清除 hover，导致白色点消失无法点击。 */}
                  {showHandles && isHovered && (!s.fromIsSource || (s.fromIsSource && s.toIsTarget)) && (
                    <div style={{ position: "relative", zIndex: 3 }}>
                      <SegmentHandle
                        x={quarter.x}
                        y={quarter.y}
                        variant="white"
                        onPointerDown={(e) => handleSegmentPointerDown(s, "white-quarter", e)}
                        onPointerEnter={() => {
                          setHoveredSegmentIdx(idx);
                          setEdgeHovered(true);
                        }}
                        onPointerLeave={() => {
                          setHoveredSegmentIdx(null);
                          setEdgeHovered(false);
                        }}
                      />
                    </div>
                  )}
                  {/* 白色 3/4 点：只在 hover 的那段显示。to 是 target 时不显示（除非直连线） */}
                  {showHandles && isHovered && (!s.toIsTarget || (s.fromIsSource && s.toIsTarget)) && (
                    <div style={{ position: "relative", zIndex: 3 }}>
                      <SegmentHandle
                        x={threeQuarter.x}
                        y={threeQuarter.y}
                        variant="white"
                        onPointerDown={(e) => handleSegmentPointerDown(s, "white-three-quarter", e)}
                        onPointerEnter={() => {
                          setHoveredSegmentIdx(idx);
                          setEdgeHovered(true);
                        }}
                        onPointerLeave={() => {
                          setHoveredSegmentIdx(null);
                          setEdgeHovered(false);
                        }}
                      />
                    </div>
                  )}
                  {/* 透明 hover 热区：沿折线方向的细长条，仅在线上才触发。
                      水平段：宽=段长，高=14px；垂直段：宽=14px，高=段长。
                      zIndex 低于把手，不遮挡点击。 */}
                  <div
                    style={{
                      position: "absolute",
                      transform: `translate(-50%, -50%) translate(${s.mid.x}px, ${s.mid.y}px)`,
                      width: isHorizontal ? s.length : 14,
                      height: isHorizontal ? 14 : s.length,
                      pointerEvents: "all",
                      cursor: isHorizontal ? "ns-resize" : "ew-resize",
                      zIndex: 1,
                    }}
                    onPointerEnter={() => {
                      setHoveredSegmentIdx(idx);
                      setEdgeHovered(true);
                    }}
                    onPointerLeave={() => {
                      setHoveredSegmentIdx(null);
                      setEdgeHovered(false);
                    }}
                    onPointerDown={(e) => {
                      if (selected !== true) {
                        setEdges((edges) =>
                          edges.map((ed) =>
                            ed.id === id ? { ...ed, selected: true } : { ...ed, selected: false },
                          ),
                        );
                      }
                      handleSegmentPointerDown(s, "blue", e);
                    }}
                  />
                </Fragment>
              );
            })}
        </EdgeLabelRenderer>
      )}
    </>
  );
}, areEdgePropsEqual);

// ---------------------------------------------------------------------------
// 曲线边（带两个把手）
// ---------------------------------------------------------------------------

export const BezierControlEdge = memo(function BezierControlEdge(props: EdgeProps) {
  const {
    id,
    sourceX: measuredSourceX,
    sourceY: measuredSourceY,
    targetX: measuredTargetX,
    targetY: measuredTargetY,
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
    style,
    markerEnd,
    markerStart,
    label,
    labelStyle,
    labelShowBg,
    labelBgStyle,
    labelBgPadding,
    labelBgBorderRadius,
    data,
    selected,
  } = props;

  const d = (data ?? {}) as FlowchartControlEdgeData;
  const controlPoints = d.controlPoints ?? [];
  const readOnly = d.readOnly === true;
  const onControlPointsChange = d.onControlPointsChange;
  const onControlPointsCommit = d.onControlPointsCommit;
  const labelOffset = d.labelOffset ?? { x: 0, y: 0 };
  const sourceX = d.sourcePoint?.x ?? measuredSourceX;
  const sourceY = d.sourcePoint?.y ?? measuredSourceY;
  const targetX = d.targetPoint?.x ?? measuredTargetX;
  const targetY = d.targetPoint?.y ?? measuredTargetY;

  // 计算 bezier 路径；如果有 2 个控制点则使用它们作为 cp1/cp2
  const { path, labelX, labelY, cp1, cp2 } = useMemo(() => {
    // 如果用户已设置控制点（长度 >= 2），使用用户值
    if (controlPoints.length >= 2) {
      const c1 = controlPoints[0];
      const c2 = controlPoints[1];
      // 构造 cubic bezier path: M source C cp1 cp2 target
      const p = `M ${sourceX},${sourceY} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${targetX},${targetY}`;
      const labelX = (sourceX + targetX) / 2;
      const labelY = (sourceY + targetY) / 2;
      return { path: p, labelX, labelY, cp1: c1, cp2: c2 };
    }
    // 否则用 React Flow 默认计算
    const [p, lx, ly] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
    // getBezierPath 内部计算的控制点位置不可直接获取，这里手动估算
    const estimatedCp1 = estimateBezierControlPoint(
      { x: sourceX, y: sourceY },
      sourcePosition,
      { x: targetX, y: targetY },
      "source",
    );
    const estimatedCp2 = estimateBezierControlPoint(
      { x: sourceX, y: sourceY },
      targetPosition,
      { x: targetX, y: targetY },
      "target",
    );
    return { path: p, labelX: lx, labelY: ly, cp1: estimatedCp1, cp2: estimatedCp2 };
  }, [controlPoints, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition]);

  // 拖动把手更新对应控制点（实时）
  const handleCpDrag = useCallback(
    (index: 0 | 1, pos: Point) => {
      if (readOnly || !onControlPointsChange) return;
      // 第一次拖动：初始化两个控制点为当前估算位置
      const base =
        controlPoints.length >= 2
          ? [controlPoints[0], controlPoints[1]]
          : [cp1, cp2];
      const next = [...base];
      next[index] = { x: pos.x, y: pos.y };
      onControlPointsChange(id, next);
    },
    [readOnly, onControlPointsChange, id, controlPoints, cp1, cp2],
  );

  // 拖动把手结束：提交到历史栈
  const handleCpDragEnd = useCallback(
    (index: 0 | 1, pos: Point) => {
      if (readOnly || !onControlPointsCommit) return;
      const base =
        controlPoints.length >= 2
          ? [controlPoints[0], controlPoints[1]]
          : [cp1, cp2];
      const next = [...base];
      next[index] = { x: pos.x, y: pos.y };
      onControlPointsCommit(id, next);
    },
    [readOnly, onControlPointsCommit, id, controlPoints, cp1, cp2],
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        labelX={labelX + labelOffset.x}
        labelY={labelY + labelOffset.y}
        label={label}
        labelStyle={labelStyle}
        labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        style={style}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {/* WPS 风格：仅在边选中时显示两个曲线把手 */}
      {!readOnly && selected === true && (
        <EdgeLabelRenderer>
          {/* 把手连接线（虚线）*/}
          <HandleConnectorLine from={{ x: sourceX, y: sourceY }} to={cp1} />
          <HandleConnectorLine from={{ x: targetX, y: targetY }} to={cp2} />
          {/* 两个把手 */}
          <BezierHandle
            x={cp1.x}
            y={cp1.y}
            onDrag={(pos) => handleCpDrag(0, pos)}
            onDragEnd={(pos) => handleCpDragEnd(0, pos)}
          />
          <BezierHandle
            x={cp2.x}
            y={cp2.y}
            onDrag={(pos) => handleCpDrag(1, pos)}
            onDragEnd={(pos) => handleCpDragEnd(1, pos)}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}, areEdgePropsEqual);

// ---------------------------------------------------------------------------
// 子组件：段把手（蓝色 1/2 + 白色 1/4）、bezier 把手、连接线
// ---------------------------------------------------------------------------

/** 段把手：蓝色（1/2 中点，整段平移）或白色（1/4 点，半段移动）。
 *  白色点需要 onPointerEnter/onPointerLeave 维持段 hover 状态——光标从热区
 *  移到白色点时热区会触发 pointerleave，若不重新设置 hover，白色点会消失无法点击。 */
function SegmentHandle({
  x,
  y,
  variant,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
}: {
  x: number;
  y: number;
  variant: "blue" | "white";
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerEnter?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
}) {
  return (
    <div
      className={variant === "blue" ? "flowchart-edge-segment-blue" : "flowchart-edge-segment-white"}
      style={{
        position: "absolute",
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: "all",
      }}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      title={variant === "blue" ? "拖动平移整段" : "拖动调整端点位置"}
      role="button"
      tabIndex={-1}
    />
  );
}

/** bezier 曲线把手 */
function BezierHandle({
  x,
  y,
  onDrag,
  onDragEnd,
}: {
  x: number;
  y: number;
  onDrag: (pos: Point) => void;
  onDragEnd: (pos: Point) => void;
}) {
  const { onPointerDown, isDragging } = useFlowDrag(onDrag, onDragEnd);
  return (
    <div
      className={`flowchart-edge-bezier-handle${isDragging ? " dragging" : ""}`}
      style={{
        position: "absolute",
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: "all",
      }}
      onPointerDown={onPointerDown}
      title="拖动调整曲线形状"
      role="button"
      tabIndex={-1}
    />
  );
}

/** bezier 把手连接线（source → cp1，cp2 → target 虚线）*/
function HandleConnectorLine({ from, to }: { from: Point; to: Point }) {
  // 使用 SVG 在 EdgeLabelRenderer 中绘制虚线
  // EdgeLabelRenderer 是 HTML 容器，所以用 absolute 定位的 SVG 元素
  // 简化：用一个旋转的 div 模拟直线
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  return (
    <div
      className="flowchart-edge-handle-line"
      style={{
        position: "absolute",
        left: `${from.x}px`,
        top: `${from.y}px`,
        width: `${length}px`,
        height: 0,
        transform: `rotate(${angle}deg)`,
        transformOrigin: "0 0",
        pointerEvents: "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// bezier 控制点估算
// ---------------------------------------------------------------------------

/** 估算 cubic bezier 的控制点位置（与 React Flow 默认 bezier 实现保持一致）。
 *  React Flow 默认 bezier 控制点偏移量 = |source - target| 在主导轴上的距离 * curvature (默认 0.25) */
function estimateBezierControlPoint(
  source: Point,
  position: Position,
  target: Point,
  side: "source" | "target",
): Point {
  const curvature = 0.25;
  const distance =
    position === Position.Left || position === Position.Right
      ? Math.abs(target.x - source.x)
      : Math.abs(target.y - source.y);
  const offset = distance * curvature;

  const base = side === "source" ? source : target;
  switch (position) {
    case Position.Top:
      return { x: base.x, y: base.y - offset };
    case Position.Bottom:
      return { x: base.x, y: base.y + offset };
    case Position.Left:
      return { x: base.x - offset, y: base.y };
    case Position.Right:
      return { x: base.x + offset, y: base.y };
  }
}
