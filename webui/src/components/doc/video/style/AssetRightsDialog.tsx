import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { VideoAssetRightsStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{
  value: VideoAssetRightsStatus;
  label: string;
  hint: string;
}> = [
  { value: "unknown", label: "暂不确认", hint: "可用于草稿，正式版前必须确认" },
  { value: "owned", label: "我拥有版权", hint: "本人原创或已完整取得权利" },
  {
    value: "licensed",
    label: "已获商业授权",
    hint: "图库、品牌方或供应商授权",
  },
  {
    value: "permission-granted",
    label: "已获作者许可",
    hint: "已取得明确使用许可",
  },
  {
    value: "public-domain",
    label: "公共领域 / CC0",
    hint: "无需署名的公共素材",
  },
  {
    value: "ai-generated",
    label: "AI 生成",
    hint: "仍需核对生成服务的商业条款",
  },
];

interface AssetRightsDialogProps {
  open: boolean;
  fileName: string;
  value: VideoAssetRightsStatus;
  loading?: boolean;
  title?: string;
  onChange: (value: VideoAssetRightsStatus) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AssetRightsDialog({
  open,
  fileName,
  value,
  loading = false,
  title = "确认素材使用权",
  onChange,
  onCancel,
  onConfirm,
}: AssetRightsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !loading && onCancel()}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {fileName || "所选素材"}将复制到项目。请选择最符合实际情况的一项。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5" role="radiogroup" aria-label="素材使用权">
          {OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant="outline"
              role="radio"
              aria-checked={value === option.value}
              onClick={() => onChange(option.value)}
              className={cn(
                "h-auto justify-start px-3 py-2 text-left",
                value === option.value && "border-primary bg-primary/5",
              )}
            >
              <span>
                <span className="block text-caption font-medium">
                  {option.label}
                </span>
                <span className="block text-micro text-muted-foreground">
                  {option.hint}
                </span>
              </span>
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button onClick={onConfirm} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            确认并导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
