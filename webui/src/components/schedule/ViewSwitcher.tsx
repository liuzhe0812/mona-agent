/** Segmented control for switching calendar view mode (month / week / day). */

import { cn } from "@/lib/utils";

export type CalendarViewMode = "month" | "week" | "day";

const MODES: { value: CalendarViewMode; label: string }[] = [
  { value: "month", label: "月" },
  { value: "week", label: "周" },
  { value: "day", label: "日" },
];

export function isCalendarViewMode(value: string | null): value is CalendarViewMode {
  return value === "month" || value === "week" || value === "day";
}

export function ViewSwitcher({
  mode,
  onChange,
}: {
  mode: CalendarViewMode;
  onChange: (mode: CalendarViewMode) => void;
}) {
  return (
    <div className="flex items-center rounded-full bg-muted p-0.5">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          className={cn(
            "inline-flex h-7 items-center justify-center whitespace-nowrap rounded-full px-2 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
            mode === m.value
              ? "bg-background text-foreground shadow-sm hover:bg-background hover:text-foreground"
              : "text-muted-foreground hover:bg-transparent hover:text-foreground",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
