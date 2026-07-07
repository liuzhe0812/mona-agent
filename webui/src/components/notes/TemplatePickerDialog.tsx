import { useEffect, useState } from "react";
import { FileCode2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { createNoteFromTemplate, listNoteTemplates, type TemplateItem } from "@/lib/tauri";

interface TemplatePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (noteId: string) => void;
  defaultNotebookId?: string;
}

export function TemplatePickerDialog({
  open,
  onOpenChange,
  onCreated,
  defaultNotebookId,
}: TemplatePickerDialogProps) {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    setTitle("");
    listNoteTemplates()
      .then((items) => {
        setTemplates(items);
        if (items.length > 0) setSelectedId(items[0].id);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [open]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const handleCreate = async () => {
    if (!selected || !title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const noteId = await createNoteFromTemplate(
        selected.id,
        title.trim(),
        defaultNotebookId,
      );
      onCreated?.(noteId);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="px-4 py-3">
          <DialogTitle className="text-[14px]">从模板创建笔记</DialogTitle>
        </DialogHeader>
        <div className="flex h-[420px] border-t border-border/60">
          <div className="flex w-[240px] shrink-0 flex-col border-r border-border/60">
            <div className="border-b border-border/60 px-2 py-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">模板列表</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-thin">
              {loading && (
                <div className="px-3 py-2 text-[11.5px] text-muted-foreground/70">
                  加载中...
                </div>
              )}
              {error && (
                <div className="px-3 py-2 text-[11.5px] text-destructive/80">
                  {error}
                </div>
              )}
              {!loading && templates.length === 0 && !error && (
                <div className="px-3 py-2 text-[11.5px] text-muted-foreground/70">
                  暂无模板。先创建一个笔记，将 frontmatter 的 type 改为
                  <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px]">template</code>
                  即可作为模板。
                </div>
              )}
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-accent/60",
                    selectedId === t.id && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
                      {t.title || "(未命名模板)"}
                    </span>
                  </div>
                  {t.preview && (
                    <span className="line-clamp-1 pl-5 text-[10.5px] text-muted-foreground/70">
                      {t.preview}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-border/60 px-3 py-2">
              <label className="mb-1 block text-[11px] text-muted-foreground">
                新笔记标题
              </label>
              <Input
                placeholder="输入新笔记标题..."
                className="h-8 text-[13px]"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim() && selected && !creating) {
                    void handleCreate();
                  }
                }}
              />
              {selected && (
                <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">
                  模板变量：<code className="rounded bg-muted px-1 py-0.5">{"{{title}}"}</code>
                  <code className="ml-1 rounded bg-muted px-1 py-0.5">{"{{date}}"}</code>
                  <code className="ml-1 rounded bg-muted px-1 py-0.5">{"{{time}}"}</code>
                  <code className="ml-1 rounded bg-muted px-1 py-0.5">{"{{notebook}}"}</code>
                  <code className="ml-1 rounded bg-muted px-1 py-0.5">{"{{timestamp}}"}</code>
                  <code className="ml-1 rounded bg-muted px-1 py-0.5">{"{{note_id}}"}</code>
                </p>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
              {selected ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
                  {selected.preview}
                </pre>
              ) : (
                <div className="flex h-full items-center justify-center text-[11.5px] text-muted-foreground/60">
                  从左侧选择一个模板
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="border-t border-border/60 px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            disabled={!selected || !title.trim() || creating}
            onClick={() => void handleCreate()}
          >
            {creating ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
