import * as React from "react";

import { cn } from "@/lib/utils";

interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "default" | "sm";
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, className, disabled, size = "default", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors",
        size === "sm" ? "h-5 w-8 after:absolute after:inset-x-0 after:top-1/2 after:h-8 after:-translate-y-1/2" : "h-6 w-10",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-info" : "bg-input",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "block rounded-full bg-white shadow-sm transition-transform",
          size === "sm" ? "h-3 w-3" : "h-4 w-4",
          checked ? size === "sm" ? "translate-x-4" : "translate-x-5" : "translate-x-1",
        )}
      />
    </button>
  );
});
