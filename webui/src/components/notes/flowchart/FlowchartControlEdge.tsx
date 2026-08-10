/**
 * WPS 风格自定义边组件：支持控制点拖动调整连接线形状。
 *
 * 1. 折线（smoothstep）：选中后每条可视段中点显示拖拽方块；拖动时整段平移
 *    （垂直方向移动，平行方向锁定），段本身不分裂、不产生新中点；只有相邻段
 *    会自适应变长/变短/变向。端点是 source/target 时自动物化拐角点。
 * 2. 曲线（bezier）：渲染两个把手（cubic bezier 的 cp1/cp2），拖动把手调整曲线形状。
 *
 * 控制点坐标使用画布流坐标系（与节点 position 同坐标系）绝对坐标，存储到 FlowchartEdge.controlPoints。
 * 不参与语义哈希，仅影响渲染。
 *
 * 自定义边通过 data 字段接收 controlPoints 和 onControlPointsChange 回调。
 * EdgeProps 中的 sourceX/Y/targetX/Y 已经是流坐标系绝对坐标，可以直接与 controlPoints 比较。
 */

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  Position,
  getBezierPath,
  useReactFlow,
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

type Point = { x: number; y: number };

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
  return [
    source,
    // 与拐角重合时省略 gap 点，避免重复顶点产生多余拐弯
    ...(first && (gappedSource.x !== first.x || gappedSource.y !== first.y) ? [gappedSource] : []),
    ...points,
    ...(last && (gappedTarget.x !== last.x || gappedTarget.y !== last.y) ? [gappedTarget] : []),
    target,
  ];
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

/** 可视折线上的一段（段中点把手的挂载单位） */
interface VisualSegment {
  from: Point;
  to: Point;
  mid: Point;
  length: number;
  /** 拖动平移轴：垂直段沿 x 平移，水平段沿 y 平移 */
  dragAxis: "x" | "y";
  /** 是否可拖拽（首段贴 source、末段贴 target，不可拖） */
  draggable: boolean;
}

interface EdgeGeometry {
  path: string;
  segments: VisualSegment[];
}

/** polyline 顶点：标记是否为逻辑点（source/CP/target，不可合并） */
interface PolylineVertex {
  point: Point;
  isLogical: boolean;
}

/** 合并共线顶点：如果 a→b→c 共线且 b 不是逻辑点，跳过 b。
 *  逻辑点（source/CP/target）是用户设定的真正拐角，不能被合并；
 *  只有 getPairVisualPoints 生成的虚拟拐角（gap 点、自动拐角）可以被合并。 */
function mergeCollinear(vertices: PolylineVertex[]): Point[] {
  if (vertices.length <= 2) return vertices.map((v) => v.point);
  const result: Point[] = [vertices[0].point];
  for (let i = 1; i < vertices.length - 1; i++) {
    const a = result[result.length - 1];
    const b = vertices[i].point;
    const c = vertices[i + 1].point;
    if (!vertices[i].isLogical && ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))) {
      continue;
    }
    result.push(b);
  }
  result.push(vertices[vertices.length - 1].point);
  return result;
}

/** 计算整条边的可视几何。
 *  逐逻辑点对用 xyflow 同款算法算可视顶点，拼接后合并共线虚拟拐角，
 *  基于合并后的 polyline 生成 path 和 segments。
 *  合并保证一条直线只产生一个段、一个中点把手。 */
function buildEdgeGeometry(
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
      // 首点对的第一个点是 logicalPoints[i]（已在上一对末尾添加），去重
      if (i > 0 && j === 0) continue;
      const prev = vertices[vertices.length - 1];
      if (prev && prev.point.x === p.x && prev.point.y === p.y) continue;
      // 逻辑点 = 每对的首尾点（pairPoints[0] 和 pairPoints[last]）
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

  // 基于合并后的 polyline 生成 segments
  // 首段贴 source、末段贴 target，不可拖
  const segments: VisualSegment[] = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    const from = polyline[i];
    const to = polyline[i + 1];
    const length = dist(from, to);
    if (length === 0) continue;
    segments.push({
      from,
      to,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      length,
      dragAxis: from.x === to.x ? "x" : "y",
      draggable: i > 0 && i < polyline.length - 2,
    });
  }

  return { path, segments };
}

// ---------------------------------------------------------------------------
// 拖拽 Hook
// ---------------------------------------------------------------------------

/** 通用拖拽逻辑：在 SVG/HTML 元素上监听 pointerdown，触发 onDragStart(startPos) → onMove(pos) → onEnd(lastPos)。
 *  使用屏幕坐标到流坐标的转换，支持画布缩放。
 *  onEnd 在 pointerup 时触发，接收最后一个 pos（用于"提交"语义）。 */
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
      const handleUp = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setIsDragging(false);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        if (lastPosRef.current) onEnd?.(lastPosRef.current);
        lastPosRef.current = null;
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
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
    sourceX,
    sourceY,
    targetX,
    targetY,
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
      ? ([longest.mid.x, longest.mid.y] as const)
      : ([(sourceX + targetX) / 2, (sourceY + targetY) / 2] as const);
  }, [segments, sourceX, sourceY, targetX, targetY]);

  // 段中点拖拽需要跨渲染跟踪最新 controlPoints：
  // 插入新拐角点后段会拆分、原把手 DOM 卸载，且 window 事件闭包捕获的是按下时的旧数组，
  // 必须用 ref 存最新值，window 级监听在边组件层统一管理。
  const { screenToFlowPosition } = useReactFlow();
  const controlPointsRef = useRef(controlPoints);
  controlPointsRef.current = controlPoints;

  // 段中点把手按下：开始段拖拽。拖动的是「可视段」——沿垂直于段的方向整体平移
  // （平行方向锁定），段保持笔直，不会产生 S 形。
  //
  // 核心原则：被拖的段只是平移，不会分裂、不会产生新中点。
  // 只有两端的顶点需要处理：
  // - 端点是已有 controlPoint → 移动它
  // - 端点是 source/target（不可移动） → 在旁边物化一个新的拐角点
  // - 端点是虚拟拐角（getPairVisualPoints 生成的） → 物化
  //
  // 坐标匹配代替 pairIndex：合并共线后顶点不再与 logicalPoints 一一对应，
  // 用坐标精确匹配 controlPoints / source / target。
  const handleSegmentHandlePointerDown = useCallback(
    (segment: VisualSegment, event: React.PointerEvent) => {
      if (readOnly || !onControlPointsChange) return;
      event.stopPropagation();
      event.preventDefault();
      const startClient = { x: event.clientX, y: event.clientY };
      const startFlow = screenToFlowPosition(startClient);
      const { dragAxis, from, to } = segment;
      const sourcePt: Point = { x: sourceX, y: sourceY };
      const targetPt: Point = { x: targetX, y: targetY };
      let started = false;
      // 首次移动时确定要操作的 controlPoints 索引，后续移动直接复用
      let leftIdx = -1;
      let rightIdx = -1;

      const handleMove = (e: PointerEvent) => {
        if (!started && Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < 3)
          return;

        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const delta = dragAxis === "x" ? pos.x - startFlow.x : pos.y - startFlow.y;
        const p1 =
          dragAxis === "x" ? { x: from.x + delta, y: from.y } : { x: from.x, y: from.y + delta };
        const p2 =
          dragAxis === "x" ? { x: to.x + delta, y: to.y } : { x: to.x, y: to.y + delta };

        if (!started) {
          started = true;
          const cps = [...controlPointsRef.current];

          // 用坐标匹配 from/to 在 controlPoints 中的位置
          const fromCpIdx = cps.findIndex((p) => p.x === from.x && p.y === from.y);
          const toCpIdx = cps.findIndex((p) => p.x === to.x && p.y === to.y);

          if (fromCpIdx >= 0 && toCpIdx >= 0) {
            // 两端都是已有 CP：直接移动，不插入新点
            leftIdx = fromCpIdx;
            rightIdx = toCpIdx;
            cps[leftIdx] = p1;
            cps[rightIdx] = p2;
          } else if (fromCpIdx >= 0) {
            // from 是 CP，to 需要物化：在 fromCpIdx 后面插入
            leftIdx = fromCpIdx;
            rightIdx = fromCpIdx + 1;
            cps[leftIdx] = p1;
            cps.splice(rightIdx, 0, p2);
          } else if (toCpIdx >= 0) {
            // to 是 CP，from 需要物化：在 toCpIdx 前面插入
            rightIdx = toCpIdx;
            leftIdx = toCpIdx;
            cps.splice(leftIdx, 0, p1);
            cps[rightIdx + 1] = p2;
          } else {
            // 两端都不是 CP（source/target/虚拟拐角），全部物化
            // 插入位置取决于 from 是否为 source、to 是否为 target
            const fromIsSource = from.x === sourcePt.x && from.y === sourcePt.y;
            const toIsTarget = to.x === targetPt.x && to.y === targetPt.y;
            if (fromIsSource && toIsTarget) {
              // source→target 直连：两端都物化，插入在开头
              cps.unshift(p1, p2);
              leftIdx = 0;
              rightIdx = 1;
            } else if (fromIsSource) {
              // from=source，to=虚拟拐角 → 在开头插入两个点
              cps.unshift(p1, p2);
              leftIdx = 0;
              rightIdx = 1;
            } else if (toIsTarget) {
              // to=target，from=虚拟拐角 → 在末尾追加两个点
              cps.push(p1, p2);
              leftIdx = cps.length - 2;
              rightIdx = cps.length - 1;
            } else {
              // 两端都是虚拟拐角（中间段），在开头插入
              cps.unshift(p1, p2);
              leftIdx = 0;
              rightIdx = 1;
            }
          }
          controlPointsRef.current = cps;
          onControlPointsChange(id, cps);
        } else {
          const next = [...controlPointsRef.current];
          if (leftIdx >= 0) next[leftIdx] = p1;
          if (rightIdx >= 0) next[rightIdx] = p2;
          controlPointsRef.current = next;
          onControlPointsChange(id, next);
        }
      };
      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        if (!started) return;
        const final = controlPointsRef.current;
        onControlPointsCommit?.(id, final.length > 0 ? final : undefined);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [readOnly, onControlPointsChange, onControlPointsCommit, id, screenToFlowPosition, sourceX, sourceY, targetX, targetY],
  );

  // 控制点不再提供拖拽/双击操作（WPS 风格——拐角自动产生，无需手动操作）

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
      {/* WPS 风格：仅在边选中时显示操作把手 */}
      {!readOnly && selected === true && (
        <EdgeLabelRenderer>
          {/* 段中点拖拽方块：每个可拖可视段中点一个操作点，仅段长 > 阈值时显示。
              拖拽过程中段拆分产生的新段若超过阈值，会自动渲染自己的中点把手。 */}
          {segments
            .filter((s) => s.draggable && s.length > SEGMENT_LENGTH_THRESHOLD)
            .map((s, idx) => (
              <SegmentMidpointHandle
                key={`seg-${idx}`}
                x={s.mid.x}
                y={s.mid.y}
                onHandlePointerDown={(e) => handleSegmentHandlePointerDown(s, e)}
              />
            ))}
          {/* 已有拐角控制点：不渲染把手（WPS 风格——拐角自动产生，无需手动操作） */}
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
    sourceX,
    sourceY,
    targetX,
    targetY,
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
// 子组件：控制点、段中点把手、bezier 把手、连接线
// ---------------------------------------------------------------------------

/** 折线段中点把手：纯展示按钮，拖拽生命周期由边组件统一管理
 *  （window 级监听，不依赖本元素在拖拽期间保持挂载——插入拐角点后段会拆分、本元素可能卸载） */
function SegmentMidpointHandle({
  x,
  y,
  onHandlePointerDown,
}: {
  x: number;
  y: number;
  onHandlePointerDown: (event: React.PointerEvent) => void;
}) {
  // 仅在边选中时渲染（由父组件控制），此处始终可见
  return (
    <div
      className="flowchart-edge-segment-handle"
      style={{
        position: "absolute",
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: "all",
      }}
      onPointerDown={onHandlePointerDown}
      title="拖动调整该段位置"
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
