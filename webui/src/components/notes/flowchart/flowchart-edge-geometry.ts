import { Position } from "@xyflow/react";

import { buildEdgeGeometry } from "./FlowchartControlEdge";
import type { FlowchartEdge } from "./flowchart-document";
import { flowchartPortPoint } from "./flowchart-ports";

export type FlowchartRouteSegment = {
  from: { x: number; y: number };
  to: { x: number; y: number };
};

export type FlowchartRouteBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function edgePosition(handle: string | undefined, fallback: "source" | "target"): Position {
  switch (handle?.split("-")[0]) {
    case "top":
      return Position.Top;
    case "right":
      return Position.Right;
    case "bottom":
      return Position.Bottom;
    case "left":
      return Position.Left;
    default:
      return fallback === "source" ? Position.Bottom : Position.Top;
  }
}

/** 返回与渲染边一致的可视线段；Bezier 没有可安全复用的折线表示，暂不参与线段质检。 */
export function flowchartEdgeSegments(
  edge: FlowchartEdge,
  sourceBox: FlowchartRouteBox,
  targetBox: FlowchartRouteBox,
): FlowchartRouteSegment[] {
  if (edge.style?.route === "bezier") return [];

  const source = flowchartPortPoint(sourceBox, edge.sourceHandle, edge.sourcePort, "source");
  const target = flowchartPortPoint(targetBox, edge.targetHandle, edge.targetPort, "target");
  if (edge.style?.route === "straight") {
    return [{ from: source, to: target }];
  }

  const geometry = buildEdgeGeometry(
    [source, ...(edge.controlPoints ?? []), target],
    edgePosition(edge.sourceHandle, "source"),
    edgePosition(edge.targetHandle, "target"),
  );
  return geometry.segments.map((segment) => ({ from: segment.from, to: segment.to }));
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function sharedSegmentLength(
  a: FlowchartRouteSegment,
  b: FlowchartRouteSegment,
): number {
  const rx = a.to.x - a.from.x;
  const ry = a.to.y - a.from.y;
  const sx = b.to.x - b.from.x;
  const sy = b.to.y - b.from.y;
  const rLength = Math.hypot(rx, ry);
  const sLength = Math.hypot(sx, sy);
  if (rLength === 0 || sLength === 0) return 0;

  const crossTolerance = 1e-6 * Math.max(1, rLength * sLength);
  if (Math.abs(cross(rx, ry, sx, sy)) > crossTolerance) return 0;

  const qx = b.from.x - a.from.x;
  const qy = b.from.y - a.from.y;
  if (Math.abs(cross(qx, qy, rx, ry)) > 1e-6 * Math.max(1, rLength * Math.hypot(qx, qy))) {
    return 0;
  }

  const ux = rx / rLength;
  const uy = ry / rLength;
  const bStart = qx * ux + qy * uy;
  const bEnd = (b.to.x - a.from.x) * ux + (b.to.y - a.from.y) * uy;
  const overlapStart = Math.max(0, Math.min(bStart, bEnd));
  const overlapEnd = Math.min(rLength, Math.max(bStart, bEnd));
  return Math.max(0, overlapEnd - overlapStart);
}

/** 计算两条折线路径的共线重合长度；端点相交只有零长度，不计入结果。 */
export function sharedRouteLength(
  a: readonly FlowchartRouteSegment[],
  b: readonly FlowchartRouteSegment[],
): number {
  let total = 0;
  for (const segmentA of a) {
    for (const segmentB of b) {
      total += sharedSegmentLength(segmentA, segmentB);
    }
  }
  return total;
}

function textUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    if (char === "\n") continue;
    units += /[\u2e80-\uffff]/u.test(char) ? 1 : 0.56;
  }
  return units;
}

function longestSegment(segments: readonly FlowchartRouteSegment[]): FlowchartRouteSegment | null {
  let longest: FlowchartRouteSegment | null = null;
  let longestLength = 0;
  for (const segment of segments) {
    const length = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
    if (length > longestLength) {
      longest = segment;
      longestLength = length;
    }
  }
  return longest;
}

/** 估算渲染标签盒：最长可视段中点叠加边标签偏移。 */
export function flowchartEdgeLabelBox(
  edge: FlowchartEdge,
  segments: readonly FlowchartRouteSegment[],
): { x: number; y: number; width: number; height: number } | null {
  if (!edge.label?.trim()) return null;
  const segment = longestSegment(segments);
  if (!segment) return null;

  const fontSize = Number.isFinite(edge.style?.labelFontSize)
    ? Math.max(1, edge.style?.labelFontSize ?? 12)
    : 12;
  const lines = edge.label.split("\n");
  const width = Math.max(...lines.map(textUnits), 0) * fontSize + 8;
  const height = lines.length * fontSize * 1.2 + 6;
  const offsetX = Number.isFinite(edge.style?.labelOffsetX) ? edge.style?.labelOffsetX ?? 0 : 0;
  const offsetY = Number.isFinite(edge.style?.labelOffsetY) ? edge.style?.labelOffsetY ?? 0 : 0;
  const centerX = (segment.from.x + segment.to.x) / 2 + offsetX;
  const centerY = (segment.from.y + segment.to.y) / 2 + offsetY;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}
