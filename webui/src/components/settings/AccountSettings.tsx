import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, LogOut } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreditsView } from "@/components/CreditsView";
import { AccountDevices } from "@/components/account/AccountDevices";
import { CloudSyncSettings } from "@/components/account/CloudSyncSettings";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { accountDeviceErrorMessage } from "@/lib/account-devices";
import { SubsectionLabel } from "@/components/ui/page-header";
import { useLicense } from "@/hooks/useLicense";
import { formatBalanceAmount } from "@/lib/money";
import { isTauri } from "@/lib/tauri";

interface CreditBalance {
  available_amount: string;
  reserved_amount: string;
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
  onChangePassword,
}: {
  onOpenLogin?: () => void;
  onManageSubscription?: () => void;
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
  const dataOwnerKey = `${licenseInfo?.account ?? ""}:${licenseInfo?.email ?? ""}:${licenseInfo?.device_session_id ?? ""}`;
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [balanceUnavailable, setBalanceUnavailable] = useState(false);
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [creditSection, setCreditSection] = useState<"recharge" | "orders" | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

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
  }, [balanceRevision, dataOwnerKey, loggedIn]);

  useEffect(() => {
    setCreditSection(null);
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

  const proStatus = serverTrial
    ? `试用剩余 ${remainingDays} 天`
    : licenseActive
      ? licenseInfo?.expires_at ? `剩余 ${remainingDays} 天` : "长期有效"
      : "未开通";
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
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={onChangePassword}>修改密码</Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full text-destructive hover:text-destructive"
                disabled={loggingOut}
                onClick={() => {
                  setLoggingOut(true);
                  void logout()
                    .catch((error) => setLogoutError(accountDeviceErrorMessage(error, "logout")))
                    .finally(() => setLoggingOut(false));
                }}
              >
                {loggingOut ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <LogOut className="mr-1.5 h-3.5 w-3.5" />}
                退出登录
              </Button>
            </div>
          </AccountSettingsRow>
          <AccountSettingsRow title={
            <div className="flex flex-wrap items-center gap-2">
              <span>Mona Pro</span>
              <Badge variant={serverTrial ? "default" : licenseActive ? "success" : "secondary"}>{proStatus}</Badge>
            </div>
          }>
            <Button variant="outline" size="sm" className="rounded-full" onClick={onManageSubscription}>
              订阅
            </Button>
          </AccountSettingsRow>
          <AccountSettingsRow title="模型余额" description={balanceDescription}>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setCreditSection("orders")}>
                订单记录
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => setCreditSection("recharge")}>
                充值
              </Button>
            </div>
          </AccountSettingsRow>
        </AccountSettingsGroup>
      </section>

      <AccountDevices key={dataOwnerKey} />
      <CloudSyncSettings key={`cloud:${dataOwnerKey}`} onUpgrade={onManageSubscription} />

      <Dialog key={`credits:${dataOwnerKey}`} open={creditSection !== null} onOpenChange={(open) => {
        if (!open) {
          setCreditSection(null);
          setBalanceRevision((value) => value + 1);
        }
      }}>
        <DialogContent className="relative flex max-h-[85vh] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{creditSection === "orders" ? "充值订单" : "余额充值"}</DialogTitle>
            <DialogDescription>
              {creditSection === "orders" ? "查看最近充值记录，或继续支付未完成的订单。" : "选择充值金额，通过支付宝完成支付后自动到账。"}
            </DialogDescription>
          </DialogHeader>
          <div className="scrollbar-thin min-h-0 overflow-y-auto">
            {creditSection && <CreditsView
              section={creditSection}
              onPaymentComplete={() => setBalanceRevision((value) => value + 1)}
            />}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!logoutError} onOpenChange={(open) => { if (!open) setLogoutError(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>退出登录未确认</DialogTitle><DialogDescription>{logoutError}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setLogoutError("")}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
