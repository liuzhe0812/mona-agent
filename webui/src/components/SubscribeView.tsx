import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLicense } from "@/hooks/useLicense";
import { Check, Copy, Mail, MessageCircle, RotateCcw } from "lucide-react";

interface SubscribeViewProps {
  userEmail: string;
  onBackToLogin: () => void;
  embed?: boolean;
  loading?: boolean;
  onLoadingChange?: (loading: boolean) => void;
}

export function SubscribeView({ userEmail, onBackToLogin, embed, loading }: SubscribeViewProps) {
  const { pricingConfig, pricingError, refreshLicense, licenseActive, localTrial, serverTrial, fetchPricing } = useLicense();
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!pricingConfig) return;
    const defaultPlan = pricingConfig.plans.find((p) => p.badge) ?? pricingConfig.plans[0];
    if (defaultPlan) setSelectedPlanId(defaultPlan.id);
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

  const buildMailto = () => {
    const subject = encodeURIComponent(`Mona Pro 订阅申请 - ${userEmail || "未登录用户"}`);
    const body = encodeURIComponent(
      `你好，我要购买 Mona Pro 订阅。\n注册邮箱：${userEmail || "待填写"}\n购买方案：${selectedPlan?.name ?? ""}`
    );
    return `mailto:${contact.email}?subject=${subject}&body=${body}`;
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshLicense();
    setRefreshing(false);
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

  const content = (
    <div className="flex w-full flex-col gap-4">
      {pricingConfig.promotionalBanner && (
        <div className="rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-center text-sm font-medium text-white">
          {pricingConfig.promotionalBanner}
        </div>
      )}

      <div className="text-center">
        <p className="text-lg font-semibold">升级至 Mona Pro</p>
        <p className="text-sm text-muted-foreground">选择订阅方案并联系作者开通</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {pricingConfig.plans.map((plan) => (
          <button
            key={plan.id}
            onClick={() => setSelectedPlanId(plan.id)}
            className={`relative flex flex-col gap-1 rounded-xl border p-4 text-left transition-colors ${
              selectedPlanId === plan.id
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50"
            }`}
          >
            {plan.badge && (
              <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
                {plan.badge}
              </span>
            )}
            <span className="text-sm font-medium">{plan.name}</span>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold">¥{plan.price}</span>
              <span className="text-xs text-muted-foreground">/{plan.durationMonths}个月</span>
            </div>
            {plan.originalPrice ? (
              <span className="text-xs text-muted-foreground line-through">
                ¥{plan.originalPrice}
              </span>
            ) : null}
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={`h-3.5 w-3.5 rounded-full border ${
                  selectedPlanId === plan.id ? "border-primary bg-primary" : "border-muted-foreground"
                }`}
              />
              选择
            </div>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <p className="mb-1 font-medium">购买步骤</p>
        <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
          <li>联系开发者完成付款</li>
          <li>开通后刷新状态或重新登录</li>
        </ol>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">邮箱：{contact.email}</span>
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
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">微信号：{contact.wechat}</span>
          <button
            type="button"
            onClick={() => handleCopy(contact.wechat, "wechat")}
            className="ml-auto inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-muted"
            title="复制微信号"
          >
            {copied === "wechat" ? (
              <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <Button variant="outline" className="w-full" asChild>
          <a href={buildMailto()}>发送申请邮件</a>
        </Button>
      </div>

      {!userEmail && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          购买需要账号才能开通授权，请先登录或注册。
        </div>
      )}

      <Button onClick={handleRefresh} disabled={refreshing} className="w-full">
        {refreshing ? "刷新中..." : "刷新订阅状态"}
      </Button>

      {licenseActive && (localTrial || serverTrial) && (
        <p className="text-center text-sm text-amber-600">
          当前为试用状态，购买正式订阅可解锁全部功能。
        </p>
      )}

      {licenseActive && !localTrial && !serverTrial && (
        <p className="text-center text-sm text-green-600">订阅已生效，请返回主界面。</p>
      )}

      <button
        type="button"
        onClick={onBackToLogin}
        className="text-center text-xs text-muted-foreground hover:underline"
      >
        ← 返回{userEmail ? "账号" : "登录"}
      </button>
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
