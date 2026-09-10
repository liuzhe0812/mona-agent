import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLicense } from "@/hooks/useLicense";
import { PaymentDialog } from "@/components/PaymentDialog";
import { Check, Copy, Loader2, Mail, RotateCcw, Zap } from "lucide-react";
import { isTauri } from "@/lib/tauri";

const PRO_BENEFITS = [
  "让 Mona 理解你的工作上下文",
  "解锁笔记 AI、邮件 AI 与知识库 AI",
  "解锁数据库 AI 与终端 AI",
  "使用股票工作台 AI 诊股",
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
  const { pricingConfig, pricingError, refreshLicense, licenseActive, serverTrial, fetchPricing } = useLicense();
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<SubscribeOrder | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const defaultPlanApplied = useRef(false);

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

  const contact = pricingConfig?.contact ?? { email: "", wechat: "" };

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshLicense();
    setRefreshing(false);
  };

  // 发起订阅
  const handleSubscribe = async (paymentMethod: "alipay_page") => {
    if (!selectedPlan) return;
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
        setErrorMsg("支付宝支付暂未开启，请使用联系作者方式开通");
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

  // 已订阅用户视图
  const isPaidUser = licenseActive && !serverTrial;

  const content = (
    <div className="flex w-full flex-col gap-4">
      {pricingConfig.promotionalBanner && (
        <div className="relative rounded-lg border border-border bg-card px-4 py-2 text-center text-sm font-medium text-foreground">
          <span
            aria-hidden="true"
            className="absolute bottom-2 left-0 top-2 w-0.5 bg-[hsl(var(--brand-red))]"
          />
          {pricingConfig.promotionalBanner}
        </div>
      )}

      <div className="text-center">
        <p className="text-title-sm font-semibold">升级至 Mona Pro</p>
        <p className="text-sm text-muted-foreground">
          {isPaidUser ? "当前订阅已生效" : "选择订阅方案，扫码即可开通"}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-primary/15 bg-primary/5 p-3 text-sm">
        {PRO_BENEFITS.map((benefit) => (
          <div key={benefit} className="flex items-center gap-2">
            <Check className="h-4 w-4 shrink-0 text-primary" />
            <span>{benefit}</span>
          </div>
        ))}
        <p className="pt-1 text-xs text-muted-foreground">
          Pro 为软件功能权益；Mona AI 模型调用余额需单独充值，我的 API Key 不扣余额。
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {pricingConfig.plans.map((plan) => {
          const period = plan.durationMonths ?? 0;
          const unitLabel = period === 0 ? "永久" : `${period}个月`;
          return (
            <button
              key={plan.id}
              onClick={() => setSelectedPlanId(plan.id)}
              className={`relative flex flex-col gap-1 rounded-xl border p-4 text-left transition-colors ${
                selectedPlanId === plan.id
                  ? "border-[hsl(var(--brand-red))] bg-foreground/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              {plan.badge && (
                <span className="absolute right-2 top-2 rounded-full bg-info-soft px-2 py-0.5 text-micro text-info">
                  {plan.badge}
                </span>
              )}
              <span className="text-sm font-medium">{plan.name}</span>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold">¥{plan.price}</span>
                <span className="text-xs text-muted-foreground">/{unitLabel}</span>
              </div>
              {plan.originalPrice ? (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground line-through">¥{plan.originalPrice}</span>
                  <span className="font-medium text-primary">早期用户价</span>
                </div>
              ) : null}
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={`h-3.5 w-3.5 rounded-full border ${
                    selectedPlanId === plan.id
                      ? "border-foreground bg-foreground"
                      : "border-muted-foreground"
                  }`}
                />
                选择
              </div>
            </button>
          );
        })}
      </div>

      {/* 订阅按钮区 */}
      {selectedPlan && (
        <div className="flex flex-col gap-2">
          <Button
            onClick={() => handleSubscribe("alipay_page")}
            disabled={subscribing || !userEmail}
            className="w-full"
          >
            {subscribing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Zap className="mr-2 h-4 w-4" />
            )}
            立即购买
          </Button>

          {!userEmail && (
            <p className="text-center text-xs text-muted-foreground">购买需要先登录账号</p>
          )}
          {errorMsg && (
            <p className="text-center text-xs text-destructive">{errorMsg}</p>
          )}
        </div>
      )}

      {/* 联系方式 */}
      <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <p className="font-medium text-foreground">联系开发者</p>
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">{contact.email}</span>
          <button
            type="button"
            onClick={() => handleCopy(contact.email, "email")}
            className="ml-auto inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-muted"
            title="复制邮箱"
          >
            {copied === "email" ? (
              <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 状态按钮 */}
      <div className="flex flex-col gap-2">
        {isPaidUser && onManageSubscription && (
          <Button variant="outline" onClick={onManageSubscription} className="w-full">
            管理订阅
          </Button>
        )}
        <Button onClick={handleRefresh} disabled={refreshing} variant={isPaidUser ? "ghost" : "outline"} className="w-full">
          {refreshing ? "刷新中..." : "刷新订阅状态"}
        </Button>
      </div>

      {licenseActive && serverTrial && (
        <p className="text-center text-sm text-amber-600">
          当前为 Mona Pro 全功能试用，购买后可延续全部权益。
        </p>
      )}

      {licenseActive && !serverTrial && (
        <p className="text-center text-sm text-green-600">订阅已生效，请返回主界面。</p>
      )}

      <button
        type="button"
        onClick={onBackToLogin}
        className="text-center text-xs text-muted-foreground hover:underline"
      >
        ← 返回{userEmail ? "账号" : "登录"}
      </button>

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
