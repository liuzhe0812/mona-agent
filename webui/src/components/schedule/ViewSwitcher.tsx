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
            "rounded-full px-2.5 py-0.5 text-[12px] transition-colors",
            mode === m.value
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
