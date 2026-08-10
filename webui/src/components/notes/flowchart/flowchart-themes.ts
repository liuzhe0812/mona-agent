/**
 * 流程图文档主题与配色（FC-THEME-01）。
 *
 * 只包含纯数据与纯函数：
 * - 三个 style preset：solid、outline、soft；
 * - 内置 palette 常量（default、深蓝、蓝灰、绿、橙黄、红、紫、单色）；
 * - 根据 palette + preset 返回节点默认颜色的纯函数。
 *
 * 渲染优先级：节点手动覆盖（node.style）> 文档主题（本模块解析）> 明暗主题 CSS token。
 * "default" palette + solid preset 返回 undefined，回退到 CSS token（跟随明暗主题）。
 *
 * 不实现网络下载主题、自定义主题编辑器或纹理图案。
 */

import type { FlowchartThemeSettings } from "./flowchart-document";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface FlowchartPalette {
  id: string;
  label: string;
  /** 形状填充色 */
  fill: string;
  /** 柔和填充色（soft preset 使用） */
  fillSoft: string;
  /** 描边/线条色 */
  stroke: string;
  /** 文字色 */
  text: string;
}

/** 主题解析出的节点默认颜色；undefined 表示回退 CSS token。 */
export interface FlowchartThemeDefaults {
  fill?: string;
  stroke?: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// 内置配色
// ---------------------------------------------------------------------------

export const FLOWCHART_PALETTES: readonly FlowchartPalette[] = [
  // default：不写具体颜色，回退 CSS token（跟随明暗主题）
  { id: "default", label: "默认", fill: "", fillSoft: "", stroke: "", text: "" },
  { id: "deep-blue", label: "深蓝", fill: "#dbeafe", fillSoft: "#eff6ff", stroke: "#2563eb", text: "#1e3a8a" },
  { id: "blue-gray", label: "蓝灰", fill: "#e2e8f0", fillSoft: "#f1f5f9", stroke: "#64748b", text: "#334155" },
  { id: "green", label: "绿色", fill: "#dcfce7", fillSoft: "#f0fdf4", stroke: "#16a34a", text: "#14532d" },
  { id: "orange", label: "橙黄", fill: "#ffedd5", fillSoft: "#fff7ed", stroke: "#ea580c", text: "#7c2d12" },
  { id: "red", label: "红色", fill: "#fee2e2", fillSoft: "#fef2f2", stroke: "#dc2626", text: "#7f1d1d" },
  { id: "purple", label: "紫色", fill: "#ede9fe", fillSoft: "#f5f3ff", stroke: "#7c3aed", text: "#4c1d95" },
  { id: "monochrome", label: "单色", fill: "#f4f4f5", fillSoft: "#fafafa", stroke: "#52525b", text: "#27272a" },
];

export const FLOWCHART_STYLE_PRESETS = [
  { id: "solid", label: "纯色" },
  { id: "outline", label: "描边" },
  { id: "soft", label: "柔和" },
] as const;

export type FlowchartStylePresetId = (typeof FLOWCHART_STYLE_PRESETS)[number]["id"];

// ---------------------------------------------------------------------------
// 解析函数
// ---------------------------------------------------------------------------

export function getFlowchartPalette(id: string): FlowchartPalette {
  return FLOWCHART_PALETTES.find((p) => p.id === id) ?? FLOWCHART_PALETTES[0];
}

/**
 * 解析节点默认颜色。
 * - paletteId 为 "default" 时返回 {}（全部回退 CSS token）；
 * - solid：fill=配色填充，stroke=配色描边，text=配色文字；
 * - outline：fill=transparent，stroke=配色描边，text=配色描边；
 * - soft：fill=柔和填充，stroke=柔和描边（stroke 半透明化由 fillSoft 区背景承担，这里直接用 stroke），text=配色文字。
 */
export function resolveFlowchartThemeDefaults(
  theme: FlowchartThemeSettings,
): FlowchartThemeDefaults {
  const palette = getFlowchartPalette(theme.paletteId);
  if (palette.id === "default") return {};
  switch (theme.stylePreset) {
    case "outline":
      return { fill: "transparent", stroke: palette.stroke, text: palette.stroke };
    case "soft":
      return { fill: palette.fillSoft, stroke: palette.stroke, text: palette.text };
    case "solid":
    default:
      return { fill: palette.fill, stroke: palette.stroke, text: palette.text };
  }
}

/**
 * 主题应用时需要清理的手动样式字段（可由主题提供的字段）。
 * 仅在「不保留手动样式」模式下从 node.style 中删除。
 */
export const THEME_PROVIDED_STYLE_KEYS = ["fill", "borderColor", "color"] as const;

/**
 * 主题清理函数能接受的最小结构。
 * 不使用 Record<string, unknown>：FlowchartNodeStyle 是 interface，无索引签名，
 * 无法赋给 Record。这里用字段级结构（unknown 值类型），FlowchartNodeStyle 可结构兼容。
 */
export interface ThemeStyleContainer {
  style?: {
    fill?: unknown;
    borderColor?: unknown;
    color?: unknown;
  };
}

/**
 * 统计应用主题时会清理手动样式的节点数量（用于确认提示）。
 * 只统计 fill/borderColor/color 三个字段存在手动覆盖的节点。
 */
export function countNodesWithManualThemeStyles(
  nodes: ReadonlyArray<ThemeStyleContainer>,
): number {
  let count = 0;
  for (const n of nodes) {
    const style = n.style;
    if (!style) continue;
    if (THEME_PROVIDED_STYLE_KEYS.some((k) => style[k] !== undefined)) count += 1;
  }
  return count;
}

/**
 * 「不保留手动样式」模式：从所有节点 style 中删除主题可提供的字段
 * （fill/borderColor/color），其余手动字段（字号、加粗等）保留。
 * 不修改输入；style 变空的节点 style 置为 undefined。
 */
export function stripThemeProvidedStyles<T extends ThemeStyleContainer>(
  nodes: readonly T[],
): T[] {
  return nodes.map((n) => {
    if (!n.style) return n;
    const next: Record<string, unknown> = { ...n.style };
    let removed = false;
    for (const k of THEME_PROVIDED_STYLE_KEYS) {
      if (next[k] !== undefined) {
        delete next[k];
        removed = true;
      }
    }
    if (!removed) return n;
    // 只删 key 不改结构，cast 回 T["style"] 是安全的
    return {
      ...n,
      style: (Object.keys(next).length > 0 ? next : undefined) as T["style"],
    };
  });
}
