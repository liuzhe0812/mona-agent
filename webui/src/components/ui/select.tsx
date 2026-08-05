import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  ({ value, onValueChange, options, placeholder = "请选择", className, disabled }, ref) => {
    const selected = options.find((o) => o.value === value);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn("w-full justify-between font-normal", className)}
          >
            <span className={cn("truncate", !selected && "text-muted-foreground")}>
              {selected?.label ?? placeholder}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="max-h-64 min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto scrollbar-thin"
          align="start"
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onValueChange?.(option.value)}
              className="gap-2"
            >
              <Check
                className={cn(
                  "h-4 w-4 shrink-0",
                  value === option.value ? "opacity-100" : "opacity-0",
                )}
              />
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
);
Select.displayName = "Select";
