import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { StockKlineBar } from "@/lib/stock-api";
import { cn } from "@/lib/utils";

/** 轻量 SVG K 线（design §12.2：不引入重型图表依赖）。
 *
 * 交互对齐常见看盘软件：滚轮以光标为锚缩放、按住左右拖动平移、
 * 双击回到默认窗口、悬停十字光标 + OHLC 读数。视口（可见窗口）
 * 由调用方持有并回传（成交量/MACD 副图共享同一切片）；未传时
 * 全量显示（非受控，供简单场景/测试）。
 *
 * A 股方向约定：close >= open 为涨（红），否则为跌（绿）。
 * 颜色走 --stock-up/--stock-down Token（数据可视化例外）。 */

export interface KlineChartMa {
  ma5: (number | null)[];
  ma20: (number | null)[];
  ma60: (number | null)[];
}

/** 可见窗口：offset = 首根可见 bar 的下标，count = 可见根数。 */
export interface KlineView {
  offset: number;
  count: number;
}

interface KlineChartProps {
  bars: StockKlineBar[];
  ma?: KlineChartMa;
  /** 受控视口；缺省显示全部。 */
  view?: KlineView;
  onViewChange?: (view: KlineView) => void;
  /** 十字光标悬停的 bar 全局下标；离场/拖动时为 null（副图联动读数用）。 */
  onHoverChange?: (idx: number | null) => void;
  className?: string;
}

const WIDTH = 600;
const HEIGHT = 240;
/** 主副图共享的绘图区左右留白：成交量/MACD 副图用同一坐标系对齐蜡烛。 */
export const KLINE_PAD_LEFT = 8;
export const KLINE_PAD_RIGHT = 46;
const PAD_LEFT = KLINE_PAD_LEFT;
const PAD_RIGHT = KLINE_PAD_RIGHT;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
/** 最少可见根数（最大放大倍数）与单次缩放步长。 */
const MIN_VISIBLE_BARS = 15;
const ZOOM_IN_FACTOR = 0.8;
const ZOOM_OUT_FACTOR = 1.25;
/** 默认窗口：最近 120 根（调用方初始视口与双击复位共用）。 */
export const DEFAULT_KLINE_VIEW_BARS = 120;

// MA 系列色复用全局语义 Token（info 蓝 / warning 橙 / muted-foreground 灰），
// 三者明度色相可区分，同一指标跨页面同色（design §4.6）。
const MA_STROKES: Record<keyof KlineChartMa, string> = {
  ma5: "hsl(var(--info))",
  ma20: "hsl(var(--warning))",
  ma60: "hsl(var(--muted-foreground))",
};

/** 把视口夹回合法范围：count ≤ 总根数，offset ≤ total - count。 */
export function clampKlineView(offset: number, count: number, total: number): KlineView {
  const boundedCount = Math.max(1, Math.min(Math.max(count, 1), Math.max(total, 1)));
  const boundedOffset = Math.max(0, Math.min(offset, Math.max(0, total - boundedCount)));
  return { offset: boundedOffset, count: boundedCount };
}

/** 默认视口：最近 min(120, total) 根。 */
export function defaultKlineView(total: number): KlineView {
  const count = Math.max(1, Math.min(DEFAULT_KLINE_VIEW_BARS, Math.max(total, 1)));
  return { offset: Math.max(0, total - count), count };
}

/** 十字光标位置（vx/vy 为 viewBox 坐标，idx 为全局 bar 下标）。 */
interface Crosshair {
  vx: number;
  vy: number;
  idx: number;
}

export function KlineChart({
  bars,
  ma,
  view,
  onViewChange,
  onHoverChange,
  className,
}: KlineChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const total = bars.length;
  const effective: KlineView = view ?? { offset: 0, count: Math.max(total, 1) };
  // 事件闭包（原生 wheel / pointer capture）读取最新值的桥。
  const totalRef = useRef(total);
  const viewRef = useRef(effective);
  useEffect(() => {
    totalRef.current = total;
    viewRef.current = effective;
  }, [total, effective]);

  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const [cross, setCross] = useState<Crosshair | null>(null);
  useEffect(() => {
    onHoverChange?.(cross ? cross.idx : null);
  }, [cross, onHoverChange]);

  const commit = useCallback(
    (offset: number, count: number) => {
      const next = clampKlineView(offset, count, totalRef.current);
      const prev = viewRef.current;
      if (next.offset === prev.offset && next.count === prev.count) return;
      onViewChange?.(next);
    },
    [onViewChange],
  );

  /** client 像素 → viewBox X（rect 宽为 0 的测试环境回退标称宽度）。 */
  const clientXToViewX = useCallback((clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) / (rect.width || WIDTH)) * WIDTH;
  }, []);

  /** client 像素 → viewBox Y。 */
  const clientYToViewY = useCallback((clientY: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return ((clientY - rect.top) / (rect.height || HEIGHT)) * HEIGHT;
  }, []);

  /** 以视口内浮点索引 anchorIdx 为锚缩放：锚点下的 bar 保持相对位置；
   *  无坐标事件（部分滚轮/合成事件不带 clientX）回退视口中心。 */
  const zoomAt = useCallback(
    (anchorVx: number, factor: number) => {
      const t = totalRef.current;
      if (t === 0) return;
      const current = viewRef.current;
      const centerVx = PAD_LEFT + (WIDTH - PAD_LEFT - PAD_RIGHT) / 2;
      const anchor = Number.isFinite(anchorVx) ? anchorVx : centerVx;
      const slot = (WIDTH - PAD_LEFT - PAD_RIGHT) / current.count;
      const anchorIdx = Math.max(0, Math.min(current.count, (anchor - PAD_LEFT) / slot));
      const newCount = Math.max(
        Math.min(MIN_VISIBLE_BARS, t),
        Math.min(t, Math.round(current.count * factor)),
      );
      const ratio = anchorIdx / current.count;
      commit(Math.round(current.offset + anchorIdx - ratio * newCount), newCount);
    },
    [commit],
  );

  // 滚轮缩放：原生监听（passive: false）才能阻止页面滚动。
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || total === 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(
        clientXToViewX(e.clientX),
        e.deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR,
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [total, zoomAt, clientXToViewX]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (total === 0) return;
    dragRef.current = { startX: e.clientX, startOffset: viewRef.current.offset };
    setDragging(true);
    setCross(null);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (total === 0) return;
    if (dragRef.current) {
      // 平移：右拖看更早（offset 减小），左拖看更晚。
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const slotPx =
        ((rect.width || WIDTH) / WIDTH) *
        ((WIDTH - PAD_LEFT - PAD_RIGHT) / viewRef.current.count);
      if (slotPx <= 0) return;
      const deltaBars = (e.clientX - dragRef.current.startX) / slotPx;
      commit(dragRef.current.startOffset - Math.round(deltaBars), viewRef.current.count);
      return;
    }
    // 悬停十字光标：吸附到最近 bar 中心，纵向自由。
    const vx = clientXToViewX(e.clientX);
    const vy = clientYToViewY(e.clientY);
    const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
    if (
      !Number.isFinite(vx) ||
      !Number.isFinite(vy) ||
      vx < PAD_LEFT ||
      vx > WIDTH - PAD_RIGHT ||
      vy < PAD_TOP ||
      vy > HEIGHT - PAD_BOTTOM
    ) {
      setCross(null);
      return;
    }
    const slot = innerW / viewRef.current.count;
    const idx = Math.max(
      viewRef.current.offset,
      Math.min(
        viewRef.current.offset + viewRef.current.count - 1,
        viewRef.current.offset + Math.floor((vx - PAD_LEFT) / slot),
      ),
    );
    setCross({ vx, vy, idx });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const visible = useMemo(
    () => bars.slice(effective.offset, effective.offset + effective.count),
    [bars, effective],
  );

  const geometry = useMemo(() => {
    if (visible.length === 0) return null;
    const highs = visible.map((b) => b.high);
    const lows = visible.map((b) => b.low);
    const max = Math.max(...highs);
    const min = Math.min(...lows);
    const span = max - min || 1;
    const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
    const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const slot = innerW / visible.length;
    const x = (i: number) => PAD_LEFT + slot * i + slot / 2;
    const y = (v: number) => PAD_TOP + innerH * (1 - (v - min) / span);
    const priceAt = (vy: number) => min + ((PAD_TOP + innerH - vy) / innerH) * span;
    return { innerH, innerW, max, min, slot, x, y, priceAt };
  }, [visible]);

  if (!geometry) {
    return (
      <div
        className={cn(
          "flex h-60 items-center justify-center text-caption text-muted-foreground",
          className,
        )}
      >
        暂无K线数据
      </div>
    );
  }

  const { innerH, innerW, max, min, slot, x, y, priceAt } = geometry;
  const bodyW = Math.max(1.5, slot * 0.6);
  const horizontalTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return {
      value: max - (max - min) * ratio,
      y: PAD_TOP + innerH * ratio,
    };
  });
  const dateTickIndexes = Array.from(
    new Set(
      Array.from(
        { length: 6 },
        (_, index) =>
          Math.min(visible.length - 1, Math.round(((visible.length - 1) * index) / 5)),
      ),
    ),
  );

  const hoverBar = cross ? bars[cross.idx] : null;
  const hoverPrevClose = cross && cross.idx > 0 ? bars[cross.idx - 1]?.close : null;
  const hoverPct =
    hoverBar && hoverPrevClose
      ? ((hoverBar.close - hoverPrevClose) / hoverPrevClose) * 100
      : null;
  const crossCx = cross ? x(cross.idx - effective.offset) : 0;

  return (
    <div className={cn("relative", className)}>
      <svg
        ref={svgRef}
        role="img"
        aria-label="K线图"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerLeave={() => setCross(null)}
        onDoubleClick={() => onViewChange?.(defaultKlineView(totalRef.current))}
        className={cn(
          "block h-60 w-full select-none 2xl:h-72",
          dragging ? "cursor-grabbing" : "cursor-crosshair",
        )}
      >
        {horizontalTicks.map((tick) => (
          <g key={tick.y}>
            <line
              x1={PAD_LEFT}
              x2={PAD_LEFT + innerW}
              y1={tick.y}
              y2={tick.y}
              stroke="hsl(var(--border))"
              strokeWidth={0.7}
            />
            <text
              x={WIDTH - 3}
              y={tick.y + 3}
              fill="hsl(var(--muted-foreground))"
              fontSize={9}
              textAnchor="end"
            >
              {tick.value.toFixed(2)}
            </text>
          </g>
        ))}
        {dateTickIndexes.map((index) => (
          <g key={index}>
            <line
              x1={x(index)}
              x2={x(index)}
              y1={PAD_TOP}
              y2={PAD_TOP + innerH}
              stroke="hsl(var(--border))"
              strokeWidth={0.45}
              strokeDasharray="2 3"
            />
            <text
              x={x(index)}
              y={HEIGHT - 5}
              fill="hsl(var(--muted-foreground))"
              fontSize={9}
              textAnchor="middle"
            >
              {visible[index]?.date?.slice(5) ?? ""}
            </text>
          </g>
        ))}
        {visible.map((b, i) => {
          const up = b.close >= b.open;
          const cx = x(i);
          const top = y(Math.max(b.open, b.close));
          const bottom = y(Math.min(b.open, b.close));
          return (
            <g
              key={b.date || i}
              data-candle
              data-date={b.date}
              data-direction={up ? "up" : "down"}
              className={up ? "text-stock-up" : "text-stock-down"}
            >
              <line
                x1={cx}
                x2={cx}
                y1={y(b.high)}
                y2={y(b.low)}
                stroke="currentColor"
                strokeWidth={1}
              />
              <rect
                x={cx - bodyW / 2}
                y={top}
                width={bodyW}
                height={Math.max(1, bottom - top)}
                fill={up ? "none" : "currentColor"}
                stroke="currentColor"
                strokeWidth={1}
              />
            </g>
          );
        })}
        {ma &&
          (Object.keys(MA_STROKES) as (keyof KlineChartMa)[]).map((key) => {
            const values = (ma[key] ?? []).slice(
              effective.offset,
              effective.offset + effective.count,
            );
            const points = values
              .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
              .filter((p): p is string => p !== null);
            if (points.length === 0) return null;
            return (
              <polyline
                key={key}
                data-ma={key}
                points={points.join(" ")}
                fill="none"
                stroke={MA_STROKES[key]}
                strokeWidth={1.2}
              />
            );
          })}
        {cross && hoverBar && (
          <g data-crosshair aria-hidden>
            <line
              x1={crossCx}
              x2={crossCx}
              y1={PAD_TOP}
              y2={PAD_TOP + innerH}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={0.7}
              strokeDasharray="3 3"
            />
            <line
              x1={PAD_LEFT}
              x2={PAD_LEFT + innerW}
              y1={cross.vy}
              y2={cross.vy}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={0.7}
              strokeDasharray="3 3"
            />
            {/* 右轴价格标签 */}
            <rect
              x={WIDTH - PAD_RIGHT + 2}
              y={cross.vy - 7}
              width={PAD_RIGHT - 4}
              height={14}
              rx={2}
              fill="hsl(var(--foreground))"
            />
            <text
              x={WIDTH - 4}
              y={cross.vy + 3.5}
              fill="hsl(var(--background))"
              fontSize={9}
              textAnchor="end"
            >
              {priceAt(cross.vy).toFixed(2)}
            </text>
            {/* 底部日期标签 */}
            <rect
              x={Math.min(Math.max(crossCx - 26, PAD_LEFT), WIDTH - PAD_RIGHT - 54)}
              y={HEIGHT - PAD_BOTTOM + 2}
              width={52}
              height={13}
              rx={2}
              fill="hsl(var(--foreground))"
            />
            <text
              x={Math.min(Math.max(crossCx, PAD_LEFT + 26), WIDTH - PAD_RIGHT - 28)}
              y={HEIGHT - PAD_BOTTOM + 11.5}
              fill="hsl(var(--background))"
              fontSize={9}
              textAnchor="middle"
            >
              {hoverBar.date?.slice(5) ?? ""}
            </text>
          </g>
        )}
      </svg>
      {/* 悬停 OHLC 读数条 */}
      {hoverBar && (
        <div className="pointer-events-none absolute left-2 top-1 flex flex-wrap gap-x-2 gap-y-0.5 text-micro tabular-nums text-muted-foreground">
          <span>{hoverBar.date}</span>
          <span>开 {hoverBar.open.toFixed(2)}</span>
          <span>高 {hoverBar.high.toFixed(2)}</span>
          <span>低 {hoverBar.low.toFixed(2)}</span>
          <span className={hoverBar.close >= hoverBar.open ? "text-stock-up" : "text-stock-down"}>
            收 {hoverBar.close.toFixed(2)}
          </span>
          {hoverPct != null && (
            <span className={hoverPct >= 0 ? "text-stock-up" : "text-stock-down"}>
              {`${hoverPct >= 0 ? "+" : ""}${hoverPct.toFixed(2)}%`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
