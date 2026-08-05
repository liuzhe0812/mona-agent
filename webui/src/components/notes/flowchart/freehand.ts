/**
 * 自由手绘几何工具（移植自 NoteGen lib/canvas/freehand.ts）。
 * 依赖 perfect-freehand 生成压感笔触外轮廓，再转成 SVG path。
 */

import { getStroke } from "perfect-freehand";

export interface FreehandPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface FreehandStyle {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  simulatePressure: boolean;
}

/** 钢笔：细线、压感 */
export const PEN_STYLE: FreehandStyle = {
  size: 4,
  thinning: 0.45,
  smoothing: 0.6,
  streamline: 0.5,
  simulatePressure: true,
};

/** 荧光笔：粗、无锥度、半透明叠加 */
export const HIGHLIGHTER_STYLE: FreehandStyle = {
  size: 18,
  thinning: 0,
  smoothing: 0.7,
  streamline: 0.6,
  simulatePressure: true,
};

/** 用 perfect-freehand 生成笔触外轮廓点集 */
export function getFreehandOutline(points: FreehandPoint[], style: FreehandStyle): number[][] {
  return getStroke(
    points.map((p) => [p.x, p.y, p.pressure] as [number, number, number]),
    style,
  );
}

/** 把外轮廓点集转为闭合 SVG path 字符串 */
export function getSvgPathFromStroke(points: number[][]): string {
  if (points.length === 0) return "";

  const average = (left: number[], right: number[]) => [
    (left[0] + right[0]) / 2,
    (left[1] + right[1]) / 2,
  ];
  const first = points[0];
  let path = `M ${first[0].toFixed(2)} ${first[1].toFixed(2)} Q`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = average(current, points[index + 1]);
    path += ` ${current[0].toFixed(2)} ${current[1].toFixed(2)} ${next[0].toFixed(2)} ${next[1].toFixed(2)}`;
  }

  path += " Z";
  return path;
}

/** 生成 freehand 节点的几何信息：位置、尺寸、本地化 path */
export function createFreehandGeometry(points: FreehandPoint[], style: FreehandStyle) {
  const outline = getFreehandOutline(points, style);
  if (outline.length === 0) return null;

  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const padding = 2;
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;
  const localized = outline.map((p) => [p[0] - minX, p[1] - minY]);

  return {
    x: minX,
    y: minY,
    width: Math.max(4, maxX - minX),
    height: Math.max(4, maxY - minY),
    path: getSvgPathFromStroke(localized),
  };
}
