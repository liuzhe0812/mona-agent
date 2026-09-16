/** 画像图表使用全局数据色，品牌红和状态色不承担普通系列语义。 */
export const PROFILE_CHART_COLORS = {
  blue: "hsl(var(--data-1))",
  teal: "hsl(var(--data-2))",
  ochre: "hsl(var(--data-3))",
  violet: "hsl(var(--data-4))",
  rose: "hsl(var(--data-5))",
  olive: "hsl(var(--data-6))",
} as const;

export const PROFILE_CHART_PALETTE = [
  PROFILE_CHART_COLORS.blue,
  PROFILE_CHART_COLORS.teal,
  PROFILE_CHART_COLORS.ochre,
  PROFILE_CHART_COLORS.violet,
  PROFILE_CHART_COLORS.rose,
  PROFILE_CHART_COLORS.olive,
] as const;

const FIXED_COLOR_INDEX: Record<string, number> = {
  "AI 应用": 0,
  产品设计: 3,
  软件开发: 1,
  知识检索: 2,
  内容创作: 4,
  效率工具: 5,
  开发: 0,
  分析: 1,
  写作: 2,
  设计: 3,
  文档: 0,
  代码: 1,
  图像: 2,
  音频: 3,
  视频: 4,
  压缩包: 5,
};

/** 同一个主题在不同图表中始终获得同一个系列色。 */
export function profileChartColor(key: string): string {
  const knownIndex = FIXED_COLOR_INDEX[key.trim()];
  if (knownIndex !== undefined) return PROFILE_CHART_PALETTE[knownIndex];
  let hash = 0;
  for (const character of key.trim().toLowerCase()) {
    hash = (hash * 31 + character.codePointAt(0)!) | 0;
  }
  return PROFILE_CHART_PALETTE[(hash >>> 0) % PROFILE_CHART_PALETTE.length];
}

/** 为 HSL CSS token 添加透明度，兼容 light/dark 主题。 */
export function profileChartColorAlpha(color: string, opacity: number): string {
  const token = /^hsl\(var\((--[\w-]+)\)\)$/.exec(color)?.[1];
  if (!token) return color;
  const clamped = Math.max(0, Math.min(1, opacity));
  return `hsl(var(${token}) / ${clamped})`;
}

/** 热力格使用低透明度填充并固定正文颜色，避免高值格吞掉数字。 */
export function profileHeatmapStyle(value: number, max: number): { backgroundColor: string; color: string } {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return {
    backgroundColor: value > 0 ? profileChartColorAlpha(PROFILE_CHART_COLORS.blue, 0.08 + ratio * 0.28) : "hsl(var(--muted))",
    color: "hsl(var(--foreground))",
  };
}
