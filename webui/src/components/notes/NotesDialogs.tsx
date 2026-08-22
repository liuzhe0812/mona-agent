import { useEffect, useState } from "react";
import { FileText } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { OperationNote } from "./notes-data";

interface PromptDialogProps {
  open: boolean;
  title: string;
  defaultValue?: string;
  placeholder?: string;
  loading?: boolean;
  onConfirm: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}

export function PromptDialog({
  open,
  title,
  defaultValue = "",
  placeholder = "",
  loading = false,
  onConfirm,
  onOpenChange,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  const handleOpenChange = (nextOpen: boolean) => {
    if (loading && !nextOpen) return;
    if (nextOpen) {
      setValue(defaultValue);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[360px] gap-0 rounded-xl border-border/70 p-0">
        <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
          <DialogTitle className="text-body">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoFocus
            disabled={loading}
            className="h-8 w-full rounded-lg border-border/70 bg-background px-2.5 text-caption shadow-none focus-visible:ring-0 focus:border-border"
          />
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-caption"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-caption"
            disabled={!value.trim() || loading}
            onClick={handleSubmit}
          >
            {loading ? "生成中..." : "确定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  destructive?: boolean;
  confirmText?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  destructive = false,
  confirmText = "确定",
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[360px] gap-0 rounded-xl border-border/70 p-0">
        <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
          <DialogTitle className="text-body">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3">
          <p className="text-ui text-muted-foreground">{message}</p>
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-caption"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className={cn("h-7 px-2.5 text-caption", destructive && "bg-destructive hover:bg-destructive/90")}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TemplatePickerDialogProps {
  open: boolean;
  templates: OperationNote[];
  onConfirm: (templateId: string, title: string) => void;
  onOpenChange: (open: boolean) => void;
}

export function TemplatePickerDialog({
  open,
  templates,
  onConfirm,
  onOpenChange,
}: TemplatePickerDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedId(templates.length > 0 ? templates[0].id : null);
      setTitle("");
    }
  }, [open, templates]);

  const handleConfirm = () => {
    if (!selectedId || !title.trim()) return;
    onConfirm(selectedId, title.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px] gap-0 rounded-xl border-border/70 p-0">
        <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
          <DialogTitle className="text-body">从模板创建笔记</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-4 py-3">
          {templates.length === 0 ? (
            <p className="py-4 text-center text-ui text-muted-foreground">
              没有可用模板。请先创建一篇笔记并标记为模板。
            </p>
          ) : (
            <>
              <div className="max-h-[220px] space-y-px overflow-y-auto scrollbar-thin">
                {templates.map((tpl) => (
                  <Button
                    key={tpl.id}
                    type="button"
                    variant="ghost"
                    onClick={() => setSelectedId(tpl.id)}
                    className={cn(
                      "h-auto w-full justify-start gap-2 rounded-md px-2.5 py-2 text-left text-ui font-normal",
                      selectedId === tpl.id
                        ? "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
                        : "hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{tpl.title || "未命名模板"}</span>
                  </Button>
                ))}
              </div>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleConfirm();
                  }
                }}
                placeholder="新笔记标题"
                autoFocus
                className="h-8 text-ui"
              />
            </>
          )}
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-caption"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-caption"
            disabled={!selectedId || !title.trim()}
            onClick={handleConfirm}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
