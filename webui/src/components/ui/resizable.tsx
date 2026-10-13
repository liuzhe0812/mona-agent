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

const resizeHandleInteractionClass = "mona-resize-handle"

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
        "group relative flex shrink-0 items-center justify-center",
        resizeHandleInteractionClass,
        // Vertical split (default between side-by-side panels): visible 1px line + 8px hit area
        "w-px cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 after:bg-transparent",
        // Horizontal split (between vertically stacked panels)
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-7 w-5 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm group-aria-[orientation=horizontal]:rotate-90">
          <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup, resizeHandleInteractionClass }
