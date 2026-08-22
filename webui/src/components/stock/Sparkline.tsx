import { useMemo } from "react";

import { cn } from "@/lib/utils";

/** 迷你走势图（design §12 自选网格）：近 N 日收盘价折线 + 面积渐隐。
 *
 *  着色遵循 A 股语义（--stock-up/--stock-down），由调用方通过
 *  text-stock-up / text-stock-down 决定 currentColor。 */

interface SparklineProps {
  /** 收盘价序列（时间升序）；少于 2 个点时渲染占位虚线。 */
  closes: number[];
  className?: string;
}

const WIDTH = 120;
const HEIGHT = 36;
const PAD = 2;

export function Sparkline({ closes, className }: SparklineProps) {
  const geometry = useMemo(() => {
    if (closes.length < 2) return null;
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const innerW = WIDTH - PAD * 2;
    const innerH = HEIGHT - PAD * 2;
    const step = innerW / (closes.length - 1);
    const x = (i: number) => PAD + step * i;
    const y = (v: number) => PAD + innerH * (1 - (v - min) / span);
    const points = closes.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    const area = `${PAD},${HEIGHT - PAD} ${points} ${x(closes.length - 1)},${HEIGHT - PAD}`;
    return { points, area };
  }, [closes]);

  if (!geometry) {
    return (
      <div
        aria-hidden
        className={cn(
          "flex items-center justify-center text-micro text-muted-foreground/50",
          className,
        )}
      >
        ···
      </div>
    );
  }

  return (
    <svg
      role="img"
      aria-label="近期走势"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
    >
      <polygon points={geometry.area} fill="currentColor" fillOpacity={0.1} />
      <polyline
        points={geometry.points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
