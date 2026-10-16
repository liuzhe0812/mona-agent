import * as React from "react";

import { cn } from "@/lib/utils";

const Slider = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => (
  <input
    {...props}
    ref={ref}
    type="range"
    className={cn(
      "accent-[hsl(var(--info))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  />
));
Slider.displayName = "Slider";

export { Slider };
