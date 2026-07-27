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
  onConfirm: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}

export function PromptDialog({
  open,
  title,
  defaultValue = "",
  placeholder = "",
  onConfirm,
  onOpenChange,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setValue(defaultValue);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onOpenChange(false);
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
          <DialogTitle className="text-[14px]">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoFocus
            className="h-8 w-full rounded-lg border border-border/70 bg-background px-2.5 text-[12px] outline-none placeholder:text-muted-foreground focus:border-border"
          />
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            disabled={!value.trim()}
            onClick={handleSubmit}
          >
            确定
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
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  destructive = false,
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[360px] gap-0 rounded-xl border-border/70 p-0">
        <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
          <DialogTitle className="text-[14px]">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-4 py-3">
          <p className="text-[12.5px] leading-5 text-muted-foreground">{message}</p>
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className={cn("h-7 px-2.5 text-[12px]", destructive && "bg-destructive hover:bg-destructive/90")}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            确定
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
          <DialogTitle className="text-[14px]">从模板创建笔记</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-4 py-3">
          {templates.length === 0 ? (
            <p className="py-4 text-center text-[12.5px] text-muted-foreground">
              没有可用模板。请先创建一篇笔记并标记为模板。
            </p>
          ) : (
            <>
              <div className="max-h-[220px] space-y-px overflow-y-auto scrollbar-thin">
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setSelectedId(tpl.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors",
                      selectedId === tpl.id
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-accent",
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{tpl.title || "未命名模板"}</span>
                    {tpl.tags.length > 0 ? (
                      <span className="shrink-0 text-[10.5px] text-muted-foreground">
                        {tpl.tags.slice(0, 3).join(" · ")}
                      </span>
                    ) : null}
                  </button>
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
                className="h-8 text-[13px]"
              />
            </>
          )}
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
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
