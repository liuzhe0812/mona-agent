import { useCallback, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SplitPaneProps {
  left: ReactNode;
  /** Optional middle pane (three-column mode). */
  middle?: ReactNode;
  /** Optional right pane. */
  right?: ReactNode;
  /** Left:rest split ratio (0..1). Kept for backward compatibility with two-column mode. */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** Right pane visibility (two-column mode) / right pane visibility (three-column mode). */
  rightVisible: boolean;
  /** Middle pane visibility (three-column mode only). */
  middleVisible?: boolean;
  /** Middle:right split ratio (0..1) within the right half. */
  middleRatio?: number;
  onMiddleRatioChange?: (ratio: number) => void;
}

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const DIVIDER_WIDTH = 6;

export function SplitPane({
  left,
  middle,
  right,
  ratio,
  onRatioChange,
  rightVisible,
  middleVisible = true,
  middleRatio = 0.6,
  onMiddleRatioChange,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const middleContainerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<null | "left" | "middle">(null);

  const onLeftPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = "left";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onMiddlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = "middle";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const which = dragging.current;
      if (!which) return;
      if (which === "left") {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const next = (e.clientX - rect.left) / rect.width;
        onRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)));
        return;
      }
      if (which === "middle") {
        const rect = middleContainerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const next = (e.clientX - rect.left) / rect.width;
        onMiddleRatioChange?.(
          Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)),
        );
      }
    },
    [onRatioChange, onMiddleRatioChange],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const hasMiddle = middle != null && middleVisible;
  const hasRight = right != null && rightVisible;

  // Neither side panel: just render left full-width.
  if (!hasMiddle && !hasRight) {
    return <>{left}</>;
  }

  // Only right pane: legacy two-column behavior.
  if (!hasMiddle) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full overflow-hidden"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          style={{ width: `${ratio * 100}%` }}
          className="flex min-w-0 flex-col overflow-hidden"
        >
          {left}
        </div>
        <Divider onPointerDown={onLeftPointerDown} />
        <div
          style={{ width: `${(1 - ratio) * 100}%` }}
          className="flex min-w-0 flex-col overflow-hidden"
        >
          {right}
        </div>
      </div>
    );
  }

  // Three-column mode: [left | middle | right]
  return (
    <div
      ref={containerRef}
      className="flex h-full w-full overflow-hidden"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        style={{ width: `${ratio * 100}%` }}
        className="flex min-w-0 flex-col overflow-hidden"
      >
        {left}
      </div>
      <Divider onPointerDown={onLeftPointerDown} />
      <div
        ref={middleContainerRef}
        style={{ width: `${(1 - ratio) * 100}%` }}
        className="flex min-w-0 overflow-hidden"
      >
        <div
          style={{ width: hasRight ? `${middleRatio * 100}%` : "100%" }}
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {middle}
        </div>
        {hasRight ? (
          <>
            <Divider onPointerDown={onMiddlePointerDown} />
            <div
              style={{ width: `${(1 - middleRatio) * 100}%` }}
              className="flex min-w-0 flex-col overflow-hidden"
            >
              {right}
            </div>
          </>
        ) : null}
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
        "bg-border/40 hover:bg-primary/25 active:bg-primary/35",
        "transition-colors",
      )}
      style={{ width: DIVIDER_WIDTH }}
    >
      <div className="h-8 w-0.5 rounded-full bg-muted-foreground/30" />
    </div>
  );
}
