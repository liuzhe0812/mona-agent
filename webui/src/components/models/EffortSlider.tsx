import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";

type EffortSliderProps = {
  stops: readonly string[];
  value: string | null;
  recommended?: string | null;
  labelOf: (value: string) => string;
  onChange: (value: string) => void | Promise<void>;
  disabled?: boolean;
};

export function EffortSlider({
  stops,
  value,
  recommended,
  labelOf,
  onChange,
  disabled = false,
}: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (pendingValue !== null && pendingValue === value) setPendingValue(null);
  }, [pendingValue, value]);

  const lastIndex = stops.length - 1;
  const currentValue = pendingValue ?? value;
  const valueIndex = Math.max(0, currentValue == null ? -1 : stops.indexOf(currentValue));
  const activeIndex = dragPosition === null ? valueIndex : Math.round(dragPosition);
  const activeStop = stops[Math.min(lastIndex, Math.max(0, activeIndex))];
  const position = dragPosition ?? valueIndex;
  const percent = lastIndex > 0 ? (position / lastIndex) * 100 : 0;

  const positionFromEvent = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return valueIndex;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * lastIndex;
    },
    [lastIndex, valueIndex],
  );

  const commit = useCallback(
    (index: number) => {
      const next = stops[Math.min(lastIndex, Math.max(0, index))];
      if (next === undefined || next === (pendingValue ?? value) || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setPendingValue(next);
      try {
        const result = onChange(next);
        if (result) {
          void result.catch(() => setPendingValue(null)).finally(() => {
            savingRef.current = false;
            setSaving(false);
          });
        } else {
          savingRef.current = false;
          setSaving(false);
        }
      } catch {
        setPendingValue(null);
        savingRef.current = false;
        setSaving(false);
      }
    },
    [lastIndex, onChange, pendingValue, stops, value],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current || disabled || savingRef.current) return;
      setDragPosition(positionFromEvent(event.clientX));
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      const nextIndex = Math.round(positionFromEvent(event.clientX));
      pointerIdRef.current = null;
      setDragging(false);
      setDragPosition(null);
      if (!disabled) commit(nextIndex);
    };
    const onCancel = (event?: PointerEvent | Event) => {
      if (event && "pointerId" in event && event.pointerId !== pointerIdRef.current) return;
      pointerIdRef.current = null;
      setDragging(false);
      setDragPosition(null);
    };

    if (disabled) onCancel();
    window.addEventListener("blur", onCancel);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("blur", onCancel);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, [commit, disabled, dragging, positionFromEvent]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || savingRef.current || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.currentTarget.focus();
    pointerIdRef.current = event.pointerId;
    setDragging(true);
    setDragPosition(Math.round(positionFromEvent(event.clientX)));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || savingRef.current) return;
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : delta === 0
            ? null
            : Math.min(lastIndex, Math.max(0, valueIndex + delta));
    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    commit(nextIndex);
  };

  const activeLabel = dragPosition === null && currentValue === null ? "默认" : activeStop ? labelOf(activeStop) : "";
  const transition = dragging ? "none" : "left var(--motion-standard) var(--ease-standard)";

  return (
    <div className={cn("group/effort relative min-w-0 flex-1 px-2 pb-1 pt-3", disabled && "opacity-50")}>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="思考强度"
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        aria-valuenow={activeIndex}
        aria-valuetext={activeLabel || undefined}
        aria-disabled={disabled || saving}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="relative flex h-8 touch-none cursor-ew-resize items-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="absolute inset-x-0 h-3 rounded-full bg-muted" />
        <div
          className="absolute left-0 h-3 rounded-full bg-info"
          style={{ width: `${percent}%`, transition: dragging ? "none" : "width var(--motion-standard) var(--ease-standard)" }}
        />
        {stops.map((stop, index) =>
          index === 0 || index === lastIndex ? null : (
            <span
              key={stop}
              aria-hidden="true"
              className="absolute z-[1] h-1 w-1 -translate-x-1/2 rounded-full bg-background"
              style={{ left: `${(index / lastIndex) * 100}%` }}
            />
          ),
        )}
        <span
          aria-hidden="true"
          className="absolute z-[2] h-5 w-5 -translate-x-1/2 rounded-full border-2 border-background bg-info"
          style={{ left: `${percent}%`, transition }}
        />
        <span
          aria-hidden="true"
          className={cn("pointer-events-none absolute -top-4 z-[3] -translate-x-1/2 whitespace-nowrap rounded-md border border-info/20 bg-popover px-2 py-0.5 text-caption text-info opacity-0 transition-opacity", "group-hover/effort:opacity-100 group-focus-within/effort:opacity-100", dragging && "opacity-100")}
          style={{ left: `clamp(2rem, ${percent}%, calc(100% - 2rem))` }}
        >
          {activeLabel}{recommended != null && activeStop === recommended ? " · 推荐" : ""}
        </span>
      </div>
      <div aria-hidden="true" className={cn("pointer-events-none absolute inset-x-2 -bottom-3 flex justify-between text-caption leading-4 text-muted-foreground transition-opacity", dragging ? "opacity-100" : "opacity-0")}>
        <span>{stops[0] ? labelOf(stops[0]) : ""}</span>
        <span>{stops[lastIndex] ? labelOf(stops[lastIndex]) : ""}</span>
      </div>
    </div>
  );
}
