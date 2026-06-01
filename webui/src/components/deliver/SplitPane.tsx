import { useCallback, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  rightVisible: boolean;
}

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const DIVIDER_WIDTH = 6;

export function SplitPane({ left, right, ratio, onRatioChange, rightVisible }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = (e.clientX - rect.left) / rect.width;
      onRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)));
    },
    [onRatioChange],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!rightVisible) {
    return <>{left}</>;
  }

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div style={{ width: `${ratio * 100}%` }} className="flex min-w-0 flex-col overflow-hidden">
        {left}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          "z-10 flex shrink-0 cursor-col-resize items-center justify-center",
          "bg-border/40 hover:bg-primary/25 active:bg-primary/35",
          "transition-colors",
        )}
        style={{ width: DIVIDER_WIDTH }}
      >
        <div className="h-8 w-0.5 rounded-full bg-muted-foreground/30" />
      </div>
      <div style={{ width: `${(1 - ratio) * 100}%` }} className="flex min-w-0 flex-col overflow-hidden">
        {right}
      </div>
    </div>
  );
}
