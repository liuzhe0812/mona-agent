import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
