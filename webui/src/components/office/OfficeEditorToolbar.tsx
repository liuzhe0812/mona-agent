import { Download, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { OfficeSessionState } from "./types";

export type OfficeEditorActivity =
  | "preparing"
  | "idle"
  | "generating"
  | "stopped"
  | "writing"
  | "formula"
  | "formatting"
  | "editing"
  | "saving";

interface OfficeEditorToolbarProps {
  session: OfficeSessionState;
  activity: OfficeEditorActivity;
  exportedFileName?: string | null;
  onSave: () => void;
  onExport: () => void;
  onClose: () => void;
  compact?: boolean;
}

function statusLabel(
  session: OfficeSessionState,
  activity: OfficeEditorActivity,
  exportedFileName?: string | null,
): string {
  if (session.lastError?.code === "SAVE_CONFLICT") return "源文件已变化";
  if (session.lastError?.code === "CHECKPOINT_FAILED") return "已恢复";
  if (session.lastError) return "需要注意";
  if (activity === "preparing") return "正在准备文档";
  if (activity === "generating") return "正在生成内容";
  if (activity === "stopped") return "已停止";
  if (activity === "writing") return "正在写入内容";
  if (activity === "formula") return "正在添加公式";
  if (activity === "formatting") return "正在调整格式";
  if (activity === "editing") return "正在修改文档";
  if (activity === "saving") return "正在保存";
  if (session.saveState === "error") return "保存失败";
  if (exportedFileName) return `已导出：${exportedFileName}`;
  if (session.dirty) return "未保存";
  return "已保存";
}

export function OfficeEditorToolbar({
  session,
  activity,
  exportedFileName,
  onSave,
  onExport,
  onClose,
  compact = false,
}: OfficeEditorToolbarProps) {
  const busy = !["idle", "stopped"].includes(activity);
  const actions = [
    { label: "保存", icon: Save, onClick: onSave, disabled: busy || !session.dirty },
    { label: "导出", icon: Download, onClick: onExport, disabled: busy },
    { label: "关闭编辑器", icon: X, onClick: onClose, disabled: busy },
  ].filter((action) => !compact || action.label !== "关闭编辑器");
  const status = statusLabel(session, activity, exportedFileName);
  return (
    <div className={cn("flex shrink-0 items-center gap-2", compact ? "h-7" : "h-10 border-b border-border bg-muted/30 px-3")}>
      {!compact ? <div className="min-w-0 flex-1">
        <div className="truncate text-ui font-medium text-foreground" title={session.displayName}>
          {session.displayName}
        </div>
      </div> : null}
      <span className={cn("shrink-0 truncate text-caption text-muted-foreground", compact && "max-w-40")} aria-live="polite" title={status}>
        {status}
      </span>
      <TooltipProvider delayDuration={150}>
        <div className="flex items-center gap-0.5">
          {actions.map(({ label, icon: Icon, onClick, disabled }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={label}
                  disabled={disabled}
                  onClick={onClick}
                  className="h-7 w-7"
                >
                  <Icon className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
}
