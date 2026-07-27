import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, RefreshCw, ShieldOff, History, Crown } from "lucide-react";
import { isTauri } from "@/lib/tauri";

interface ManageSubscriptionProps {
  onBack: () => void;
}

interface SubscriptionInfo {
  status: string;
  current_period_end: string | null;
  plan_code: string | null;
  auto_renew: boolean;
  agreement_status: string | null;
  cancelled_at: string | null;
}

interface RenewalItem {
  id: number;
  out_trade_no: string;
  amount: number;
  period_days: number;
  status: string;
  paid_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

const PLAN_NAMES: Record<string, string> = {
  monthly: "月度会员",
  yearly: "年度会员",
  lifetime: "终身版",
};

const STATUS_LABELS: Record<string, string> = {
  active: "已生效",
  expired: "已过期",
  pending: "扣款中",
  success: "成功",
  failed: "失败",
  retrying: "重试中",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  success: "bg-green-100 text-green-700",
  expired: "bg-gray-100 text-gray-700",
  failed: "bg-red-100 text-red-700",
  pending: "bg-amber-100 text-amber-700",
  retrying: "bg-orange-100 text-orange-700",
};

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso;
  }
}

export function ManageSubscription({ onBack }: ManageSubscriptionProps) {
  const [sub, setSub] = useState<SubscriptionInfo | null>(null);
  const [renewals, setRenewals] = useState<RenewalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelMsg, setCancelMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const fetchData = useCallback(async () => {
    if (!isTauri()) {
      setErrorMsg("请在 Mona 桌面客户端中操作");
      setLoading(false);
      return;
    }
    setErrorMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [subRes, renewalsRes] = await Promise.all([
        invoke<SubscriptionInfo>("get_subscription_info"),
        invoke<{ renewals: RenewalItem[] }>("list_renewals"),
      ]);
      setSub(subRes);
      setRenewals(renewalsRes.renewals ?? []);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const handleCancelConfirm = async () => {
    setCancelling(true);
    setErrorMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ message: string }>("cancel_auto_renew", {
        reason: cancelReason || null,
      });
      setCancelMsg(result.message || "已关闭自动续费");
      setConfirmOpen(false);
      setCancelReason("");
      await fetchData();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-sm font-medium">订阅管理</h1>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshing}
          className="ml-auto h-8 w-8"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* 当前订阅状态 */}
          <div className="rounded-xl border border-border p-4">
            <div className="mb-3 flex items-center gap-2">
              <Crown className="h-4 w-4 text-amber-500" />
              <h2 className="text-sm font-medium">当前订阅</h2>
            </div>

            {!sub || sub.status === "expired" ? (
              <div className="py-4 text-center">
                <p className="text-sm text-muted-foreground">暂无有效订阅</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onBack}>
                  去订阅
                </Button>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">套餐</span>
                  <span className="font-medium">
                    {sub.plan_code ? PLAN_NAMES[sub.plan_code] ?? sub.plan_code : "-"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">状态</span>
                  <Badge variant="secondary" className={STATUS_COLORS[sub.status] ?? ""}>
                    {STATUS_LABELS[sub.status] ?? sub.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">到期时间</span>
                  <span>{formatDate(sub.current_period_end)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">自动续费</span>
                  {sub.auto_renew ? (
                    <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                      已开启
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-gray-100 text-gray-700">
                      {sub.cancelled_at ? "已关闭" : "未开启"}
                    </Badge>
                  )}
                </div>
                {sub.agreement_status && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">协议状态</span>
                    <span className="text-xs">
                      {sub.agreement_status === "active" ? "有效" : sub.agreement_status === "cancelled" ? "已解约" : "已过期"}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 操作按钮 */}
          {sub && sub.auto_renew && (
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              className="w-full"
            >
              <ShieldOff className="mr-2 h-4 w-4" />
              关闭自动续费
            </Button>
          )}

          {cancelMsg && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
              {cancelMsg}
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {errorMsg}
            </div>
          )}

          {/* 续费记录 */}
          <div className="rounded-xl border border-border p-4">
            <div className="mb-3 flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">续费扣款记录</h2>
            </div>

            {renewals.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                暂无续费记录
              </p>
            ) : (
              <div className="space-y-2">
                {renewals.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3 text-sm"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">¥{r.amount.toFixed(2)}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(r.paid_at || r.created_at)} · +{r.period_days}天
                      </span>
                      {r.failure_reason && (
                        <span className="text-xs text-destructive">{r.failure_reason}</span>
                      )}
                    </div>
                    <Badge variant="secondary" className={STATUS_COLORS[r.status] ?? ""}>
                      {STATUS_LABELS[r.status] ?? r.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 取消自动续费确认弹窗 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>关闭自动续费</DialogTitle>
            <DialogDescription>
              关闭后，当前订阅期内功能仍可正常使用，到期后不会自动扣款。
              如需恢复自动续费，需要重新发起订阅并签约。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              placeholder="取消原因（可选）"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="rounded-lg"
            />
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              variant="destructive"
              onClick={handleCancelConfirm}
              disabled={cancelling}
              className="w-full"
            >
              {cancelling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldOff className="mr-2 h-4 w-4" />
              )}
              确认关闭自动续费
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={cancelling}
              className="w-full"
            >
              再想想
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
