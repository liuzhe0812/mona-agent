/** 能力雷达图：8 维 SVG 雷达，支持单/双叠加模式 + 动画。 */

import { useEffect, useState } from "react";

import { PROFILE_COLORS } from "../profile-theme";
import type { RadarScore } from "@/lib/profile-api";

interface RadarChartProps {
  current: RadarScore[];
  previous?: RadarScore[]; // 叠加对比时传入
  size?: number;
  animate?: boolean;
}

export function RadarChart({
  current,
  previous,
  size = 320,
  animate = true,
}: RadarChartProps) {
  const [progress, setProgress] = useState(animate ? 0 : 1);

  useEffect(() => {
    if (!animate) {
      setProgress(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const duration = 1000;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  if (!current || current.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
        暂无数据
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 52;
  const n = current.length;
  const angleStep = (Math.PI * 2) / n;

  // 网格圈数
  const gridLevels = 4;
  const gridRings = Array.from({ length: gridLevels }, (_, i) => (i + 1) / gridLevels);

  // 计算坐标
  const pointAt = (value: number, i: number, scale = 1) => {
    const angle = -Math.PI / 2 + i * angleStep;
    const r = (value / 100) * radius * scale;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as const;
  };

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-auto w-full"
      style={{ maxWidth: `${size}px` }}
    >
      <defs>
        <radialGradient id="radar-fill" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={PROFILE_COLORS.emerald} stopOpacity="0.4" />
          <stop offset="100%" stopColor={PROFILE_COLORS.emeraldDeep} stopOpacity="0.15" />
        </radialGradient>
        <radialGradient id="radar-prev" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={PROFILE_COLORS.amber} stopOpacity="0.25" />
          <stop offset="100%" stopColor={PROFILE_COLORS.amberDeep} stopOpacity="0.08" />
        </radialGradient>
        <filter id="radar-glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 网格 */}
      {gridRings.map((ring, ri) => {
        const pts = current
          .map((_, i) => {
            const [x, y] = pointAt(100 * ring, i);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return (
          <polygon
            key={ri}
            points={pts}
            fill="none"
            className="stroke-border/30"
            strokeWidth={0.5}
          />
        );
      })}

      {/* 轴线 */}
      {current.map((_, i) => {
        const [x, y] = pointAt(100, i);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            className="stroke-border/30"
            strokeWidth={0.5}
          />
        );
      })}

      {/* 之前的快照（叠加） */}
      {previous && previous.length === n && (
        <polygon
          points={previous
            .map((s, i) => {
              const [x, y] = pointAt(s.value, i);
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ")}
          fill="url(#radar-prev)"
          stroke={PROFILE_COLORS.amber}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}

      {/* 当前数据 */}
      <polygon
        points={current
          .map((s, i) => {
            const [x, y] = pointAt(s.value * progress, i);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")}
        fill="url(#radar-fill)"
        stroke={PROFILE_COLORS.emerald}
        strokeWidth={2}
        filter="url(#radar-glow)"
      />

      {/* 数据点 */}
      {current.map((s, i) => {
        const [x, y] = pointAt(s.value * progress, i);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={3.5}
            fill={PROFILE_COLORS.emerald}
            stroke="white"
            strokeWidth={1.5}
          />
        );
      })}

      {/* 轴标签 */}
      {current.map((s, i) => {
        const [x, y] = pointAt(113, i);
        const anchor =
          Math.abs(x - cx) < 5 ? "middle" : x > cx ? "start" : "end";
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-foreground text-[11px] font-medium"
          >
            {s.axis}
          </text>
        );
      })}

      {/* 数值 */}
      {current.map((s, i) => {
        const [x, y] = pointAt(s.value * progress + 10, i);
        return (
          <text
            key={`v-${i}`}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-muted-foreground text-[9px] tabular-nums"
          >
            {Math.round(s.value * progress)}
          </text>
        );
      })}
    </svg>
  );
}
