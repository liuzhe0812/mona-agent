import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

interface CollapsibleContentProps {
  children: ReactNode;
  contentKey: string;
  maxHeight: number;
  fadeClassName?: string;
  className?: string;
}

/** Keeps unusually tall chat content readable without discarding any of it. */
export function CollapsibleContent({
  children,
  contentKey,
  maxHeight,
  fadeClassName = "from-background via-background/90",
  className,
}: CollapsibleContentProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    setOverflows(content.scrollHeight > maxHeight);
  }, [maxHeight]);

  useLayoutEffect(() => {
    setExpanded(false);
    measure();
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentKey, measure]);

  const collapsed = overflows && !expanded;
  return (
    <div className={className}>
      <div
        className={cn("relative", collapsed && "overflow-hidden")}
        style={collapsed ? { maxHeight } : undefined}
      >
        <div ref={contentRef}>{children}</div>
        {collapsed ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent",
              fadeClassName,
            )}
          />
        ) : null}
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t("message.collapse") : t("message.showAll")}
        </button>
      ) : null}
    </div>
  );
}
