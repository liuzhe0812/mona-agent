import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/CodeBlock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DbToolButton } from "./DbToolButton";

export function DdlPreviewPopover({
  open,
  title,
  sql,
  loading = false,
  error,
  onClose,
}: {
  open: boolean;
  title: string;
  sql: string | null | undefined;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => setCopied(false), [open, sql]);

  if (!open) return null;
  const content = sql?.trim() ?? "";

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        role="dialog"
        aria-modal="false"
        aria-label="DDL 预览"
        className="absolute right-2 top-12 z-30 w-3/5 min-w-96 overflow-hidden rounded-lg border border-border bg-popover shadow-float"
      >
        <div className="flex h-9 items-center gap-2 border-b border-border px-2">
          <span className="min-w-0 flex-1 truncate text-caption font-medium" title={title}>{title}</span>
          <DbToolButton
            icon="copy"
            label={copied ? "已复制 DDL" : "复制 DDL"}
            className="h-7 w-7"
            disabled={!content}
            onClick={() => {
              if (!navigator.clipboard || !content) return;
              void navigator.clipboard.writeText(content).then(() => setCopied(true));
            }}
          />
          <DbToolButton icon="close" label="关闭 DDL" className="h-7 w-7" onClick={onClose} />
        </div>
        {loading ? (
          <div className="flex min-h-32 items-center justify-center text-caption text-muted-foreground" role="status">正在加载 DDL…</div>
        ) : error ? (
          <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 text-caption text-destructive" role="alert">{error}</div>
        ) : content ? (
          <CodeBlock language="sql" code={content} showHeader={false} className="rounded-none" />
        ) : (
          <div className="flex min-h-32 items-center justify-center text-caption text-muted-foreground">选择一个对象查看 DDL</div>
        )}
      </aside>
    </TooltipProvider>
  );
}
