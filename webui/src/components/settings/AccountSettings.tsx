import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SubsectionLabel } from "@/components/ui/page-header";
import { useLicense } from "@/hooks/useLicense";
import { formatBalanceAmount } from "@/lib/money";
import { isTauri } from "@/lib/tauri";

interface CreditBalance {
  available_amount: string;
  reserved_amount: string;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "长期有效";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(timestamp)
    : value;
}

function AccountSettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

function AccountSettingsRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[62px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <div className="text-body font-medium text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 max-w-[28rem] text-caption text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {children ? <div className="shrink-0 sm:ml-6">{children}</div> : null}
    </div>
  );
}

export function AccountSettings({
  onOpenLogin,
  onManageSubscription,
  onOpenBilling,
  onChangePassword,
}: {
  onOpenLogin?: () => void;
  onManageSubscription?: () => void;
  onOpenBilling?: () => void;
  onChangePassword?: () => void;
}) {
  const {
    loggedIn,
    licenseInfo,
    licenseActive,
    serverTrial,
    remainingDays,
    logout,
  } = useLicense();
  const dataOwnerKey = `${licenseInfo?.account ?? ""}:${licenseInfo?.email ?? ""}`;
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [balanceUnavailable, setBalanceUnavailable] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    setBalance(null);
    setBalanceUnavailable(false);
    if (!loggedIn || !isTauri()) return;
    let cancelled = false;
    void invoke<CreditBalance>("get_credit_balance")
      .then((value) => {
        if (!cancelled) setBalance(value);
      })
      .catch(() => {
        if (!cancelled) setBalanceUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dataOwnerKey, loggedIn]);

  if (!loggedIn) {
    return (
      <section>
        <SubsectionLabel className="mb-2 px-1">账户与权益</SubsectionLabel>
        <AccountSettingsGroup>
          <AccountSettingsRow
            title="登录 Mona"
            description="登录后可查看软件权益、模型余额和用量。"
          >
            <Button className="rounded-full" onClick={onOpenLogin}>登录或注册</Button>
          </AccountSettingsRow>
        </AccountSettingsGroup>
      </section>
    );
  }

  const planName = serverTrial ? "Mona Pro 试用" : licenseActive ? "Mona Pro" : "免费版";
  const planDescription = serverTrial
    ? `试用剩余 ${remainingDays} 天`
    : licenseActive
      ? `有效期至 ${formatDate(licenseInfo?.expires_at)}`
      : "当前没有生效中的软件订阅";
  const balanceDescription = balance
    ? balance.reserved_amount !== "0"
      ? `可用 ¥${formatBalanceAmount(balance.available_amount)} · 生成中预留 ¥${formatBalanceAmount(balance.reserved_amount)}`
      : `可用 ¥${formatBalanceAmount(balance.available_amount)}`
    : balanceUnavailable
      ? "余额暂不可用"
      : "正在读取余额";

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">账户与权益</SubsectionLabel>
        <AccountSettingsGroup>
          <AccountSettingsRow
            title={licenseInfo?.account ?? "Mona 用户"}
            description={licenseInfo?.email ?? "已登录"}
          >
            <Button variant="outline" size="sm" className="rounded-full" onClick={onChangePassword}>修改密码</Button>
          </AccountSettingsRow>
          <AccountSettingsRow
            title="当前软件权益"
            description={`${planName} · ${planDescription}`}
          >
            <Button variant="outline" size="sm" className="rounded-full" onClick={onManageSubscription}>
              {licenseActive ? "管理订阅" : "查看套餐"}
            </Button>
          </AccountSettingsRow>
          <AccountSettingsRow title="模型余额" description={balanceDescription}>
            <div className="flex items-center gap-2">
              {onOpenBilling ? (
                <Button variant="outline" size="sm" className="rounded-full" onClick={onOpenBilling}>
                  充值
                </Button>
              ) : null}
            </div>
          </AccountSettingsRow>
        </AccountSettingsGroup>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">账户安全</SubsectionLabel>
        <AccountSettingsGroup>
          <AccountSettingsRow title="退出登录" description="退出后，本机保存的登录凭据将被清除。">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full text-destructive hover:text-destructive"
              disabled={loggingOut}
              onClick={() => {
                setLoggingOut(true);
                void logout().finally(() => setLoggingOut(false));
              }}
            >
              {loggingOut ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <LogOut className="mr-1.5 h-3.5 w-3.5" />}
              退出登录
            </Button>
          </AccountSettingsRow>
        </AccountSettingsGroup>
      </section>
    </div>
  );
}
