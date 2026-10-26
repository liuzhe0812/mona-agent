import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Check, Coins, Gift, Loader2, RefreshCw } from "lucide-react";

import { PaymentDialog } from "@/components/PaymentDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLicense } from "@/hooks/useLicense";
import { isTauri } from "@/lib/tauri";
import { formatBalanceAmount, formatMoneyAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

interface CreditProduct {
  code: string;
  name: string;
  price: string;
  balance_amount: string;
}

interface CustomRechargeConfig {
  enabled: boolean;
  min_amount: string;
  max_amount: string;
}

interface RechargeProPromotion {
  enabled: boolean;
  active: boolean;
  min_amount: string;
  gift_days: number;
  start_at: string | null;
  end_at: string | null;
  description: string;
}

interface CreditBalance {
  available_amount: string;
  reserved_amount: string;
  updated_at: string;
}

interface CreditOrderHistoryItem {
  order_id: number;
  trade_order_id: string;
  amount: string;
  status: "pending" | "paid" | "failed";
  fulfillment_status: string;
  balance_amount: string;
  payment_url: string | null;
  created_at: string;
  bonus_pro_days?: number;
  bonus_pro_revoked?: boolean;
}

interface ActiveCreditOrder {
  orderId: number;
  paymentUrl: string;
}

type PendingRecharge =
  | { kind: "product"; productCode: string; amount: string; balanceAmount: string }
  | { kind: "custom"; amount: string; balanceAmount: string };

const orderStatusLabels: Record<CreditOrderHistoryItem["status"], string> = {
  pending: "等待支付",
  paid: "已支付",
  failed: "支付失败",
};

const rechargeButtonClassName = "border-info/25 bg-info/5 text-foreground hover:border-info/40 hover:bg-info/10 hover:text-foreground active:bg-info/15";

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp)
    : value;
}

function shortOrderId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function errorMessage(reason: unknown): string {
  return String(reason).replace(/^Error:\s*/, "");
}

const emptyCustomRecharge: CustomRechargeConfig = {
  enabled: false,
  min_amount: "",
  max_amount: "",
};

function decimalToMicros(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function validateCustomAmount(value: string, config: CustomRechargeConfig): string | null {
  const amount = value.trim();
  if (!amount) return "请输入充值金额";
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return "请输入最多两位小数的金额";

  const amountMicros = decimalToMicros(amount);
  const minMicros = decimalToMicros(config.min_amount);
  const maxMicros = decimalToMicros(config.max_amount);
  if (amountMicros === null || minMicros === null || maxMicros === null) {
    return "充值金额范围暂不可用";
  }
  if (amountMicros < minMicros || amountMicros > maxMicros) {
    return `充值金额需在 ¥${formatMoneyAmount(config.min_amount)} 至 ¥${formatMoneyAmount(config.max_amount)} 之间`;
  }
  return null;
}

export function CreditsView({
  onBack,
  section,
  onPaymentComplete,
}: {
  onBack?: () => void;
  section?: "recharge" | "orders";
  onPaymentComplete?: () => void;
}) {
  const { licenseInfo } = useLicense();
  const dataOwnerKey = `${licenseInfo?.account ?? ""}:${licenseInfo?.email ?? ""}`;
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [products, setProducts] = useState<CreditProduct[]>([]);
  const [rechargeEnabled, setRechargeEnabled] = useState(false);
  const [customRecharge, setCustomRecharge] = useState<CustomRechargeConfig>(emptyCustomRecharge);
  const [promotion, setPromotion] = useState<RechargeProPromotion | null>(null);
  const [customAmount, setCustomAmount] = useState("");
  const [selectedProductCode, setSelectedProductCode] = useState<string | null>(null);
  const [orders, setOrders] = useState<CreditOrderHistoryItem[]>([]);
  const [hasMoreOrders, setHasMoreOrders] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [balanceUnavailable, setBalanceUnavailable] = useState(false);
  const [productsUnavailable, setProductsUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ordering, setOrdering] = useState<string | null>(null);
  const [pendingRecharge, setPendingRecharge] = useState<PendingRecharge | null>(null);
  const [order, setOrder] = useState<ActiveCreditOrder | null>(null);
  const [error, setError] = useState("");
  const productsRef = useRef<HTMLDivElement>(null);
  const orderAttemptKeys = useRef(new Map<string, string>());
  const dataOwnerRef = useRef(dataOwnerKey);
  dataOwnerRef.current = dataOwnerKey;

  const load = useCallback(async (background = false) => {
    const requestedOwner = dataOwnerKey;
    if (!isTauri()) {
      const message = "请在 Mona 桌面客户端中使用余额服务";
      if (section === "orders") setOrdersError(message);
      else setError(message);
      setLoading(false);
      return;
    }
    background ? setRefreshing(true) : setLoading(true);
    setError("");
    const needsBalance = section !== "orders";
    const needsProducts = section !== "orders";
    const needsOrders = section !== "recharge";
    const [balanceResult, productResult, orderResult] = await Promise.allSettled([
      needsBalance ? invoke<CreditBalance>("get_credit_balance") : Promise.resolve(null),
      needsProducts ? invoke<{
        recharge_enabled: boolean;
        custom_recharge?: Partial<CustomRechargeConfig> | null;
        promotion?: RechargeProPromotion | null;
        products: CreditProduct[];
      }>("get_credit_products") : Promise.resolve(null),
      needsOrders ? invoke<{ orders: CreditOrderHistoryItem[]; has_more: boolean }>("get_credit_orders", {
        limit: 10,
      }) : Promise.resolve(null),
    ]);
    if (dataOwnerRef.current !== requestedOwner) return;

    if (needsBalance && balanceResult.status === "fulfilled" && balanceResult.value) {
      setBalance(balanceResult.value);
      setBalanceUnavailable(false);
    } else if (needsBalance) {
      setBalanceUnavailable(true);
    }
    if (needsProducts && productResult.status === "fulfilled" && productResult.value) {
      setProducts(productResult.value.products);
      setRechargeEnabled(productResult.value.recharge_enabled);
      setPromotion(productResult.value.promotion ?? null);
      setCustomRecharge({
        enabled: productResult.value.custom_recharge?.enabled === true,
        min_amount: String(productResult.value.custom_recharge?.min_amount ?? ""),
        max_amount: String(productResult.value.custom_recharge?.max_amount ?? ""),
      });
      setProductsUnavailable(false);
    } else if (needsProducts) {
      setRechargeEnabled(false);
      setPromotion(null);
      setCustomRecharge(emptyCustomRecharge);
      setProductsUnavailable(true);
    }
    if (needsOrders && orderResult.status === "fulfilled" && orderResult.value) {
      setOrders(orderResult.value.orders);
      setHasMoreOrders(orderResult.value.has_more);
      setOrdersError("");
    } else if (needsOrders && orderResult.status === "rejected") {
      setOrdersError(errorMessage(orderResult.reason));
    }
    if (needsBalance && balanceResult.status === "rejected") {
      setError(errorMessage(balanceResult.reason));
    } else if (needsProducts && productResult.status === "rejected") {
      setError(errorMessage(productResult.reason));
    }
    setLoading(false);
    setRefreshing(false);
  }, [dataOwnerKey, section]);

  useEffect(() => {
    setBalance(null);
    setProducts([]);
    setRechargeEnabled(false);
    setCustomRecharge(emptyCustomRecharge);
    setPromotion(null);
    setCustomAmount("");
    setSelectedProductCode(null);
    setOrders([]);
    setHasMoreOrders(false);
    setOrdersError("");
    setOrder(null);
    setOrdering(null);
    setPendingRecharge(null);
    orderAttemptKeys.current.clear();
    void load();
  }, [load]);

  const createOrder = async (productCode: string) => {
    if (ordering) return;
    const requestedOwner = dataOwnerKey;
    setOrdering(productCode);
    setError("");
    const attemptScope = `${requestedOwner}:${productCode}`;
    const idempotencyKey =
      orderAttemptKeys.current.get(attemptScope) ?? crypto.randomUUID().replaceAll("-", "");
    orderAttemptKeys.current.set(attemptScope, idempotencyKey);
    try {
      const result = await invoke<{ order_id: number; payment_url: string }>(
        "create_credit_order",
        { productCode, idempotencyKey },
      );
      if (dataOwnerRef.current !== requestedOwner) return;
      orderAttemptKeys.current.delete(attemptScope);
      setOrder({ orderId: result.order_id, paymentUrl: result.payment_url });
      void load(true);
    } catch (reason) {
      if (dataOwnerRef.current !== requestedOwner) return;
      const message = errorMessage(reason);
      if (/\((?:4\d\d|502|503)\)$/.test(message)) {
        orderAttemptKeys.current.delete(attemptScope);
      }
      setError(message);
    } finally {
      if (dataOwnerRef.current === requestedOwner) setOrdering(null);
    }
  };

  const createCustomOrder = async (amount: string) => {
    if (ordering) return;
    const validationError = validateCustomAmount(amount, customRecharge);
    if (validationError) {
      setError(validationError);
      return;
    }

    const requestedOwner = dataOwnerKey;
    const attemptScope = `${requestedOwner}:custom:${amount}`;
    setOrdering("custom");
    setError("");
    const idempotencyKey =
      orderAttemptKeys.current.get(attemptScope) ?? crypto.randomUUID().replaceAll("-", "");
    orderAttemptKeys.current.set(attemptScope, idempotencyKey);
    try {
      const result = await invoke<{ order_id: number; payment_url: string }>(
        "create_custom_credit_order",
        { amount, idempotencyKey },
      );
      if (dataOwnerRef.current !== requestedOwner) return;
      orderAttemptKeys.current.delete(attemptScope);
      setOrder({ orderId: result.order_id, paymentUrl: result.payment_url });
      void load(true);
    } catch (reason) {
      if (dataOwnerRef.current !== requestedOwner) return;
      const message = errorMessage(reason);
      if (/\((?:4\d\d|502|503)\)$/.test(message)) {
        orderAttemptKeys.current.delete(attemptScope);
      }
      setError(message);
    } finally {
      if (dataOwnerRef.current === requestedOwner) setOrdering(null);
    }
  };

  const requestCustomRecharge = () => {
    const amount = customAmount.trim();
    const validationError = validateCustomAmount(amount, customRecharge);
    if (validationError) {
      setError(validationError);
      return;
    }
    setPendingRecharge({ kind: "custom", amount, balanceAmount: amount });
  };

  const confirmRecharge = () => {
    const pending = pendingRecharge;
    if (!pending) return;
    setPendingRecharge(null);
    if (pending.kind === "product") {
      void createOrder(pending.productCode);
    } else {
      void createCustomOrder(pending.amount);
    }
  };

  const customAmountError = customAmount
    ? validateCustomAmount(customAmount, customRecharge)
    : null;
  const selectedProduct = products.find((product) => product.code === selectedProductCode);
  const rechargeSelection: PendingRecharge | null = selectedProduct
    ? { kind: "product", productCode: selectedProduct.code, amount: selectedProduct.price, balanceAmount: selectedProduct.balance_amount }
    : customRecharge.enabled && customAmount.trim() && !customAmountError
      ? { kind: "custom", amount: customAmount.trim(), balanceAmount: customAmount.trim() }
      : null;
  const pendingAmountMicros = pendingRecharge ? decimalToMicros(pendingRecharge.amount) : null;
  const promotionThresholdMicros = promotion ? decimalToMicros(promotion.min_amount) : null;
  const pendingPromotionDays =
    promotion?.active &&
    pendingAmountMicros !== null &&
    promotionThresholdMicros !== null &&
    pendingAmountMicros >= promotionThresholdMicros
      ? promotion.gift_days
      : 0;

  const resumeOrder = (item: CreditOrderHistoryItem) => {
    if (item.status !== "pending" || !item.payment_url) return;
    setOrder({ orderId: item.order_id, paymentUrl: item.payment_url });
  };

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center" aria-label={section === "orders" ? "正在读取充值订单" : "正在加载余额"}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className={cn("space-y-5", onBack && "max-h-[72vh] overflow-y-auto pr-1")}>
      {section !== "recharge" ? (
        <header className={cn("flex items-start gap-3", section === "orders" && "justify-end", onBack && "sticky top-0 z-10 bg-background pb-2")}>
          {section !== "orders" ? (
            <>
              {onBack ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onBack}
                  className="h-8 w-8"
                  aria-label="返回账户"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              ) : null}
              <div className="min-w-0 flex-1">
                <h1 className={onBack ? "text-sm font-medium" : "text-title-lg"}>余额与充值</h1>
                {!onBack ? (
                  <p className="mt-1 text-body text-muted-foreground">查看模型余额和充值订单。</p>
                ) : null}
              </div>
            </>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-full"
          >
            {refreshing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            刷新
          </Button>
        </header>
      ) : null}

      {section === undefined ? <section aria-labelledby="credit-balance-title">
        <h2 id="credit-balance-title" className="text-heading">
          可用余额
        </h2>
        <div className="mt-2 rounded-2xl border border-info/20 bg-info/5 p-5 shadow-sm sm:p-6" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Coins className="h-4 w-4 text-info" />
                模型余额
              </div>
              {balance ? (
                <div className="mt-2 text-4xl font-semibold tracking-tight tabular-nums text-[hsl(var(--data-1))]">
                  <span className="mr-1 text-xl font-medium">¥</span>{formatBalanceAmount(balance.available_amount)}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  {balanceUnavailable ? "余额暂不可用" : "尚无余额数据"}
                </p>
              )}
              {balance?.updated_at ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  更新于 {formatDate(balance.updated_at)}
                </p>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              className={cn("min-w-24 rounded-full", rechargeButtonClassName)}
              onClick={() => productsRef.current?.scrollIntoView({ behavior: "smooth" })}
            >
              充值余额
            </Button>
          </div>
          {balance && balance.reserved_amount !== "0" ? (
            <p className="mt-4 border-t border-border/60 pt-4 text-caption text-muted-foreground">
              预留或冻结金额 ¥{formatBalanceAmount(balance.reserved_amount)}，可能包含模型处理中、待核实或退款确认中的金额；模型实际扣费以核算结果为准
            </p>
          ) : null}
        </div>
      </section> : null}

      {section === "recharge" ? (
        <div className="flex items-center justify-between gap-3 text-caption text-muted-foreground" aria-live="polite">
          <span>当前可用余额</span>
          <span className="text-body font-medium tabular-nums text-foreground">
            {balance ? `¥${formatBalanceAmount(balance.available_amount)}` : balanceUnavailable ? "余额暂不可用" : "尚无余额数据"}
          </span>
        </div>
      ) : null}

      {section !== "orders" ? <section ref={productsRef}
        aria-label={section === "recharge" ? "充值金额" : undefined}
        aria-labelledby={section === "recharge" ? undefined : "credit-products-title"}>
        {section !== "recharge" ? <>
          <h2 id="credit-products-title" className="text-heading">
            充值余额
          </h2>
          <p className="mt-1 text-caption text-muted-foreground">选择固定面额，或输入金额，通过支付宝完成支付后自动到账。</p>
        </> : null}
        {promotion ? (
          <div className="mt-3 flex gap-3 rounded-2xl border border-warning/20 bg-warning/10 p-4">
            <Gift className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-sm font-medium">充值赠 Pro</p>
              <p className="mt-1 text-sm text-foreground/80">{promotion.description}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {promotion.active
                  ? "活动进行中；退款将收回该订单赠送的 Pro 时长。"
                  : promotion.start_at
                    ? `活动将于 ${formatDate(promotion.start_at)} 开始。`
                    : "活动尚未开始。"}
              </p>
            </div>
          </div>
        ) : null}
        {!productsUnavailable && !rechargeEnabled ? (
          <p className="mt-2 rounded-lg border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground">
            充值服务维护中，暂时无法创建订单。
          </p>
        ) : null}
        <div
          role="group"
          aria-label="预置充值额度"
          className={cn("mt-2 grid gap-2 sm:grid-cols-3", section === "recharge" && "grid-cols-2 gap-3")}
        >
          {products.length === 0 ? (
            <p className="col-span-full rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {productsUnavailable ? "充值商品暂不可用" : "暂无可购买的充值商品"}
            </p>
          ) : (
            products.map((product) => section === "recharge" ? (
              <Button
                key={product.code}
                variant="outline"
                title={product.name}
                aria-pressed={selectedProductCode === product.code}
                className={cn(
                  "relative h-auto min-h-20 min-w-0 flex-col gap-1 rounded-xl px-3 py-4",
                  selectedProductCode === product.code && "border-foreground bg-muted/50 ring-1 ring-foreground hover:bg-muted/50",
                )}
                disabled={ordering !== null || !rechargeEnabled}
                onClick={() => {
                  setSelectedProductCode(product.code);
                  setCustomAmount("");
                }}
              >
                {selectedProductCode === product.code && <Check className="absolute right-2 top-2 h-3.5 w-3.5" aria-hidden />}
                <span className="text-title-sm font-semibold tabular-nums">¥{product.price}</span>
                {decimalToMicros(product.balance_amount) !== decimalToMicros(product.price) && (
                  <span className="text-caption font-normal text-muted-foreground">到账 ¥{formatBalanceAmount(product.balance_amount)}</span>
                )}
              </Button>
            ) : (
              <div
                key={product.code}
                className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{product.name}</div>
                  <div className="text-xs text-muted-foreground">
                    余额增加 ¥{formatMoneyAmount(product.balance_amount)}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("ml-auto min-w-20 rounded-full", rechargeButtonClassName)}
                  disabled={ordering !== null || !rechargeEnabled}
                  onClick={() => setPendingRecharge({
                    kind: "product",
                    productCode: product.code,
                    amount: product.price,
                    balanceAmount: product.balance_amount,
                  })}
                >
                  {ordering === product.code ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    `¥${product.price}`
                  )}
                </Button>
              </div>
            ))
          )}
        </div>
        {customRecharge.enabled ? (
          <div className={section === "recharge" ? "mt-5" : "mt-2 rounded-2xl border border-border/70 bg-card p-4 shadow-sm"}>
            <div className={section === "recharge" ? "space-y-2" : "flex flex-wrap items-start justify-between gap-3"}>
              <div className="min-w-0 flex-1">
                <label htmlFor="credit-custom-amount" className="text-ui font-medium">自定义金额</label>
                <p id="credit-custom-range" className="mt-1 text-caption text-muted-foreground">
                  可充值 ¥{formatMoneyAmount(customRecharge.min_amount)} 至 ¥
                  {formatMoneyAmount(customRecharge.max_amount)}，最多两位小数
                </p>
              </div>
              <div className={cn("flex w-full min-w-0 flex-col gap-1", section !== "recharge" && "sm:w-auto sm:items-end")}>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">¥</span>
                  <Input
                    id="credit-custom-amount"
                    aria-label="自定义充值金额"
                    aria-describedby={customAmountError ? "credit-custom-range credit-custom-error" : "credit-custom-range"}
                    aria-invalid={!!customAmountError}
                    value={customAmount}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (/^\d*(?:\.\d{0,2})?$/.test(value)) {
                        setCustomAmount(value);
                        setSelectedProductCode(null);
                      }
                    }}
                    inputMode="decimal"
                    placeholder="输入金额"
                    disabled={ordering !== null || !rechargeEnabled}
                    className={section === "recharge" ? "h-10 flex-1 rounded-lg" : "max-w-48"}
                  />
                  {section !== "recharge" && <Button
                    variant="outline"
                    size="sm"
                    className={cn("min-w-20 shrink-0 rounded-full", rechargeButtonClassName)}
                    disabled={
                      ordering !== null ||
                      !rechargeEnabled ||
                      !customAmount.trim() ||
                      customAmountError !== null
                    }
                    onClick={requestCustomRecharge}
                  >
                    {ordering === "custom" ? <Loader2 className="h-4 w-4 animate-spin" /> : "充值"}
                  </Button>}
                </div>
                {customAmountError ? (
                  <p id="credit-custom-error" className="text-caption text-destructive">{customAmountError}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </section> : null}

      {section !== "recharge" && (orders.length > 0 || section === "orders" || !!ordersError) ? (
        <section aria-labelledby="credit-orders-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="credit-orders-title" className="text-heading">
              最近充值订单
            </h2>
            {orders.length > 0 ? (
              <span className="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                {orders.length} 笔
              </span>
            ) : null}
          </div>
          {ordersError ? (
            <p role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {ordersError}
            </p>
          ) : null}
          {orders.length === 0 ? (
            !ordersError ? <p className="mt-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground" role="status">暂无充值订单</p> : null
          ) : <div className="mt-2 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
            {orders.map((item) => (
              <div
                key={item.order_id}
                className="flex flex-wrap items-center gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    充值 ¥{item.amount}
                  </p>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={item.trade_order_id}
                  >
                    {shortOrderId(item.trade_order_id)} · {formatDate(item.created_at)}
                  </p>
                  {item.bonus_pro_days ? (
                    <p className="mt-1 text-xs text-primary">
                      {item.bonus_pro_revoked ? "已收回" : "已赠送"} {item.bonus_pro_days} 天 Pro
                    </p>
                  ) : null}
                </div>
                <span className={cn("rounded-full px-2.5 py-1 text-micro font-medium text-foreground",
                  item.status === "failed" ? "bg-destructive/10"
                    : item.status === "paid" && item.fulfillment_status === "succeeded" ? "bg-success/10" : "bg-warning/15",
                )}>
                  {item.status === "paid" && item.fulfillment_status === "succeeded"
                    ? "已到账"
                    : orderStatusLabels[item.status]}
                </span>
                {item.status === "pending" && item.payment_url ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn("h-8 rounded-full", rechargeButtonClassName)}
                    onClick={() => resumeOrder(item)}
                  >
                    继续支付
                  </Button>
                ) : null}
              </div>
            ))}
            {hasMoreOrders ? (
              <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                仅显示最近 10 笔订单
              </p>
            ) : null}
          </div>}
        </section>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
          {section === "recharge" ? <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void load(true)}>
            重试
          </Button> : null}
        </div>
      ) : null}

      {section === "recharge" && <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
        <div className="min-w-0" aria-live="polite">
          <p className="text-caption text-muted-foreground">到账金额</p>
          <p className="mt-0.5 text-title-sm font-semibold tabular-nums">
            {rechargeSelection ? `¥${formatBalanceAmount(rechargeSelection.balanceAmount)}` : "—"}
          </p>
        </div>
        <Button
          className="rounded-lg px-6"
          disabled={ordering !== null || !rechargeEnabled || !rechargeSelection}
          onClick={() => setPendingRecharge(rechargeSelection)}
        >
          {ordering ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {ordering ? "正在创建订单…" : "去支付"}
        </Button>
      </div>}

      <AlertDialog
        open={pendingRecharge !== null}
        onOpenChange={(open) => !open && setPendingRecharge(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认充值</AlertDialogTitle>
            <AlertDialogDescription>
              确认支付 ¥{formatMoneyAmount(pendingRecharge?.amount ?? "0")}，余额将增加 ¥
              {formatMoneyAmount(pendingRecharge?.balanceAmount ?? "0")}。
              {pendingPromotionDays ? `同时赠送 ${pendingPromotionDays} 天 Pro。` : ""}
              确认后才会生成支付宝订单。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className={cn("border", rechargeButtonClassName)} onClick={confirmRecharge}>确认充值</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {order ? (
        <PaymentDialog
          open
          onOpenChange={(open) => !open && setOrder(null)}
          orderId={order.orderId}
          paymentUrl={order.paymentUrl}
          paymentMethod="alipay_page"
          pollCommand="get_credit_order_status"
          title="余额充值"
          successMessage="充值已到账，正在刷新..."
          onSuccess={() => {
            setOrder(null);
            void load(true);
            onPaymentComplete?.();
          }}
          onCancel={() => {
            setOrder(null);
            void load(true);
          }}
        />
      ) : null}
    </div>
  );
}
