import type { ReactNode } from "react";
import { TooltipProvider } from "./primitives/tooltip";
import { cn } from "@/components/development/zcode/utils";
import "./zcode-stream.css";

export function ZCodeSurface({ children, className }: { children: ReactNode; className?: string }) {
  return <TooltipProvider><div className={cn("zcode-stream", className)}>{children}</div></TooltipProvider>;
}
