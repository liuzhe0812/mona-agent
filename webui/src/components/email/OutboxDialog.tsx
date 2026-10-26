import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { outboxDelete, outboxList } from "./lib/emailApi";
import type { OutboxEmail } from "./lib/types";

interface OutboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "待发送",
  sent: "已发送",
  failed: "发送失败",
  unknown: "结果待确认",
};

function formatScheduledAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function safeStatusHint(email: OutboxEmail): string | null {
  if (email.status === "unknown") {
    return "发送结果不确定。请先在已发送文件夹核对，避免重复发送。";
  }
  if (email.status === "failed") {
    return "发送失败，请检查收件人和邮箱账号设置。";
  }
  if (email.error) return "这项定时发送需要处理，请先核对发送结果。";
  return null;
}

export function OutboxDialog({ open, onOpenChange, accountId }: OutboxDialogProps) {
  const [emails, setEmails] = useState<OutboxEmail[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (showLoading = false) => {
    const requestId = ++requestIdRef.current;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const result = await outboxList(accountId);
      if (requestId === requestIdRef.current) {
        setEmails(result.filter((email) => email.accountId === accountId));
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setError("暂时无法加载定时邮件，请关闭后重新打开。");
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (!open) return;
    if (!accountId) {
      setEmails([]);
      setLoading(false);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    void refresh(true);
    void listen("email-outbox-updated", () => {
      if (active) void refresh();
    })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {
        if (active) setError("自动更新暂不可用，请关闭后重新打开此列表。");
      });
    return () => {
      active = false;
      requestIdRef.current += 1;
      unlisten?.();
    };
  }, [accountId, open, refresh]);

  const cancelPending = async (email: OutboxEmail) => {
    if (email.status !== "pending" || deletingId) return;
    setDeletingId(email.id);
    setError(null);
    try {
      await outboxDelete(email.id);
      setEmails((current) => current.filter((item) => item.id !== email.id));
    } catch {
      setError("未能取消，请重新打开列表并核对发送状态。");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>定时邮件</DialogTitle>
          <DialogDescription>
            查看当前账号安排的邮件。结果待确认的邮件请先检查已发送，避免重复发送。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive">
            {error.trim()}
          </p>
        )}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-caption text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载定时邮件...
          </div>
        ) : emails.length === 0 ? (
          <p className="py-8 text-center text-caption text-muted-foreground">当前账号没有定时邮件</p>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {emails.map((email) => {
              const statusLabel = STATUS_LABELS[email.status] ?? "状态未知";
              const hint = safeStatusHint(email);
              return (
                <div key={email.id} className="flex items-start gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui font-medium text-foreground">
                      {email.subject.trim() || "(无主题)"}
                    </div>
                    <p className="mt-1 text-caption text-muted-foreground">
                      计划发送：{formatScheduledAt(email.scheduledAt)}
                    </p>
                    <p className="mt-1 text-caption text-muted-foreground">状态：{statusLabel}</p>
                    {hint && <p className="mt-1 text-caption text-muted-foreground">{hint}</p>}
                  </div>
                  {email.status === "pending" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-caption text-muted-foreground hover:text-destructive"
                      disabled={deletingId !== null}
                      onClick={() => void cancelPending(email)}
                    >
                      {deletingId === email.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "取消发送"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
