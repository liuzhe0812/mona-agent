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
        "group relative flex shrink-0 items-center justify-center bg-transparent",
        // Vertical split (default between side-by-side panels): narrow tall handle
        "w-3 cursor-col-resize",
        // Horizontal split (between vertically stacked panels): wide short handle
        "aria-[orientation=horizontal]:h-3 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize",
        className
      )}
      {...props}
    >
      {/* Visible 1px line - vertical split (between side-by-side panels) */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/40 group-active:bg-primary/40 group-aria-[orientation=horizontal]:hidden" />
      {/* Visible 1px line - horizontal split (between stacked panels) */}
      <div className="absolute inset-x-0 top-1/2 hidden h-px -translate-y-1/2 bg-border group-hover:bg-primary/40 group-active:bg-primary/40 group-aria-[orientation=horizontal]:block" />
      {withHandle && (
        <div className="z-10 flex h-8 w-1.5 shrink-0 rounded-full bg-border group-aria-[orientation=horizontal]:h-1.5 group-aria-[orientation=horizontal]:w-8" />
      )}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
