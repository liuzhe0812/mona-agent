import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  Download,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusNotice } from "@/components/ui/status-notice";
import { SubsectionLabel } from "@/components/ui/page-header";
import {
  cancelComputerUse,
  fetchAutomationStatus,
  grantComputerUsePermissions,
  updateBrowserAutomation,
  updateComputerUse,
} from "@/lib/api";
import type { AutomationStatus, ComputerUseState } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AutomationSettings({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) =>
    t(key, { defaultValue: fallback });
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [computerSaving, setComputerSaving] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [cancelSaving, setCancelSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchAutomationStatus(token));
    } catch (reason) {
      if (mounted.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : tx("settings.automation.loadError", "自动化能力状态暂时不可用"),
        );
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!token || status?.computerUse.state !== "downloading") return;
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const latest = await fetchAutomationStatus(token);
        if (!active) return;
        setStatus(latest);
        if (latest.computerUse.state === "downloading") {
          timer = window.setTimeout(() => void poll(), 700);
        }
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : tx("settings.automation.loadError", "自动化能力状态暂时不可用"),
          );
      }
    };

    timer = window.setTimeout(() => void poll(), 700);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [status?.computerUse.state, t, token]);

  const saveBrowser = useCallback(
    async (enabled: boolean) => {
      if (!token || browserSaving || !status) return;
      setBrowserSaving(true);
      setError(null);
      try {
        const result = await updateBrowserAutomation(token, enabled);
        if (mounted.current) {
          setStatus((current) =>
            current
              ? {
                  ...current,
                  browserAutomationEnabled: result.browserAutomationEnabled,
                }
              : current,
          );
        }
      } catch (reason) {
        if (mounted.current)
          setError(
            reason instanceof Error
              ? reason.message
              : tx("settings.automation.updateError", "无法更新自动化设置"),
          );
      } finally {
        if (mounted.current) setBrowserSaving(false);
      }
    },
    [browserSaving, status, t, token],
  );

  const saveComputer = useCallback(
    async (enabled: boolean) => {
      if (!token || computerSaving || !status?.computerUse.supported) return;
      setComputerSaving(true);
      setError(null);
      try {
        const next = await updateComputerUse(token, enabled);
        if (mounted.current) {
          setStatus((current) =>
            current ? { ...current, computerUse: next } : current,
          );
        }
      } catch (reason) {
        if (mounted.current)
          setError(
            reason instanceof Error
              ? reason.message
              : tx("settings.automation.updateError", "无法更新自动化设置"),
          );
      } finally {
        if (mounted.current) setComputerSaving(false);
      }
    },
    [computerSaving, status, t, token],
  );

  const cancelDownload = useCallback(async () => {
    if (!token || cancelSaving) return;
    setCancelSaving(true);
    setError(null);
    try {
      const next = await cancelComputerUse(token);
      if (mounted.current)
        setStatus((current) =>
          current ? { ...current, computerUse: next } : current,
        );
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : tx(
                "settings.automation.cancelError",
                "无法取消电脑操作自动化驱动下载",
              ),
        );
    } finally {
      if (mounted.current) setCancelSaving(false);
    }
  }, [cancelSaving, t, token]);

  const grantPermissions = useCallback(async () => {
    if (!token || permissionSaving) return;
    setPermissionSaving(true);
    setError(null);
    try {
      const next = await grantComputerUsePermissions(token);
      if (mounted.current)
        setStatus((current) =>
          current ? { ...current, computerUse: next } : current,
        );
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : tx("settings.automation.permissionError", "无法完成系统授权"),
        );
    } finally {
      if (mounted.current) setPermissionSaving(false);
    }
  }, [permissionSaving, t, token]);

  if (loading && !status) {
    return (
      <section>
        <SubsectionLabel className="mb-2 px-1">
          {tx("settings.automation.title", "自动化能力")}
        </SubsectionLabel>
        <div className="flex h-32 items-center justify-center text-body text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {tx("settings.automation.loading", "正在读取自动化能力状态…")}
        </div>
      </section>
    );
  }

  if (!status) {
    return (
      <section>
        <SubsectionLabel className="mb-2 px-1">
          {tx("settings.automation.title", "自动化能力")}
        </SubsectionLabel>
        <StatusNotice tone="danger">
          {error ??
            tx("settings.automation.loadError", "自动化能力状态暂时不可用")}
        </StatusNotice>
      </section>
    );
  }

  const computer = status.computerUse;
  const job = computer.job;
  const downloading = computer.state === "downloading";
  const driverSize = formatBytes(computer.downloadBytes);
  const computerDescription = `${tx("settings.automation.computer.description", "允许 Mona 观察并操作电脑上的其他应用。首次启用需要下载驱动并完成系统授权。")}${!computer.installed && computer.downloadBytes > 0 ? t("settings.automation.computer.driverSize", { size: driverSize, defaultValue: "（驱动约 {{size}}）" }) : ""}`;
  const progress =
    job && job.totalBytes > 0
      ? Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100))
      : 0;
  const computerError =
    computer.error ||
    job?.error ||
    tx("settings.automation.computerError", "电脑操作自动化暂时不可用");

  return (
    <section>
      <SubsectionLabel className="mb-2 px-1">
        {tx("settings.automation.title", "自动化能力")}
      </SubsectionLabel>
      <SettingsGroup>
        <SettingsRow
          title={tx("settings.automation.browser.title", "浏览器自动操作")}
          description={tx(
            "settings.automation.browser.description",
            "允许 Mona 在内置浏览器中读取页面并执行点击、输入等操作。",
          )}
        >
          <AutomationToggle
            checked={status.browserAutomationEnabled}
            disabled={browserSaving}
            onChange={(enabled) => void saveBrowser(enabled)}
            label={
              status.browserAutomationEnabled
                ? tx("settings.values.on", "开")
                : tx("settings.values.off", "关")
            }
            ariaLabel={tx(
              "settings.automation.browser.toggle",
              "浏览器自动操作",
            )}
          />
        </SettingsRow>
        <SettingsRow
          title={tx("settings.automation.computer.title", "电脑操作自动化")}
          description={computerDescription}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <StatusPill tone={stateTone(computer.state)}>
              {stateLabel(computer.state, tx)}
            </StatusPill>
            <AutomationToggle
              checked={computer.enabled}
              disabled={!computer.supported || computerSaving || downloading}
              onChange={(enabled) => void saveComputer(enabled)}
              label={
                computer.enabled
                  ? tx("settings.values.on", "开")
                  : tx("settings.values.off", "关")
              }
              ariaLabel={tx(
                "settings.automation.computer.toggle",
                "电脑操作自动化",
              )}
            />
          </div>
        </SettingsRow>
        {downloading ? (
          <div className="px-4 py-3.5 sm:px-5">
            <div className="flex items-center justify-between gap-3 text-caption text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5" aria-hidden />
                {tx(
                  "settings.automation.computer.downloading",
                  "正在下载电脑操作自动化驱动",
                )}
              </span>
              <span className="tabular-nums">{progress}%</span>
            </div>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={tx(
                "settings.automation.computer.progress",
                "电脑操作自动化驱动下载进度",
              )}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.max(3, progress)}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 text-caption text-muted-foreground">
              <span>
                {formatBytes(job?.totalBytes || computer.downloadBytes)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={cancelSaving}
                onClick={() => void cancelDownload()}
              >
                {cancelSaving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {tx("settings.automation.cancel", "取消下载")}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsGroup>

      <div className="mt-3 space-y-2">
        {!computer.supported ? (
          <StatusNotice
            tone="warning"
            title={tx(
              "settings.automation.unsupported.title",
              "当前系统不支持电脑操作自动化",
            )}
          >
            {tx(
              "settings.automation.unsupported.description",
              "此设备暂时无法使用通用电脑操作。",
            )}
          </StatusNotice>
        ) : null}
        {computer.state === "available" && computer.degraded ? (
          <StatusNotice
            tone="warning"
            title={tx(
              "settings.automation.degraded.title",
              "部分操作能力受限",
            )}
          >
            {tx(
              "settings.automation.degraded.description",
              "基础电脑操作仍可使用；部分依赖辅助功能的精细操作暂时不可用。",
            )}
          </StatusNotice>
        ) : null}
        {computer.state === "pending_authorization" ? (
          <StatusNotice
            tone="warning"
            title={tx(
              "settings.automation.authorization.title",
              "需要系统授权",
            )}
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={permissionSaving}
                onClick={() => void grantPermissions()}
              >
                {permissionSaving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                )}
                {tx("settings.automation.authorize", "授权")}
              </Button>
            }
          >
            {tx(
              "settings.automation.authorization.description",
              "请在系统设置中允许屏幕录制和辅助功能权限，然后点击授权。",
            )}
          </StatusNotice>
        ) : null}
        {computer.state === "error" ? (
          <StatusNotice
            tone="danger"
            title={tx(
              "settings.automation.error.title",
              "电脑操作自动化异常",
            )}
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={computerSaving}
                onClick={() => void saveComputer(true)}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                {tx("settings.automation.retry", "重试")}
              </Button>
            }
          >
            {computerError}
          </StatusNotice>
        ) : null}
        {computer.state === "not_installed" && computer.enabled ? (
          <StatusNotice
            tone="info"
            title={tx(
              "settings.automation.notInstalled.title",
              "电脑操作自动化尚未安装",
            )}
            action={
              <Button
                size="sm"
                disabled={computerSaving}
                onClick={() => void saveComputer(true)}
              >
                {tx("settings.automation.download", "下载驱动")}
              </Button>
            }
          >
            {t("settings.automation.notInstalled.description", {
              size: driverSize,
              defaultValue: "首次启用需要下载约 {{size}}。",
            })}
          </StatusNotice>
        ) : null}
        {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
      </div>
    </section>
  );
}

function stateLabel(
  state: ComputerUseState,
  tx: (key: string, fallback: string) => string,
): string {
  switch (state) {
    case "disabled":
      return tx("settings.automation.states.disabled", "已关闭");
    case "not_installed":
      return tx("settings.automation.states.notInstalled", "未安装");
    case "downloading":
      return tx("settings.automation.states.downloading", "下载中");
    case "pending_authorization":
      return tx("settings.automation.states.pendingAuthorization", "待授权");
    case "available":
      return tx("settings.automation.states.available", "可用");
    case "error":
      return tx("settings.automation.states.error", "异常");
  }
}

function stateTone(
  state: ComputerUseState,
): "neutral" | "success" | "warning" | "info" {
  if (state === "available") return "success";
  if (state === "downloading" || state === "pending_authorization")
    return "warning";
  if (state === "not_installed") return "info";
  return "neutral";
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

function SettingsRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[62px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <div className="text-body font-medium text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 max-w-[32rem] text-caption text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? <div className="shrink-0 sm:ml-6">{children}</div> : null}
    </div>
  );
}

function AutomationToggle({
  checked,
  disabled,
  onChange,
  label,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  ariaLabel: string;
}) {
  return (
    <Switch
      disabled={disabled}
      aria-label={ariaLabel}
      title={label}
      checked={checked}
      onCheckedChange={onChange}
    />
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "neutral" | "success" | "warning" | "info";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium",
        tone === "success" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "info" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {tone === "success" ? (
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

function formatBytes(value: number): string {
  if (!(value > 0)) return "—";
  const megabytes = value / 1024 / 1024;
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}
