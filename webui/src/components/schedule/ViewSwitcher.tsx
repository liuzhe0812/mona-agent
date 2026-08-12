/** Segmented control for switching calendar view mode (month / week / day). */

import { Button } from "@/components/ui/button";
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
        <Button
          key={m.value}
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onChange(m.value)}
          className={cn(
            "rounded-full px-2.5",
            mode === m.value
              ? "bg-background font-medium text-foreground shadow-sm hover:bg-background hover:text-foreground"
              : "text-muted-foreground hover:bg-transparent hover:text-foreground",
          )}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}
