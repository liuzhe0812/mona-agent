import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getEmailStatistics } from "./lib/emailApi";
import { getFolderDisplayName } from "./lib/folderUtils";
import type { EmailAccount } from "./lib/types";

interface EmailStatisticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: EmailAccount | null;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function EmailStatisticsDialog({
  open,
  onOpenChange,
  account,
}: EmailStatisticsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    totalCount: number;
    totalSize: number;
    folders: { folder: string; count: number; size: number }[];
  } | null>(null);

  useEffect(() => {
    if (!open || !account) {
      setStats(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    getEmailStatistics(account.id)
      .then((data) => {
        setStats({
          totalCount: data.totalCount,
          totalSize: data.totalSize,
          folders: data.folders,
        });
      })
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, account?.id]);

  const rows = useMemo(() => {
    if (!stats) return [];
    return stats.folders.map((f) => ({
      name: getFolderDisplayName(f.folder),
      count: f.count,
      size: f.size,
    }));
  }, [stats]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base font-semibold">邮件统计</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-3">
          <div className="text-[13px] text-foreground">
            帐号：{account?.displayName ?? account?.fromAddress ?? "-"}
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            邮件总计
            <span className="mx-1 font-medium text-foreground">
              {stats?.totalCount ?? 0}
            </span>
            封，占用磁盘空间
            <span className="mx-1 font-medium text-foreground">
              {formatSize(stats?.totalSize ?? 0)}
            </span>
          </div>
        </div>

        <div className="border-y border-border">
          <div className="grid grid-cols-[1fr_80px_90px] gap-2 bg-muted/50 px-4 py-2 text-[12px] font-medium text-foreground">
            <span>文件夹</span>
            <span className="text-right">邮件数量</span>
            <span className="text-right">所占容量</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                统计中...
              </div>
            ) : error ? (
              <div className="px-4 py-6 text-center text-[12px] text-destructive">
                {error}
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                暂无邮件数据
              </div>
            ) : (
              rows.map((row) => (
                <div
                  key={row.name}
                  className="grid grid-cols-[1fr_80px_90px] gap-2 px-4 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span className="truncate text-foreground">{row.name}</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {row.count}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {formatSize(row.size)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-5 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
