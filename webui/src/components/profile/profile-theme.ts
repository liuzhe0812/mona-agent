/** 画像可视化主题：翡翠绿（成长）+ 琥珀金（成就）+ 珊瑚橙（活力） */

export const PROFILE_COLORS = {
  // 主色系
  emerald: "#10b981", // 翡翠绿 - 成长
  emeraldSoft: "#34d399",
  emeraldDeep: "#059669",

  amber: "#f59e0b", // 琥珀金 - 成就
  amberSoft: "#fbbf24",
  amberDeep: "#d97706",

  coral: "#fb7185", // 珊瑚橙 - 活力
  coralSoft: "#fda4af",
  coralDeep: "#e11d48",

  // 中性
  cyan: "#06b6d4", // 青蓝 - 辅助
  violet: "#a78bfa", // 淡紫 - 仅作辅助点缀
  rose: "#f43f5e",

  // 等级色（从低到高）
  levels: [
    "#1f2937", // Lv0 - 深灰
    "#374151", // Lv1
    "#06b6d4", // Lv2 - 青
    "#10b981", // Lv3 - 绿
    "#f59e0b", // Lv4 - 金
    "#fb7185", // Lv5 - 珊瑚
  ],

  // 维度色（8维雷达图）
  radarAxes: [
    "#10b981", // 架构 - 翡翠
    "#06b6d4", // 创意 - 青蓝
    "#f59e0b", // 沟通 - 琥珀
    "#fb7185", // 学习 - 珊瑚
    "#34d399", // 效率 - 浅绿
    "#fbbf24", // 工具 - 浅金
    "#22d3ee", // 编程 - 浅青
    "#fda4af", // 深度 - 浅珊瑚
  ],
} as const;

/** CSS 变量注入（可在 className 中用 var(--profile-emerald) 等） */
export const PROFILE_CSS_VARS = `
:root {
  --profile-emerald: ${PROFILE_COLORS.emerald};
  --profile-emerald-soft: ${PROFILE_COLORS.emeraldSoft};
  --profile-emerald-deep: ${PROFILE_COLORS.emeraldDeep};
  --profile-amber: ${PROFILE_COLORS.amber};
  --profile-amber-soft: ${PROFILE_COLORS.amberSoft};
  --profile-amber-deep: ${PROFILE_COLORS.amberDeep};
  --profile-coral: ${PROFILE_COLORS.coral};
  --profile-coral-soft: ${PROFILE_COLORS.coralSoft};
  --profile-coral-deep: ${PROFILE_COLORS.coralDeep};
}
`.trim();

/** 关键帧动画 */
export const PROFILE_ANIMATIONS = `
@keyframes profile-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes profile-scale-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes profile-draw-line {
  from { stroke-dashoffset: var(--len, 1000); }
  to { stroke-dashoffset: 0; }
}
@keyframes profile-grow-bar {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
@keyframes profile-pulse-glow {
  0%, 100% { opacity: 0.6; filter: blur(8px); }
  50% { opacity: 1; filter: blur(12px); }
}
@keyframes profile-spin-slow {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes profile-count-up {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.profile-card {
  animation: profile-fade-in 0.5s ease-out backwards;
}
.profile-scale-in {
  animation: profile-scale-in 0.6s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.profile-draw {
  stroke-dasharray: var(--len, 1000);
  animation: profile-draw-line 1.2s ease-out forwards;
}
.profile-grow-x {
  transform-origin: left;
  animation: profile-grow-bar 0.8s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.profile-pulse {
  animation: profile-pulse-glow 3s ease-in-out infinite;
}
.profile-count {
  animation: profile-count-up 0.4s ease-out backwards;
}
`.trim();

/** 通用卡片样式 */
export const CARD_BASE =
  "relative overflow-hidden rounded-2xl border border-border/40 bg-card/40 backdrop-blur-md";
export const CARD_HOVER =
  "transition-all duration-300 hover:border-border/80 hover:bg-card/60 hover:shadow-lg hover:shadow-emerald-500/5";

/** 等级颜色 */
export function levelColor(level: number): string {
  return PROFILE_COLORS.levels[Math.min(level, PROFILE_COLORS.levels.length - 1)];
}

/** 根据分数（0-100）返回等级标签 */
export function scoreLevel(score: number): { label: string; color: string; level: number } {
  if (score >= 85) return { label: "精通", color: PROFILE_COLORS.coral, level: 5 };
  if (score >= 65) return { label: "熟练", color: PROFILE_COLORS.amber, level: 4 };
  if (score >= 45) return { label: "熟悉", color: PROFILE_COLORS.emerald, level: 3 };
  if (score >= 25) return { label: "了解", color: PROFILE_COLORS.cyan, level: 2 };
  if (score >= 10) return { label: "入门", color: "#374151", level: 1 };
  return { label: "未涉", color: "#1f2937", level: 0 };
}

/** 把 work_patterns.evidence.hourly_distribution（{ "9": 12, ... }）转成 7×24 热力图网格。
 *  若无数据返回全 0 网格。 */
export function hourlyToHeatmap(
  hourly: Record<string, number> | undefined | null,
): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  if (!hourly) return grid;
  const max = Math.max(1, ...Object.values(hourly));
  for (const [hStr, count] of Object.entries(hourly)) {
    const h = Number(hStr);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    // 工作日（0-4）给满权重，周末给 0.4
    for (let day = 0; day < 7; day++) {
      const factor = day < 5 ? 1 : 0.4;
      grid[day][h] = Math.round((count / max) * 10 * factor);
    }
  }
  return grid;
}

