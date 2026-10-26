import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionHeader, SubsectionLabel } from "@/components/ui/page-header";
import { useLicense } from "@/hooks/useLicense";
import { PaymentDialog } from "@/components/PaymentDialog";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { isTauri } from "@/lib/tauri";
import { formatMoneyAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

const PRO_BENEFITS = [
  "最多 3 台设备登录",
  "10GB 个人云空间",
  "Work 会话与关联文件同步",
  "云端历史版本恢复",
];

interface SubscribeViewProps {
  userEmail: string;
  onBackToLogin: () => void;
  embed?: boolean;
  loading?: boolean;
  onLoadingChange?: (loading: boolean) => void;
  onManageSubscription?: () => void;
}

interface SubscribeOrder {
  orderId: number;
  tradeOrderId: string;
  paymentUrl: string;
  paymentMethod: "alipay_page";
}

export function SubscribeView({
  userEmail,
  onBackToLogin,
  embed,
  loading,
  onManageSubscription,
}: SubscribeViewProps) {
  const { pricingConfig, pricingError, refreshLicense, licenseActive, serverTrial, remainingDays, licenseInfo, fetchPricing } = useLicense();
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<SubscribeOrder | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [autoRenew, setAutoRenew] = useState(false);
  const [autoRenewError, setAutoRenewError] = useState(false);
  const [subscriptionRevision, setSubscriptionRevision] = useState(0);
  const defaultPlanApplied = useRef(false);
  const subscriptionOwner = `${licenseInfo?.account ?? userEmail}:${licenseInfo?.email ?? ""}:${licenseInfo?.device_session_id ?? ""}`;
  const canManageSubscription = !!onManageSubscription;

  useEffect(() => {
    setAutoRenew(false);
    setAutoRenewError(false);
    if (!licenseActive || serverTrial || !canManageSubscription || !isTauri()) return;
    let cancelled = false;
    void import("@tauri-apps/api/core").then(async ({ invoke }) => {
      const info = await invoke<{ auto_renew: boolean }>("get_subscription_info");
      if (typeof info?.auto_renew !== "boolean") throw new Error("自动续费状态返回异常");
      if (!cancelled) setAutoRenew(info.auto_renew);
    }).catch(() => {
      if (!cancelled) setAutoRenewError(true);
    });
    return () => { cancelled = true; };
  }, [licenseActive, serverTrial, canManageSubscription, subscriptionOwner, subscriptionRevision]);

  useEffect(() => {
    if (!pricingConfig || defaultPlanApplied.current) return;
    const defaultPlan = pricingConfig.plans.find((p) => p.badge) ?? pricingConfig.plans[0];
    if (defaultPlan) setSelectedPlanId(defaultPlan.id);
    defaultPlanApplied.current = true;
  }, [pricingConfig]);

  const selectedPlan = useMemo(
    () => pricingConfig?.plans.find((p) => p.id === selectedPlanId),
    [pricingConfig, selectedPlanId]
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshLicense();
      setSubscriptionRevision((value) => value + 1);
    } finally {
      setRefreshing(false);
    }
  };

  // 发起订阅
  const handleSubscribe = async (paymentMethod: "alipay_page") => {
    if (!selectedPlan || (licenseActive && !serverTrial)) return;
    if (!userEmail) {
      setErrorMsg("请先登录后再订阅");
      return;
    }
    if (!isTauri()) {
      setErrorMsg("请在 Mona 桌面客户端中订阅");
      return;
    }
    setErrorMsg("");
    setSubscribing(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        order_id: number;
        trade_order_id: string;
        payment_url: string;
        payment_method: string;
      }>("create_subscription", {
        planCode: selectedPlan.id,
        paymentMethod,
      });
      setCurrentOrder({
        orderId: result.order_id,
        tradeOrderId: result.trade_order_id,
        paymentUrl: result.payment_url,
        paymentMethod,
      });
      setDialogOpen(true);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("already_subscribed")) {
        setErrorMsg("您已有有效订阅，无需重复购买");
      } else if (msg.includes("alipay_disabled")) {
        setErrorMsg("支付宝支付暂未开启，请稍后重试。");
      } else {
        setErrorMsg(msg);
      }
    } finally {
      setSubscribing(false);
    }
  };

  const handlePaymentSuccess = async () => {
    setDialogOpen(false);
    setCurrentOrder(null);
    await refreshLicense();
  };

  const handlePaymentCancel = () => {
    setDialogOpen(false);
    setCurrentOrder(null);
    void refreshLicense();
  };

  if (loading) {
    return (
      <div className="flex h-40 w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">加载中...</p>
      </div>
    );
  }

  if (!pricingConfig) {
    return (
      <div className="flex h-40 w-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">
          {pricingError ? `加载失败：${pricingError}` : "价格配置加载失败"}
        </p>
        <Button variant="outline" size="sm" onClick={() => fetchPricing()}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  const isPaidUser = licenseActive && !serverTrial;
  const subscriptionStatus = serverTrial
    ? `试用剩余 ${remainingDays} 天`
    : isPaidUser
      ? licenseInfo?.expires_at ? `剩余 ${remainingDays} 天` : "长期有效"
      : "未开通";

  const content = (
    <div className="flex w-full flex-col gap-5">
      {!embed && <SectionHeader title="Mona Pro" description="多设备登录与个人云空间" />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-caption text-muted-foreground">当前状态</span>
          <Badge variant={serverTrial ? "default" : isPaidUser ? "success" : "secondary"}>{subscriptionStatus}</Badge>
        </div>
        <div className="flex items-center gap-1">
          {autoRenew && onManageSubscription && <Button variant="ghost" size="xs" onClick={onManageSubscription}>
            自动续费设置
          </Button>}
          <Button variant="ghost" size="xs" onClick={handleRefresh} disabled={refreshing}>
            <RotateCcw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden />
            {refreshing ? "刷新中…" : "刷新状态"}
          </Button>
        </div>
      </div>

      {pricingConfig.promotionalBanner && (
        <div className="rounded-lg bg-muted/50 px-3 py-2 text-caption text-foreground">
          {pricingConfig.promotionalBanner}
        </div>
      )}

      <section className="space-y-3 border-y border-border/60 py-4" aria-label="Pro 权益">
        <ul className="grid gap-3 sm:grid-cols-2">
          {PRO_BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2 text-ui">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
        <p className="text-caption leading-relaxed text-muted-foreground">
          本地 AI 功能免费；Pro 不含模型额度，自带 API Key 或 CLI 不扣 Mona 余额。云同步以账户设置中的服务可用状态为准。
        </p>
      </section>

      <section aria-label="订阅套餐">
        <SubsectionLabel className="mb-2">{isPaidUser ? "订阅套餐" : "选择订阅周期"}</SubsectionLabel>
        <div className="grid gap-3 sm:grid-cols-3">
          {pricingConfig.plans.map((plan) => {
            const period = plan.durationMonths
              ? `${plan.durationMonths}个月`
              : plan.periodDays ? `${plan.periodDays}天` : "长期有效";
            const selected = selectedPlanId === plan.id;
            return (
              <Button
                key={plan.id}
                variant="outline"
                aria-pressed={selected}
                disabled={subscribing}
                onClick={() => setSelectedPlanId(plan.id)}
                className={cn(
                  "h-auto min-w-0 flex-col items-start gap-2 whitespace-normal rounded-xl p-3 text-left",
                  selected && "border-foreground bg-muted/50 ring-1 ring-foreground hover:bg-muted/50",
                )}
              >
                <div className="flex w-full flex-wrap items-center gap-1.5">
                  <span className="mr-auto text-ui font-medium">{plan.name}</span>
                  {plan.badge && <Badge variant="secondary" className="px-1.5 py-0 text-micro">{plan.badge}</Badge>}
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                </div>
                <span className="flex flex-wrap items-baseline gap-1">
                  <span className="text-title-sm font-semibold tabular-nums">¥{formatMoneyAmount(String(plan.price))}</span>
                  <span className="text-caption font-normal text-muted-foreground">/ {period}</span>
                </span>
                {plan.originalPrice ? (
                  <span className="flex flex-wrap items-center gap-x-1.5 text-caption font-normal text-muted-foreground">
                    <span className="line-through">¥{formatMoneyAmount(String(plan.originalPrice))}</span>
                    <span>早期用户价</span>
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
        {pricingConfig.plans.length === 0 && <p className="py-3 text-caption text-muted-foreground">暂无可购买的订阅套餐</p>}
      </section>

      {licenseActive && serverTrial && <p className="text-caption text-muted-foreground">
        历史软件试用不包含多设备登录和云空间权益。
      </p>}

      {errorMsg && <p role="alert" className="text-caption text-destructive">{errorMsg}</p>}
      {autoRenewError && <p role="alert" className="text-caption text-muted-foreground">
        自动续费状态暂时无法读取，请点击“刷新状态”重试。
      </p>}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <div>
          <p className="text-caption text-muted-foreground">{isPaidUser ? "套餐价格" : "应付金额"}</p>
          <p className="mt-0.5 text-title-sm font-semibold tabular-nums">
            {selectedPlan ? `¥${formatMoneyAmount(String(selectedPlan.price))}` : "—"}
          </p>
        </div>
        <Button
          onClick={() => handleSubscribe("alipay_page")}
          disabled={isPaidUser || subscribing || !userEmail || !selectedPlan}
          className="rounded-lg px-5"
        >
          {subscribing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {isPaidUser ? "已开通" : subscribing ? "正在创建订单…" : "立即订阅"}
        </Button>
      </div>
      {!userEmail && <p className="text-caption text-muted-foreground">购买需要先登录账号</p>}

      {!embed && <Button type="button" variant="text" size="sm" className="self-center" onClick={onBackToLogin}>
        返回{userEmail ? "账户" : "登录"}
      </Button>}

      {/* 支付弹窗 */}
      {currentOrder && (
        <PaymentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          orderId={currentOrder.orderId}
          paymentUrl={currentOrder.paymentUrl}
          paymentMethod={currentOrder.paymentMethod}
          onSuccess={handlePaymentSuccess}
          onCancel={handlePaymentCancel}
        />
      )}
    </div>
  );

  if (embed) {
    return content;
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">{content}</div>
    </div>
  );
}
