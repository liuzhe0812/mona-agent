import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SplitPaneProps {
  left: ReactNode;
  /** Optional right pane. */
  right?: ReactNode;
  /** Left:right split ratio (0..1) — fraction occupied by the left pane. */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** Right pane visibility. */
  rightVisible: boolean;
}

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.85;
const DIVIDER_WIDTH = 6;
/** Pixel floors: ratio bounds alone let narrow windows crush a pane below a
 *  usable width (right panel forms break, conversation column over-wraps). */
const MIN_LEFT_PX = 360;
const MIN_RIGHT_PX = 280;

export function SplitPane({
  left,
  right,
  ratio,
  onRatioChange,
  rightVisible,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rightVisible]);

  const clampRatio = useCallback((next: number, width: number) => {
    let minR = MIN_RATIO;
    let maxR = MAX_RATIO;
    if (width > 0) {
      minR = Math.max(minR, MIN_LEFT_PX / width);
      maxR = Math.min(maxR, 1 - MIN_RIGHT_PX / width);
      // Too narrow for both floors: keep the right pane usable and let the
      // conversation column take whatever remains.
      if (minR > maxR) minR = 0;
    }
    return Math.min(maxR, Math.max(minR, next));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = (e.clientX - rect.left) / rect.width;
      onRatioChange(clampRatio(next, rect.width));
    },
    [clampRatio, onRatioChange],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!rightVisible || right == null) {
    return <>{left}</>;
  }

  const effectiveRatio = clampRatio(ratio, containerWidth);

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full overflow-hidden"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        style={{ width: `${effectiveRatio * 100}%` }}
        className="flex min-w-0 flex-col overflow-hidden"
      >
        {left}
      </div>
      <Divider onPointerDown={onPointerDown} />
      <div
        style={{ width: `${(1 - effectiveRatio) * 100}%` }}
        className="flex min-w-0 shrink-0 flex-col overflow-hidden"
      >
        {right}
      </div>
    </div>
  );
}

function Divider({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "z-10 flex shrink-0 cursor-col-resize items-center justify-center",
        "bg-transparent hover:bg-primary/10 active:bg-primary/20",
        "transition-colors",
      )}
      style={{ width: DIVIDER_WIDTH }}
    >
      <div className="h-full w-px bg-border/60" />
    </div>
  );
}
