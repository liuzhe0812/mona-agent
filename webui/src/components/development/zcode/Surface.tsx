import type { ReactNode } from "react";
import { TooltipProvider } from "./primitives/tooltip";
import { cn } from "@/components/development/zcode/utils";
import "./zcode-stream.css";

// The provider is supplied by ZCode Root in the original app. Scope it to the
// transplanted surface so standalone transcript/preview hosts have the same context.
export function ZCodeSurface({ children, className }: { children: ReactNode; className?: string }) {
  return <TooltipProvider><div className={cn("zcode-stream", className)}>{children}</div></TooltipProvider>;
}
