import { forwardRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DbIcon, type DbIconName } from "./DbIcon";

export const DbToolButton = forwardRef<HTMLButtonElement, ButtonProps & { icon: DbIconName; label: string }>(
  ({ icon, label, className, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={ref} type="button" variant="ghost" size="icon" aria-label={label}
          className={cn("h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground", className)} {...props}>
          <DbIcon name={icon} className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  ),
);
DbToolButton.displayName = "DbToolButton";
