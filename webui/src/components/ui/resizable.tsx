import { GripVertical } from "lucide-react"
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: GroupProps & { direction?: "horizontal" | "vertical" }) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction ?? "horizontal"}
      className={cn(
        "flex h-full w-full data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "group relative flex shrink-0 items-center justify-center bg-border",
        // Vertical split (default between side-by-side panels): visible 1px line + 8px hit area
        "w-px cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 after:bg-transparent",
        // Horizontal split (between vertically stacked panels)
        "data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full data-[orientation=vertical]:cursor-row-resize data-[orientation=vertical]:after:inset-x-0 data-[orientation=vertical]:after:top-1/2 data-[orientation=vertical]:after:h-2 data-[orientation=vertical]:after:w-full data-[orientation=vertical]:after:-translate-y-1/2 data-[orientation=vertical]:after:translate-x-0",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-7 w-5 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm transition-colors group-hover:border-primary/40 group-hover:text-primary group-active:border-primary/40 group-active:text-primary group-data-[orientation=vertical]:rotate-90">
          <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
