import { useState } from "react";
import { RotateCcw } from "lucide-react";

import { TooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { ConfirmDialog } from "./NotesDialogs";

interface ResetNoteChatButtonProps {
  disabled?: boolean;
  onReset: () => void;
  className?: string;
}

export function ResetNoteChatButton({
  disabled = false,
  onReset,
  className,
}: ResetNoteChatButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <TooltipButton
        type="button"
        variant="ghost"
        size="icon"
        title="重置会话"
        aria-label="重置会话"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setConfirmOpen(true);
        }}
        className={cn(
          "h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
          className,
        )}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </TooltipButton>
      <ConfirmDialog
        open={confirmOpen}
        title="重置会话"
        message="确认后将开始一个新会话，当前笔记正文会保留。"
        confirmText="开始新会话"
        destructive
        onConfirm={() => {
          if (!disabled) onReset();
        }}
        onOpenChange={setConfirmOpen}
      />
    </>
  );
}
