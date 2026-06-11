import { Button } from "@/components/ui/button";

interface AiStatus {
  description: string;
  steps?: string[];
  needsConfirmation: boolean;
}

interface AiOperationOverlayProps {
  status: AiStatus;
  onConfirm?: () => void;
  onPause?: () => void;
  onCancel?: () => void;
}

export function AiOperationOverlay({
  status,
  onConfirm,
  onPause,
  onCancel,
}: AiOperationOverlayProps) {
  return (
    <div className="flex items-center gap-3 border-t border-border/50 bg-background/95 px-3 py-2">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
        🤖
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium truncate">{status.description}</div>
        {status.steps && status.steps.length > 0 && (
          <div className="text-[10px] text-muted-foreground truncate">
            {status.steps.join(" → ")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {status.needsConfirmation ? (
          <Button
            variant="default"
            size="sm"
            className="h-6 text-[11px] px-3"
            onClick={onConfirm}
          >
            确认执行
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px] px-2"
            onClick={onPause}
          >
            暂停
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[11px] px-2 text-muted-foreground"
          onClick={onCancel}
        >
          取消
        </Button>
      </div>
    </div>
  );
}
